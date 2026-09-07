import type { FrameCallback } from './types';

export interface DecoderConfig {
  codec: string;
  codedWidth?: number;
  codedHeight?: number;
  description?: Uint8Array;
}

export class HardwareVideoDecoder {
  private decoder: VideoDecoder | null = null;
  private onFrameCallback: FrameCallback | null = null;
  private isConfigured: boolean = false;
  private isHardware: boolean = true;

  constructor(onFrame: FrameCallback) {
    this.onFrameCallback = onFrame;
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

  public configure(config: VideoDecoderConfig): void {
    if (typeof VideoDecoder === 'undefined') {
      throw new Error('WebCodecs VideoDecoder is not supported in this browser environment.');
    }

    if (this.decoder) {
      this.decoder.close();
    }

    this.decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        if (this.onFrameCallback) {
          this.onFrameCallback(frame, { pts: frame.timestamp });
        } else {
          // If no consumer, immediately close to prevent GPU memory leak
          frame.close();
        }
      },
      error: (e: DOMException) => {
        console.error('🚨 [WebCodecs VideoDecoder Error]:', e);
      },
    });

    this.decoder.configure({
      ...config,
      hardwareAcceleration: 'prefer-hardware',
    });

    this.isConfigured = true;
  }

  public decodeChunk(chunk: EncodedVideoChunk): void {
    if (!this.decoder || !this.isConfigured) {
      throw new Error('Decoder must be configured before decoding chunks.');
    }
    this.decoder.decode(chunk);
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
    }
  }

  public getQueueSize(): number {
    return this.decoder ? this.decoder.decodeQueueSize : 0;
  }

  public isHardwareAccelerated(): boolean {
    return this.isHardware;
  }
}
