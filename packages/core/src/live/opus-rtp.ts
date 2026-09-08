/**
 * RFC 7587 RTP Payload Format for Opus Audio.
 * 
 * Provides:
 * - OpusRtpPacketizer: Encapsulates Opus frames into RFC 3550 RTP packets at 48kHz.
 * - OpusRtpDemuxer: Parses RFC 7587 packets, unrolls 16-bit sequence numbers and 48kHz timestamps to microsecond PTS.
 */

export interface ParsedOpusRtpHeader {
  version: number;
  payloadType: number;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  headerLen: number;
}

export interface AssembledOpusPacket {
  payload: Uint8Array;
  ptsUs: number;
  seq: number;
  ssrc: number;
}

export interface OpusDemuxerStats {
  packetsReceived: number;
  packetsDropped: number;
}

/**
 * OpusRtpPacketizer:
 * Wraps Opus compressed packets into RFC 7587 RTP datagrams at 48kHz clock rate.
 */
export class OpusRtpPacketizer {
  private seq: number = 1;
  private ssrc: number = 0x87654321;
  private payloadType: number = 111;
  private clockRate: number = 48000;

  constructor(options?: { ssrc?: number; payloadType?: number; clockRate?: number }) {
    if (options?.ssrc) this.ssrc = options.ssrc;
    if (options?.payloadType) this.payloadType = options.payloadType;
    if (options?.clockRate) this.clockRate = options.clockRate;
  }

  public packetize(opusData: Uint8Array, timestampUs: number, marker: boolean = false): Uint8Array {
    const ts48k = Math.floor((timestampUs * this.clockRate) / 1_000_000) >>> 0;
    const packet = new Uint8Array(12 + opusData.length);

    packet[0] = 0x80; // V=2, P=0, X=0, CC=0
    packet[1] = (marker ? 0x80 : 0x00) | (this.payloadType & 0x7f);
    packet[2] = (this.seq >> 8) & 0xff;
    packet[3] = this.seq & 0xff;
    packet[4] = (ts48k >> 24) & 0xff;
    packet[5] = (ts48k >> 16) & 0xff;
    packet[6] = (ts48k >> 8) & 0xff;
    packet[7] = ts48k & 0xff;
    packet[8] = (this.ssrc >> 24) & 0xff;
    packet[9] = (this.ssrc >> 16) & 0xff;
    packet[10] = (this.ssrc >> 8) & 0xff;
    packet[11] = this.ssrc & 0xff;

    packet.set(opusData, 12);
    this.seq = (this.seq + 1) & 0xffff;

    return packet;
  }
}

/**
 * OpusRtpDemuxer:
 * Depacketizes RFC 7587 RTP packets and converts 48kHz timestamps into microseconds PTS.
 */
export class OpusRtpDemuxer {
  private clockRate: number = 48000;
  private maxSeq: number = 0;
  private seqCycles: number = 0;
  private seqInitialized: boolean = false;
  private expectedSeq: number = 0;

  private maxTs: number = 0;
  private tsCycles: number = 0;
  private tsInitialized: boolean = false;

  private stats: OpusDemuxerStats = {
    packetsReceived: 0,
    packetsDropped: 0,
  };

  constructor(options?: { clockRate?: number }) {
    if (options?.clockRate) this.clockRate = options.clockRate;
  }

  public getStats(): OpusDemuxerStats {
    return { ...this.stats };
  }

  public demux(data: Uint8Array): AssembledOpusPacket | null {
    return this.pushPacket(data);
  }

  public pushPacket(data: Uint8Array): AssembledOpusPacket | null {
    if (data.length < 12) {
      return null;
    }

    const b0 = data[0];
    const version = (b0 >> 6) & 0x03;
    if (version !== 2) {
      return null;
    }

    const csrcCount = b0 & 0x0f;
    const headerLen = 12 + csrcCount * 4;
    if (data.length <= headerLen) {
      return null;
    }

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const seq = view.getUint16(2, false);
    const ts = view.getUint32(4, false);
    const ssrc = view.getUint32(8, false);

    this.stats.packetsReceived++;

    // Unroll sequence
    const unrolledSeq = this.unrollSequence(seq);
    if (this.seqInitialized && this.expectedSeq !== 0) {
      if (seq !== this.expectedSeq) {
        const gap = (seq - this.expectedSeq) & 0xffff;
        if (gap < 0x8000) {
          this.stats.packetsDropped += gap;
        }
      }
    }
    this.expectedSeq = (seq + 1) & 0xffff;

    // Unroll timestamp to microsecond PTS
    const ptsUs = this.toPtsUs(ts);
    const payload = data.subarray(headerLen);

    return {
      payload: new Uint8Array(payload),
      ptsUs,
      seq: unrolledSeq,
      ssrc,
    };
  }

  private unrollSequence(seq: number): number {
    if (!this.seqInitialized) {
      this.maxSeq = seq;
      this.seqCycles = 0;
      this.seqInitialized = true;
      return seq;
    }

    const delta = (seq - this.maxSeq) & 0xffff;
    const signedDelta = delta > 0x7fff ? delta - 0x10000 : delta;

    if (signedDelta > 0) {
      if (seq < this.maxSeq) {
        this.seqCycles += 1;
      }
      this.maxSeq = seq;
    }

    return this.seqCycles * 65536 + seq;
  }

  private toPtsUs(ts: number): number {
    if (!this.tsInitialized) {
      this.maxTs = ts;
      this.tsCycles = 0;
      this.tsInitialized = true;
    } else {
      const delta = (ts - this.maxTs) >>> 0;
      const signedDelta = delta > 0x7fffffff ? delta - 0x100000000 : delta;
      if (signedDelta > 0) {
        if (ts < this.maxTs) {
          this.tsCycles += 1;
        }
        this.maxTs = ts;
      }
    }

    const unrolled = this.tsCycles * 0x100000000 + ts;
    return Math.floor((unrolled * 1_000_000) / this.clockRate);
  }
}
