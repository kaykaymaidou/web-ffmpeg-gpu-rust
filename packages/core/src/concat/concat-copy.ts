import { SimpleMp4Demuxer, type DemuxedTrack } from '../demuxer/mp4-demuxer.js';
import { FastStartMp4Muxer, type MuxerVideoCodec } from '../muxer/mp4-muxer.js';
import { bytesEqual, copyBytes, toArrayBuffer, videoCodecFamily } from './bytes.js';

export class ConcatCopyError extends Error {
  readonly code: string;

  constructor(message: string, code: string = 'CONCAT_COPY') {
    super(message);
    this.name = 'ConcatCopyError';
    this.code = code;
  }
}

function muxerCodec(family: ReturnType<typeof videoCodecFamily>): MuxerVideoCodec {
  return family === 'hevc' ? 'hvc1' : 'avc1';
}

function remapTicks(ticks: number, fromTimescale: number, toTimescale: number): number {
  if (fromTimescale === toTimescale) {
    return ticks;
  }
  if (fromTimescale <= 0) {
    throw new ConcatCopyError(`invalid timescale ${fromTimescale}`, 'BAD_TIMESCALE');
  }
  return Math.round((ticks * toTimescale) / fromTimescale);
}

function findVideo(tracks: DemuxedTrack[]): DemuxedTrack | undefined {
  return tracks.find((t) => t.kind === 'video' && t.samples.length > 0);
}

function findAudio(tracks: DemuxedTrack[]): DemuxedTrack | undefined {
  return tracks.find((t) => t.kind === 'audio' && t.samples.length > 0);
}

/**
 * In-memory ISOBMFF remux concatenator.
 * Rewrites a monotonic timeline; does not decode pixels and does not clone ffmpeg concat.
 */
export async function concatCopy(parts: Uint8Array[]): Promise<Uint8Array> {
  if (parts.length < 2) {
    throw new ConcatCopyError('concatCopy requires at least 2 parts', 'TOO_FEW_PARTS');
  }

  const parsed = parts.map((part, index) => {
    if (!part || part.byteLength < 16) {
      throw new ConcatCopyError(`part ${index} is empty or too small`, 'BAD_PART');
    }
    const demuxer = new SimpleMp4Demuxer(toArrayBuffer(part));
    const tracks = demuxer.parse();
    const video = findVideo(tracks);
    if (!video) {
      throw new ConcatCopyError(`part ${index} has no video track`, 'NO_VIDEO');
    }
    return { video, audio: findAudio(tracks) };
  });

  const template = parsed[0];
  const family = videoCodecFamily(template.video.codec);
  if (family === 'other') {
    throw new ConcatCopyError(
      `unsupported video codec '${template.video.codec}' (need AVC or HEVC)`,
      'UNSUPPORTED_CODEC'
    );
  }
  if (!template.video.description || template.video.description.byteLength === 0) {
    throw new ConcatCopyError('part 0 is missing avcC/hvcC description', 'MISSING_EXTRADATA');
  }
  if (template.video.samples[0].type !== 'key') {
    throw new ConcatCopyError('part 0 does not start on a keyframe', 'NON_KEY_START');
  }

  const outVideoTimescale = template.video.timescale || 30000;
  const wantAudio = !!template.audio;
  const outAudioTimescale = template.audio?.timescale || template.audio?.sampleRate || 44100;

  for (let i = 1; i < parsed.length; i++) {
    const part = parsed[i];
    if (part.video.width !== template.video.width || part.video.height !== template.video.height) {
      throw new ConcatCopyError(
        `part ${i} resolution ${part.video.width}x${part.video.height} != ${template.video.width}x${template.video.height}`,
        'RESOLUTION_MISMATCH'
      );
    }
    const partFamily = videoCodecFamily(part.video.codec);
    if (partFamily !== family) {
      throw new ConcatCopyError(
        `part ${i} codec '${part.video.codec}' != '${template.video.codec}'`,
        'CODEC_MISMATCH'
      );
    }
    if (!bytesEqual(part.video.description, template.video.description)) {
      throw new ConcatCopyError(`part ${i} video extradata (avcC/hvcC) does not match part 0`, 'EXTRADATA_MISMATCH');
    }
    if (part.video.samples[0].type !== 'key') {
      throw new ConcatCopyError(`part ${i} does not start on a keyframe`, 'NON_KEY_START');
    }
    if (wantAudio !== !!part.audio) {
      throw new ConcatCopyError(
        `part ${i} audio presence ${!!part.audio} != part 0 ${wantAudio}`,
        'AUDIO_LAYOUT_MISMATCH'
      );
    }
    if (wantAudio && template.audio && part.audio) {
      if (part.audio.codec.split('.')[0] !== template.audio.codec.split('.')[0]) {
        throw new ConcatCopyError(
          `part ${i} audio codec '${part.audio.codec}' != '${template.audio.codec}'`,
          'AUDIO_CODEC_MISMATCH'
        );
      }
      if ((part.audio.sampleRate || 0) !== (template.audio.sampleRate || 0)) {
        throw new ConcatCopyError(
          `part ${i} sampleRate ${part.audio.sampleRate} != ${template.audio.sampleRate}`,
          'AUDIO_RATE_MISMATCH'
        );
      }
      if ((part.audio.channels || 0) !== (template.audio.channels || 0)) {
        throw new ConcatCopyError(
          `part ${i} channels ${part.audio.channels} != ${template.audio.channels}`,
          'AUDIO_CHANNELS_MISMATCH'
        );
      }
    }
  }

  const muxer = new FastStartMp4Muxer();
  muxer.setVideoTrack({
    width: template.video.width,
    height: template.video.height,
    timescale: outVideoTimescale,
    codec: muxerCodec(family),
    description: copyBytes(template.video.description),
  });

  if (wantAudio && template.audio) {
    muxer.setAudioTrack({
      timescale: outAudioTimescale,
      sampleRate: template.audio.sampleRate || outAudioTimescale,
      channels: template.audio.channels || 2,
      config: template.audio.description ? copyBytes(template.audio.description) : undefined,
    });
  }

  for (const part of parsed) {
    const fromVideoTs = part.video.timescale || outVideoTimescale;
    for (const sample of part.video.samples) {
      const durationTicks = Math.max(1, remapTicks(sample.durationTicks || 0, fromVideoTs, outVideoTimescale));
      const compositionOffsetTicks = remapTicks(sample.compositionOffsetTicks || 0, fromVideoTs, outVideoTimescale);
      muxer.writeVideoSample(
        copyBytes(sample.data),
        durationTicks,
        sample.type === 'key',
        compositionOffsetTicks
      );
    }

    if (wantAudio && part.audio) {
      const fromAudioTs = part.audio.timescale || outAudioTimescale;
      for (const sample of part.audio.samples) {
        const durationTicks = Math.max(1, remapTicks(sample.durationTicks || 0, fromAudioTs, outAudioTimescale));
        muxer.writeAudioSample(copyBytes(sample.data), durationTicks);
      }
    }
  }

  return muxer.finalize();
}
