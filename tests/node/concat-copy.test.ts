import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  concatCopy,
  ConcatCopyError,
  concatXfade,
  concatTranscode,
  extractStills,
  FastStartMp4Muxer,
  SimpleMp4Demuxer,
  probe,
  trimCopy,
} from '../../packages/core/dist/node.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SPS = new Uint8Array([0x67, 0x42, 0x00, 0x1e, 0xe9, 0x01, 0x40, 0x7b, 0x40]);
const PPS = new Uint8Array([0x68, 0xce, 0x38, 0x80]);
const SPS_OTHER = new Uint8Array([0x67, 0x64, 0x00, 0x1f, 0xe9, 0x01, 0x40, 0x7b, 0x40]);

function avccSample(): Uint8Array {
  return new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x65, 0x88]);
}

function aacSample(): Uint8Array {
  return new Uint8Array([0x21, 0x00, 0x49, 0x90, 0x02, 0x1f, 0xfc]);
}

function makeHvcc(): Uint8Array {
  const hvcc = new Uint8Array(23);
  hvcc[0] = 1;
  hvcc[22] = 0x03;
  return hvcc;
}

function boxIndex(bytes: Uint8Array, fourcc: string): number {
  const a = fourcc.charCodeAt(0);
  const b = fourcc.charCodeAt(1);
  const c = fourcc.charCodeAt(2);
  const d = fourcc.charCodeAt(3);
  for (let i = 4; i < bytes.length; i++) {
    if (bytes[i - 4] === a && bytes[i - 3] === b && bytes[i - 2] === c && bytes[i - 1] === d) {
      return i - 4;
    }
  }
  return -1;
}

function makeAvcClip(opts?: {
  width?: number;
  height?: number;
  timescale?: number;
  sps?: Uint8Array;
  firstKey?: boolean;
  withAudio?: boolean;
  compositionOffset?: number;
}): Uint8Array {
  const muxer = new FastStartMp4Muxer();
  muxer.setVideoTrack({
    width: opts?.width ?? 320,
    height: opts?.height ?? 240,
    timescale: opts?.timescale ?? 30000,
    sps: opts?.sps ?? SPS,
    pps: PPS,
  });
  if (opts?.withAudio !== false) {
    muxer.setAudioTrack({
      timescale: 44100,
      sampleRate: 44100,
      channels: 2,
    });
  }
  const ctts = opts?.compositionOffset ?? 0;
  muxer.writeVideoSample(avccSample(), 1000, opts?.firstKey !== false, ctts);
  muxer.writeVideoSample(avccSample(), 1000, opts?.firstKey === false, 0);
  if (opts?.withAudio !== false) {
    muxer.writeAudioSample(aacSample(), 1024);
    muxer.writeAudioSample(aacSample(), 1024);
  }
  return muxer.finalize();
}

function makeHevcClip(): Uint8Array {
  const muxer = new FastStartMp4Muxer();
  muxer.setVideoTrack({
    width: 320,
    height: 240,
    timescale: 30000,
    codec: 'hvc1',
    description: makeHvcc(),
  });
  muxer.writeVideoSample(avccSample(), 1000, true, 0);
  muxer.writeVideoSample(avccSample(), 1000, false, 0);
  return muxer.finalize();
}

