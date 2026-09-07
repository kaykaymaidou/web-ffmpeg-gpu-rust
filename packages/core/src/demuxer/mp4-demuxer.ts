export interface DemuxedSample {
  type: 'key' | 'delta';
  timestamp: number; // in microseconds
  duration: number;  // in microseconds
  data: Uint8Array;
}

export interface DemuxedTrack {
  id: number;
  codec: string;
  width: number;
  height: number;
  timescale: number;
  description?: Uint8Array;
  samples: DemuxedSample[];
}

export class SimpleMp4Demuxer {
  private buffer: ArrayBuffer;
  private view: DataView;

  constructor(buffer: ArrayBuffer) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
  }

  public parse(): DemuxedTrack[] {
    const tracks: DemuxedTrack[] = [];
    let offset = 0;

    while (offset < this.view.byteLength - 8) {
      const size = this.view.getUint32(offset);
      const type = this.getString(offset + 4, 4);

      if (size === 0) break;
      const boxSize = size === 1 ? Number(this.view.getBigUint64(offset + 8)) : size;

      if (type === 'moov') {
        const moovTracks = this.parseMoov(offset + 8, offset + boxSize);
        tracks.push(...moovTracks);
      }

      offset += boxSize;
    }

    return tracks;
  }

  private parseMoov(start: number, end: number): DemuxedTrack[] {
    const tracks: DemuxedTrack[] = [];
    let offset = start;

    while (offset < end - 8) {
      const size = this.view.getUint32(offset);
      const type = this.getString(offset + 4, 4);
      if (size === 0) break;

      if (type === 'trak') {
        const track = this.parseTrak(offset + 8, offset + size);
        if (track) {
          tracks.push(track);
        }
      }
      offset += size;
    }
    return tracks;
  }

  private parseTrak(start: number, end: number): DemuxedTrack | null {
    let offset = start;
    let codec = 'avc1.640028';
    let width = 1920;
    let height = 1080;
    let timescale = 30000;
    let description: Uint8Array | undefined;
    const samples: DemuxedSample[] = [];

    while (offset < end - 8) {
      const size = this.view.getUint32(offset);
      const type = this.getString(offset + 4, 4);
      if (size === 0) break;

      if (type === 'mdia') {
        let mdiaOffset = offset + 8;
        while (mdiaOffset < offset + size - 8) {
          const mSize = this.view.getUint32(mdiaOffset);
          const mType = this.getString(mdiaOffset + 4, 4);
          if (mType === 'mdhd') {
            const version = this.view.getUint8(mdiaOffset + 8);
            timescale = version === 1
              ? this.view.getUint32(mdiaOffset + 28)
              : this.view.getUint32(mdiaOffset + 20);
          } else if (mType === 'minf') {
            let minfOffset = mdiaOffset + 8;
            while (minfOffset < mdiaOffset + mSize - 8) {
              const infSize = this.view.getUint32(minfOffset);
              const infType = this.getString(minfOffset + 4, 4);
              if (infType === 'stbl') {
                this.parseStbl(minfOffset + 8, minfOffset + infSize, (parsed) => {
                  if (parsed.codec) codec = parsed.codec;
                  if (parsed.width) width = parsed.width;
                  if (parsed.height) height = parsed.height;
                  if (parsed.description) description = parsed.description;
                  if (parsed.samples) samples.push(...parsed.samples);
                }, timescale);
              }
              minfOffset += infSize;
            }
          }
          mdiaOffset += mSize;
        }
      }
      offset += size;
    }

    if (samples.length === 0) {
      return null;
    }

    return {
      id: 1,
      codec,
      width,
      height,
      timescale,
      description,
      samples,
    };
  }

  private parseStbl(
    start: number,
    end: number,
    onResult: (data: {
      codec?: string;
      width?: number;
      height?: number;
      description?: Uint8Array;
      samples?: DemuxedSample[];
    }) => void,
    timescale: number
  ) {
    let offset = start;
    let chunkOffsets: number[] = [];
    let sampleSizes: number[] = [];
    let keyframeIndices = new Set<number>();
    let sampleDeltas: number[] = [];
    let codecString = 'avc1.640028';
    let trackWidth = 1920;
    let trackHeight = 1080;
    let descBytes: Uint8Array | undefined;

    while (offset < end - 8) {
      const size = this.view.getUint32(offset);
      const type = this.getString(offset + 4, 4);
      if (size === 0) break;

      if (type === 'stsd') {
        const entryCount = this.view.getUint32(offset + 12);
        let entryOffset = offset + 16;
        for (let i = 0; i < entryCount; i++) {
          const entrySize = this.view.getUint32(entryOffset);
          const format = this.getString(entryOffset + 4, 4);
          if (format === 'avc1' || format === 'hvc1' || format === 'vp09' || format === 'av01') {
            trackWidth = this.view.getUint16(entryOffset + 32);
            trackHeight = this.view.getUint16(entryOffset + 34);

            let subOffset = entryOffset + 86;
            while (subOffset < entryOffset + entrySize - 8) {
              const subSize = this.view.getUint32(subOffset);
              const subType = this.getString(subOffset + 4, 4);
              if (subType === 'avcC') {
                descBytes = new Uint8Array(this.buffer, subOffset + 8, subSize - 8);
                const profile = descBytes[1].toString(16).padStart(2, '0');
                const compat = descBytes[2].toString(16).padStart(2, '0');
                const level = descBytes[3].toString(16).padStart(2, '0');
                codecString = `avc1.${profile}${compat}${level}`;
              } else if (subType === 'hvcC') {
                descBytes = new Uint8Array(this.buffer, subOffset + 8, subSize - 8);
                codecString = 'hvc1.1.6.L93.B0';
              }
              subOffset += subSize;
            }
          }
          entryOffset += entrySize;
        }
      } else if (type === 'stsz') {
        const sampleSize = this.view.getUint32(offset + 12);
        const sampleCount = this.view.getUint32(offset + 16);
        if (sampleSize === 0) {
          for (let i = 0; i < sampleCount; i++) {
            sampleSizes.push(this.view.getUint32(offset + 20 + i * 4));
          }
        } else {
          for (let i = 0; i < sampleCount; i++) {
            sampleSizes.push(sampleSize);
          }
        }
      } else if (type === 'stco') {
        const count = this.view.getUint32(offset + 12);
        for (let i = 0; i < count; i++) {
          chunkOffsets.push(this.view.getUint32(offset + 16 + i * 4));
        }
      } else if (type === 'co64') {
        const count = this.view.getUint32(offset + 12);
        for (let i = 0; i < count; i++) {
          chunkOffsets.push(Number(this.view.getBigUint64(offset + 16 + i * 8)));
        }
      } else if (type === 'stss') {
        const count = this.view.getUint32(offset + 12);
        for (let i = 0; i < count; i++) {
          keyframeIndices.add(this.view.getUint32(offset + 16 + i * 4) - 1);
        }
      } else if (type === 'stts') {
        const count = this.view.getUint32(offset + 12);
        for (let i = 0; i < count; i++) {
          const sampleCount = this.view.getUint32(offset + 16 + i * 8);
          const sampleDelta = this.view.getUint32(offset + 20 + i * 8);
          for (let j = 0; j < sampleCount; j++) {
            sampleDeltas.push(sampleDelta);
          }
        }
      }
      offset += size;
    }

    const samples: DemuxedSample[] = [];
    let currentOffset = chunkOffsets[0] || 0;
    let currentTimestamp = 0;

    for (let i = 0; i < sampleSizes.length; i++) {
      const size = sampleSizes[i];
      const delta = sampleDeltas[i] || 1000;
      const durationUs = Math.round((delta / timescale) * 1_000_000);
      const isKey = keyframeIndices.size === 0 || keyframeIndices.has(i);

      const sampleData = new Uint8Array(this.buffer, currentOffset, size);
      samples.push({
        type: isKey ? 'key' : 'delta',
        timestamp: currentTimestamp,
        duration: durationUs,
        data: sampleData,
      });

      currentTimestamp += durationUs;
      currentOffset += size;
    }

    onResult({
      codec: codecString,
      width: trackWidth,
      height: trackHeight,
      description: descBytes,
      samples,
    });
  }

  private getString(start: number, length: number): string {
    let result = '';
    for (let i = 0; i < length; i++) {
      result += String.fromCharCode(this.view.getUint8(start + i));
    }
    return result;
  }
}
