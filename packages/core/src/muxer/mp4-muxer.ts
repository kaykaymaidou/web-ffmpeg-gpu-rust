export interface MuxerVideoTrack {
  width: number;
  height: number;
  timescale: number;
  sps: Uint8Array;
  pps: Uint8Array;
}

export interface MuxerAudioTrack {
  timescale: number;
  sampleRate: number;
  channels: number;
  config?: Uint8Array;
}

interface MuxerSample {
  isVideo: boolean;
  isKey: boolean;
  durationTicks: number;
  data: Uint8Array;
  relativeOffset: number;
}

interface ChunkRun {
  sampleCount: number;
  relativeOffset: number;
}

/**
 * Pure TypeScript & ISOBMFF compliant MP4 Muxer with FastStart streaming order.
 * Places `moov` box before `mdat` box for progressive web playback.
 * Contiguous samples of the same track collapse to one chunk (one stco entry).
 */
export class FastStartMp4Muxer {
  private videoTrack: MuxerVideoTrack | null = null;
  private audioTrack: MuxerAudioTrack | null = null;
  private samples: MuxerSample[] = [];
  private totalPayloadBytes: number = 0;

  public setVideoTrack(track: MuxerVideoTrack): void {
    this.videoTrack = track;
  }

  public setAudioTrack(track: MuxerAudioTrack): void {
    this.audioTrack = track;
  }

  public writeVideoSample(data: Uint8Array, durationTicks: number, isKey: boolean): void {
    const sample: MuxerSample = {
      isVideo: true,
      isKey,
      durationTicks,
      data,
      relativeOffset: this.totalPayloadBytes,
    };
    this.samples.push(sample);
    this.totalPayloadBytes += data.byteLength;
  }

  public writeAudioSample(data: Uint8Array, durationTicks: number): void {
    const sample: MuxerSample = {
      isVideo: false,
      isKey: true,
      durationTicks,
      data,
      relativeOffset: this.totalPayloadBytes,
    };
    this.samples.push(sample);
    this.totalPayloadBytes += data.byteLength;
  }

  public finalize(): Uint8Array {
    const ftyp = this.buildFtyp();
    const ftypLen = ftyp.byteLength;

    // 1. First pass: build moov with dummy offset 0 to calculate exact byte length
    const dummyMoov = this.buildMoov(0);
    const moovLen = dummyMoov.byteLength;

    // 2. Base offset: ftypLen + moovLen + 8 (mdat box header)
    const baseOffset = ftypLen + moovLen + 8;

    // 3. Second pass: build moov with exact absolute chunk offsets
    const realMoov = this.buildMoov(baseOffset);

    // 4. Build mdat header (8 bytes)
    const mdatHeader = new Uint8Array(8);
    const mdatView = new DataView(mdatHeader.buffer);
    mdatView.setUint32(0, 8 + this.totalPayloadBytes);
    mdatHeader.set([0x6d, 0x64, 0x61, 0x74], 4); // 'mdat'

    // 5. Concatenate output
    const totalSize = ftypLen + moovLen + 8 + this.totalPayloadBytes;
    const result = new Uint8Array(totalSize);
    let offset = 0;

    result.set(ftyp, offset);
    offset += ftypLen;

    result.set(realMoov, offset);
    offset += moovLen;

    result.set(mdatHeader, offset);
    offset += 8;

    for (const sample of this.samples) {
      result.set(sample.data, offset);
      offset += sample.data.byteLength;
    }

    return result;
  }

  private buildFtyp(): Uint8Array {
    const payload = new Uint8Array(24);
    const view = new DataView(payload.buffer);
    payload.set([0x69, 0x73, 0x6f, 0x6d], 0); // 'isom' major brand
    view.setUint32(4, 0x00000200); // minor version
    payload.set([0x69, 0x73, 0x6f, 0x6d], 8);  // isom
    payload.set([0x69, 0x73, 0x6f, 0x32], 12); // iso2
    payload.set([0x61, 0x76, 0x63, 0x31], 16); // avc1
    payload.set([0x6d, 0x70, 0x34, 0x31], 20); // mp41
    return this.box('ftyp', payload);
  }