describe('concatCopy', () => {
  it('splices H.264 + AAC with audio, real avcC, and faststart', async () => {
    const a = makeAvcClip({ compositionOffset: 2000 });
    const b = makeAvcClip({ compositionOffset: 2000 });
    const out = await concatCopy([a, b]);

    const moov = boxIndex(out, 'moov');
    const mdat = boxIndex(out, 'mdat');
    assert.ok(moov >= 0 && mdat >= 0 && moov < mdat, 'moov must precede mdat');
    assert.ok(boxIndex(out, 'avcC') >= 0);
    assert.equal(boxIndex(out, 'hvcC'), -1);

    const tracks = new SimpleMp4Demuxer(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)).parse();
    const video = tracks.find((t) => t.kind === 'video');
    const audio = tracks.find((t) => t.kind === 'audio');
    assert.ok(video);
    assert.ok(audio);
    assert.equal(video.width, 320);
    assert.equal(video.height, 240);
    assert.equal(video.samples.length, 4);
    assert.equal(audio.samples.length, 4);
    assert.ok(video.description && video.description.byteLength > 0);
    assert.equal(video.description[1], SPS[1]);
    assert.equal(video.samples[0].type, 'key');
    assert.equal(video.samples[2].type, 'key');
    assert.equal(video.samples[0].compositionOffsetTicks, 2000);
    assert.equal(video.samples[2].compositionOffsetTicks, 2000);

    let dts = 0;
    for (const s of video.samples) {
      assert.equal(s.dtsTicks, dts);
      dts += s.durationTicks;
    }
  });

  it('remaps timescale onto the first part', async () => {
    const a = makeAvcClip({ timescale: 30000 });
    const b = makeAvcClip({ timescale: 60000 });
    const out = await concatCopy([a, b]);
    const tracks = new SimpleMp4Demuxer(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)).parse();
    const video = tracks.find((t) => t.kind === 'video');
    assert.ok(video);
    assert.equal(video.timescale, 30000);
    assert.equal(video.samples.length, 4);
    assert.equal(video.samples[2].durationTicks, 500);
  });

  it('splices HEVC using the source hvcC', async () => {
    const out = await concatCopy([makeHevcClip(), makeHevcClip()]);
    assert.ok(boxIndex(out, 'hvcC') >= 0);
    assert.ok(boxIndex(out, 'hvc1') >= 0);
    const tracks = new SimpleMp4Demuxer(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)).parse();
    const video = tracks.find((t) => t.kind === 'video');
    assert.ok(video);
    assert.ok(video.codec.startsWith('hvc1'));
    assert.equal(video.samples.length, 4);
  });

  it('rejects fewer than two parts', async () => {
    await assert.rejects(() => concatCopy([makeAvcClip()]), (err: unknown) => {
      assert.ok(err instanceof ConcatCopyError);
      assert.equal(err.code, 'TOO_FEW_PARTS');
      return true;
    });
  });

  it('rejects resolution mismatch', async () => {
    await assert.rejects(
      () => concatCopy([makeAvcClip(), makeAvcClip({ width: 640, height: 480 })]),
      (err: unknown) => {
        assert.ok(err instanceof ConcatCopyError);
        assert.equal(err.code, 'RESOLUTION_MISMATCH');
        return true;
      }
    );
  });

  it('rejects codec family mismatch', async () => {
    await assert.rejects(
      () => concatCopy([makeAvcClip({ withAudio: false }), makeHevcClip()]),
      (err: unknown) => {
        assert.ok(err instanceof ConcatCopyError);
        assert.equal(err.code, 'CODEC_MISMATCH');
        return true;
      }
    );
  });

  it('rejects extradata mismatch', async () => {
    await assert.rejects(
      () => concatCopy([makeAvcClip(), makeAvcClip({ sps: SPS_OTHER })]),
      (err: unknown) => {
        assert.ok(err instanceof ConcatCopyError);
        assert.equal(err.code, 'EXTRADATA_MISMATCH');
        return true;
      }
    );
  });

  it('rejects a non-keyframe start', async () => {
    await assert.rejects(
      () => concatCopy([makeAvcClip(), makeAvcClip({ firstKey: false })]),
      (err: unknown) => {
        assert.ok(err instanceof ConcatCopyError);
        assert.equal(err.code, 'NON_KEY_START');
        return true;
      }
    );
  });

  it('rejects audio layout mismatch', async () => {
    await assert.rejects(
      () => concatCopy([makeAvcClip({ withAudio: true }), makeAvcClip({ withAudio: false })]),
      (err: unknown) => {
        assert.ok(err instanceof ConcatCopyError);
        assert.equal(err.code, 'AUDIO_LAYOUT_MISMATCH');
        return true;
      }
    );
  });
});

describe('Node package surface', () => {
  it('exports concatCopy without GPU / WebCodecs bindings', async () => {
    const mod = await import('../../packages/core/dist/node.js');
    assert.equal(typeof mod.concatCopy, 'function');
    assert.equal('HardwareVideoDecoder' in mod, false);
    assert.equal('WebGpuVideoRenderer' in mod, false);
    assert.equal('HardwareVideoEncoder' in mod, false);

    const nodeSrc = readFileSync(path.join(repoRoot, 'packages/core/src/node.ts'), 'utf8');
    assert.equal(nodeSrc.includes('hardware-decoder'), false);
    assert.equal(nodeSrc.includes('gpu-renderer'), false);
    assert.equal(nodeSrc.includes('wasm/rust-core'), false);
    assert.equal(nodeSrc.includes('./live'), false);
  });

  it('pixel ops are exported as not implemented', async () => {
    await assert.rejects(() => concatXfade([makeAvcClip(), makeAvcClip()]), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as Error & { code?: string }).code, 'NOT_IMPLEMENTED');
      return true;
    });
    await assert.rejects(() => extractStills(makeAvcClip(), { first: true }), (err: unknown) => {
      assert.equal((err as Error & { code?: string }).code, 'NOT_IMPLEMENTED');
      return true;
    });
    await assert.rejects(() => concatTranscode([makeAvcClip(), makeAvcClip()]), (err: unknown) => {
      assert.equal((err as Error & { code?: string }).code, 'NOT_IMPLEMENTED');
      return true;
    });
  });
});

describe('probe and trimCopy', () => {
  it('probe reports duration, size, and audio', async () => {
    const info = await probe(makeAvcClip());
    assert.equal(info.width, 320);
    assert.equal(info.height, 240);
    assert.equal(info.hasAudio, true);
    assert.equal(info.sampleCount, 2);
    assert.ok(info.durationUs > 0);
  });

  it('trimCopy keeps a keyframe start', async () => {
    const trimmed = await trimCopy(makeAvcClip(), { startUs: 0, endUs: 1_000_000 });
    const tracks = new SimpleMp4Demuxer(
      trimmed.buffer.slice(trimmed.byteOffset, trimmed.byteOffset + trimmed.byteLength)
    ).parse();
    const video = tracks.find((t) => t.kind === 'video');
    assert.ok(video && video.samples.length >= 1);
    assert.equal(video.samples[0].type, 'key');
  });
});
