/**
 * WebRTC / WebSocket RTP Live Stream Demuxer (RFC 3550, RFC 6184, RFC 7798).
 * 
 * Provides:
 * - RFC 3550 RTP 12-byte header parsing with extension and padding handling.
 * - Sequence unroller for 16-bit to 64-bit continuous sequence numbers (FAIL-10).
 * - 90kHz timestamp conversion to microseconds.
 * - H.264 RFC 6184: Single NAL (1-23), STAP-A aggregation (24), FU-A fragmentation (28).
 * - H.265 RFC 7798: Single NAL (0-47), AP aggregation (48), FU fragmentation (49).
 * - FAIL-09 Self-Healing: Discards partial frames when FU fragments are lost, preventing WebCodecs crash.
 */

export interface ParsedRtpHeader {
  version: number;
  padding: boolean;
  extension: boolean;
  csrcCount: number;
  marker: boolean;
  payloadType: number;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  headerLen: number;
}

export interface AssembledRtpFrame {
  nals: Uint8Array[];
  ptsUs: number;
  isKeyframe: boolean;
  ssrc: number;
  marker: boolean;
}

export interface RtpDemuxerStats {
  packetsReceived: number;
  packetsDropped: number;
  framesAssembled: number;
  fragmentLossEvents: number;
}

export class RtpStreamDemuxer {
  private isHevc: boolean;
  private currentNals: Uint8Array[] = [];
  private fuBuffer: number[] = [];
  private fuExpectedSeq: number = 0;
  private fuInProgress: boolean = false;
  private fuHasGap: boolean = false;
  private currentFrameTimestamp: number = -1;
  private cachedSps: Uint8Array | null = null;
  private cachedPps: Uint8Array | null = null;

  // RFC 3550 Appendix A.1 Sequence Unroller
  private maxSeq: number = 0;
  private seqCycles: number = 0;
  private seqInitialized: boolean = false;

  // Timestamp Unroller (90kHz -> microseconds)
  private maxTs: number = 0;
  private tsCycles: number = 0;
  private tsInitialized: boolean = false;
  private clockRate: number = 90000;

  // Metrics
  private stats: RtpDemuxerStats = {
    packetsReceived: 0,
    packetsDropped: 0,
    framesAssembled: 0,
    fragmentLossEvents: 0,
  };

  constructor(options?: { isHevc?: boolean; clockRate?: number }) {
    this.isHevc = options?.isHevc ?? false;
    this.clockRate = options?.clockRate ?? 90000;
  }

  public getStats(): RtpDemuxerStats {
    return { ...this.stats };
  }

  /**
   * Build AVCDecoderConfigurationRecord (ISO/IEC 14496-15) from cached SPS and PPS.
   */
  public getAvcDescription(): Uint8Array | null {
    if (!this.cachedSps || !this.cachedPps) return null;
    const sps = this.cachedSps;
    const pps = this.cachedPps;
    const desc = new Uint8Array(11 + sps.length + pps.length);
    desc[0] = 1; // configurationVersion
    desc[1] = sps[1]; // profile
    desc[2] = sps[2]; // profile_compatibility
    desc[3] = sps[3]; // level
    desc[4] = 0xff; // 4-byte length prefix (lengthSizeMinusOne = 3)
    desc[5] = 0xe1; // numOfSequenceParameterSets = 1
    desc[6] = (sps.length >> 8) & 0xff;
    desc[7] = sps.length & 0xff;
    desc.set(sps, 8);
    const ppsOffset = 8 + sps.length;
    desc[ppsOffset] = 1; // numOfPictureParameterSets = 1
    desc[ppsOffset + 1] = (pps.length >> 8) & 0xff;
    desc[ppsOffset + 2] = pps.length & 0xff;
    desc.set(pps, ppsOffset + 3);
    return desc;
  }

  public getCachedParameterSets(): { sps: Uint8Array | null; pps: Uint8Array | null } {
    return { sps: this.cachedSps, pps: this.cachedPps };
  }