  private buildMoov(baseOffset: number): Uint8Array {
    const children: Uint8Array[] = [];
    const movieTimescale = 1000;

    const videoSamples = this.samples.filter((s) => s.isVideo);
    const audioSamples = this.samples.filter((s) => !s.isVideo);

    const videoTotalTicks = videoSamples.reduce((acc, s) => acc + s.durationTicks, 0);
    const audioTotalTicks = audioSamples.reduce((acc, s) => acc + s.durationTicks, 0);

    const videoDurMovieTs = this.videoTrack ? Math.round((videoTotalTicks * movieTimescale) / this.videoTrack.timescale) : 0;
    const audioDurMovieTs = this.audioTrack ? Math.round((audioTotalTicks * movieTimescale) / this.audioTrack.timescale) : 0;
    const maxDur = Math.max(videoDurMovieTs, audioDurMovieTs);

    let trackCount = 0;
    if (this.videoTrack) trackCount++;
    if (this.audioTrack) trackCount++;

    // 1. mvhd
    children.push(this.buildMvhd(movieTimescale, maxDur, trackCount + 1));

    // 2. Video trak
    let trackId = 1;
    if (this.videoTrack) {
      children.push(this.buildVideoTrak(trackId, this.videoTrack, videoSamples, videoTotalTicks, videoDurMovieTs, baseOffset));
      trackId++;
    }

    // 3. Audio trak
    if (this.audioTrack) {
      children.push(this.buildAudioTrak(trackId, this.audioTrack, audioSamples, audioTotalTicks, audioDurMovieTs, baseOffset));
    }

    return this.box('moov', this.concat(children));
  }

  private buildMvhd(timescale: number, duration: number, nextTrackId: number): Uint8Array {
    const payload = new Uint8Array(100);
    const view = new DataView(payload.buffer);
    view.setUint32(12, timescale);
    view.setUint32(16, duration);
    view.setUint32(20, 0x00010000); // rate 1.0
    view.setUint16(24, 0x0100);     // volume 1.0
    // 3x3 identity matrix
    view.setUint32(36, 0x00010000);
    view.setUint32(52, 0x00010000);
    view.setUint32(84, 0x40000000);
    view.setUint32(96, nextTrackId);
    return this.box('mvhd', payload);
  }

  private buildVideoTrak(
    trackId: number,
    config: MuxerVideoTrack,
    samples: MuxerSample[],
    trackTicks: number,
    durationMovieTs: number,
    baseOffset: number
  ): Uint8Array {
    const children: Uint8Array[] = [];

    // tkhd
    const tkhdPayload = new Uint8Array(84);
    const tkhdView = new DataView(tkhdPayload.buffer);
    tkhdPayload.set([0x00, 0x00, 0x07], 1); // flags: enabled | in_movie | in_preview
    tkhdView.setUint32(12, trackId);
    tkhdView.setUint32(20, durationMovieTs);
    tkhdView.setUint32(36, 0x00010000);
    tkhdView.setUint32(52, 0x00010000);
    tkhdView.setUint32(68, 0x40000000);
    tkhdView.setUint32(76, config.width << 16);
    tkhdView.setUint32(80, config.height << 16);
    children.push(this.box('tkhd', tkhdPayload));

    // mdia
    const mdiaChildren: Uint8Array[] = [];
    // mdhd
    const mdhdPayload = new Uint8Array(24);
    const mdhdView = new DataView(mdhdPayload.buffer);
    mdhdView.setUint32(12, config.timescale);
    mdhdView.setUint32(16, trackTicks);
    mdhdView.setUint16(20, 0x55c4); // 'und'
    mdiaChildren.push(this.box('mdhd', mdhdPayload));

    // hdlr
    const hdlrPayload = new Uint8Array(37);
    hdlrPayload.set([0x76, 0x69, 0x64, 0x65], 8); // 'vide'
    const enc = new TextEncoder();
    hdlrPayload.set(enc.encode('VideoHandler\0'), 24);
    mdiaChildren.push(this.box('hdlr', hdlrPayload));

    // minf
    const minfChildren: Uint8Array[] = [];
    const vmhdPayload = new Uint8Array(12);
    new DataView(vmhdPayload.buffer).setUint32(0, 0x00000001);
    minfChildren.push(this.box('vmhd', vmhdPayload));
    minfChildren.push(this.buildDinf());

    // stbl
    const stblChildren: Uint8Array[] = [];
    const videoRuns = this.chunkRuns(samples);
    stblChildren.push(this.buildStsdVideo(config));
    stblChildren.push(this.buildStts(samples));
    stblChildren.push(this.buildStss(samples));
    stblChildren.push(this.buildStsc(videoRuns));
    stblChildren.push(this.buildStsz(samples));
    stblChildren.push(this.buildStco(videoRuns, baseOffset));

    minfChildren.push(this.box('stbl', this.concat(stblChildren)));
    mdiaChildren.push(this.box('minf', this.concat(minfChildren)));
    children.push(this.box('mdia', this.concat(mdiaChildren)));

    return this.box('trak', this.concat(children));
  }

