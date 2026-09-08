/**
 * Hardware Audio Encoder based on W3C WebCodecs AudioEncoder API.
 * Encodes raw AudioData (PCM) into compressed Opus frames (RFC 7587).
 */

export interface AudioEncoderOptions {
  codec?: string; // default: 'opus'
  sampleRate?: number; // default: 48000
  numberOfChannels?: number; // default: 2
  bitrate?: number; // default: 64000
}

export type AudioChunkCallback = (
  chunk: EncodedAudioChunk,
  metadata?: EncodedAudioChunkMetadata
) => void;

export class HardwareAudioEncoder {
  private encoder: AudioEncoder | null = null;
  private isConfigured: boolean = false;
  private onChunkCallback: AudioChunkCallback;
  private onErrorCallback?: (err: DOMException) => void;

  constructor(
    onChunk: AudioChunkCallback,
    onError?: (err: DOMException) => void
  ) {
    this.onChunkCallback = onChunk;
    this.onErrorCallback = onError;
  }

  public static async isSupported(config: AudioEncoderConfig): Promise<boolean> {
    if (typeof AudioEncoder === 'undefined') {
      return false;
    }
    try {
      const support = await AudioEncoder.isConfigSupported(config);
      return !!support.supported;
    } catch {
      return false;
    }
  }

  public async configure(options: AudioEncoderOptions = {}): Promise<boolean> {
    if (typeof AudioEncoder === 'undefined') {
      throw new Error('WebCodecs AudioEncoder is not supported in this environment.');
    }

    const config: AudioEncoderConfig = {
      codec: options.codec || 'opus',
      sampleRate: options.sampleRate || 48000,
      numberOfChannels: options.numberOfChannels || 2,
      bitrate: options.bitrate || 64000,
    };

    const supported = await HardwareAudioEncoder.isSupported(config);
    if (!supported) {
      console.warn(`[HardwareAudioEncoder] Config not reported as supported:`, config);
    }

    if (this.encoder) {
      this.encoder.close();
    }

    this.encoder = new AudioEncoder({
      output: (chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) => {
        this.onChunkCallback(chunk, metadata);
      },
      error: (e: DOMException) => {
        console.error('🚨 [HardwareAudioEncoder Error]:', e);
        if (this.onErrorCallback) {
          this.onErrorCallback(e);
        }
      },
    });

    this.encoder.configure(config);
    this.isConfigured = true;
    return true;
  }

  public encode(data: AudioData): void {
    if (!this.encoder || !this.isConfigured) {
      throw new Error('HardwareAudioEncoder must be configured before calling encode().');
    }
    this.encoder.encode(data);
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
      } catch {
        // ignore
      }
      this.encoder = null;
      this.isConfigured = false;
    }
  }
}