  /**
   * Parse RFC 3550 RTP packet header.
   */
  public static parseHeader(data: Uint8Array): { header: ParsedRtpHeader; payload: Uint8Array } {
    if (data.length < 12) {
      throw new Error('RTP packet too small (< 12 bytes)');
    }

    const b0 = data[0];
    const version = (b0 >> 6) & 0x03;
    if (version !== 2) {
      throw new Error(`Unsupported RTP version: ${version} (expected 2)`);
    }

    const padding = ((b0 >> 5) & 0x01) === 1;
    const extension = ((b0 >> 4) & 0x01) === 1;
    const csrcCount = b0 & 0x0f;

    const b1 = data[1];
    const marker = ((b1 >> 7) & 0x01) === 1;
    const payloadType = b1 & 0x7f;

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const sequenceNumber = view.getUint16(2, false);
    const timestamp = view.getUint32(4, false);
    const ssrc = view.getUint32(8, false);

    let headerLen = 12 + csrcCount * 4;
    if (data.length < headerLen) {
      throw new Error('RTP packet truncated within CSRC list');
    }

    if (extension) {
      if (data.length < headerLen + 4) {
        throw new Error('RTP packet truncated within extension header');
      }
      const extWords = view.getUint16(headerLen + 2, false);
      headerLen += 4 + extWords * 4;
      if (data.length < headerLen) {
        throw new Error('RTP packet truncated within extension body');
      }
    }

    let payloadLen = data.length - headerLen;
    if (padding) {
      if (payloadLen === 0) {
        throw new Error('RTP packet has padding flag but empty payload');
      }
      const padLen = data[data.length - 1];
      if (padLen > payloadLen) {
        throw new Error('Invalid RTP padding length exceeds payload');
      }
      payloadLen -= padLen;
    }

    const payload = data.subarray(headerLen, headerLen + payloadLen);

    return {
      header: {
        version,
        padding,
        extension,
        csrcCount,
        marker,
        payloadType,
        sequenceNumber,
        timestamp,
        ssrc,
        headerLen,
      },
      payload,
    };
  }