  private buildAudioTrak(
    trackId: number,
    config: MuxerAudioTrack,
    samples: MuxerSample[],
    trackTicks: number,
    durationMovieTs: number,
    baseOffset: number
  ): Uint8Array {
    const children: Uint8Array[] = [];

    // tkhd
    const tkhdPayload = new Uint8Array(84);
    const tkhdView = new DataView(tkhdPayload.buffer);
    tkhdPayload.set([0x00, 0x00, 0x07], 1);
    tkhdView.setUint32(12, trackId);
    tkhdView.setUint32(20, durationMovieTs);
    tkhdView.setUint16(36, 0x0100); // volume 1.0
    tkhdView.setUint32(40, 0x00010000);
    tkhdView.setUint32(56, 0x00010000);
    tkhdView.setUint32(72, 0x40000000);
    children.push(this.box('tkhd', tkhdPayload));

    // mdia
    const mdiaChildren: Uint8Array[] = [];
    const mdhdPayload = new Uint8Array(24);
    const mdhdView = new DataView(mdhdPayload.buffer);
    mdhdView.setUint32(12, config.timescale);
    mdhdView.setUint32(16, trackTicks);
    mdhdView.setUint16(20, 0x55c4);
    mdiaChildren.push(this.box('mdhd', mdhdPayload));

    // hdlr
    const hdlrPayload = new Uint8Array(37);
    hdlrPayload.set([0x73, 0x6f, 0x75, 0x6e], 8); // 'soun'
    const enc = new TextEncoder();
    hdlrPayload.set(enc.encode('SoundHandler\0'), 24);
    mdiaChildren.push(this.box('hdlr', hdlrPayload));

    // minf
    const minfChildren: Uint8Array[] = [];
    const smhdPayload = new Uint8Array(8);
    minfChildren.push(this.box('smhd', smhdPayload));
    minfChildren.push(this.buildDinf());

    // stbl
    const stblChildren: Uint8Array[] = [];
    const audioRuns = this.chunkRuns(samples);
    stblChildren.push(this.buildStsdAudio(config));
    stblChildren.push(this.buildStts(samples));
    stblChildren.push(this.buildStsc(audioRuns));
    stblChildren.push(this.buildStsz(samples));
    stblChildren.push(this.buildStco(audioRuns, baseOffset));

    minfChildren.push(this.box('stbl', this.concat(stblChildren)));
    mdiaChildren.push(this.box('minf', this.concat(minfChildren)));
    children.push(this.box('mdia', this.concat(mdiaChildren)));

    return this.box('trak', this.concat(children));
  }

  private buildDinf(): Uint8Array {
    const urlBox = this.box('url ', new Uint8Array([0, 0, 0, 1])); // data in same file
    const drefPayload = new Uint8Array(8 + urlBox.byteLength);
    const view = new DataView(drefPayload.buffer);
    view.setUint32(4, 1); // 1 entry
    drefPayload.set(urlBox, 8);
    const drefBox = this.box('dref', drefPayload);
    return this.box('dinf', drefBox);
  }

