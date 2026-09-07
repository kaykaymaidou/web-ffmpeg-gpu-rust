import { HardwareVideoDecoder } from '../decoder/hardware-decoder';

export interface StreamPacket {
  data: Uint8Array;
  timestamp: number;
  duration?: number;
  isKey?: boolean;
}

/**
 * StreamFeeder manages real-time packet ingestion (e.g. WebSocket, WebRTC, MSE push).
 * Handles:
 * 1. Annex-B vs AVCC NAL unit normalization;
 * 2. In-band SPS/PPS parameter set extraction and dynamic decoder reconfiguration;
 * 3. Flow-controlled hardware push queue with backpressure.
 */
export class StreamFeeder {
  private decoder: HardwareVideoDecoder;
  private isConfigured: boolean = false;
  private currentSps: Uint8Array | null = null;
  private currentPps: Uint8Array | null = null;
  private maxQueueSize: number = 6;

  constructor(decoder: HardwareVideoDecoder, maxQueueSize: number = 6) {
    this.decoder = decoder;
    this.maxQueueSize = maxQueueSize;
  }

  public getIsConfigured(): boolean {
    return this.isConfigured;
  }

  /**
   * Ingest a single stream packet.
   * Inspects NAL unit types for in-band SPS/PPS configuration updates.
   */
  public async push(packet: StreamPacket): Promise<boolean> {
    const nalType = this.extractNalType(packet.data);

    // H.264 SPS = 7, PPS = 8
    if (nalType === 7) {
      this.currentSps = packet.data;
      await this.tryReconfigure();
      return true;
    } else if (nalType === 8) {
      this.currentPps = packet.data;
      await this.tryReconfigure();
      return true;
    }

    // Wait if hardware decoder queue is full (Backpressure flow control)
    while (this.decoder.getQueueSize() >= this.maxQueueSize) {
      await new Promise((resolve) => setTimeout(resolve, 4));
    }

    const chunk = new EncodedVideoChunk({
      type: packet.isKey ? 'key' : 'delta',
      timestamp: packet.timestamp,
      duration: packet.duration || 33333,
      data: packet.data,
    });

    this.decoder.decodeChunk(chunk);
    return true;
  }

  /**
   * Try configuring or reconfiguring the decoder dynamically when SPS/PPS changes.
   */
  private async tryReconfigure(): Promise<boolean> {
    if (!this.currentSps) return false;

    // Parse H.264 profile, compatibility, and level from SPS
    const profile = this.currentSps[1].toString(16).padStart(2, '0');
    const compat = this.currentSps[2].toString(16).padStart(2, '0');
    const level = this.currentSps[3].toString(16).padStart(2, '0');
    const codecString = `avc1.${profile}${compat}${level}`;

    const config: VideoDecoderConfig = {
      codec: codecString,
      hardwareAcceleration: 'prefer-hardware',
      optimizeForLatency: true,
    };

    if (this.currentSps && this.currentPps) {
      // Build AVCC description record if needed
      config.description = this.buildAvcc(this.currentSps, this.currentPps);
    }

    const ok = await this.decoder.configure(config);
    this.isConfigured = ok;
    return ok;
  }

  /**
   * Helper to inspect H.264 NAL unit header (supports 3-byte and 4-byte start codes).
   */
  private extractNalType(data: Uint8Array): number {
    if (data.length < 5) return 0;
    let offset = 0;
    if (data[0] === 0 && data[1] === 0) {
      if (data[2] === 1) {
        offset = 3;
      } else if (data[2] === 0 && data[3] === 1) {
        offset = 4;
      }
    }
    return data[offset] & 0x1f;
  }

  /**
   * Construct an AVCC extradata box from raw SPS and PPS NAL units.
   */
  private buildAvcc(sps: Uint8Array, pps: Uint8Array): Uint8Array {
    const totalSize = 11 + sps.length + pps.length;
    const avcc = new Uint8Array(totalSize);
    avcc[0] = 1; // configurationVersion
    avcc[1] = sps[1]; // profile
    avcc[2] = sps[2]; // profile compatibility
    avcc[3] = sps[3]; // level
    avcc[4] = 0xff;   // 6 bits reserved + 2 bits NAL length size - 1 (3 = 4 bytes)
    avcc[5] = 0xe1;   // 3 bits reserved + 5 bits number of SPS (1)
    
    // SPS length & data
    avcc[6] = (sps.length >> 8) & 0xff;
    avcc[7] = sps.length & 0xff;
    avcc.set(sps, 8);

    let offset = 8 + sps.length;
    avcc[offset++] = 1; // number of PPS
    avcc[offset++] = (pps.length >> 8) & 0xff;
    avcc[offset++] = pps.length & 0xff;
    avcc.set(pps, offset);

    return avcc;
  }
}
