import { WebGpuVideoRenderer } from './gpu-renderer';
import { HardwareVideoDecoder } from './decoder';
import { SimpleMp4Demuxer, type DemuxedTrack } from './mp4-demuxer';
import type { FilterSettings, PlaybackMetrics, VideoStreamInfo } from './types';

export class WebFfmpegPipeline {
  private renderer: WebGpuVideoRenderer;
  private decoder: HardwareVideoDecoder | null = null;
  private canvas: HTMLCanvasElement;
  private currentTrack: DemuxedTrack | null = null;
  private isPlaying: boolean = false;
  private currentSampleIndex: number = 0;
  private animationFrameId: number | null = null;

  // Performance metrics tracking
  private frameCount: number = 0;
  private lastFpsUpdateTime: number = performance.now();
  private currentFps: number = 0;
  private renderTimeAccumulator: number = 0;
  private renderTimeCount: number = 0;
  private avgRenderTimeMs: number = 0;

  private onMetricsUpdate?: (metrics: PlaybackMetrics) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new WebGpuVideoRenderer(canvas);
  }

  public async initialize(onMetrics?: (metrics: PlaybackMetrics) => void): Promise<void> {
    this.onMetricsUpdate = onMetrics;
    await this.renderer.initialize();

    // Initialize hardware decoder
    this.decoder = new HardwareVideoDecoder((videoFrame: VideoFrame) => {
      const renderStart = performance.now();

      // Render via WebGPU
      this.renderer.render(videoFrame);

      // Measure render time
      const renderDuration = performance.now() - renderStart;
      this.renderTimeAccumulator += renderDuration;
      this.renderTimeCount++;
      this.frameCount++;

      // Free GPU memory immediately! Critical for preventing memory leaks
      videoFrame.close();

      this.updateMetrics();
    });
  }

  public async loadMedia(fileBuffer: ArrayBuffer): Promise<VideoStreamInfo> {
    this.pause();
    this.currentSampleIndex = 0;

    const demuxer = new SimpleMp4Demuxer(fileBuffer);
    const tracks = demuxer.parse();

    if (tracks.length === 0) {
      throw new Error('No video track found in the provided file.');
    }

    const videoTrack = tracks[0];
    this.currentTrack = videoTrack;

    // Adjust canvas resolution
    this.canvas.width = videoTrack.width;
    this.canvas.height = videoTrack.height;

    // Configure WebCodecs hardware decoder
    const decoderConfig: VideoDecoderConfig = {
      codec: videoTrack.codec,
      codedWidth: videoTrack.width,
      codedHeight: videoTrack.height,
      description: videoTrack.description,
      hardwareAcceleration: 'prefer-hardware',
    };

    const isSupported = await HardwareVideoDecoder.isSupported(decoderConfig);
    console.log(`🎬 [WebCodecs] Codec ${videoTrack.codec} hardware support: ${isSupported}`);

    this.decoder?.configure(decoderConfig);

    return {
      codec: videoTrack.codec,
      width: videoTrack.width,
      height: videoTrack.height,
      durationUs: videoTrack.samples.reduce((acc, s) => acc + s.duration, 0),
      fps: Math.round(videoTrack.timescale / (videoTrack.samples[0]?.duration || 1000)),
    };
  }

  public play(): void {
    if (!this.currentTrack || this.isPlaying) return;
    this.isPlaying = true;
    this.scheduleNextPlaybackTick();
  }

  public pause(): void {
    this.isPlaying = false;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  public togglePlay(): void {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  public setFilters(settings: FilterSettings): void {
    this.renderer.updateFilterUniforms(settings);
  }

  private scheduleNextPlaybackTick(): void {
    if (!this.isPlaying || !this.currentTrack) return;

    if (this.currentSampleIndex >= this.currentTrack.samples.length) {
      // Loop playback
      this.currentSampleIndex = 0;
    }

    // Keep decoder queue filled with 2-3 frames to achieve buttery smooth hardware playback
    while (this.decoder && this.decoder.getQueueSize() < 4 && this.currentSampleIndex < this.currentTrack.samples.length) {
      const sample = this.currentTrack.samples[this.currentSampleIndex++];
      const chunk = new EncodedVideoChunk({
        type: sample.type,
        timestamp: sample.timestamp,
        duration: sample.duration,
        data: sample.data,
      });
      this.decoder.decodeChunk(chunk);
    }

    this.animationFrameId = requestAnimationFrame(() => {
      this.scheduleNextPlaybackTick();
    });
  }

  private updateMetrics(): void {
    const now = performance.now();
    const elapsed = now - this.lastFpsUpdateTime;

    if (elapsed >= 500) {
      this.currentFps = Math.round((this.frameCount * 1000) / elapsed);
      this.avgRenderTimeMs = this.renderTimeCount > 0
        ? Number((this.renderTimeAccumulator / this.renderTimeCount).toFixed(2))
        : 0;

      this.frameCount = 0;
      this.renderTimeAccumulator = 0;
      this.renderTimeCount = 0;
      this.lastFpsUpdateTime = now;

      if (this.onMetricsUpdate) {
        this.onMetricsUpdate({
          currentFps: this.currentFps,
          avgFrameRenderTimeMs: this.avgRenderTimeMs,
          totalDecodedFrames: this.currentSampleIndex,
          droppedFrames: 0,
          gpuDeviceName: this.renderer.getDeviceName(),
          isHardwareAccelerated: true,
        });
      }
    }
  }

  public destroy(): void {
    this.pause();
    this.decoder?.close();
    this.renderer.destroy();
  }
}
