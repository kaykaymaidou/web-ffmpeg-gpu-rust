import { HardwareVideoDecoder } from '../decoder/hardware-decoder.js';
import { HardwareVideoEncoder } from '../encoder/hardware-encoder.js';
import { SimpleMp4Demuxer, type DemuxedSample, type DemuxedTrack } from '../demuxer/mp4-demuxer.js';
import { FastStartMp4Muxer } from '../muxer/mp4-muxer.js';
import { WebFfmpegTranscoder, type TranscodePreset } from '../pipeline/transcoder.js';
import { copyBytes, toArrayBuffer } from './bytes.js';
import { concatCopy } from './concat-copy.js';
import type { ConcatXfadeOptions, ExtractStillsOptions } from './pixel-ops.js';

function videoTrack(bytes: Uint8Array): DemuxedTrack {
  const tracks = new SimpleMp4Demuxer(toArrayBuffer(bytes)).parse();
  const video = tracks.find((t) => t.kind === 'video' && t.samples.length > 0);
  if (!video) {
    throw new Error('no video track');
  }
  return video;
}

function decoderConfig(video: DemuxedTrack): VideoDecoderConfig {
  const config: VideoDecoderConfig = {
    codec: video.codec,
    codedWidth: video.width,
    codedHeight: video.height,
    hardwareAcceleration: 'prefer-hardware',
  };
  if (video.description && video.description.byteLength > 0) {
    config.description = copyBytes(video.description);
  }
  return config;
}

async function decodeSamples(video: DemuxedTrack, samples: DemuxedSample[]): Promise<VideoFrame[]> {
  const frames: VideoFrame[] = [];
  const decoder = new HardwareVideoDecoder((frame) => {
    frames.push(frame);
  });
  const ok = await decoder.configure(decoderConfig(video));
  if (!ok) {
    decoder.close();
    throw new Error(`WebCodecs cannot decode ${video.codec}`);
  }
  for (const sample of samples) {
    decoder.decodeChunk(
      new EncodedVideoChunk({
        type: sample.type === 'key' ? 'key' : 'delta',
        timestamp: sample.timestamp,
        duration: sample.duration,
        data: copyBytes(sample.data),
      })
    );
  }
  await decoder.flush();
  decoder.close();
  return frames;
}

async function frameToJpeg(frame: VideoFrame): Promise<Uint8Array> {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('OffscreenCanvas is required to encode stills');
  }
  const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2d canvas unavailable');
  }
  ctx.drawImage(frame, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  return new Uint8Array(await blob.arrayBuffer());
}

export async function decodeExtractStills(
  bytes: Uint8Array,
  opts: ExtractStillsOptions = {}
): Promise<{ first?: Uint8Array; last?: Uint8Array }> {
  const wantFirst = opts.first !== false;
  const wantLast = opts.last !== false;
  const video = videoTrack(bytes);
  const frames = await decodeSamples(video, video.samples);
  if (frames.length === 0) {
    throw new Error('extractStills: decoder produced no frames');
  }
  const firstFrame = frames[0];
  const lastFrame = frames[frames.length - 1];
  const out: { first?: Uint8Array; last?: Uint8Array } = {};
  try {
    if (wantFirst) {
      out.first = await frameToJpeg(firstFrame);
    }
    if (wantLast) {
      out.last = await frameToJpeg(lastFrame);
    }
  } finally {
    for (const f of frames) {
      f.close();
    }
  }
  return out;
}

