import { test, expect } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const root = process.cwd();
const resultsDir = join(root, 'tests/benchmark/results');
const ladderDir = join(root, 'tests/fixtures/bitrate-ladder');
const incomingDir = join(root, 'tests/fixtures/incoming');
const publicClips = join(root, 'apps/playground/public/bench-clips');

function listClips() {
  const clips: Array<{ id: string; name: string }> = [];
  const add = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).filter((n) => /\.(mp4|m4v)$/i.test(n))) {
      clips.push({ id: basename(name).replace(/\.[^.]+$/, ''), name });
      copyFileSync(join(dir, name), join(publicClips, name));
    }
  };
  mkdirSync(publicClips, { recursive: true });
  add(ladderDir);
  add(incomingDir);
  return clips;
}

test.describe('ffmpeg.wasm vs in-page ISOBMFF parser (no WebCodecs)', () => {
  test('packet demux only', async ({ page }) => {
    test.setTimeout(180_000);
    const clips = listClips();
    expect(clips.length).toBeGreaterThan(0);

    await page.goto('/');
    await page.waitForFunction(() => {
      const w = window as any;
      return !!(w.loadFfmpegWasm && w.SimpleMp4Demuxer);
    });

    const loadMs = await page.evaluate(async () => {
      const w = window as any;
      const t0 = performance.now();
      w.__ffmpegWasm = await w.loadFfmpegWasm();
      return Math.round(performance.now() - t0);
    });

    const rows = [];
    for (const clip of clips) {
      const row = await page.evaluate(async (name: string) => {
        const w = window as any;
        const ffmpeg = w.__ffmpegWasm;
        const res = await fetch(`/bench-clips/${name}`);
        const fetched = await res.arrayBuffer();
        const forParser = fetched.slice(0);
        const forWasm = new Uint8Array(fetched.slice(0));

        for (let i = 0; i < 3; i++) {
          new w.SimpleMp4Demuxer(forParser.slice(0)).parse();
        }
        const parseTimes: number[] = [];
        let samples = 0;
        let tracks = 0;
        for (let i = 0; i < 20; i++) {
          const copy = forParser.slice(0);
          const t0 = performance.now();
          const parsed = new w.SimpleMp4Demuxer(copy).parse();
          parseTimes.push(performance.now() - t0);
          tracks = parsed.length;
          const video = parsed.find(
            (t: { codec: string }) => t.codec.startsWith('avc1') || t.codec.startsWith('hvc1')
          ) || parsed[0];
          samples = video?.samples?.length || 0;
        }
        parseTimes.sort((a, b) => a - b);
        const parserMedianMs = Math.round(parseTimes[Math.floor(parseTimes.length / 2)] * 1000) / 1000;

        await ffmpeg.writeFile('in.mp4', forWasm);
        const wasmTimes: number[] = [];
        let wasmError: string | null = null;
        try {
          for (let i = 0; i < 3; i++) {
            const t0 = performance.now();
            const code = await ffmpeg.exec([
              '-hide_banner',
              '-i',
              'in.mp4',
              '-c',
              'copy',
              '-an',
              '-f',
              'null',
              '-',
            ]);
            wasmTimes.push(performance.now() - t0);
            if (code !== 0) throw new Error(`ffmpeg.wasm copy exit ${code}`);
          }
        } catch (err: any) {
          wasmError = err?.message || String(err);
        }
        try {
          await ffmpeg.deleteFile('in.mp4');
        } catch {}
        wasmTimes.sort((a, b) => a - b);
        const wasmCopyMedianMs =
          wasmTimes.length > 0
            ? Math.round(wasmTimes[Math.floor(wasmTimes.length / 2)])
            : null;

        return {
          parserMedianMs,
          wasmCopyMedianMs,
          samples,
          tracks,
          wasmError,
          ratio:
            wasmCopyMedianMs && parserMedianMs > 0
              ? Math.round((wasmCopyMedianMs / parserMedianMs) * 10) / 10
              : null,
        };
      }, clip.name);

      console.log(
        `[demux ${clip.id}] parser ${row.parserMedianMs}ms  ffmpeg.wasm -c copy ${row.wasmCopyMedianMs}ms  ${row.ratio}x  samples=${row.samples} err=${row.wasmError ?? 'none'}`
      );
      rows.push({ id: clip.id, ...row });
    }

    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(
      join(resultsDir, 'ffmpeg-wasm-vs-parser.json'),
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          ffmpegWasmLoadMs: loadMs,
          methodology: {
            parser:
              'In-page SimpleMp4Demuxer (TS twin of crates/core Mp4Demuxer). Rust WASM is not loaded in the playground. Median of 20 parses after 3 warmup.',
            ffmpegWasm:
              'Same Chrome page, @ffmpeg/core -i in.mp4 -c copy -an -f null -. Median of 3. No WebCodecs. No native ffmpeg CLI.',
          },
          clips: rows,
        },
        null,
        2
      )
    );

    const ok = rows.filter((r) => !r.wasmError && r.samples > 0);
    expect(ok.length).toBeGreaterThan(0);
  });
});
