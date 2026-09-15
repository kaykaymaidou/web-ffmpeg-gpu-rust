import { test, expect } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const root = process.cwd();
const resultsDir = join(root, 'tests/benchmark/results');
const ladderDir = join(root, 'tests/fixtures/bitrate-ladder');
const incomingDir = join(root, 'tests/fixtures/incoming');
const publicClips = join(root, 'apps/playground/public/bench-clips');

type Clip = { id: string; name: string; durationSec: number; frames: number };

function listClips(): Clip[] {
  const clips: Clip[] = [];
  const add = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).filter((n) => /\.(mp4|m4v)$/i.test(n))) {
      const id = basename(name).replace(/\.[^.]+$/, '');
      const is60 = /60/.test(id);
      clips.push({
        id,
        name,
        durationSec: 4,
        frames: is60 ? 240 : 120,
      });
      copyFileSync(join(dir, name), join(publicClips, name));
    }
  };
  mkdirSync(publicClips, { recursive: true });
  add(ladderDir);
  add(incomingDir);
  return clips;
}

test.describe('ffmpeg.wasm vs WebCodecs (same browser)', () => {
  test('decode + social-720p transcode', async ({ page }) => {
    test.setTimeout(900_000);
    const clips = listClips();
    expect(clips.length).toBeGreaterThan(0);

    await page.goto('/');
    await page.waitForFunction(() => {
      const w = window as any;
      return !!(w.loadFfmpegWasm && w.WebFfmpegTranscoder && w.HardwareVideoDecoder);
    });

    const loadMs = await page.evaluate(async () => {
      const w = window as any;
      const t0 = performance.now();
      w.__ffmpegWasm = await w.loadFfmpegWasm();
      return Math.round(performance.now() - t0);
    });
    console.log(`[ffmpeg.wasm] core load ${loadMs}ms`);

    const rows = [];

    for (const clip of clips) {
      const doWasmTranscode = /^(360p30-800k|720p30-2m|1080p30-8m)$/.test(clip.id);
      const row = await page.evaluate(
        async (payload: {
          name: string;
          durationSec: number;
          frames: number;
          doWasmTranscode: boolean;
        }) => {
          const w = window as any;
          const ffmpeg = w.__ffmpegWasm as {
            writeFile: (n: string, d: Uint8Array) => Promise<void>;
            exec: (args: string[]) => Promise<number>;
            readFile: (n: string) => Promise<Uint8Array>;
            deleteFile: (n: string) => Promise<void>;
          };

          const res = await fetch(`/bench-clips/${payload.name}`);
          const fetched = await res.arrayBuffer();
          const wasmBytes = new Uint8Array(fetched.slice(0));
          const buffer = fetched.slice(0);

          const out: Record<string, unknown> = {
            wasmDecodeMs: null,
            wasmDecodeFps: null,
            wasmTranscodeMs: null,
            wasmTranscodeX: null,
            wasmTranscodeBytes: null,
            wasmError: null,
            gpuParseMs: null,
            gpuDecodeMs: null,
            gpuDecodeFps: null,
            gpuDecodedFrames: 0,
            gpuTranscodeMs: null,
            gpuTranscodeX: null,
            gpuTranscodeBytes: null,
            gpuError: null,
            codec: null,
          };

          try {
            await ffmpeg.writeFile('in.mp4', wasmBytes);
            const d0 = performance.now();
            const decodeCode = await ffmpeg.exec(['-hide_banner', '-i', 'in.mp4', '-an', '-f', 'null', '-']);
            const wasmDecodeMs = performance.now() - d0;
            if (decodeCode !== 0) {
              throw new Error(`ffmpeg.wasm decode exit ${decodeCode}`);
            }
            out.wasmDecodeMs = Math.round(wasmDecodeMs);
            out.wasmDecodeFps =
              wasmDecodeMs > 0
                ? Math.round((payload.frames / (wasmDecodeMs / 1000)) * 10) / 10
                : 0;

            if (payload.doWasmTranscode) {
              const t0 = performance.now();
              const code = await ffmpeg.exec([
                '-hide_banner',
                '-i',
                'in.mp4',
                '-c:v',
                'libx264',
                '-preset',
                'ultrafast',
                '-pix_fmt',
                'yuv420p',
                '-b:v',
                '2500k',
                '-vf',
                'scale=-2:720',
                '-an',
                'out.mp4',
              ]);
              const wasmTranscodeMs = performance.now() - t0;
              if (code !== 0) {
                throw new Error(`ffmpeg.wasm transcode exit ${code}`);
              }
              const encoded = await ffmpeg.readFile('out.mp4');
              out.wasmTranscodeMs = Math.round(wasmTranscodeMs);
              out.wasmTranscodeX =
                payload.durationSec > 0
                  ? Math.round((payload.durationSec / (wasmTranscodeMs / 1000)) * 100) / 100
                  : 0;
              out.wasmTranscodeBytes = encoded.byteLength;
              try {
                await ffmpeg.deleteFile('out.mp4');
              } catch {}
            }
            try {
              await ffmpeg.deleteFile('in.mp4');
            } catch {}
          } catch (err: any) {
            out.wasmError = err?.message || String(err);
          }

          try {
            const parseStart = performance.now();
            const demuxer = new w.SimpleMp4Demuxer(buffer);
            const tracks = demuxer.parse();
            out.gpuParseMs = Math.round(performance.now() - parseStart);
            const videoTrack = tracks.find(
              (t: { codec: string; samples: unknown[] }) =>
                t.codec.startsWith('avc1') || t.codec.startsWith('hvc1')
            );
            if (!videoTrack) throw new Error('no avc1/hvc1 track');
            out.codec = videoTrack.codec;

            let decoded = 0;
            const decoder = new w.HardwareVideoDecoder((frame: VideoFrame) => {
              decoded++;
              frame.close();
            });
            const ok = await decoder.configure({
              codec: videoTrack.codec,
              description: videoTrack.description,
              codedWidth: videoTrack.width,
              codedHeight: videoTrack.height,
            });
            if (!ok) throw new Error(`VideoDecoder rejected ${videoTrack.codec}`);
            const d0 = performance.now();
            for (const sample of videoTrack.samples) {
              while (decoder.getQueueSize() >= 8) {
                await new Promise((r) => setTimeout(r, 2));
              }
              decoder.decodeChunk(
                new EncodedVideoChunk({
                  type: sample.type,
                  timestamp: sample.timestamp,
                  duration: sample.duration || 33333,
                  data: sample.data,
                })
              );
            }
            await decoder.flush();
            const gpuDecodeMs = performance.now() - d0;
            decoder.close();
            out.gpuDecodeMs = Math.round(gpuDecodeMs);
            out.gpuDecodedFrames = decoded;
            out.gpuDecodeFps =
              gpuDecodeMs > 0 ? Math.round((decoded / (gpuDecodeMs / 1000)) * 10) / 10 : 0;

            const transcoder = new w.WebFfmpegTranscoder();
            const result = await transcoder.transcode(buffer, { preset: 'social-720p', muteAudio: true });
            out.gpuTranscodeMs = Math.round(result.totalTimeMs);
            out.gpuTranscodeX = result.avgRealtime;
            out.gpuTranscodeBytes = result.outputSizeBytes;
          } catch (err: any) {
            out.gpuError = err?.message || String(err);
          }

          return out;
        },
        { name: clip.name, durationSec: clip.durationSec, frames: clip.frames, doWasmTranscode }
      );

      console.log(
        `[clip ${clip.id}] wasm decode=${row.wasmDecodeMs}ms/${row.wasmDecodeFps}fps xcode=${row.wasmTranscodeMs}ms ${row.wasmTranscodeX}x | gpu decode=${row.gpuDecodeMs}ms/${row.gpuDecodeFps}fps xcode=${row.gpuTranscodeMs}ms ${row.gpuTranscodeX}x wasmErr=${row.wasmError ?? 'none'} gpuErr=${row.gpuError ?? 'none'}`
      );
      rows.push({
        id: clip.id,
        wasmTranscodeRan: doWasmTranscode,
        decodeSpeedup:
          typeof row.wasmDecodeMs === 'number' &&
          typeof row.gpuDecodeMs === 'number' &&
          (row.gpuDecodeMs as number) > 0
            ? Math.round(((row.wasmDecodeMs as number) / (row.gpuDecodeMs as number)) * 100) / 100
            : null,
        transcodeSpeedup:
          typeof row.wasmTranscodeMs === 'number' &&
          typeof row.gpuTranscodeMs === 'number' &&
          (row.gpuTranscodeMs as number) > 0
            ? Math.round(((row.wasmTranscodeMs as number) / (row.gpuTranscodeMs as number)) * 100) / 100
            : null,
        ...row,
      });
    }

    mkdirSync(resultsDir, { recursive: true });
    const payload = {
      capturedAt: new Date().toISOString(),
      ffmpegWasmLoadMs: loadMs,
      methodology: {
        wasmDecode: 'ffmpeg.wasm @ffmpeg/core single-thread, -an -f null -',
        wasmTranscode:
          'ffmpeg.wasm libx264 -preset ultrafast, scale=-2:720, 2500k (360p/720p/1080p-8m only; 20M and 60fps skipped to bound runtime)',
        gpuDecode: 'SimpleMp4Demuxer + HardwareVideoDecoder prefer-hardware',
        gpuTranscode: 'WebFfmpegTranscoder social-720p muteAudio',
      },
      clips: rows,
    };
    writeFileSync(join(resultsDir, 'ffmpeg-wasm-vs-webcodecs.json'), JSON.stringify(payload, null, 2));

    const ok = rows.filter((r) => !r.gpuError && !r.wasmError);
    expect(ok.length).toBeGreaterThan(0);
    for (const clip of ok) {
      expect(clip.gpuDecodedFrames as number).toBeGreaterThan(10);
    }
  });
});