function blend(a: VideoFrame, b: VideoFrame, t: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(a.displayWidth, a.displayHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2d canvas unavailable');
  }
  ctx.globalAlpha = 1;
  ctx.drawImage(a, 0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = Math.min(1, Math.max(0, t));
  ctx.drawImage(b, 0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = 1;
  return canvas;
}

async function encodeCanvases(canvases: OffscreenCanvas[], width: number, height: number, fps: number): Promise<Uint8Array> {
  const muxer = new FastStartMp4Muxer();
  let sps = new Uint8Array([0x67, 0x42, 0xc0, 0x1e, 0xd9, 0x00, 0xa0, 0x7b, 0x40]);
  let pps = new Uint8Array([0x68, 0xce, 0x38, 0x80]);
  muxer.setVideoTrack({ width, height, timescale: 90000, sps, pps });

  const durationTicks = Math.max(1, Math.round(90000 / fps));
  const encoder = new HardwareVideoEncoder((chunk, metadata) => {
    if (metadata?.decoderConfig?.description) {
      const desc = new Uint8Array(metadata.decoderConfig.description as ArrayBuffer);
      muxer.setVideoTrack({ width, height, timescale: 90000, description: desc, codec: 'avc1' });
    }
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    muxer.writeVideoSample(data, durationTicks, chunk.type === 'key');
  });

  const configured = await encoder.configure({
    codec: 'avc1.42001e',
    width,
    height,
    bitrate: 4_000_000,
    framerate: fps,
    avcFormat: 'avc',
  });
  if (!configured) {
    encoder.close();
    throw new Error('WebCodecs encoder rejected avc1.42001e');
  }

  const frameDurationUs = Math.round(1_000_000 / fps);
  for (let i = 0; i < canvases.length; i++) {
    const ts = i * frameDurationUs;
    const frame = new VideoFrame(canvases[i], { timestamp: ts, duration: frameDurationUs });
    encoder.encode(frame, { keyFrame: i === 0 || i % fps === 0 });
    frame.close();
  }
  await encoder.flush();
  encoder.close();
  return muxer.finalize();
}

export async function decodeConcatXfade(parts: Uint8Array[], opts: ConcatXfadeOptions = {}): Promise<Uint8Array> {
  if (parts.length < 2) {
    throw new Error('concatXfade requires at least 2 parts');
  }
  const height = opts.height ?? 720;
  const durationSec = opts.durationSec ?? 0.5;
  const transcoder = new WebFfmpegTranscoder();
  const normalized: Uint8Array[] = [];
  for (const part of parts) {
    const result = await transcoder.transcode(toArrayBuffer(part), {
      preset: 'social-720p',
      targetHeight: height,
      muteAudio: true,
    });
    normalized.push(result.mp4Buffer);
  }

  const decoded: VideoFrame[][] = [];
  try {
    for (const buf of normalized) {
      const video = videoTrack(buf);
      decoded.push(await decodeSamples(video, video.samples));
    }

    const fps = 24;
    const overlap = Math.max(1, Math.round(durationSec * fps));
    const width = decoded[0][0].displayWidth;
    const outH = decoded[0][0].displayHeight;
    const canvases: OffscreenCanvas[] = [];

    const drawFrame = (frame: VideoFrame): OffscreenCanvas => {
      const canvas = new OffscreenCanvas(width, outH);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('2d canvas unavailable');
      }
      ctx.drawImage(frame, 0, 0, width, outH);
      return canvas;
    };

    for (let c = 0; c < decoded.length; c++) {
      const clip = decoded[c];
      const next = decoded[c + 1];
      const keepEnd = next ? Math.max(1, clip.length - overlap) : clip.length;
      for (let i = 0; i < keepEnd; i++) {
        canvases.push(drawFrame(clip[i]));
      }
      if (next) {
        for (let i = 0; i < overlap; i++) {
          const a = clip[Math.min(clip.length - 1, keepEnd + i)] ?? clip[clip.length - 1];
          const b = next[Math.min(next.length - 1, i)];
          canvases.push(blend(a, b, (i + 1) / (overlap + 1)));
        }
      }
    }

    return await encodeCanvases(canvases, width, outH, fps);
  } finally {
    for (const clip of decoded) {
      for (const f of clip) {
        f.close();
      }
    }
  }
}

export async function decodeConcatTranscode(
  parts: Uint8Array[],
  opts?: { preset?: TranscodePreset }
): Promise<Uint8Array> {
  if (parts.length < 2) {
    throw new Error('concatTranscode requires at least 2 parts');
  }
  const transcoder = new WebFfmpegTranscoder();
  const out: Uint8Array[] = [];
  for (const part of parts) {
    const result = await transcoder.transcode(toArrayBuffer(part), {
      preset: opts?.preset ?? 'social-720p',
      muteAudio: true,
    });
    out.push(result.mp4Buffer);
  }
  return concatCopy(out);
}
