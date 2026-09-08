/**
 * Hardware Audio Decoder based on W3C WebCodecs AudioDecoder API.
 * Decodes compressed Opus audio chunks into raw PCM AudioData.
 */

export interface AudioDecoderOptions {
  codec?: string; // default: 'opus'
  sampleRate?: number; // default: 48000
  numberOfChannels?: number; // default: 2
  description?: BufferSource;
}

export type AudioDataCallback = (data: AudioData) => void;

export class HardwareAudioDecoder {
  private decoder: AudioDecoder | null = null;
  private isConfigured: boolean = false;
  private onDataCallback: AudioDataCallback;
  private onErrorCallback?: (err: DOMException) => void;
  private totalDecoded: number = 0;

  constructor(
    onData: AudioDataCallback,
    onError?: (err: DOMException) => void
  ) {
    this.onDataCallback = onData;
    this.onErrorCallback = onError;
  }

  public static async isSupported(config: AudioDecoderConfig): Promise<boolean> {
    if (typeof AudioDecoder === 'undefined') {
      return false;
    }
    try {
      const support = await AudioDecoder.isConfigSupported(config);
      return !!support.supported;
    } catch {
      return false;
    }
  }

  public async configure(options: AudioDecoderOptions = {}): Promise<boolean> {
    if (typeof AudioDecoder === 'undefined') {
      throw new Error('WebCodecs AudioDecoder is not supported in this environment.');
    }

    const config: AudioDecoderConfig = {
      codec: options.codec || 'opus',
      sampleRate: options.sampleRate || 48000,
      numberOfChannels: options.numberOfChannels || 2,
    };
    if (options.description) {
      config.description = options.description;
    }

    const supported = await HardwareAudioDecoder.isSupported(config);
    if (!supported) {
      console.warn(`[HardwareAudioDecoder] Config not reported as supported:`, config);
    }

    if (this.decoder) {
      this.decoder.close();
    }

    this.decoder = new AudioDecoder({
      output: (data: AudioData) => {
        this.totalDecoded++;
        this.onDataCallback(data);
      },
      error: (e: DOMException) => {
        console.error('🚨 [HardwareAudioDecoder Error]:', e);
        if (this.onErrorCallback) {
          this.onErrorCallback(e);
        }
      },
    });

    this.decoder.configure(config);
    this.isConfigured = true;
    return true;
  }

  public decode(chunk: EncodedAudioChunk): void {
    if (!this.decoder || !this.isConfigured) {
      throw new Error('HardwareAudioDecoder must be configured before calling decode().');
    }
    this.decoder.decode(chunk);
  }

  public async flush(): Promise<void> {
    if (this.decoder && this.decoder.state === 'configured') {
      await this.decoder.flush();
    }
  }

  public close(): void {
    if (this.decoder) {
      try {
        if (this.decoder.state !== 'closed') {
          this.decoder.close();
        }
      } catch {
        // ignore
      }
      this.decoder = null;
      this.isConfigured = false;
    }
  }

  public get totalDecodedCount(): number {
    return this.totalDecoded;
  }
}
