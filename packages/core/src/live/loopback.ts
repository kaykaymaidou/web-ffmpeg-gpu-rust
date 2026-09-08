import { HardwareVideoEncoder } from '../encoder/hardware-encoder';
import { HardwareVideoDecoder } from '../decoder/hardware-decoder';
import { RtpStreamDemuxer, type AssembledRtpFrame } from './rtp-demuxer';

export interface LoopbackOptions {
  width?: number;
  height?: number;
  framerate?: number;
  bitrate?: number;
  packetLossRate?: number; // 0.0 - 0.5 (e.g. 0.15 = 15% packet loss)
  jitterMs?: number;       // 0 - 200ms
  renderCanvas?: HTMLCanvasElement;
  onMetrics?: (metrics: LoopbackMetrics) => void;
  onError?: (err: Error) => void;
}

export interface LoopbackMetrics {
  ingestFps: number;
  playoutFps: number;
  bitrateKbps: number;
  rtpPacketsSent: number;
  rtpPacketsReceived: number;
  rtpPacketsDropped: number;
  fail09Rescues: number;
  keyframeRequests: number;
  glassToGlassLatencyMs: number;
  isRunning: boolean;
}

/**
 * WebRTC / RTC Real-time P2P Live Loopback Session with Weak Network Emulation
 * and FAIL-09 / PLI Self-Healing Autopilot.
 */
export class LiveLoopbackSession {
  private options: LoopbackOptions;
  private isRunning: boolean = false;

  private encoder: HardwareVideoEncoder | null = null;
  private decoder: HardwareVideoDecoder | null = null;
  private demuxer: RtpStreamDemuxer | null = null;

  private captureCanvas: HTMLCanvasElement | null = null;
  private captureCtx: CanvasRenderingContext2D | null = null;
  private animTimerId: any = null;

  // Network Impairment Settings
  public packetLossRate: number = 0.0;
  public jitterMs: number = 0.0;

  // RTP Packetizer State
  private rtpSeq: number = 1;
  private rtpSsrc: number = 0x12345678;
  private mtu: number = 1400;

  // Telemetry & Latency Tracking
  private frameCaptureTimes: Map<number, number> = new Map(); // ptsUs -> captureTimeMs
  private metrics: LoopbackMetrics = {
    ingestFps: 0,
    playoutFps: 0,
    bitrateKbps: 0,
    rtpPacketsSent: 0,
    rtpPacketsReceived: 0,
    rtpPacketsDropped: 0,
    fail09Rescues: 0,
    keyframeRequests: 0,
    glassToGlassLatencyMs: 0,
    isRunning: false,
  };

  private encodedBytesWindow: number = 0;
  private lastStatsTime: number = 0;
  private encodedFramesCount: number = 0;
  private decodedFramesCount: number = 0;
  private forceNextKeyframe: boolean = true;
  private hasReceivedFirstKeyframe: boolean = false;
  private waitingForPliRecoveryKeyframe: boolean = false;
  private cachedEncoderDescription: Uint8Array | null = null;
  private decoderConfiguredWithDescription: boolean = false;

  constructor(options: LoopbackOptions = {}) {
    this.options = options;
    this.packetLossRate = options.packetLossRate ?? 0.0;
    this.jitterMs = options.jitterMs ?? 0.0;
  }

  public getMetrics(): LoopbackMetrics {
    return { ...this.metrics };
  }

  public setImpairments(impairments: { packetLossRate?: number; jitterMs?: number }): void {
    if (impairments.packetLossRate !== undefined) {
      this.packetLossRate = Math.max(0, Math.min(0.5, impairments.packetLossRate));
    }
    if (impairments.jitterMs !== undefined) {
      this.jitterMs = Math.max(0, Math.min(500, impairments.jitterMs));
    }
  }