  /**
   * Unroll 16-bit sequence number to continuous monotonic 64-bit sequence (FAIL-10).
   */
  public unrollSequence(seq: number): number {
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
        this.seqCycles += 1; // 65535 -> 0 wrap-around
      }
      this.maxSeq = seq;
    }

    return this.seqCycles * 65536 + seq;
  }

  /**
   * Convert RTP 32-bit timestamp to absolute microseconds.
   */
  public toPtsUs(ts: number): number {
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
    return Math.floor((unrolled * 1000000) / this.clockRate);
  }

  /**
   * Push a raw RTP packet into the demuxer.
   * If a frame is completed (Marker bit M=1), returns AssembledRtpFrame.
   */
  public pushPacket(data: Uint8Array): AssembledRtpFrame | null {
    this.stats.packetsReceived += 1;
    const { header, payload } = RtpStreamDemuxer.parseHeader(data);
    this.unrollSequence(header.sequenceNumber);
    const ptsUs = this.toPtsUs(header.timestamp);

    // Frame boundary isolation: if timestamp jumps, any previous uncompleted frame was severed by packet loss
    if (this.currentFrameTimestamp !== -1 && header.timestamp !== this.currentFrameTimestamp) {
      if (this.currentNals.length > 0) {
        this.stats.packetsDropped += this.currentNals.length;
        this.stats.fragmentLossEvents += 1;
        this.currentNals = [];
      }
      this.fuBuffer = [];
      this.fuInProgress = false;
      this.fuHasGap = false;
    }
    this.currentFrameTimestamp = header.timestamp;

    if (payload.length === 0) {
      return null;
    }

    if (!this.isHevc) {
      this.processH264Payload(header.sequenceNumber, payload);
    } else {
      this.processH265Payload(header.sequenceNumber, payload);
    }

    if (header.marker && this.currentNals.length > 0) {
      const nals = this.currentNals;
      this.currentNals = [];

      // Check if there is any VCL slice in this frame
      const hasVcl = !this.isHevc
        ? nals.some(nal => {
            if (nal.length < 1) return false;
            const t = nal[0] & 0x1f;
            return t >= 1 && t <= 5;
          })
        : nals.some(nal => {
            if (nal.length < 2) return false;
            const t = (nal[0] >> 1) & 0x3f;
            return t <= 31;
          });

      if (!hasVcl) {
        // Non-VCL only (e.g. standalone parameter sets) cannot be decoded as an individual frame
        return null;
      }

      // Check if it's an IDR keyframe
      const isKeyframe = !this.isHevc
        ? nals.some(nal => nal.length > 0 && (nal[0] & 0x1f) === 5)
        : nals.some(nal => {
            if (nal.length < 2) return false;
            const t = (nal[0] >> 1) & 0x3f;
            return t >= 19 && t <= 21;
          });

      // If keyframe and missing parameter sets, inject cached SPS/PPS
      if (!this.isHevc && isKeyframe) {
        const hasSps = nals.some(nal => nal.length > 0 && (nal[0] & 0x1f) === 7);
        const hasPps = nals.some(nal => nal.length > 0 && (nal[0] & 0x1f) === 8);
        if (!hasSps && this.cachedSps) {
          nals.unshift(this.cachedSps);
        }
        if (!hasPps && this.cachedPps) {
          const spsIdx = nals.findIndex(nal => nal.length > 0 && (nal[0] & 0x1f) === 7);
          if (spsIdx >= 0) {
            nals.splice(spsIdx + 1, 0, this.cachedPps);
          } else {
            nals.unshift(this.cachedPps);
          }
        }
      }

      const frame: AssembledRtpFrame = {
        nals,
        ptsUs,
        isKeyframe,
        ssrc: header.ssrc,
        marker: true,
      };
      this.stats.framesAssembled += 1;
      return frame;
    }

    return null;
  }

  private processH264Payload(seq: number, payload: Uint8Array): void {
    const nalHeader = payload[0];
    const nalType = nalHeader & 0x1f;

    switch (nalType) {
      case 1:
      case 2:
      case 3:
      case 4:
      case 5:
      case 6:
      case 7:
      case 8:
      case 9:
      case 10:
      case 11:
      case 12: {
        // Single NAL unit packet
        if (nalType === 7) {
          this.cachedSps = new Uint8Array(payload);
        } else if (nalType === 8) {
          this.cachedPps = new Uint8Array(payload);
        }
        this.currentNals.push(new Uint8Array(payload));
        break;
      }

      case 24: {
        // STAP-A aggregation
        let offset = 1;
        const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        while (offset + 2 <= payload.length) {
          const naluSize = view.getUint16(offset, false);
          offset += 2;
          if (offset + naluSize > payload.length) {
            break;
          }
          const nalu = payload.subarray(offset, offset + naluSize);
          if (nalu.length > 0) {
            const innerType = nalu[0] & 0x1f;
            if (innerType === 7) {
              this.cachedSps = new Uint8Array(nalu);
            } else if (innerType === 8) {
              this.cachedPps = new Uint8Array(nalu);
            }
            this.currentNals.push(new Uint8Array(nalu));
          }
          offset += naluSize;
        }
        break;
      }

      case 28: {
        // FU-A fragmentation
        if (payload.length < 2) return;
        const fuIndicator = payload[0];
        const fuHeader = payload[1];
        const startBit = (fuHeader & 0x80) !== 0;
        const endBit = (fuHeader & 0x40) !== 0;
        const originalType = fuHeader & 0x1f;

        if (startBit) {
          const reconstructedHeader = (fuIndicator & 0xe0) | originalType;
          this.fuBuffer = [reconstructedHeader];
          for (let i = 2; i < payload.length; i++) {
            this.fuBuffer.push(payload[i]);
          }
          this.fuExpectedSeq = (seq + 1) & 0xffff;
          this.fuInProgress = true;
          this.fuHasGap = false;
        } else if (this.fuInProgress) {
          // FAIL-09 Defense: detect fragment gap
          if (seq !== this.fuExpectedSeq) {
            this.fuHasGap = true;
            this.fuInProgress = false;
            this.fuBuffer = [];
            this.stats.packetsDropped += 1;
            this.stats.fragmentLossEvents += 1;
          } else if (!this.fuHasGap) {
            for (let i = 2; i < payload.length; i++) {
              this.fuBuffer.push(payload[i]);
            }
            this.fuExpectedSeq = (seq + 1) & 0xffff;

            if (endBit) {
              this.currentNals.push(new Uint8Array(this.fuBuffer));
              this.fuInProgress = false;
              this.fuBuffer = [];
            }
          }
        } else {
          this.stats.packetsDropped += 1;
        }
        break;
      }
    }
  }

  private processH265Payload(seq: number, payload: Uint8Array): void {
    if (payload.length < 2) return;
    const nalType = (payload[0] >> 1) & 0x3f;

    if (nalType <= 47) {
      // Single NAL
      this.currentNals.push(new Uint8Array(payload));
    } else if (nalType === 48) {
      // AP
      let offset = 2;
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      while (offset + 2 <= payload.length) {
        const naluSize = view.getUint16(offset, false);
        offset += 2;
        if (offset + naluSize > payload.length) break;
        const nalu = payload.subarray(offset, offset + naluSize);
        if (nalu.length >= 2) {
          this.currentNals.push(new Uint8Array(nalu));
        }
        offset += naluSize;
      }
    } else if (nalType === 49) {
      // FU
      if (payload.length < 3) return;
      const fuHeader = payload[2];
      const startBit = (fuHeader & 0x80) !== 0;
      const endBit = (fuHeader & 0x40) !== 0;
      const originalType = fuHeader & 0x3f;

      if (startBit) {
        const byte0 = (payload[0] & 0x81) | (originalType << 1);
        const byte1 = payload[1];
        this.fuBuffer = [byte0, byte1];
        for (let i = 3; i < payload.length; i++) {
          this.fuBuffer.push(payload[i]);
        }
        this.fuExpectedSeq = (seq + 1) & 0xffff;
        this.fuInProgress = true;
        this.fuHasGap = false;
      } else if (this.fuInProgress) {
        if (seq !== this.fuExpectedSeq) {
          this.fuHasGap = true;
          this.fuInProgress = false;
          this.fuBuffer = [];
          this.stats.packetsDropped += 1;
          this.stats.fragmentLossEvents += 1;
        } else if (!this.fuHasGap) {
          for (let i = 3; i < payload.length; i++) {
            this.fuBuffer.push(payload[i]);
          }
          this.fuExpectedSeq = (seq + 1) & 0xffff;

          if (endBit) {
            this.currentNals.push(new Uint8Array(this.fuBuffer));
            this.fuInProgress = false;
            this.fuBuffer = [];
          }
        }
      } else {
        this.stats.packetsDropped += 1;
      }
    }
  }

  /**
   * Helper to convert assembled NALs into Annex-B format (0x00000001).
   */
  public static toAnnexB(frame: AssembledRtpFrame): Uint8Array {
    let totalLen = 0;
    for (const nal of frame.nals) {
      totalLen += 4 + nal.length;
    }
    const out = new Uint8Array(totalLen);
    let offset = 0;
    for (const nal of frame.nals) {
      out[offset] = 0;
      out[offset + 1] = 0;
      out[offset + 2] = 0;
      out[offset + 3] = 1;
      out.set(nal, offset + 4);
      offset += 4 + nal.length;
    }
    return out;
  }
}
