import type { FrameCallback, ErrorCallback, FallbackCallback } from '../types';

export class HardwareVideoDecoder {
  private decoder: VideoDecoder | null = null;
  private onFrameCallback: FrameCallback | null = null;
  private onErrorCallback: ErrorCallback | null = null;
  private onFallbackCallback: FallbackCallback | null = null;
  private isConfigured: boolean = false;
  private currentConfig: VideoDecoderConfig | null = null;
  private totalDecoded: number = 0;
  private totalDropped: number = 0;

  constructor(
    onFrame: FrameCallback,
    onError?: ErrorCallback,
    onFallback?: FallbackCallback
  ) {
    this.onFrameCallback = onFrame;
    this.onErrorCallback = onError || null;
    this.onFallbackCallback = onFallback || null;
  }

  public static async isSupported(config: VideoDecoderConfig): Promise<boolean> {
    if (typeof VideoDecoder === 'undefined') {
      return false;
    }
    try {
      const support = await VideoDecoder.isConfigSupported(config);
      return !!support.supported;
    } catch {
      return false;
    }
  }

  public async configure(config: VideoDecoderConfig): Promise<boolean> {
    if (typeof VideoDecoder === 'undefined') {
      this.triggerFallback('WebCodecs is not available in this environment', config);
      return false;
    }

    const supported = await HardwareVideoDecoder.isSupported(config);
    if (!supported) {
      this.triggerFallback(`Hardware codec '${config.codec}' is not supported by this browser/GPU`, config);
      return false;
    }

    if (this.decoder) {
      this.decoder.close();
    }

    this.currentConfig = config;
    this.decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        this.totalDecoded++;
        if (this.onFrameCallback) {
          this.onFrameCallback(frame, { pts: frame.timestamp });
        } else {
          // Invariant 1: Always close unconsumed frames
          frame.close();
        }
      },
      error: (e: DOMException) => {
        this.totalDropped++;
        console.error('[HardwareVideoDecoder Error]:', e);
        if (this.onErrorCallback) {
          this.onErrorCallback(e);
        }
      },
    });

    this.decoder.configure({
      ...config,
      hardwareAcceleration: config.hardwareAcceleration ?? 'prefer-hardware',
    });

    this.isConfigured = true;
    return true;
  }

  public decodeChunk(chunk: EncodedVideoChunk): void {
    if (!this.decoder || !this.isConfigured) {
      throw new Error('Decoder must be configured before decoding chunks.');
    }
    try {
      this.decoder.decode(chunk);
    } catch (err: any) {
      this.totalDropped++;
      if (this.onErrorCallback) {
        this.onErrorCallback(err);
      }
    }
  }

  public async flush(): Promise<void> {
    if (this.decoder && this.decoder.state === 'configured') {
      await this.decoder.flush();
    }
  }

  public reset(): void {
    if (this.decoder && this.decoder.state !== 'closed') {
      this.decoder.reset();
    }
  }

  public close(): void {
    if (this.decoder && this.decoder.state !== 'closed') {
      this.decoder.close();
      this.decoder = null;
      this.isConfigured = false;
    }
  }

  public getQueueSize(): number {
    return this.decoder ? this.decoder.decodeQueueSize : 0;
  }

  public getStats() {
    return {
      decoded: this.totalDecoded,
      dropped: this.totalDropped,
      isConfigured: this.isConfigured,
      codec: this.currentConfig?.codec,
    };
  }

  private triggerFallback(reason: string, config: VideoDecoderConfig) {
    if (this.onFallbackCallback) {
      this.onFallbackCallback(reason, config);
    }
  }
}
