import { SimpleMp4Demuxer, type DemuxedSample, type DemuxedTrack } from '../demuxer/mp4-demuxer.js';
import { FastStartMp4Muxer, type MuxerVideoCodec } from '../muxer/mp4-muxer.js';
import { copyBytes, toArrayBuffer, videoCodecFamily } from './bytes.js';
import { ConcatCopyError } from './concat-copy.js';

export type TrimCopyOptions = {
  startUs?: number;
  endUs?: number;
};

function muxCodec(codec: string): MuxerVideoCodec {
  return videoCodecFamily(codec) === 'hevc' ? 'hvc1' : 'avc1';
}

function sliceFromKeyframe(samples: DemuxedSample[], startUs: number, endUs: number): DemuxedSample[] {
  const inRange = samples.filter((s) => s.timestamp >= startUs && s.timestamp <= endUs);
  if (inRange.length === 0) {
    throw new ConcatCopyError('trimCopy: no samples in range', 'EMPTY_TRIM');
  }
  const firstKey = inRange.findIndex((s) => s.type === 'key');
  if (firstKey === -1) {
    const before = samples.filter((s) => s.timestamp < startUs && s.type === 'key');
    const lastKey = before[before.length - 1];
    if (!lastKey) {
      throw new ConcatCopyError('trimCopy: range does not contain a keyframe', 'NON_KEY_START');
    }
    return samples.filter((s) => s.timestamp >= lastKey.timestamp && s.timestamp <= endUs);
  }
  return inRange.slice(firstKey);
}

/**
 * Keyframe-aligned in-memory trim. Not frame-accurate. Packet remux only.
 */
export async function trimCopy(bytes: Uint8Array, opts: TrimCopyOptions = {}): Promise<Uint8Array> {
  const startUs = opts.startUs ?? 0;
  const endUs = opts.endUs ?? Number.POSITIVE_INFINITY;
  const tracks = new SimpleMp4Demuxer(toArrayBuffer(bytes)).parse();
  const video = tracks.find((t) => t.kind === 'video' && t.samples.length > 0);
  if (!video || !video.description) {
    throw new ConcatCopyError('trimCopy: missing video/extradata', 'NO_VIDEO');
  }
  const family = videoCodecFamily(video.codec);
  if (family === 'other') {
    throw new ConcatCopyError(`trimCopy: unsupported codec ${video.codec}`, 'UNSUPPORTED_CODEC');
  }

  const exportVideo = sliceFromKeyframe(video.samples, startUs, endUs);
  const muxer = new FastStartMp4Muxer();
  muxer.setVideoTrack({
    width: video.width,
    height: video.height,
    timescale: video.timescale || 30000,
    codec: muxCodec(video.codec),
    description: copyBytes(video.description),
  });

  for (const s of exportVideo) {
    muxer.writeVideoSample(
      copyBytes(s.data),
      Math.max(1, s.durationTicks || 1),
      s.type === 'key',
      s.compositionOffsetTicks || 0
    );
  }

  const audio = tracks.find((t: DemuxedTrack) => t.kind === 'audio' && t.samples.length > 0);
  if (audio) {
    const firstTs = exportVideo[0].timestamp;
    const lastTs = exportVideo[exportVideo.length - 1].timestamp + exportVideo[exportVideo.length - 1].duration;
    muxer.setAudioTrack({
      timescale: audio.timescale || audio.sampleRate || 44100,
      sampleRate: audio.sampleRate || audio.timescale || 44100,
      channels: audio.channels || 2,
      config: audio.description ? copyBytes(audio.description) : undefined,
    });
    for (const s of audio.samples) {
      if (s.timestamp + s.duration < firstTs || s.timestamp > lastTs) {
        continue;
      }
      muxer.writeAudioSample(copyBytes(s.data), Math.max(1, s.durationTicks || 1));
    }
  }

  return muxer.finalize();
}