  private buildStsdVideo(config: MuxerVideoTrack): Uint8Array {
    // avcC
    const avccPayload = new Uint8Array(11 + config.sps.byteLength + config.pps.byteLength);
    avccPayload[0] = 1; // configurationVersion
    avccPayload[1] = config.sps[1] || 0x42;
    avccPayload[2] = config.sps[2] || 0x00;
    avccPayload[3] = config.sps[3] || 0x1e;
    avccPayload[4] = 0xff; // lengthSizeMinusOne: 4-byte NAL
    avccPayload[5] = 0xe1; // 1 SPS
    new DataView(avccPayload.buffer).setUint16(6, config.sps.byteLength);
    avccPayload.set(config.sps, 8);
    const ppsOffset = 8 + config.sps.byteLength;
    avccPayload[ppsOffset] = 1; // 1 PPS
    new DataView(avccPayload.buffer).setUint16(ppsOffset + 1, config.pps.byteLength);
    avccPayload.set(config.pps, ppsOffset + 3);

    const avccBox = this.box('avcC', avccPayload);

    // avc1
    const avc1Payload = new Uint8Array(78 + avccBox.byteLength);
    const avc1View = new DataView(avc1Payload.buffer);
    avc1View.setUint16(6, 1); // data_reference_index
    avc1View.setUint16(24, config.width);
    avc1View.setUint16(26, config.height);
    avc1View.setUint32(28, 0x00480000); // 72 dpi
    avc1View.setUint32(32, 0x00480000); // 72 dpi
    avc1View.setUint16(40, 1); // frame_count
    avc1View.setUint16(74, 0x0018); // depth 24
    avc1View.setInt16(76, -1);
    avc1Payload.set(avccBox, 78);

    const avc1Box = this.box('avc1', avc1Payload);

    const stsdPayload = new Uint8Array(8 + avc1Box.byteLength);
    new DataView(stsdPayload.buffer).setUint32(4, 1); // 1 entry
    stsdPayload.set(avc1Box, 8);

    return this.box('stsd', stsdPayload);
  }

  private buildStsdAudio(config: MuxerAudioTrack): Uint8Array {
    const asc = config.config || this.generateAacConfig(config.sampleRate, config.channels);

    // esds
    const esdsPayload = new Uint8Array(38 + asc.byteLength);
    // DecSpecificInfo
    const dsi = new Uint8Array(2 + asc.byteLength);
    dsi[0] = 0x05;
    dsi[1] = asc.byteLength;
    dsi.set(asc, 2);

    // DecoderConfigDescriptor
    const dcd = new Uint8Array(15 + dsi.byteLength);
    dcd[0] = 0x04;
    dcd[1] = 13 + dsi.byteLength;
    dcd[2] = 0x40; // AAC
    dcd[3] = 0x15; // AudioStream
    dcd.set(dsi, 15);

    // ES_Descriptor
    const esd = new Uint8Array(5 + dcd.byteLength + 3);
    esd[0] = 0x03;
    esd[1] = 3 + dcd.byteLength + 3;
    new DataView(esd.buffer).setUint16(2, 1);
    esd.set(dcd, 5);
    esd.set([0x06, 0x01, 0x02], 5 + dcd.byteLength); // SLConfig

    esdsPayload.set(esd, 4);
    const esdsBox = this.box('esds', esdsPayload);

    // mp4a
    const mp4aPayload = new Uint8Array(28 + esdsBox.byteLength);
    const mp4aView = new DataView(mp4aPayload.buffer);
    mp4aView.setUint16(6, 1); // data_reference_index
    mp4aView.setUint16(16, config.channels);
    mp4aView.setUint16(18, 16); // 16 bits
    mp4aView.setUint32(24, config.sampleRate << 16);
    mp4aPayload.set(esdsBox, 28);

    const mp4aBox = this.box('mp4a', mp4aPayload);

    const stsdPayload = new Uint8Array(8 + mp4aBox.byteLength);
    new DataView(stsdPayload.buffer).setUint32(4, 1);
    stsdPayload.set(mp4aBox, 8);

    return this.box('stsd', stsdPayload);
  }

  private generateAacConfig(sampleRate: number, channels: number): Uint8Array {
    const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
    const idx = rates.indexOf(sampleRate);
    const freqIdx = idx === -1 ? 4 : idx;
    const val = (2 << 11) | (freqIdx << 7) | ((channels & 0x0f) << 3);
    return new Uint8Array([(val >> 8) & 0xff, val & 0xff]);
  }