  /**
   * Start the end-to-end capture, encode, packetize, impairment, depacketize, decode, and render pipeline.
   */
  public async start(mediaTrack?: MediaStreamTrack): Promise<void> {
    if (this.isRunning) {
      throw new Error('LiveLoopbackSession is already running');
    }

    const width = this.options.width || 640;
    const height = this.options.height || 360;
    const framerate = this.options.framerate || 30;
    const bitrate = this.options.bitrate || 1_500_000;

    this.isRunning = true;
    this.metrics.isRunning = true;
    this.lastStatsTime = performance.now();
    this.forceNextKeyframe = true;

    // 1. Initialize RTP Depacketizer with FAIL-09 defense
    this.demuxer = new RtpStreamDemuxer({ isHevc: false, clockRate: 90000 });

    // 2. Initialize Hardware Decoder
    this.decoder = new HardwareVideoDecoder((frame, _meta) => {
      this.decodedFramesCount++;

      // Compute Glass-to-Glass Latency
      const captureTime = this.frameCaptureTimes.get(frame.timestamp);
      if (captureTime) {
        this.metrics.glassToGlassLatencyMs = Math.round(performance.now() - captureTime);
        this.frameCaptureTimes.delete(frame.timestamp);
      }

      // Render to target canvas
      if (this.options.renderCanvas) {
        const renderCtx = this.options.renderCanvas.getContext('2d');
        if (renderCtx) {
          renderCtx.drawImage(frame, 0, 0, this.options.renderCanvas.width, this.options.renderCanvas.height);
        }
      }

      // Zero VRAM Leak Invariant: synchronously close decoded frame
      frame.close();
    }, (err) => {
      this.options.onError?.(err);
    });

    await this.decoder.configure({
      codec: 'avc1.42001f',
      hardwareAcceleration: 'prefer-hardware',
    });

    // 3. Initialize Hardware Encoder
    this.encoder = new HardwareVideoEncoder((chunk, metadata) => {
      this.encodedFramesCount++;
      this.encodedBytesWindow += chunk.byteLength;

      // Ingest extradata / parameter sets if present
      if (metadata?.decoderConfig?.description) {
        const desc = new Uint8Array(metadata.decoderConfig.description as ArrayBuffer);
        this.cachedEncoderDescription = desc;
        this.extractAndSendSpsPps(desc, chunk.timestamp);
      } else if (chunk.type === 'key' && this.cachedEncoderDescription) {
        // Resend parameter sets with every keyframe to ensure weak network recovery
        this.extractAndSendSpsPps(this.cachedEncoderDescription, chunk.timestamp);
      }

      // Extract NALUs from chunk and packetize into RTP
      const chunkBytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(chunkBytes);
      this.packetizeAndTransmitChunk(chunkBytes, chunk.timestamp);
    }, (err) => {
      this.options.onError?.(err);
    });

    await this.encoder.configure({
      codec: 'avc1.42001f',
      width,
      height,
      bitrate,
      framerate,
      latencyMode: 'realtime',
    });

    // 4. Start Video Source (Camera Track or Synthetic Generator)
    if (mediaTrack && typeof (window as any).MediaStreamTrackProcessor !== 'undefined') {
      this.startTrackProcessor(mediaTrack);
    } else {
      this.startSyntheticSource(width, height, framerate);
    }

    // 5. Start Telemetry Periodic Loop
    this.startTelemetryLoop();
  }

  /**
   * Stop session and release all encoders, decoders, and canvas resources.
   */
  public stop(): void {
    this.isRunning = false;
    this.metrics.isRunning = false;

    if (this.animTimerId) {
      clearInterval(this.animTimerId);
      this.animTimerId = null;
    }

    this.frameCaptureTimes.clear();

    if (this.encoder) {
      this.encoder.close();
      this.encoder = null;
    }
    if (this.decoder) {
      this.decoder.close();
      this.decoder = null;
    }
    this.demuxer = null;
    this.captureCanvas = null;
    this.captureCtx = null;
    this.cachedEncoderDescription = null;
    this.decoderConfiguredWithDescription = false;
    this.hasReceivedFirstKeyframe = false;
    this.waitingForPliRecoveryKeyframe = false;
  }

  /**
   * Request an immediate IDR Keyframe from the encoder (PLI / FIR).
   */
  public requestKeyframe(): void {
    this.forceNextKeyframe = true;
    this.metrics.keyframeRequests++;
  }

