// Entry point for @web-ffmpeg-gpu/core

export { WebFfmpegEngine } from './pipeline/pipeline';
export { HardwareVideoDecoder } from './decoder/hardware-decoder';
export { HardwareVideoEncoder, type VideoEncoderOptions, type ChunkCallback } from './encoder/hardware-encoder';
export { HardwareAudioEncoder, type AudioEncoderOptions, type AudioChunkCallback } from './codec/audio-encoder';
export { HardwareAudioDecoder, type AudioDecoderOptions, type AudioDataCallback } from './codec/audio-decoder';
export { FastStartMp4Muxer, type MuxerVideoTrack, type MuxerAudioTrack } from './muxer/mp4-muxer';
export {
  WebFfmpegTranscoder,
  type TranscodePreset,
  type TranscodeOptions,
  type TranscodeProgress,
  type TranscodeResult,
} from './pipeline/transcoder';
export { WebGpuVideoRenderer } from './renderer/gpu-renderer';
export { WebGpuComputeEngine } from './renderer/gpu-compute-pipeline';
export { SimpleMp4Demuxer, type DemuxedTrack, type DemuxedSample } from './demuxer/mp4-demuxer';
export { StreamFeeder, type StreamPacket } from './stream/feeder';
export { FILTERS_WGSL } from './shaders/filters.wgsl';
export {
  BILATERAL_DENOISE_COMPUTE_WGSL,
  LANCZOS_UPSAMPLE_COMPUTE_WGSL,
  HISTOGRAM_COMPUTE_WGSL,
} from './shaders/compute-filters.wgsl';

export type {
  FilterMode,
  FilterSettings,
  VideoStreamInfo,
  PlaybackMetrics,
  FrameCallback,
  FallbackCallback,
  ErrorCallback,
} from './types';
export * from './live';

