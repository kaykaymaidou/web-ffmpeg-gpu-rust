import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const root = process.cwd();
const resultsDir = join(root, 'tests/benchmark/results');
const ladderDir = join(root, 'tests/fixtures/bitrate-ladder');
const incomingDir = join(root, 'tests/fixtures/incoming');
const nativePath = join(resultsDir, 'ffmpeg-native.json');

type NativeClip = {
  id: string;
  label: string;
  sourceKind: string;
  file: string;
  source: {
    codec: string;
    width: number | null;
    height: number | null;
    fps: number | null;
    durationSec: number | null;
    sizeBytes: number;
  };
  ffmpeg: {
    decodeMs: number;
    decodeFps: number;
    transcodeMs: number;
    transcodeFps: number;
    transcodeXRealtime: number;
    outputBytes: number;
    encoder: string;
    target: string;
  };
  ffmpegNvenc?: {
    transcodeMs?: number;
    transcodeFps?: number;
    transcodeXRealtime?: number;
    outputBytes?: number;
    encoder?: string;
    error?: string;
  } | null;
};

type GpuResult = {
  parseMs: number | null;
  decodeMs: number | null;
  decodeFps: number | null;
  decodedFrames: number;
  droppedFrames: number;
  transcodeMs: number | null;
  transcodeFps: number | null;
  transcodeXRealtime: number | null;
  outputBytes: number | null;
  avgRealtime: number | null;
  codec: string | null;
  error: string | null;
};

function listClipFiles(): Array<{ id: string; label: string; file: string; sourceKind: string }> {
  const clips: Array<{ id: string; label: string; file: string; sourceKind: string }> = [];
  if (existsSync(ladderDir)) {
    for (const name of readdirSync(ladderDir).filter((n) => n.endsWith('.mp4'))) {
      clips.push({
        id: basename(name, '.mp4'),
        label: basename(name, '.mp4'),
        file: join(ladderDir, name),
        sourceKind: 'synthetic-ladder',
      });
    }
  }
  if (existsSync(incomingDir)) {
    for (const name of readdirSync(incomingDir).filter((n) => /\.(mp4|m4v|mov)$/i.test(n))) {
      clips.push({
        id: `incoming-${basename(name).replace(/\.[^.]+$/, '')}`,
        label: `incoming: ${name}`,
        file: join(incomingDir, name),
        sourceKind: 'incoming',
      });
    }
  }
  return clips;
}