  private startTrackProcessor(track: MediaStreamTrack): void {
    const processor = new (window as any).MediaStreamTrackProcessor({ track });
    const reader = processor.readable.getReader();

    const readLoop = async () => {
      while (this.isRunning) {
        const { done, value } = await reader.read();
        if (done || !value) break;

        const frame: VideoFrame = value;
        const now = performance.now();
        this.frameCaptureTimes.set(frame.timestamp, now);

        const keyFrame = this.forceNextKeyframe;
        this.forceNextKeyframe = false;

        this.encoder?.encode(frame, { keyFrame });
        frame.close(); // Zero VRAM leak
      }
    };

    readLoop().catch((err) => this.options.onError?.(err));
  }

  private startSyntheticSource(width: number, height: number, framerate: number): void {
    this.captureCanvas = document.createElement('canvas');
    this.captureCanvas.width = width;
    this.captureCanvas.height = height;
    this.captureCtx = this.captureCanvas.getContext('2d')!;

    let frameIndex = 0;
    const intervalMs = 1000 / framerate;

    this.animTimerId = setInterval(() => {
      if (!this.isRunning || !this.captureCtx || !this.captureCanvas) return;

      const now = performance.now();
      const ptsUs = Math.round(frameIndex * (1_000_000 / framerate));

      // Draw synthetic animated calibration pattern
      const ctx = this.captureCtx;
      const w = width;
      const h = height;

      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, w, h);

      // Moving scanning bar
      const barX = (frameIndex * 8) % w;
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(barX, 0, 16, h);

      // Rotating radar indicator
      const angle = (frameIndex * 0.1) % (Math.PI * 2);
      ctx.strokeStyle = '#34d399';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 60, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(w / 2, h / 2);
      ctx.lineTo(w / 2 + Math.cos(angle) * 60, h / 2 + Math.sin(angle) * 60);
      ctx.stroke();

      // Timestamp & sequence text
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 20px monospace';
      ctx.fillText(`RTC Live | Frame: ${frameIndex} | PTS: ${ptsUs} µs`, 20, 40);
      ctx.fillText(`Loss Rate: ${(this.packetLossRate * 100).toFixed(0)}% | Jitter: ${this.jitterMs}ms`, 20, 70);

      // Create VideoFrame from canvas
      const frame = new VideoFrame(this.captureCanvas, {
        timestamp: ptsUs,
      });

      this.frameCaptureTimes.set(ptsUs, now);

      const keyFrame = this.forceNextKeyframe || (frameIndex % 60 === 0);
      this.forceNextKeyframe = false;

      this.encoder?.encode(frame, { keyFrame });
      frame.close(); // Zero VRAM Leak Invariant

      frameIndex++;
    }, intervalMs);
  }

  private extractAndSendSpsPps(avcC: Uint8Array, timestampUs: number): void {
    if (avcC.length < 8) return;

    // ISO/IEC 14496-15 AVCDecoderConfigurationRecord parsing
    let offset = 5;
    const numSps = avcC[offset] & 0x1f;
    offset += 1;

    for (let i = 0; i < numSps; i++) {
      if (offset + 2 > avcC.length) break;
      const spsLen = (avcC[offset] << 8) | avcC[offset + 1];
      offset += 2;
      if (offset + spsLen > avcC.length) break;
      const sps = avcC.subarray(offset, offset + spsLen);
      offset += spsLen;
      this.transmitSingleRtpPacket(sps, timestampUs, false);
    }

    if (offset < avcC.length) {
      const numPps = avcC[offset];
      offset += 1;
      for (let i = 0; i < numPps; i++) {
        if (offset + 2 > avcC.length) break;
        const ppsLen = (avcC[offset] << 8) | avcC[offset + 1];
        offset += 2;
        if (offset + ppsLen > avcC.length) break;
        const pps = avcC.subarray(offset, offset + ppsLen);
        offset += ppsLen;
        this.transmitSingleRtpPacket(pps, timestampUs, false);
      }
    }
  }

  private packetizeAndTransmitChunk(chunkData: Uint8Array, timestampUs: number): void {
    const view = new DataView(chunkData.buffer, chunkData.byteOffset, chunkData.byteLength);
    let offset = 0;
    const nals: Uint8Array[] = [];

    // Parse 4-byte length-prefixed AVCC NALUs
    while (offset + 4 <= chunkData.byteLength) {
      const nalLen = view.getUint32(offset, false);
      offset += 4;
      if (offset + nalLen > chunkData.byteLength) break;
      nals.push(chunkData.subarray(offset, offset + nalLen));
      offset += nalLen;
    }

    for (let i = 0; i < nals.length; i++) {
      const nal = nals[i];
      const isLastNal = i === nals.length - 1;
      this.packetizeNal(nal, timestampUs, isLastNal);
    }
  }

  private packetizeNal(nal: Uint8Array, timestampUs: number, isLastNalOfFrame: boolean): void {
    if (nal.length === 0) return;

    const maxPayload = this.mtu - 12;

    if (nal.length <= maxPayload) {
      // Single NAL unit packet
      this.transmitSingleRtpPacket(nal, timestampUs, isLastNalOfFrame);
    } else {
      // FU-A fragmentation
      const nalHeader = nal[0];
      const nri = nalHeader & 0x60;
      const nalType = nalHeader & 0x1f;
      const fuIndicator = nri | 28;

      const rawData = nal.subarray(1);
      const chunkSize = maxPayload - 2;
      let off = 0;

      while (off < rawData.length) {
        const end = Math.min(off + chunkSize, rawData.length);
        const isFirst = off === 0;
        const isLast = end === rawData.length;

        let fuHeader = nalType;
        if (isFirst) fuHeader |= 0x80;
        if (isLast) fuHeader |= 0x40;

        const marker = isLast && isLastNalOfFrame;
        const packet = new Uint8Array(12 + 2 + (end - off));
        this.writeRtpHeader(packet, marker, timestampUs);
        packet[12] = fuIndicator;
        packet[13] = fuHeader;
        packet.set(rawData.subarray(off, end), 14);

        this.transmitThroughImpairmentChannel(packet);
        off = end;
      }
    }
  }

  private transmitSingleRtpPacket(nal: Uint8Array, timestampUs: number, marker: boolean): void {
    const packet = new Uint8Array(12 + nal.length);
    this.writeRtpHeader(packet, marker, timestampUs);
    packet.set(nal, 12);
    this.transmitThroughImpairmentChannel(packet);
  }

  private writeRtpHeader(out: Uint8Array, marker: boolean, timestampUs: number): void {
    const ts90k = Math.floor((timestampUs * 90) / 1000) >>> 0;

    out[0] = 0x80; // V=2, P=0, X=0, CC=0
    out[1] = (marker ? 0x80 : 0x00) | 96; // PT=96
    out[2] = (this.rtpSeq >> 8) & 0xff;
    out[3] = this.rtpSeq & 0xff;
    out[4] = (ts90k >> 24) & 0xff;
    out[5] = (ts90k >> 16) & 0xff;
    out[6] = (ts90k >> 8) & 0xff;
    out[7] = ts90k & 0xff;
    out[8] = (this.rtpSsrc >> 24) & 0xff;
    out[9] = (this.rtpSsrc >> 16) & 0xff;
    out[10] = (this.rtpSsrc >> 8) & 0xff;
    out[11] = this.rtpSsrc & 0xff;

    this.rtpSeq = (this.rtpSeq + 1) & 0xffff;
    this.metrics.rtpPacketsSent++;
  }

  /**
   * Ingest packet into simulated weak network channel with packet loss and jitter.
   */
  private transmitThroughImpairmentChannel(packet: Uint8Array): void {
    // 1. Weak Network Packet Loss Injection
    if (this.packetLossRate > 0 && Math.random() < this.packetLossRate) {
      this.metrics.rtpPacketsDropped++;
      // Packet dropped! Do not deliver to receiving demuxer
      return;
    }

    this.metrics.rtpPacketsReceived++;

    // 2. Jitter simulation
    if (this.jitterMs > 0) {
      setTimeout(() => {
        this.receiveRtpPacket(packet);
      }, this.jitterMs + (Math.random() * 10 - 5));
    } else {
      this.receiveRtpPacket(packet);
    }
  }

  /**
   * Receive RTP packet on the playout end, depacketize with FAIL-09 defense, and feed to VideoDecoder.
   */
  private receiveRtpPacket(packet: Uint8Array): void {
    if (!this.demuxer || !this.decoder) return;

    const prevFragmentLossEvents = this.demuxer.getStats().fragmentLossEvents;
    const prevPacketsDropped = this.demuxer.getStats().packetsDropped;
    const assembledFrame: AssembledRtpFrame | null = this.demuxer.pushPacket(packet);
    const newFragmentLossEvents = this.demuxer.getStats().fragmentLossEvents;
    const newPacketsDropped = this.demuxer.getStats().packetsDropped;

    // FAIL-09 Self-Healing Check: If intermediate FU-A fragments or packets were lost, request PLI keyframe!
    if (newFragmentLossEvents > prevFragmentLossEvents || newPacketsDropped > prevPacketsDropped) {
      this.metrics.fail09Rescues++;
      this.waitingForPliRecoveryKeyframe = true;
      this.requestKeyframe();
    }

    if (assembledFrame) {
      // Reconfigure decoder with AVCDecoderConfigurationRecord description as soon as SPS/PPS arrives
      if (!this.decoderConfiguredWithDescription) {
        const desc = this.demuxer.getAvcDescription();
        if (desc) {
          this.decoder.configure({
            codec: 'avc1.42001f',
            description: desc,
            hardwareAcceleration: 'prefer-hardware',
          });
          this.decoderConfiguredWithDescription = true;
        }
      }

      // FAIL-01 & FAIL-09 Defense: Never feed orphaned delta frames or keyframes without parameter sets to decoder
      if (assembledFrame.isKeyframe) {
        if (!this.decoderConfiguredWithDescription) {
          this.requestKeyframe();
          return;
        }
        this.hasReceivedFirstKeyframe = true;
        this.waitingForPliRecoveryKeyframe = false;
      } else if (!this.hasReceivedFirstKeyframe || this.waitingForPliRecoveryKeyframe) {
        return;
      }
      // Reconstructed complete frame: convert NALUs to AVCC EncodedVideoChunk and feed to decoder
      let totalSize = 0;
      for (const nal of assembledFrame.nals) {
        totalSize += 4 + nal.length;
      }

      const avccBytes = new Uint8Array(totalSize);
      let offset = 0;
      for (const nal of assembledFrame.nals) {
        avccBytes[offset] = (nal.length >> 24) & 0xff;
        avccBytes[offset + 1] = (nal.length >> 16) & 0xff;
        avccBytes[offset + 2] = (nal.length >> 8) & 0xff;
        avccBytes[offset + 3] = nal.length & 0xff;
        avccBytes.set(nal, offset + 4);
        offset += 4 + nal.length;
      }

      const chunk = new EncodedVideoChunk({
        type: assembledFrame.isKeyframe ? 'key' : 'delta',
        timestamp: assembledFrame.ptsUs,
        data: avccBytes,
      });

      this.decoder.decodeChunk(chunk);
    }
  }

  private startTelemetryLoop(): void {
    const statsTimer = setInterval(() => {
      if (!this.isRunning) {
        clearInterval(statsTimer);
        return;
      }

      const now = performance.now();
      const elapsedSec = (now - this.lastStatsTime) / 1000;

      if (elapsedSec >= 0.5) {
        this.metrics.ingestFps = Math.round(this.encodedFramesCount / elapsedSec);
        this.metrics.playoutFps = Math.round(this.decodedFramesCount / elapsedSec);
        this.metrics.bitrateKbps = Math.round((this.encodedBytesWindow * 8) / elapsedSec / 1000);

        this.encodedFramesCount = 0;
        this.decodedFramesCount = 0;
        this.encodedBytesWindow = 0;
        this.lastStatsTime = now;

        this.options.onMetrics?.(this.getMetrics());
      }
    }, 500);
  }
}
