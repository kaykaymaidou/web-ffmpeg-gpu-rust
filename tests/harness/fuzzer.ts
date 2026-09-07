/**
 * Synthetic Bitstream Fuzzer & Stress Media Generator
 * Generates pathological, corrupt, out-of-order, and extreme test streams.
 */

export interface FuzzedPacket {
  pts: number;
  dts: number;
  data: Uint8Array;
  isKey: boolean;
}

export class BitstreamFuzzer {
  /**
   * Generates a stream with deep B-pyramid where PTS is drastically out-of-order
   * compared to monotonic DTS.
   */
  public static generateDeepBPyramid(frameCount: number = 30): FuzzedPacket[] {
    const packets: FuzzedPacket[] = [];
    const ptsOrder = [0, 80, 40, 20, 60, 10, 30, 50, 70]; // Non-monotonic PTS offsets

    for (let i = 0; i < frameCount; i++) {
      const dts = i * 33333; // 30fps baseline DTS
      const ptsOffset = ptsOrder[i % ptsOrder.length] * 1000;
      const pts = dts + ptsOffset;
      const isKey = i === 0 || i % 15 === 0;

      // H.264 NAL structure: 4-byte length + NAL header + payload
      const nalType = isKey ? 0x65 : 0x41;
      const data = new Uint8Array(64);
      const view = new DataView(data.buffer);
      view.setUint32(0, 60);
      data[4] = nalType;
      // Fill random payload
      for (let j = 5; j < 64; j++) {
        data[j] = (i * 17 + j * 31) & 0xff;
      }

      packets.push({ pts, dts, data, isKey });
    }

    return packets;
  }

  /**
   * Generates severely corrupted NAL units (missing start codes, truncated bytes, random garbage).
   */
  public static generateCorruptedNalStream(count: number = 20): Uint8Array[] {
    const stream: Uint8Array[] = [];

    for (let i = 0; i < count; i++) {
      const corruptType = i % 4;
      let chunk: Uint8Array;

      switch (corruptType) {
        case 0:
          // Truncated NAL length header (only 2 bytes instead of 4)
          chunk = new Uint8Array([0x00, 0x00, 0x65, 0x01, 0x02]);
          break;
        case 1:
          // Completely random garbage noise
          chunk = new Uint8Array(32);
          for (let k = 0; k < 32; k++) chunk[k] = (k * 97 + i * 13) & 0xff;
          break;
        case 2:
          // Declared length is 1000 bytes, but buffer only has 10 bytes (Buffer underflow attack)
          chunk = new Uint8Array(10);
          new DataView(chunk.buffer).setUint32(0, 1000);
          chunk[4] = 0x65;
          break;
        case 3:
        default:
          // Missing IDR header at start of stream
          chunk = new Uint8Array([0x00, 0x00, 0x00, 0x08, 0x41, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
          break;
      }

      stream.push(chunk);
    }

    return stream;
  }

  /**
   * Generates extreme variable framerate (VFR) timestamps (from 1ms to 500ms jitter).
   */
  public static generateExtremeVfrTimestamps(count: number = 50): number[] {
    const timestamps: number[] = [0];
    let currentUs = 0;

    for (let i = 1; i < count; i++) {
      // Jitter alternates between 1,000us (1000fps) and 500,000us (2fps)
      const step = i % 2 === 0 ? 1000 : 500000;
      currentUs += step;
      timestamps.push(currentUs);
    }

    return timestamps;
  }

  /**
   * Generates an invalid SPS header with out-of-bounds dimensions (e.g. 16384x16384).
   */
  public static generateMalformedSps(): Uint8Array {
    // Synthetic SPS bytes with malformed Exp-Golomb codes
    return new Uint8Array([
      0x67, // NAL Type 7 (SPS)
      0xff, // Invalid Profile 255
      0x00,
      0xff, // Invalid Level 255
      0xff, 0xff, 0xff, 0xff, 0xff, // Malformed Exp-Golomb bitstream
    ]);
  }
}
