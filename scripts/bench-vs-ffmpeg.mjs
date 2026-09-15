/**
 * Generate a bitrate-ladder of H.264 MP4 clips and time native ffmpeg
 * (ffmpeg-static, libx264 software) decode + social-720p transcode.
 *
 * Drop extra files into tests/fixtures/incoming/ and re-run; they are
 * picked up automatically.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ffmpegBin = require('ffmpeg-static');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ladderDir = join(root, 'tests/fixtures/bitrate-ladder');
const incomingDir = join(root, 'tests/fixtures/incoming');
const resultsDir = join(root, 'tests/benchmark/results');
const force = process.argv.includes('--force');

const LADDER = [
  {
    id: '360p30-800k',
    label: '360p30 @ 800 kbps',
    size: '640x360',
    fps: 30,
    duration: 4,
    videoBitrate: '800k',
    extra: [],
  },
  {
    id: '720p30-2m',
    label: '720p30 @ 2 Mbps',
    size: '1280x720',
    fps: 30,
    duration: 4,
    videoBitrate: '2M',
    extra: [],
  },
  {
    id: '1080p30-8m',
    label: '1080p30 @ 8 Mbps',
    size: '1920x1080',
    fps: 30,
    duration: 4,
    videoBitrate: '8M',
    extra: [],
  },
  {
    id: '1080p30-20m',
    label: '1080p30 @ 20 Mbps',
    size: '1920x1080',
    fps: 30,
    duration: 4,
    videoBitrate: '20M',
    extra: [],
  },
  {
    id: '1080p60-12m-bframes',
    label: '1080p60 @ 12 Mbps (B-frames)',
    size: '1920x1080',
    fps: 60,
    duration: 4,
    videoBitrate: '12M',
    extra: ['-bf', '3', '-g', '60'],
  },
];

function runFfmpeg(args, { allowFail = false } = {}) {
  const started = performance.now();
  const result = spawnSync(ffmpegBin, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  const wallMs = Math.round(performance.now() - started);
  const stderr = `${result.stderr || ''}${result.stdout || ''}`;
  if (result.status !== 0 && !allowFail) {
    throw new Error(`ffmpeg failed (${result.status}): ${stderr.slice(-800)}`);
  }
  return { wallMs, stderr, status: result.status };
}

function parseBench(stderr) {
  const m = stderr.match(/bench:\s+utime=([\d.]+)s\s+stime=([\d.]+)s\s+rtime=([\d.]+)s/i);
  return m
    ? {
        utimeSec: Number(m[1]),
        stimeSec: Number(m[2]),
        rtimeSec: Number(m[3]),
      }
    : null;
}

function parseVideoMeta(file) {
  const { stderr } = runFfmpeg(['-hide_banner', '-i', file], { allowFail: true });
  const stream = stderr.match(/Stream #0:0.*Video:\s*([^\s,]+).*?,\s*(\d+)x(\d+).*?,\s*([\d.]+)\s*fps/i);
  const duration = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  let durationSec = null;
  if (duration) {
    durationSec =
      Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  }
  return {
    codec: stream?.[1] ?? 'unknown',
    width: stream ? Number(stream[2]) : null,
    height: stream ? Number(stream[3]) : null,
    fps: stream ? Number(stream[4]) : null,
    durationSec,
    sizeBytes: existsSync(file) ? statSync(file).size : 0,
  };
}

function probeFfmpeg() {
  const { stderr } = runFfmpeg(['-version'], { allowFail: true });
  const versionLine = stderr.split('\n').find((l) => l.startsWith('ffmpeg version')) || stderr.slice(0, 120);
  const enc = runFfmpeg(['-hide_banner', '-encoders'], { allowFail: true }).stderr;
  return {
    path: ffmpegBin,
    versionLine: versionLine.trim(),
    hasLibx264: /\blibx264\b/.test(enc),
    hasNvenc: /\bh264_nvenc\b/.test(enc),
    hasQsv: /\bh264_qsv\b/.test(enc),
    hasAmf: /\bh264_amf\b/.test(enc),
  };
}

function generateLadder() {
  mkdirSync(ladderDir, { recursive: true });
  const files = [];
  for (const clip of LADDER) {
    const out = join(ladderDir, `${clip.id}.mp4`);
    if (!existsSync(out) || force) {
      console.log(`generating ${clip.id}…`);
      runFfmpeg([
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${clip.size}:rate=${clip.fps}:duration=${clip.duration}`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:sample_rate=48000:duration=${clip.duration}`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        '-profile:v',
        'high',
        '-b:v',
        clip.videoBitrate,
        '-maxrate',
        clip.videoBitrate,
        '-bufsize',
        clip.videoBitrate,
        ...clip.extra,
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        out,
      ]);
    }
    files.push({
      id: clip.id,
      label: clip.label,
      path: out,
      sourceKind: 'synthetic-ladder',
      nominal: {
        size: clip.size,
        fps: clip.fps,
        duration: clip.duration,
        videoBitrate: clip.videoBitrate,
      },
    });
  }
  return files;
}

function collectIncoming() {
  mkdirSync(incomingDir, { recursive: true });
  return readdirSync(incomingDir)
    .filter((name) => /\.(mp4|m4v|mov)$/i.test(name))
    .map((name) => {
      const path = join(incomingDir, name);
      return {
        id: `incoming-${basename(name, '.mp4')}`,
        label: `incoming: ${name}`,
        path,
        sourceKind: 'incoming',
        nominal: null,
      };
    });
}

function benchClip(clip) {
  const meta = parseVideoMeta(clip.path);
  const fps = meta.fps || clip.nominal?.fps || 30;
  const durationSec = meta.durationSec || clip.nominal?.duration || 0;
  const frameCount = Math.round(fps * durationSec);

  const decode = runFfmpeg([
    '-hide_banner',
    '-nostats',
    '-benchmark',
    '-i',
    clip.path,
    '-an',
    '-f',
    'null',
    '-',
  ]);
  const decodeBench = parseBench(decode.stderr);
  const decodeMs = Math.round((decodeBench?.rtimeSec ?? decode.wallMs / 1000) * 1000);
  const decodeFps = decodeMs > 0 ? Math.round((frameCount / (decodeMs / 1000)) * 10) / 10 : 0;

  const tmpOut = join(resultsDir, `_ffmpeg_${clip.id}.mp4`);
  const transcode = runFfmpeg([
    '-y',
    '-hide_banner',
    '-nostats',
    '-benchmark',
    '-i',
    clip.path,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    '2500k',
    '-maxrate',
    '2500k',
    '-bufsize',
    '5000k',
    '-vf',
    'scale=-2:720',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    tmpOut,
  ]);
  const transcodeBench = parseBench(transcode.stderr);
  const transcodeMs = Math.round((transcodeBench?.rtimeSec ?? transcode.wallMs / 1000) * 1000);
  const transcodeFps = transcodeMs > 0 ? Math.round((frameCount / (transcodeMs / 1000)) * 10) / 10 : 0;
  const transcodeXRealtime =
    durationSec > 0 ? Math.round((durationSec / (transcodeMs / 1000)) * 100) / 100 : 0;

  const row = {
    id: clip.id,
    label: clip.label,
    sourceKind: clip.sourceKind,
    file: clip.path,
    source: meta,
    ffmpeg: {
      decodeMs,
      decodeFps,
      decodeUtimeSec: decodeBench?.utimeSec ?? null,
      transcodeMs,
      transcodeFps,
      transcodeXRealtime,
      transcodeUtimeSec: transcodeBench?.utimeSec ?? null,
      outputBytes: existsSync(tmpOut) ? statSync(tmpOut).size : 0,
      encoder: 'libx264 -preset veryfast',
      target: 'social-720p 2.5 Mbps',
    },
    ffmpegNvenc: null,
  };

  const nvencOut = join(resultsDir, `_ffmpeg_nvenc_${clip.id}.mp4`);
  try {
    const nvenc = runFfmpeg([
      '-y',
      '-hide_banner',
      '-nostats',
      '-benchmark',
      '-i',
      clip.path,
      '-c:v',
      'h264_nvenc',
      '-preset',
      'p1',
      '-b:v',
      '2500k',
      '-maxrate',
      '2500k',
      '-bufsize',
      '5000k',
      '-vf',
      'scale=-2:720',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      nvencOut,
    ]);
    const nvencBench = parseBench(nvenc.stderr);
    const transcodeMs = Math.round((nvencBench?.rtimeSec ?? nvenc.wallMs / 1000) * 1000);
    row.ffmpegNvenc = {
      transcodeMs,
      transcodeFps: transcodeMs > 0 ? Math.round((frameCount / (transcodeMs / 1000)) * 10) / 10 : 0,
      transcodeXRealtime:
        durationSec > 0 ? Math.round((durationSec / (transcodeMs / 1000)) * 100) / 100 : 0,
      outputBytes: existsSync(nvencOut) ? statSync(nvencOut).size : 0,
      encoder: 'h264_nvenc -preset p1',
    };
  } catch (err) {
    row.ffmpegNvenc = { error: err instanceof Error ? err.message.slice(0, 240) : String(err) };
  }

  return row;
}

mkdirSync(resultsDir, { recursive: true });
mkdirSync(incomingDir, { recursive: true });

const ffmpegInfo = probeFfmpeg();
console.log(ffmpegInfo.versionLine);
console.log(`binary: ${ffmpegInfo.path}`);
console.log(
  `encoders: libx264=${ffmpegInfo.hasLibx264} nvenc=${ffmpegInfo.hasNvenc} qsv=${ffmpegInfo.hasQsv} amf=${ffmpegInfo.hasAmf}`
);

const clips = [...generateLadder(), ...collectIncoming()];
const results = clips.map((clip) => {
  console.log(`ffmpeg bench ${clip.id}…`);
  return benchClip(clip);
});

const payload = {
  capturedAt: new Date().toISOString(),
  machine: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  },
  ffmpeg: ffmpegInfo,
  methodology: {
    decode: 'ffmpeg -benchmark -i FILE -an -f null -  (software decode)',
    transcode:
      'ffmpeg libx264 veryfast AND optional h264_nvenc p1, scale=-2:720, 2500k, AAC 128k, +faststart — matches WebFfmpegTranscoder social-720p',
    note: 'Decode is ffmpeg software. libx264 is CPU encode. h264_nvenc is native GPU encode when the driver is present. Browser path is WebCodecs VideoDecoder/VideoEncoder prefer-hardware.',
  },
  clips: results,
};

const outFile = join(resultsDir, 'ffmpeg-native.json');
writeFileSync(outFile, JSON.stringify(payload, null, 2));
console.log(`wrote ${outFile}`);
for (const clip of results) {
  console.log(
    `  ${clip.id}: decode ${clip.ffmpeg.decodeMs}ms (${clip.ffmpeg.decodeFps} fps)  x264 ${clip.ffmpeg.transcodeMs}ms (${clip.ffmpeg.transcodeXRealtime}x)` +
      (clip.ffmpegNvenc && !clip.ffmpegNvenc.error
        ? `  nvenc ${clip.ffmpegNvenc.transcodeMs}ms (${clip.ffmpegNvenc.transcodeXRealtime}x)`
        : clip.ffmpegNvenc?.error
          ? `  nvenc FAIL`
          : '')
  );
}
