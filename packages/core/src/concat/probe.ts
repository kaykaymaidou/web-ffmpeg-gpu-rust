import { SimpleMp4Demuxer } from '../demuxer/mp4-demuxer.js';
import { toArrayBuffer } from './bytes.js';

export type ProbeInfo = {
  byteLength: number;
  durationUs: number;
  width: number;
  height: number;
  videoCodec: string;
  videoTimescale: number;
  sampleCount: number;
  keyframeCount: number;
  hasAudio: boolean;
  audioCodec?: string;
  audioSampleRate?: number;
  audioChannels?: number;
};

export function probeMp4(bytes: Uint8Array): ProbeInfo {
  if (!bytes || bytes.byteLength < 16) {
    throw new Error('probe: buffer too small');
  }
  const tracks = new SimpleMp4Demuxer(toArrayBuffer(bytes)).parse();
  const video = tracks.find((t) => t.kind === 'video' && t.samples.length > 0);
  if (!video) {
    throw new Error('probe: no video track');
  }
  const audio = tracks.find((t) => t.kind === 'audio' && t.samples.length > 0);
  const durationUs = video.samples.reduce((acc, s) => acc + s.duration, 0);
  return {
    byteLength: bytes.byteLength,
    durationUs,
    width: video.width,
    height: video.height,
    videoCodec: video.codec,
    videoTimescale: video.timescale,
    sampleCount: video.samples.length,
    keyframeCount: video.samples.filter((s) => s.type === 'key').length,
    hasAudio: !!audio,
    audioCodec: audio?.codec,
    audioSampleRate: audio?.sampleRate,
    audioChannels: audio?.channels,
  };
}

export async function probe(bytes: Uint8Array): Promise<ProbeInfo> {
  return probeMp4(bytes);
}