  private buildStts(samples: MuxerSample[]): Uint8Array {
    if (samples.length === 0) {
      const p = new Uint8Array(8);
      return this.box('stts', p);
    }
    const entries: Array<{ count: number; dur: number }> = [];
    let curCount = 1;
    let curDur = samples[0].durationTicks;

    for (let i = 1; i < samples.length; i++) {
      if (samples[i].durationTicks === curDur) {
        curCount++;
      } else {
        entries.push({ count: curCount, dur: curDur });
        curCount = 1;
        curDur = samples[i].durationTicks;
      }
    }
    entries.push({ count: curCount, dur: curDur });

    const payload = new Uint8Array(8 + entries.length * 8);
    const view = new DataView(payload.buffer);
    view.setUint32(4, entries.length);
    let offset = 8;
    for (const e of entries) {
      view.setUint32(offset, e.count);
      view.setUint32(offset + 4, e.dur);
      offset += 8;
    }
    return this.box('stts', payload);
  }

  private buildStss(samples: MuxerSample[]): Uint8Array {
    const keyIndices: number[] = [];
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].isKey) {
        keyIndices.push(i + 1); // 1-indexed
      }
    }
    const payload = new Uint8Array(8 + keyIndices.length * 4);
    const view = new DataView(payload.buffer);
    view.setUint32(4, keyIndices.length);
    let offset = 8;
    for (const idx of keyIndices) {
      view.setUint32(offset, idx);
      offset += 4;
    }
    return this.box('stss', payload);
  }

  private chunkRuns(samples: MuxerSample[]): ChunkRun[] {
    const runs: ChunkRun[] = [];
    if (samples.length === 0) {
      return runs;
    }
    let sampleCount = 1;
    let relativeOffset = samples[0].relativeOffset;
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1];
      if (samples[i].relativeOffset === prev.relativeOffset + prev.data.byteLength) {
        sampleCount++;
      } else {
        runs.push({ sampleCount, relativeOffset });
        sampleCount = 1;
        relativeOffset = samples[i].relativeOffset;
      }
    }
    runs.push({ sampleCount, relativeOffset });
    return runs;
  }

  private buildStsc(runs: ChunkRun[]): Uint8Array {
    if (runs.length === 0) {
      return this.box('stsc', new Uint8Array(8));
    }
    const entries: { firstChunk: number; samplesPerChunk: number }[] = [];
    for (let i = 0; i < runs.length; i++) {
      const samplesPerChunk = runs[i].sampleCount;
      const last = entries[entries.length - 1];
      if (!last || last.samplesPerChunk !== samplesPerChunk) {
        entries.push({ firstChunk: i + 1, samplesPerChunk });
      }
    }
    const payload = new Uint8Array(8 + entries.length * 12);
    const view = new DataView(payload.buffer);
    view.setUint32(4, entries.length);
    let offset = 8;
    for (const entry of entries) {
      view.setUint32(offset, entry.firstChunk);
      view.setUint32(offset + 4, entry.samplesPerChunk);
      view.setUint32(offset + 8, 1);
      offset += 12;
    }
    return this.box('stsc', payload);
  }

  private buildStsz(samples: MuxerSample[]): Uint8Array {
    const payload = new Uint8Array(12 + samples.length * 4);
    const view = new DataView(payload.buffer);
    view.setUint32(8, samples.length);
    let offset = 12;
    for (const s of samples) {
      view.setUint32(offset, s.data.byteLength);
      offset += 4;
    }
    return this.box('stsz', payload);
  }

  private buildStco(runs: ChunkRun[], baseOffset: number): Uint8Array {
    const payload = new Uint8Array(8 + runs.length * 4);
    const view = new DataView(payload.buffer);
    view.setUint32(4, runs.length);
    let offset = 8;
    for (const run of runs) {
      view.setUint32(offset, baseOffset + run.relativeOffset);
      offset += 4;
    }
    return this.box('stco', payload);
  }

  private box(tag: string, payload: Uint8Array): Uint8Array {
    const size = 8 + payload.byteLength;
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer);
    view.setUint32(0, size);
    for (let i = 0; i < 4; i++) {
      buf[4 + i] = tag.charCodeAt(i);
    }
    buf.set(payload, 8);
    return buf;
  }

  private concat(arrays: Uint8Array[]): Uint8Array {
    const total = arrays.reduce((acc, a) => acc + a.byteLength, 0);
    const res = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
      res.set(a, offset);
      offset += a.byteLength;
    }
    return res;
  }
}
