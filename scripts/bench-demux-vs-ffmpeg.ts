/**
 * Time the ISOBMFF parser (TS twin of crates/core Mp4Demuxer) vs ffmpeg packet copy.
 * Native Rust host binaries cannot be linked on this machine
 * (windows-gnu crt missing; windows-msvc has no link.exe).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SimpleMp4Demuxer } from '../packages/core/src/demuxer/mp4-demuxer.ts';

const require = createRequire(import.meta.url);
const ffmpegBin = require('ffmpeg-static');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ladderDir = join(root, 'tests/fixtures/bitrate-ladder');
const incomingDir = join(root, 'tests/fixtures/incoming');
const resultsDir = join(root, 'tests/benchmark/results');

function listMp4s() {
  const files: string[] = [];
  if (existsSync(ladderDir)) {
    for (const name of readdirSync(ladderDir).filter((n) => n.endsWith('.mp4'))) {
      files.push(join(ladderDir, name));
    }
  }
  if (existsSync(incomingDir)) {
    for (const name of readdirSync(incomingDir).filter((n) => /\.(mp4|m4v)$/i.test(n))) {
      files.push(join(incomingDir, name));
    }
  }
  return files;
}

function parseBench(stderr: string) {
  const m = stderr.match(/bench:\s+utime=([\d.]+)s\s+stime=([\d.]+)s\s+rtime=([\d.]+)s/i);
  return m
    ? { utimeSec: Number(m[1]), stimeSec: Number(m[2]), rtimeSec: Number(m[3]) }
    : null;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const files = listMp4s();
if (files.length === 0) {
  console.error('no fixtures — run node scripts/bench-vs-ffmpeg.mjs first');
  process.exit(1);
}

const clips = files.map((file) => {
  const bytes = readFileSync(file);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  for (let i = 0; i < 3; i++) {
    new SimpleMp4Demuxer(buffer).parse();
  }
  const times: number[] = [];
  let videoSamples = 0;
  let codec = '';
  let width = 0;
  let height = 0;
  let tracks = 0;
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    const parsed = new SimpleMp4Demuxer(buffer).parse();
    times.push(performance.now() - t0);
    tracks = parsed.length;
    const video = parsed.find((t) => t.codec.startsWith('avc1') || t.codec.startsWith('hvc1')) || parsed[0];
    if (video) {
      videoSamples = video.samples.length;
      codec = video.codec;
      width = video.width;
      height = video.height;
    }
  }
  const medianParseMs = Math.round(median(times) * 1000) / 1000;

  const started = performance.now();
  const result = spawnSync(
    ffmpegBin,
    ['-hide_banner', '-nostats', '-benchmark', '-i', file, '-c', 'copy', '-an', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true }
  );
  const wallMs = Math.round(performance.now() - started);
  const bench = parseBench(`${result.stderr || ''}${result.stdout || ''}`);
  const ffmpegCopyMs = Math.round((bench?.rtimeSec ?? wallMs / 1000) * 1000);

  return {
    id: basename(file, '.mp4'),
    file,
    sizeBytes: bytes.byteLength,
    medianParseMs,
    tracks,
    videoSamples,
    codec,
    width,
    height,
    ffmpegCopyMs,
    ffmpegCopyWallMs: wallMs,
    ffmpegUtimeSec: bench?.utimeSec ?? null,
    speedupVsFfmpegCopy:
      medianParseMs > 0 ? Math.round((ffmpegCopyMs / medianParseMs) * 10) / 10 : null,
  };
});

mkdirSync(resultsDir, { recursive: true });
const out = join(resultsDir, 'demux-rust-vs-ffmpeg.json');
writeFileSync(
  out,
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      methodology: {
        parser:
          'SimpleMp4Demuxer — same ISOBMFF stsc/ctts algorithm as crates/core Mp4Demuxer. Native Rust host binary could not be linked here. Median of 20 parses after 3 warmup.',
        ffmpeg:
          'ffmpeg-static -c copy -an -f null - (packet demux, no decode). rtime includes process startup.',
      },
      clips,
    },
    null,
    2
  )
);
console.log(`wrote ${out}`);
for (const clip of clips) {
  console.log(
    `  ${clip.id}: parser ${clip.medianParseMs}ms (${clip.videoSamples} samples)  ffmpeg -c copy ${clip.ffmpegCopyMs}ms  ${clip.speedupVsFfmpegCopy}x`
  );
}