test.describe('Native ffmpeg vs WebCodecs GPU', () => {
  test('decode + social-720p transcode across bitrate ladder', async ({ page }) => {
    test.setTimeout(240_000);
    expect(existsSync(nativePath), 'run `node scripts/bench-vs-ffmpeg.mjs` first').toBe(true);

    const native = JSON.parse(readFileSync(nativePath, 'utf8')) as {
      capturedAt: string;
      machine: Record<string, string>;
      ffmpeg: Record<string, unknown>;
      methodology: Record<string, string>;
      clips: NativeClip[];
    };

    const files = listClipFiles();
    expect(files.length).toBeGreaterThan(0);

    await page.goto('/');
    await page.waitForFunction(() => {
      const w = window as any;
      return !!(w.WebFfmpegTranscoder && w.SimpleMp4Demuxer && w.HardwareVideoDecoder);
    });

    const gpuById = new Map<string, GpuResult>();

    for (const clip of files) {
      const b64 = readFileSync(clip.file).toString('base64');
      const gpu = await page.evaluate(async (payload: { b64: string }) => {
        const w = window as any;
        const binary = atob(payload.b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const buffer = bytes.buffer;

        const out: GpuResult = {
          parseMs: null,
          decodeMs: null,
          decodeFps: null,
          decodedFrames: 0,
          droppedFrames: 0,
          transcodeMs: null,
          transcodeFps: null,
          transcodeXRealtime: null,
          outputBytes: null,
          avgRealtime: null,
          codec: null,
          error: null,
        };

        try {
          const parseStart = performance.now();
          const demuxer = new w.SimpleMp4Demuxer(buffer);
          const tracks = demuxer.parse();
          out.parseMs = Math.round(performance.now() - parseStart);

          const videoTrack = tracks.find(
            (t: { codec: string; samples: unknown[] }) =>
              t.codec.startsWith('avc1') || t.codec.startsWith('hvc1')
          );
          if (!videoTrack || videoTrack.samples.length === 0) {
            throw new Error('No H.264/H.265 video track (engine currently demuxes MP4 avc1/hvc1 only)');
          }
          out.codec = videoTrack.codec;

          const firstKey = videoTrack.samples.findIndex((s: { type: string }) => s.type === 'key');
          const samples =
            firstKey > 0 ? videoTrack.samples.slice(firstKey) : videoTrack.samples;

          let decoded = 0;
          let decodeError = '';
          const decoder = new w.HardwareVideoDecoder(
            (frame: VideoFrame) => {
              decoded++;
              frame.close();
            },
            (err: DOMException) => {
              decodeError = err?.message || String(err);
            }
          );
          const configured = await decoder.configure({
            codec: videoTrack.codec,
            description: videoTrack.description,
            codedWidth: videoTrack.width,
            codedHeight: videoTrack.height,
          });
          if (!configured) {
            throw new Error(`VideoDecoder rejected ${videoTrack.codec}`);
          }

          const decodeStart = performance.now();
          for (const sample of samples) {
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
          const decodeMs = performance.now() - decodeStart;
          const stats = decoder.getStats();
          decoder.close();
          out.decodeMs = Math.round(decodeMs);
          out.decodedFrames = Math.max(decoded, stats.decoded);
          out.droppedFrames = stats.dropped;
          out.decodeFps =
            decodeMs > 0 ? Math.round((out.decodedFrames / (decodeMs / 1000)) * 10) / 10 : 0;
          if (out.decodedFrames === 0 && decodeError) {
            throw new Error(`decode produced 0 frames: ${decodeError}`);
          }

          const transcoder = new w.WebFfmpegTranscoder();
          const result = await transcoder.transcode(buffer, { preset: 'social-720p' });
          out.transcodeMs = Math.round(result.totalTimeMs);
          out.transcodeFps = result.avgFps;
          out.transcodeXRealtime = result.avgRealtime;
          out.outputBytes = result.outputSizeBytes;
          out.avgRealtime = result.avgRealtime;
          if (typeof result.decodedFrames === 'number' && result.decodedFrames > out.decodedFrames) {
            out.decodedFrames = result.decodedFrames;
          }
        } catch (err: any) {
          out.error = err?.message || String(err);
        }
        return out;
      }, { b64 });

      gpuById.set(clip.id, gpu);
      console.log(
        `[gpu] ${clip.id}: parse=${gpu.parseMs}ms decode=${gpu.decodeMs}ms/${gpu.decodeFps}fps transcode=${gpu.transcodeMs}ms ${gpu.transcodeXRealtime}x err=${gpu.error ?? 'none'}`
      );
    }

    const merged = {
      capturedAt: new Date().toISOString(),
      nativeCapturedAt: native.capturedAt,
      machine: native.machine,
      ffmpeg: native.ffmpeg,
      methodology: {
        ...native.methodology,
        gpuDecode: 'SimpleMp4Demuxer + HardwareVideoDecoder (WebCodecs prefer-hardware), close every VideoFrame',
        gpuTranscode: 'WebFfmpegTranscoder preset social-720p (720p / 2.5 Mbps, FastStart MP4)',
      },
      clips: native.clips.map((clip) => {
        const gpu = gpuById.get(clip.id) ?? null;
        const decodeSpeedup =
          gpu?.decodeMs && gpu.decodeMs > 0
            ? Math.round((clip.ffmpeg.decodeMs / gpu.decodeMs) * 100) / 100
            : null;
        const transcodeSpeedup =
          gpu?.transcodeMs && gpu.transcodeMs > 0
            ? Math.round((clip.ffmpeg.transcodeMs / gpu.transcodeMs) * 100) / 100
            : null;
        const nvencMs =
          clip.ffmpegNvenc && typeof clip.ffmpegNvenc.transcodeMs === 'number'
            ? clip.ffmpegNvenc.transcodeMs
            : null;
        const vsNvenc =
          gpu?.transcodeMs && gpu.transcodeMs > 0 && nvencMs
            ? Math.round((nvencMs / gpu.transcodeMs) * 100) / 100
            : null;
        return {
          ...clip,
          gpu,
          speedup: { decode: decodeSpeedup, transcodeVsLibx264: transcodeSpeedup, transcodeVsNvenc: vsNvenc },
        };
      }),
    };

    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, 'comparison.json'), JSON.stringify(merged, null, 2));

    const ok = merged.clips.filter((c) => c.gpu && !c.gpu.error);
    expect(ok.length, `GPU bench failures: ${JSON.stringify(merged.clips.map((c) => [c.id, c.gpu?.error]))}`).toBeGreaterThan(0);
    for (const clip of ok) {
      expect(clip.gpu!.decodedFrames).toBeGreaterThan(10);
      expect(clip.gpu!.transcodeMs).toBeGreaterThan(0);
    }
  });
});
