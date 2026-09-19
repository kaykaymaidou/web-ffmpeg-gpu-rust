export interface DemuxedSample {
  type: 'key' | 'delta';
  timestamp: number; // PTS in microseconds
  duration: number;  // in microseconds
  dtsTicks: number;
  durationTicks: number;
  compositionOffsetTicks: number;
  data: Uint8Array;
}

export interface DemuxedTrack {
  id: number;
  kind: 'video' | 'audio';
  codec: string;
  width: number;
  height: number;
  channels?: number;
  sampleRate?: number;
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

    // FAIL-05 Autocorrection: if no moov box found (truncated file), activate salvage mode
    if (tracks.length === 0) {
      const salvaged = this.salvageTruncatedMdat();
      if (salvaged) {
        tracks.push(salvaged);
      }
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
    let trackId = 1;
    let trackKind: 'video' | 'audio' = 'video';
    let codec = 'avc1.640028';
    let width = 0;
    let height = 0;
    let channels: number | undefined;
    let sampleRate: number | undefined;
    let timescale = 30000;
    let description: Uint8Array | undefined;
    const samples: DemuxedSample[] = [];

    while (offset < end - 8) {
      const size = this.view.getUint32(offset);
      const type = this.getString(offset + 4, 4);
      if (size === 0) break;

      if (type === 'tkhd' && offset + 24 <= this.view.byteLength) {
        trackId = this.view.getUint32(offset + 20);
      } else if (type === 'mdia') {
        let mdiaOffset = offset + 8;
        while (mdiaOffset < offset + size - 8) {
          const mSize = this.view.getUint32(mdiaOffset);
          const mType = this.getString(mdiaOffset + 4, 4);
          if (mType === 'hdlr' && mdiaOffset + 20 <= offset + size) {
            const hType = this.getString(mdiaOffset + 16, 4);
            if (hType === 'soun') {
              trackKind = 'audio';
            } else if (hType === 'vide') {
              trackKind = 'video';
            }
          } else if (mType === 'mdhd') {
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
                  if (parsed.kind) trackKind = parsed.kind;
                  if (parsed.codec) codec = parsed.codec;
                  if (parsed.width !== undefined) width = parsed.width;
                  if (parsed.height !== undefined) height = parsed.height;
                  if (parsed.channels !== undefined) channels = parsed.channels;
                  if (parsed.sampleRate !== undefined) sampleRate = parsed.sampleRate;
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
      id: trackId,
      kind: trackKind,
      codec,
      width,
      height,
      channels,
      sampleRate,
      timescale,
      description,
      samples,
    };
  }

  private parseStbl(
    start: number,
    end: number,
    onResult: (data: {
      kind?: 'video' | 'audio';
      codec?: string;
      width?: number;
      height?: number;
      channels?: number;
      sampleRate?: number;
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
    const stscEntries: Array<{ firstChunk: number; samplesPerChunk: number }> = [];
    const cttsOffsets: number[] = [];
    let trackKind: 'video' | 'audio' = 'video';
    let codecString = 'avc1.640028';
    let trackWidth = 0;
    let trackHeight = 0;
    let trackChannels: number | undefined;
    let trackSampleRate: number | undefined;
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
          if (format === 'avc1' || format === 'avc3' || format === 'hvc1' || format === 'hev1' || format === 'vp09' || format === 'av01') {
            trackKind = 'video';
            trackWidth = this.view.getUint16(entryOffset + 32);
            trackHeight = this.view.getUint16(entryOffset + 34);

            let subOffset = entryOffset + 86;
            while (subOffset < entryOffset + entrySize - 8) {
              const subSize = this.view.getUint32(subOffset);
              const subType = this.getString(subOffset + 4, 4);
              if (subType === 'avcC' && subSize > 8) {
                descBytes = new Uint8Array(this.buffer, subOffset + 8, subSize - 8);
                const profile = descBytes[1].toString(16).padStart(2, '0');
                const compat = descBytes[2].toString(16).padStart(2, '0');
                const level = descBytes[3].toString(16).padStart(2, '0');
                codecString = `avc1.${profile}${compat}${level}`;
              } else if (subType === 'hvcC' && subSize > 8) {
                descBytes = new Uint8Array(this.buffer, subOffset + 8, subSize - 8);
                codecString = format === 'hev1' ? 'hev1.1.6.L93.B0' : 'hvc1.1.6.L93.B0';
              }
              subOffset += subSize;
            }
          } else if (format === 'mp4a') {
            trackKind = 'audio';
            trackWidth = 0;
            trackHeight = 0;
            trackChannels = this.view.getUint16(entryOffset + 24);
            trackSampleRate = this.view.getUint32(entryOffset + 32) >>> 16;
            codecString = 'mp4a.40.2';

            // Scan child boxes for esds
            let subOffset = entryOffset + 36;
            while (subOffset < entryOffset + entrySize - 8) {
              const subSize = this.view.getUint32(subOffset);
              const subType = this.getString(subOffset + 4, 4);
              if (subType === 'esds' && subSize > 8) {
                const esdsData = new Uint8Array(this.buffer, subOffset + 8, subSize - 8);
                // Extract AudioSpecificConfig from DecSpecificInfo (Tag 0x05)
                for (let k = 0; k < esdsData.length - 2; k++) {
                  if (esdsData[k] === 0x05) {
                    const ascLen = esdsData[k + 1];
                    if (k + 2 + ascLen <= esdsData.length) {
                      descBytes = esdsData.slice(k + 2, k + 2 + ascLen);
                      const aot = (descBytes[0] >> 3) & 0x1f;
                      if (aot > 0) {
                        codecString = `mp4a.40.${aot}`;
                      }
                      break;
                    }
                  }
                }
              }
              subOffset += subSize;
            }
          } else if (format === 'Opus') {
            trackKind = 'audio';
            trackWidth = 0;
            trackHeight = 0;
            trackChannels = this.view.getUint16(entryOffset + 24);
            trackSampleRate = 48000;
            codecString = 'opus';
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
      } else if (type === 'stsc') {
        const count = this.view.getUint32(offset + 12);
        for (let i = 0; i < count; i++) {
          stscEntries.push({
            firstChunk: this.view.getUint32(offset + 16 + i * 12),
            samplesPerChunk: this.view.getUint32(offset + 20 + i * 12),
          });
        }
      } else if (type === 'ctts') {
        const count = this.view.getUint32(offset + 12);
        for (let i = 0; i < count; i++) {
          const sampleCount = this.view.getUint32(offset + 16 + i * 8);
          const compositionOffset = this.view.getInt32(offset + 20 + i * 8);
          for (let j = 0; j < sampleCount; j++) {
            cttsOffsets.push(compositionOffset);
          }
        }
      }
      offset += size;
    }

    const samplesPerChunkAt = (chunkIndex1Based: number): number => {
      if (stscEntries.length === 0) {
        if (chunkOffsets.length <= 1) return sampleSizes.length;
        return 1;
      }
      let samplesPerChunk = stscEntries[0].samplesPerChunk;
      for (const entry of stscEntries) {
        if (entry.firstChunk <= chunkIndex1Based) {
          samplesPerChunk = entry.samplesPerChunk;
        }
      }
      return samplesPerChunk;
    };

    const samples: DemuxedSample[] = [];
    let sampleIndex = 0;
    let decodeTicks = 0;

    for (let chunk = 0; chunk < chunkOffsets.length && sampleIndex < sampleSizes.length; chunk++) {
      let byteOffset = chunkOffsets[chunk];
      const count = samplesPerChunkAt(chunk + 1);
      for (let s = 0; s < count && sampleIndex < sampleSizes.length; s++) {
        const size = sampleSizes[sampleIndex];
        const delta = sampleDeltas[sampleIndex] || 1000;
        const compositionTicks = cttsOffsets[sampleIndex] || 0;
        const durationUs = Math.round((delta / timescale) * 1_000_000);
        const timestamp = Math.round(((decodeTicks + compositionTicks) / timescale) * 1_000_000);
        const isKey = keyframeIndices.size === 0 || keyframeIndices.has(sampleIndex);
        const sampleEnd = byteOffset + size;
        if (sampleEnd > this.view.byteLength) {
          break;
        }
        samples.push({
          type: isKey ? 'key' : 'delta',
          timestamp: Math.max(0, timestamp),
          duration: durationUs,
          dtsTicks: decodeTicks,
          durationTicks: delta,
          compositionOffsetTicks: compositionTicks,
          // View into source buffer — matches Rust Mp4Demuxer offset/size. EncodedVideoChunk copies on construct.
          data: new Uint8Array(this.buffer, byteOffset, size),
        });
        byteOffset += size;
        decodeTicks += delta;
        sampleIndex++;
      }
    }

    onResult({
      kind: trackKind,
      codec: codecString,
      width: trackWidth,
      height: trackHeight,
      channels: trackChannels,
      sampleRate: trackSampleRate,
      description: descBytes,
      samples,
    });
  }

  private getString(start: number, length: number): string {
    if (length === 4) {
      return String.fromCharCode(
        this.view.getUint8(start),
        this.view.getUint8(start + 1),
        this.view.getUint8(start + 2),
        this.view.getUint8(start + 3)
      );
    }
    let str = '';
    for (let i = 0; i < length; i++) {
      str += String.fromCharCode(this.view.getUint8(start + i));
    }
    return str;
  }

  /**
   * FAIL-05 Salvage Engine:
   * Scans a raw mdat payload for Annex-B NAL start codes (00 00 00 01)
   * when the MP4 has no valid moov box (e.g. abrupt termination/crash during recording).
   */
  private salvageTruncatedMdat(): DemuxedTrack | null {
    const bytes = new Uint8Array(this.buffer);
    const samples: DemuxedSample[] = [];

    let startIndices: number[] = [];
    for (let i = 0; i < bytes.length - 4; i++) {
      if (
        bytes[i] === 0x00 &&
        bytes[i + 1] === 0x00 &&
        bytes[i + 2] === 0x00 &&
        bytes[i + 3] === 0x01
      ) {
        startIndices.push(i);
      }
    }

    if (startIndices.length === 0) {
      return null;
    }

    let frameIndex = 0;
    for (let i = 0; i < startIndices.length; i++) {
      const start = startIndices[i];
      const end = i + 1 < startIndices.length ? startIndices[i + 1] : bytes.length;
      const nalData = bytes.slice(start, end);

      const nalType = nalData[4] & 0x1f;
      if (nalType === 1 || nalType === 5) {
        const isKey = nalType === 5;
        samples.push({
          type: isKey ? 'key' : 'delta',
          timestamp: frameIndex * 33333,
          duration: 33333,
          dtsTicks: frameIndex * 1000,
          durationTicks: 1000,
          compositionOffsetTicks: 0,
          data: nalData,
        });
        frameIndex++;
      }
    }

    if (samples.length > 0) {
      console.warn(`[Autocorrection FAIL-05] Salvaged ${samples.length} frames from truncated MP4 without moov box.`);
      return {
        id: 1,
        kind: 'video',
        codec: 'avc1.42001f',
        width: 1280,
        height: 720,
        timescale: 30000,
        samples,
      };
    }

    return null;
  }
}
