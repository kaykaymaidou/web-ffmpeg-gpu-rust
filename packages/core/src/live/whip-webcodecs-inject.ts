/**
 * Optional WebCodecs NALU injector for WHIP.
 * Replaces RTCPeerConnection encoded frames with HardwareVideoEncoder output
 * so bitrate/GOP stay under engine control while RTP remains SFU-compatible.
 */

import { HardwareVideoEncoder } from '../encoder/hardware-encoder';

export interface WhipWebCodecsInjectorOptions {
  width: number;
  height: number;
  bitrate?: number;
  framerate?: number;
  keyframeIntervalMs?: number;
}

type EncodedSender = RTCRtpSender & {
  createEncodedStreams?: () => {
    readable: ReadableStream<RTCEncodedVideoFrame>;
    writable: WritableStream<RTCEncodedVideoFrame>;
  };
};

interface RTCEncodedVideoFrame {
  data: ArrayBuffer;
  timestamp: number;
  type?: string;
}

export class WhipWebCodecsInjector {
  private encoder: HardwareVideoEncoder | null = null;
  private queue: EncodedVideoChunk[] = [];
  private abort = false;
  private forceKeyframe = true;
  private lastKeyframeAt = -Infinity;
  private keyframeIntervalMs: number;
  public encodedFrames = 0;
  public active = false;

  constructor(private readonly options: WhipWebCodecsInjectorOptions) {
    this.keyframeIntervalMs = options.keyframeIntervalMs ?? 2000;
  }

  public async attach(sender: RTCRtpSender): Promise<boolean> {
    const encodedSender = sender as EncodedSender;
    if (typeof encodedSender.createEncodedStreams !== 'function') {
      return false;
    }

    this.encoder = new HardwareVideoEncoder((chunk) => {
      this.encodedFrames++;
      this.queue.push(chunk);
      if (this.queue.length > 6) {
        const dropped = this.queue.shift();
        void dropped;
      }
    });

    try {
      await this.encoder.configure({
        codec: 'avc1.42001f',
        width: this.options.width,
        height: this.options.height,
        bitrate: this.options.bitrate || 2_500_000,
        framerate: this.options.framerate || 30,
        latencyMode: 'realtime',
        avcFormat: 'annexb',
      });
    } catch {
      this.encoder.close();
      this.encoder = null;
      return false;
    }

    let streams: { readable: ReadableStream<RTCEncodedVideoFrame>; writable: WritableStream<RTCEncodedVideoFrame> };
    try {
      streams = encodedSender.createEncodedStreams();
    } catch {
      this.encoder.close();
      this.encoder = null;
      return false;
    }

    this.active = true;
    this.abort = false;
    void this.pump(streams);
    return true;
  }

  public acceptFrame(frame: VideoFrame): void {
    if (!this.encoder || !this.active) {
      return;
    }
    if (this.encoder.encodeQueueSize >= 4) {
      return;
    }
    const now = performance.now();
    const keyFrame = this.forceKeyframe || now - this.lastKeyframeAt >= this.keyframeIntervalMs;
    this.encoder.encode(frame, { keyFrame });
    if (keyFrame) {
      this.forceKeyframe = false;
      this.lastKeyframeAt = now;
    }
  }

  public requestKeyframe(): void {
    this.forceKeyframe = true;
  }

  public destroy(): void {
    this.abort = true;
    this.active = false;
    this.queue = [];
    this.encoder?.close();
    this.encoder = null;
  }

  private async pump(streams: {
    readable: ReadableStream<RTCEncodedVideoFrame>;
    writable: WritableStream<RTCEncodedVideoFrame>;
  }): Promise<void> {
    const reader = streams.readable.getReader();
    const writer = streams.writable.getWriter();
    try {
      while (!this.abort) {
        const { value, done } = await reader.read();
        if (done || !value) {
          break;
        }
        const replacement = this.queue.shift();
        if (replacement) {
          const copy = new Uint8Array(replacement.byteLength);
          replacement.copyTo(copy);
          value.data = copy.buffer;
        }
        await writer.write(value);
      }
    } catch {
      // Sender closed during WHIP teardown.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
      try {
        await writer.close();
      } catch {
        // ignore
      }
    }
  }
}
