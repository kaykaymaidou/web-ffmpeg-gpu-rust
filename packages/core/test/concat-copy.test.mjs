import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { concatCopy, ConcatCopyError } from '../dist/concat/concat-copy.js';
import { extractStills, concatXfade, concatTranscode } from '../dist/concat/pixel-ops.js';
import { probe } from '../dist/concat/probe.js';
import { trimCopy } from '../dist/concat/trim-copy.js';
import { FastStartMp4Muxer } from '../dist/muxer/mp4-muxer.js';
import { SimpleMp4Demuxer } from '../dist/demuxer/mp4-demuxer.js';

const SPS = new Uint8Array([0x67, 0x42, 0xc0, 0x1e, 0xd9, 0x00, 0xa0, 0x7b, 0x40]);
const PPS = new Uint8Array([0x68, 0xce, 0x38, 0x80]);

function nal(payload) {
  const out = new Uint8Array(4 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, payload.byteLength);
  out.set(payload, 4);
  return out;
}

function makeClip(opts) {
  const timescale = opts.timescale ?? 30000;
  const muxer = new FastStartMp4Muxer();
  muxer.setVideoTrack({
    width: opts.width,
    height: opts.height,
    timescale,
    sps: SPS,
    pps: PPS,
  });
  if (opts.audio) {
    muxer.setAudioTrack({
      timescale: 44100,
      sampleRate: 44100,
      channels: 2,
    });
  }
  for (let i = 0; i < opts.frames; i++) {
    muxer.writeVideoSample(nal(new Uint8Array([0x65, i, 1, 2, 3])), 1000, i === 0, opts.compositionOffset ?? 0);
    if (opts.audio) {
      muxer.writeAudioSample(new Uint8Array([0xff, 0xf1, i, 0, 0]), 1024);
    }
  }
  return muxer.finalize();
}

test('concatCopy remuxes video+audio and keeps faststart moov', async () => {
  const a = makeClip({ width: 64, height: 48, frames: 3, audio: true });
  const b = makeClip({ width: 64, height: 48, frames: 2, audio: true });
  const out = await concatCopy([a, b]);
  assert.ok(out.byteLength > a.byteLength);
  const text = Buffer.from(out.buffer, out.byteOffset, out.byteLength).toString('latin1');
  const moov = text.indexOf('moov');
  const mdat = text.indexOf('mdat');
  assert.ok(moov >= 0 && mdat >= 0 && moov < mdat);

  const tracks = new SimpleMp4Demuxer(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)).parse();
  const video = tracks.find((t) => t.kind === 'video');
  const audio = tracks.find((t) => t.kind === 'audio');
  assert.equal(video?.width, 64);
  assert.equal(video?.height, 48);
  assert.equal(video?.samples.length, 5);
  assert.equal(video?.samples[0].type, 'key');
  assert.equal(video?.samples[3].type, 'key');
  assert.ok(audio && audio.samples.length >= 5);
});

test('concatCopy preserves ctts offsets', async () => {
  const a = makeClip({ width: 32, height: 32, frames: 2, compositionOffset: 200 });
  const b = makeClip({ width: 32, height: 32, frames: 2, compositionOffset: 200 });
  const out = await concatCopy([a, b]);
  const tracks = new SimpleMp4Demuxer(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)).parse();
  const video = tracks.find((t) => t.kind === 'video');
  assert.ok(video);
  for (const s of video.samples) {
    assert.equal(s.compositionOffsetTicks, 200);
  }
});

test('concatCopy rejects resolution mismatch', async () => {
  const a = makeClip({ width: 64, height: 48, frames: 1 });
  const b = makeClip({ width: 128, height: 48, frames: 1 });
  await assert.rejects(() => concatCopy([a, b]), (err) => {
    assert.ok(err instanceof ConcatCopyError);
    assert.equal(err.code, 'RESOLUTION_MISMATCH');
    return true;
  });
});

test('concatCopy rejects a single part', async () => {
  const a = makeClip({ width: 16, height: 16, frames: 1 });
  await assert.rejects(() => concatCopy([a]), (err) => {
    assert.ok(err instanceof ConcatCopyError);
    assert.equal(err.code, 'TOO_FEW_PARTS');
    return true;
  });
});

test('probe reports duration and layout', async () => {
  const clip = makeClip({ width: 80, height: 60, frames: 4, audio: true, timescale: 30000 });
  const info = await probe(clip);
  assert.equal(info.width, 80);
  assert.equal(info.height, 60);
  assert.equal(info.sampleCount, 4);
  assert.equal(info.hasAudio, true);
  assert.ok(info.durationUs > 100_000);
});

test('trimCopy keeps samples from the first keyframe', async () => {
  const clip = makeClip({ width: 40, height: 40, frames: 5 });
  const trimmed = await trimCopy(clip, { startUs: 0, endUs: 1_000_000 });
  const tracks = new SimpleMp4Demuxer(
    trimmed.buffer.slice(trimmed.byteOffset, trimmed.byteOffset + trimmed.byteLength)
  ).parse();
  const video = tracks.find((t) => t.kind === 'video');
  assert.ok(video && video.samples.length >= 1);
  assert.equal(video.samples[0].type, 'key');
});

test('pixel APIs are NOT_IMPLEMENTED in Node', async () => {
  const clip = makeClip({ width: 16, height: 16, frames: 2 });
  await assert.rejects(() => extractStills(clip), (err) => {
    assert.equal(err.code, 'NOT_IMPLEMENTED');
    return true;
  });
  await assert.rejects(() => concatXfade([clip, clip]), (err) => {
    assert.equal(err.code, 'NOT_IMPLEMENTED');
    return true;
  });
  await assert.rejects(() => concatTranscode([clip, clip]), (err) => {
    assert.equal(err.code, 'NOT_IMPLEMENTED');
    return true;
  });
});

test('node entry does not import gpu renderer', () => {
  const nodePath = fileURLToPath(new URL('../src/node.ts', import.meta.url));
  const src = readFileSync(nodePath, 'utf8');
  assert.equal(src.includes('gpu-renderer'), false);
  assert.equal(src.includes('live/'), false);
  assert.ok(src.includes('concat-copy'));
});
