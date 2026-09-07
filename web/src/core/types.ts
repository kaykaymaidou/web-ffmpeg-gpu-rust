export type FilterMode = 'none' | 'grayscale' | 'invert' | 'brightness_contrast' | 'sepia' | 'vignette';

export interface FilterSettings {
  mode: FilterMode;
  brightness: number; // -1.0 to 1.0
  contrast: number;   // 0.0 to 3.0
  saturation: number; // 0.0 to 3.0
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
