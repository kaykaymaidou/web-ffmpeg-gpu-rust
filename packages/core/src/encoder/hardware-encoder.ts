export interface VideoEncoderOptions {
  codec: string;
  width: number;
  height: number;
  bitrate?: number;
  framerate?: number;
  latencyMode?: 'quality' | 'realtime';
  bitrateMode?: 'constant' | 'variable';
}

export type ChunkCallback = (
  chunk: EncodedVideoChunk,
  metadata?: EncodedVideoChunkMetadata
) => void;

export class HardwareVideoEncoder {
  private encoder: VideoEncoder | null = null;
  private isConfigured: boolean = false;
  private onChunkCallback: ChunkCallback;
  private onErrorCallback?: (err: DOMException) => void;
  private dequeueListeners: Array<() => void> = [];

  constructor(
    onChunk: ChunkCallback,
    onError?: (err: DOMException) => void
  ) {
    this.onChunkCallback = onChunk;
    this.onErrorCallback = onError;
  }

  public static async isSupported(config: VideoEncoderConfig): Promise<boolean> {
    if (typeof VideoEncoder === 'undefined') {
      return false;
    }
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      return !!support.supported;
    } catch {
      return false;
    }
  }

  public async configure(options: VideoEncoderOptions): Promise<boolean> {
    if (typeof VideoEncoder === 'undefined') {
      throw new Error('WebCodecs VideoEncoder is not supported in this browser/environment.');
    }

    const config: VideoEncoderConfig = {
      codec: options.codec,
      width: options.width,
      height: options.height,
      bitrate: options.bitrate || 4_000_000,
      framerate: options.framerate || 30,
      latencyMode: options.latencyMode || 'quality',
      bitrateMode: options.bitrateMode || 'variable',
      hardwareAcceleration: 'prefer-hardware',
      avc: { format: 'avc' },
    };

    const isSupported = await HardwareVideoEncoder.isSupported(config);
    if (!isSupported) {
      console.warn(`[HardwareVideoEncoder] Hardware acceleration preferred config not reported as supported, attempting fallback options...`);
    }

    if (this.encoder) {
      this.encoder.close();
    }

    this.encoder = new VideoEncoder({
      output: (chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) => {
        this.onChunkCallback(chunk, metadata);
      },
      error: (e: DOMException) => {
        console.error('🚨 [HardwareVideoEncoder Error]:', e);
        if (this.onErrorCallback) {
          this.onErrorCallback(e);
        }
      },
    });

    this.encoder.ondequeue = () => {
      // Wake up any workers/promises waiting on backpressure
      const listeners = this.dequeueListeners.splice(0);
      for (const cb of listeners) {
        cb();
      }
    };

    this.encoder.configure(config);
    this.isConfigured = true;
    return true;
  }

  public get encodeQueueSize(): number {
    return this.encoder ? this.encoder.encodeQueueSize : 0;
  }

  /**
   * Backpressure controller: Resolves when encodeQueueSize drops below the threshold.
   * Prevents accumulating too many unencoded VideoFrames in GPU memory.
   */
  public async waitForBackpressure(maxQueueSize: number = 8): Promise<void> {
    if (!this.encoder) return;
    if (this.encoder.encodeQueueSize <= maxQueueSize) {
      return;
    }

    return new Promise((resolve) => {
      const check = () => {
        if (!this.encoder || this.encoder.encodeQueueSize <= maxQueueSize) {
          resolve();
        } else {
          this.dequeueListeners.push(check);
        }
      };
      this.dequeueListeners.push(check);
    });
  }

  /**
   * Encode a single VideoFrame.
   * Note: The caller is responsible for closing the frame after this call.
   */
  public encode(frame: VideoFrame, options?: VideoEncoderEncodeOptions): void {
    if (!this.encoder || !this.isConfigured) {
      throw new Error('HardwareVideoEncoder must be configured before encoding frames.');
    }
    this.encoder.encode(frame, options);
  }

  public async flush(): Promise<void> {
    if (this.encoder && this.encoder.state === 'configured') {
      await this.encoder.flush();
    }
  }

  public close(): void {
    if (this.encoder) {
      try {
        if (this.encoder.state !== 'closed') {
          this.encoder.close();
        }
      } catch (err) {
        console.warn('Error closing encoder:', err);
      }
      this.encoder = null;
      this.isConfigured = false;
    }
  }
}
