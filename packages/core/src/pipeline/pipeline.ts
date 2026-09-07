import { WebGpuVideoRenderer } from '../renderer/gpu-renderer';
import { HardwareVideoDecoder } from '../decoder/hardware-decoder';
import { SimpleMp4Demuxer, type DemuxedTrack } from '../demuxer/mp4-demuxer';
import type { FilterSettings, PlaybackMetrics, VideoStreamInfo, FallbackCallback, ErrorCallback } from '../types';

export class WebFfmpegEngine {
  private renderer: WebGpuVideoRenderer;
  private decoder: HardwareVideoDecoder | null = null;
  private canvas: HTMLCanvasElement;
  private currentTrack: DemuxedTrack | null = null;
  private isPlaying: boolean = false;
  private currentSampleIndex: number = 0;
  private animationFrameId: number | null = null;

  // Telemetry metrics
  private frameCount: number = 0;
  private lastFpsUpdateTime: number = performance.now();
  private currentFps: number = 0;
  private renderTimeAccumulator: number = 0;
  private renderTimeCount: number = 0;
  private avgRenderTimeMs: number = 0;

  private onMetricsUpdate?: (metrics: PlaybackMetrics) => void;
  private onFallback?: FallbackCallback;
  private onError?: ErrorCallback;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new WebGpuVideoRenderer(canvas);
  }

  public async initialize(options?: {
    onMetrics?: (metrics: PlaybackMetrics) => void;
    onFallback?: FallbackCallback;
    onError?: ErrorCallback;
  }): Promise<void> {
    this.onMetricsUpdate = options?.onMetrics;
    this.onFallback = options?.onFallback;
    this.onError = options?.onError;

    await this.renderer.initialize();

    this.decoder = new HardwareVideoDecoder(
      (videoFrame: VideoFrame) => {
        const renderStart = performance.now();
        this.renderer.render(videoFrame);
        const renderDuration = performance.now() - renderStart;

        this.renderTimeAccumulator += renderDuration;
        this.renderTimeCount++;
        this.frameCount++;

        // Invariant 1: Close frame immediately after consumption
        videoFrame.close();
        this.updateMetrics();
      },
      this.onError,
      this.onFallback
    );
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

    this.canvas.width = videoTrack.width;
    this.canvas.height = videoTrack.height;

    const decoderConfig: VideoDecoderConfig = {
      codec: videoTrack.codec,
      codedWidth: videoTrack.width,
      codedHeight: videoTrack.height,
      description: videoTrack.description,
      hardwareAcceleration: 'prefer-hardware',
    };

    const isOk = await this.decoder?.configure(decoderConfig);
    if (!isOk) {
      console.warn(`[WebFfmpegEngine] Codec ${videoTrack.codec} not hardware-accelerated. Triggered fallback.`);
    }

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

  public seek(sampleIndex: number): void {
    if (!this.currentTrack) return;
    this.decoder?.reset();
    this.currentSampleIndex = Math.max(0, Math.min(sampleIndex, this.currentTrack.samples.length - 1));
  }

  public getTrack(): DemuxedTrack | null {
    return this.currentTrack;
  }

  public getCurrentSampleIndex(): number {
    return this.currentSampleIndex;
  }

  public getDecoder(): HardwareVideoDecoder | null {
    return this.decoder;
  }

  private scheduleNextPlaybackTick(): void {
    if (!this.isPlaying || !this.currentTrack) return;

    if (this.currentSampleIndex >= this.currentTrack.samples.length) {
      this.currentSampleIndex = 0;
    }

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
          droppedFrames: this.decoder?.getStats().dropped || 0,
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
