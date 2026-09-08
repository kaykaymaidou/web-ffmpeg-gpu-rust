export type FilterMode =
  | 'none'
  | 'grayscale'
  | 'invert'
  | 'brightness_contrast'
  | 'sepia'
  | 'vignette'
  | 'hdr_tonemap'
  | 'bilateral_denoise'
  | 'lanczos_upsample';

export interface FilterSettings {
  mode: FilterMode;
  brightness: number; // -1.0 to 1.0
  contrast: number;   // 0.0 to 3.0
  saturation: number; // 0.0 to 3.0
  sigmaSpatial?: number; // For bilateral filter (default ~2.0)
  sigmaRange?: number;   // For bilateral filter (default ~0.15)
}

export interface VideoStreamInfo {
  codec: string;
  width: number;
  height: number;
  durationUs: number;
  fps: number;
}

export interface PlaybackMetrics {
  currentFps: number;
  avgFrameRenderTimeMs: number;
  totalDecodedFrames: number;
  droppedFrames: number;
  gpuDeviceName: string;
  isHardwareAccelerated: boolean;
}

export type FrameCallback = (frame: VideoFrame, metadata: { pts: number }) => void;
export type FallbackCallback = (reason: string, config: VideoDecoderConfig) => void;
export type ErrorCallback = (error: DOMException | Error) => void;
