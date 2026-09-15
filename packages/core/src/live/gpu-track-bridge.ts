/**
 * WebGPU → MediaStreamTrackGenerator bridge for WHIP ingest.
 * Camera/synthetic VideoFrame stays on GPU, WGSL filters run, then a generator
 * track is handed to RTCPeerConnection.addTrack (RFC 0003).
 */

import type { FilterSettings } from '../types';
import { WebGpuVideoRenderer } from '../renderer/gpu-renderer';

export interface GpuTrackBridgeOptions {
  filter?: FilterSettings;
  onFilteredFrame?: (frame: VideoFrame) => void;
  onError?: (err: Error) => void;
}

export interface GpuTrackBridgeStats {
  gpuActive: boolean;
  filteredFrames: number;
  droppedFrames: number;
}

export function isInsertableTrackSupported(): boolean {
  return (
    typeof (globalThis as any).MediaStreamTrackProcessor !== 'undefined' &&
    typeof (globalThis as any).MediaStreamTrackGenerator !== 'undefined'
  );
}

export class WhipGpuTrackBridge {
  private renderer: WebGpuVideoRenderer | null = null;
  private canvas: OffscreenCanvas | null = null;
  private writer: WritableStreamDefaultWriter<VideoFrame> | null = null;
  private generatorTrack: MediaStreamTrack | null = null;
  private running = false;
  private filter: FilterSettings;
  private onFilteredFrame?: (frame: VideoFrame) => void;
  private onError?: (err: Error) => void;
  private filteredFrames = 0;
  private droppedFrames = 0;

  constructor(options: GpuTrackBridgeOptions = {}) {
    this.filter = options.filter ?? {
      mode: 'none',
      brightness: 0,
      contrast: 1,
      saturation: 1,
    };
    this.onFilteredFrame = options.onFilteredFrame;
    this.onError = options.onError;
  }

  public setFilter(settings: FilterSettings): void {
    this.filter = { ...settings };
    this.renderer?.updateFilterUniforms(this.filter);
  }

  public setOnFilteredFrame(callback?: (frame: VideoFrame) => void): void {
    this.onFilteredFrame = callback;
  }

  public getStats(): GpuTrackBridgeStats {
    return {
      gpuActive: this.running && this.renderer !== null,
      filteredFrames: this.filteredFrames,
      droppedFrames: this.droppedFrames,
    };
  }

  public async start(source: MediaStreamTrack): Promise<MediaStreamTrack> {
    if (!isInsertableTrackSupported()) {
      throw new Error('MediaStreamTrackProcessor/Generator is required for WHIP GPU ingest');
    }
    if (this.running) {
      throw new Error('WhipGpuTrackBridge is already running');
    }

    const settings = source.getSettings();
    const width = settings.width || 640;
    const height = settings.height || 360;

    this.canvas = new OffscreenCanvas(width, height);
    this.renderer = new WebGpuVideoRenderer(this.canvas);
    await this.renderer.initialize();
    this.renderer.updateFilterUniforms(this.filter);

    const generator = new (globalThis as any).MediaStreamTrackGenerator({ kind: 'video' });
    this.generatorTrack = generator;
    this.writer = generator.writable.getWriter();

    const processor = new (globalThis as any).MediaStreamTrackProcessor({ track: source });
    const reader: ReadableStreamDefaultReader<VideoFrame> = processor.readable.getReader();
    this.running = true;
    void this.pump(reader);
    return generator as MediaStreamTrack;
  }

  public destroy(): void {
    this.running = false;
    if (this.writer) {
      try {
        void this.writer.close();
      } catch {
        // already closed
      }
      this.writer = null;
    }
    this.generatorTrack?.stop();
    this.generatorTrack = null;
    this.renderer?.destroy();
    this.renderer = null;
    this.canvas = null;
  }

  private async pump(reader: ReadableStreamDefaultReader<VideoFrame>): Promise<void> {
    while (this.running && this.writer && this.renderer) {
      let frame: VideoFrame | null = null;
      try {
        const result = await reader.read();
        if (result.done || !result.value) {
          break;
        }
        frame = result.value;

        if (this.writer.desiredSize !== null && this.writer.desiredSize <= 0) {
          this.droppedFrames++;
          continue;
        }

        this.renderer.updateFilterUniforms(this.filter);
        const filtered = this.renderer.renderToVideoFrame(frame);
        try {
          if (this.onFilteredFrame) {
            const clone = filtered.clone();
            try {
              this.onFilteredFrame(clone);
            } finally {
              clone.close();
            }
          }
          await this.writer.write(filtered);
          this.filteredFrames++;
        } finally {
          filtered.close();
        }
      } catch (err) {
        if (this.running) {
          this.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
        break;
      } finally {
        frame?.close();
      }
    }

    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
}
