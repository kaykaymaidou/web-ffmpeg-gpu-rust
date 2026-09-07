import { HardwareVideoEncoder } from '../encoder/hardware-encoder';

export interface IngestOptions {
  width?: number;
  height?: number;
  bitrate?: number;
  framerate?: number;
  keyframeIntervalMs?: number;
  onChunk?: (chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) => void;
  onError?: (err: Error) => void;
}

export interface IngestTelemetry {
  encodedFrames: number;
  currentFps: number;
  averageBitrateBps: number;
  droppedFrames: number;
}

/**
 * Low-Latency Live Ingest Pipeline (RFC 0002).
 * Captures frames from MediaStreamTrack via MediaStreamTrackProcessor without CPU readback,
 * encodes with hardware-accelerated WebCodecs VideoEncoder (latencyMode: 'realtime').
 */
export class LiveStreamIngestPipeline {
  private encoder: HardwareVideoEncoder | null = null;
  private isRunning: boolean = false;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private abortController: AbortController | null = null;

  private totalBytesEncoded: number = 0;
  private encodedFrames: number = 0;
  private droppedFrames: number = 0;
  private startTime: number = 0;
  private lastReportTime: number = 0;
  private framesSinceLastReport: number = 0;
  private currentFps: number = 0;

  /**
   * Start the live ingest capture and encoding loop.
   */
  public async start(
    track: MediaStreamTrack,
    options: IngestOptions = {}
  ): Promise<void> {
    if (this.isRunning) {
      throw new Error('LiveStreamIngestPipeline is already running.');
    }

    const targetWidth = options.width || 1280;
    const targetHeight = options.height || 720;
    const targetBitrate = options.bitrate || 2_500_000;
    const framerate = options.framerate || 30;
    const keyframeIntervalMs = options.keyframeIntervalMs || 2000;

    this.encoder = new HardwareVideoEncoder((chunk, metadata) => {
      this.encodedFrames++;
      this.framesSinceLastReport++;
      this.totalBytesEncoded += chunk.byteLength;

      const now = performance.now();
      if (now - this.lastReportTime >= 1000) {
        this.currentFps = Math.round((this.framesSinceLastReport * 1000) / (now - this.lastReportTime));
        this.lastReportTime = now;
        this.framesSinceLastReport = 0;
      }

      if (options.onChunk) {
        options.onChunk(chunk, metadata);
      }
    });

    await this.encoder.configure({
      codec: 'avc1.42001f',
      width: targetWidth,
      height: targetHeight,
      bitrate: targetBitrate,
      framerate,
      latencyMode: 'realtime',
    });

    this.isRunning = true;
    this.startTime = performance.now();
    this.lastReportTime = this.startTime;
    this.abortController = new AbortController();

    // Ingest loop using MediaStreamTrackProcessor
    if (typeof (window as any).MediaStreamTrackProcessor !== 'undefined') {
      const processor = new (window as any).MediaStreamTrackProcessor({ track });
      this.reader = processor.readable.getReader();

      let lastKeyframeTime = -keyframeIntervalMs;

      const processLoop = async () => {
        while (this.isRunning && this.reader) {
          try {
            const { value: frame, done } = await this.reader.read();
            if (done || !frame) break;

            const now = performance.now();
            const shouldKeyframe = now - lastKeyframeTime >= keyframeIntervalMs;

            // Backpressure check: if encoder queue is surging (> 4 in live mode), drop frame to maintain latency
            if (this.encoder && this.encoder.encodeQueueSize >= 4) {
              this.droppedFrames++;
              frame.close();
              continue;
            }

            try {
              if (this.encoder) {
                this.encoder.encode(frame, { keyFrame: shouldKeyframe });
                if (shouldKeyframe) {
                  lastKeyframeTime = now;
                }
              }
            } finally {
              // Strict RAII closure
              frame.close();
            }
          } catch (err: any) {
            if (this.isRunning && options.onError) {
              options.onError(err);
            }
            break;
          }
        }
      };

      processLoop();
    } else {
      console.warn('[LiveIngest] MediaStreamTrackProcessor is unavailable in this environment.');
    }
  }

  /**
   * Stop the live ingest pipeline and flush encoder.
   */
  public async stop(): Promise<void> {
    this.isRunning = false;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch {}
      this.reader = null;
    }

    if (this.encoder) {
      try {
        await this.encoder.flush();
      } catch {}
      this.encoder.close();
      this.encoder = null;
    }
  }

  /**
   * Current live telemetry metrics.
   */
  public getTelemetry(): IngestTelemetry {
    const elapsedSec = (performance.now() - this.startTime) / 1000;
    const averageBitrateBps = elapsedSec > 0 ? Math.round((this.totalBytesEncoded * 8) / elapsedSec) : 0;

    return {
      encodedFrames: this.encodedFrames,
      currentFps: this.currentFps,
      averageBitrateBps,
      droppedFrames: this.droppedFrames,
    };
  }

  public get active(): boolean {
    return this.isRunning;
  }
}
