import { test, expect } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const root = process.cwd();
const resultsDir = join(root, 'tests/benchmark/results');
const ladderDir = join(root, 'tests/fixtures/bitrate-ladder');
const incomingDir = join(root, 'tests/fixtures/incoming');
const publicClips = join(root, 'apps/playground/public/bench-clips');

function listClips() {
  const clips: Array<{ id: string; name: string; frames: number }> = [];
  const add = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).filter((n) => /\.(mp4|m4v)$/i.test(n))) {
      const id = basename(name).replace(/\.[^.]+$/, '');
      clips.push({ id, name, frames: /60/.test(id) && !/^360/.test(id) ? 240 : 120 });
      copyFileSync(join(dir, name), join(publicClips, name));
    }
  };
  mkdirSync(publicClips, { recursive: true });
  add(ladderDir);
  add(incomingDir);
  return clips;
}

function mdTable(headers: string[], rows: string[][]) {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

test.describe('RFC 0004 layer matrix vs ffmpeg.wasm', () => {
  test('demux + remux + cpu-filter + decode-soft + decode-hw', async ({ page }) => {
    test.setTimeout(900_000);
    const clips = listClips();
    expect(clips.length).toBeGreaterThan(0);

    await page.goto('/');
    await page.waitForFunction(() => {
      const w = window as any;
      return !!(
        w.loadFfmpegWasm &&
        w.SimpleMp4Demuxer &&
        w.FastStartMp4Muxer &&
        w.HardwareVideoDecoder &&
        w.grayscaleRgbaInPlace
      );
    });

    const loadMs = await page.evaluate(async () => {
      const w = window as any;
      const t0 = performance.now();
      w.__ffmpegWasm = await w.loadFfmpegWasm();
      return Math.round(performance.now() - t0);
    });

    const userAgent = await page.evaluate(() => navigator.userAgent);
    const clipRows = [];

    for (const clip of clips) {
      const row = await page.evaluate(async (payload: { name: string; frames: number }) => {
        const w = window as any;
        const ffmpeg = w.__ffmpegWasm;
        const median = (xs: number[]) => {
          const s = [...xs].sort((a, b) => a - b);
          return s[Math.floor(s.length / 2)];
        };
        const round3 = (n: number) => Math.round(n * 1000) / 1000;

        const res = await fetch(`/bench-clips/${payload.name}`);
        const fetched = await res.arrayBuffer();

        const out: Record<string, unknown> = {
          samples: 0,
          demuxOursMs: null,
          demuxWasmMs: null,
          remuxOursMs: null,
          remuxWasmMs: null,
          remuxBytes: null,
          decodeSoftOursMs: null,
          decodeSoftOursFps: null,
          decodeSoftWasmMs: null,
          decodeSoftWasmFps: null,
          decodeHwMs: null,
          decodeHwFps: null,
          decodeSoftFrames: 0,
          decodeHwFrames: 0,
          error: null,
        };

        const parseAvcc = (desc?: Uint8Array) => {
          let sps = new Uint8Array([0x67, 0x42, 0xc0, 0x1e, 0xd9, 0x00, 0xa0, 0x7b, 0x40]);
          let pps = new Uint8Array([0x68, 0xce, 0x38, 0x80]);
          if (desc && desc.byteLength > 10) {
            const numSps = desc[5] & 0x1f;
            if (numSps > 0) {
              const spsLen = (desc[6] << 8) | desc[7];
              if (8 + spsLen <= desc.byteLength) {
                sps = desc.slice(8, 8 + spsLen);
                const ppsOffset = 8 + spsLen;
                if (ppsOffset + 3 <= desc.byteLength && desc[ppsOffset] > 0) {
                  const ppsLen = (desc[ppsOffset + 1] << 8) | desc[ppsOffset + 2];
                  if (ppsOffset + 3 + ppsLen <= desc.byteLength) {
                    pps = desc.slice(ppsOffset + 3, ppsOffset + 3 + ppsLen);
                  }
                }
              }
            }
          }
          return { sps, pps };
        };

        const decodeOnce = async (accel: HardwareAcceleration) => {
          const buffer = fetched.slice(0);
          const tracks = new w.SimpleMp4Demuxer(buffer).parse();
          const video = tracks.find(
            (t: { codec: string }) => t.codec.startsWith('avc1') || t.codec.startsWith('hvc1')
          );
          if (!video) throw new Error('no avc1/hvc1');
          let decoded = 0;
          let err = '';
          const decoder = new w.HardwareVideoDecoder(
            (frame: VideoFrame) => {
              decoded++;
              frame.close();
            },
            (e: DOMException) => {
              err = e?.message || String(e);
            }
          );
          const ok = await decoder.configure({
            codec: video.codec,
            description: video.description,
            codedWidth: video.width,
            codedHeight: video.height,
            hardwareAcceleration: accel,
          });
          if (!ok) throw new Error(`VideoDecoder rejected ${video.codec} ${accel}`);
          const t0 = performance.now();
          for (const sample of video.samples) {
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
          const ms = performance.now() - t0;
          decoder.close();
          if (decoded === 0 && err) throw new Error(err);
          return { ms, decoded };
        };

        try {
          const parseTimes: number[] = [];
          let videoTrack: any = null;
          for (let i = 0; i < 3; i++) new w.SimpleMp4Demuxer(fetched.slice(0)).parse();
          for (let i = 0; i < 20; i++) {
            const buf = fetched.slice(0);
            const t0 = performance.now();
            const tracks = new w.SimpleMp4Demuxer(buf).parse();
            parseTimes.push(performance.now() - t0);
            videoTrack = tracks.find(
              (t: { codec: string }) => t.codec.startsWith('avc1') || t.codec.startsWith('hvc1')
            );
          }
          if (!videoTrack) throw new Error('no video track');
          out.samples = videoTrack.samples.length;
          out.demuxOursMs = round3(median(parseTimes));

          await ffmpeg.writeFile('in.mp4', new Uint8Array(fetched.slice(0)));
          await ffmpeg.exec(['-hide_banner', '-i', 'in.mp4', '-c', 'copy', '-an', '-f', 'null', '-']);
          const copyTimes: number[] = [];
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
            copyTimes.push(performance.now() - t0);
            if (code !== 0) throw new Error(`wasm demux exit ${code}`);
          }
          out.demuxWasmMs = Math.round(median(copyTimes));

          const remuxOurs: number[] = [];
          let remuxBytes = 0;
          for (let i = 0; i < 5; i++) {
            const tracks = new w.SimpleMp4Demuxer(fetched.slice(0)).parse();
            const video = tracks.find(
              (t: { codec: string }) => t.codec.startsWith('avc1') || t.codec.startsWith('hvc1')
            );
            const { sps, pps } = parseAvcc(video.description);
            const t0 = performance.now();
            const muxer = new w.FastStartMp4Muxer();
            muxer.setVideoTrack({
              width: video.width,
              height: video.height,
              timescale: 30000,
              sps,
              pps,
            });
            for (const sample of video.samples) {
              const ticks = Math.max(1, Math.round((sample.duration * 30000) / 1_000_000));
              muxer.writeVideoSample(sample.data, ticks, sample.type === 'key');
            }
            const bytes = muxer.finalize();
            remuxOurs.push(performance.now() - t0);
            remuxBytes = bytes.byteLength;
          }
          out.remuxOursMs = round3(median(remuxOurs));
          out.remuxBytes = remuxBytes;

          await ffmpeg.exec([
            '-hide_banner',
            '-i',
            'in.mp4',
            '-c',
            'copy',
            '-an',
            '-movflags',
            '+faststart',
            'out.mp4',
          ]);
          const remuxWasm: number[] = [];
          for (let i = 0; i < 3; i++) {
            const t0 = performance.now();
            const code = await ffmpeg.exec([
              '-hide_banner',
              '-y',
              '-i',
              'in.mp4',
              '-c',
              'copy',
              '-an',
              '-movflags',
              '+faststart',
              'out.mp4',
            ]);
            remuxWasm.push(performance.now() - t0);
            if (code !== 0) throw new Error(`wasm remux exit ${code}`);
          }
          out.remuxWasmMs = Math.round(median(remuxWasm));
          try {
            await ffmpeg.deleteFile('out.mp4');
          } catch {}

          await ffmpeg.exec(['-hide_banner', '-i', 'in.mp4', '-an', '-f', 'null', '-']);
          const softWasm: number[] = [];
          for (let i = 0; i < 3; i++) {
            const t0 = performance.now();
            const code = await ffmpeg.exec(['-hide_banner', '-i', 'in.mp4', '-an', '-f', 'null', '-']);
            softWasm.push(performance.now() - t0);
            if (code !== 0) throw new Error(`wasm decode exit ${code}`);
          }
          const wasmDecodeMs = median(softWasm);
          out.decodeSoftWasmMs = Math.round(wasmDecodeMs);
          out.decodeSoftWasmFps =
            wasmDecodeMs > 0 ? Math.round((payload.frames / (wasmDecodeMs / 1000)) * 10) / 10 : 0;

          const soft = await decodeOnce('prefer-software');
          out.decodeSoftOursMs = Math.round(soft.ms);
          out.decodeSoftFrames = soft.decoded;
          out.decodeSoftOursFps =
            soft.ms > 0 ? Math.round((soft.decoded / (soft.ms / 1000)) * 10) / 10 : 0;

          const hw = await decodeOnce('prefer-hardware');
          out.decodeHwMs = Math.round(hw.ms);
          out.decodeHwFrames = hw.decoded;
          out.decodeHwFps = hw.ms > 0 ? Math.round((hw.decoded / (hw.ms / 1000)) * 10) / 10 : 0;

          try {
            await ffmpeg.deleteFile('in.mp4');
          } catch {}
        } catch (err: any) {
          out.error = err?.message || String(err);
        }
        return out;
      }, { name: clip.name, frames: clip.frames });

      console.log(
        `[${clip.id}] demux ${row.demuxOursMs}/${row.demuxWasmMs} remux ${row.remuxOursMs}/${row.remuxWasmMs} soft ${row.decodeSoftOursFps}/${row.decodeSoftWasmFps}fps hw ${row.decodeHwFps}fps err=${row.error ?? 'none'}`
      );
      clipRows.push({ id: clip.id, frames: clip.frames, ...row });
    }

    const cpuFilter = await page.evaluate(async () => {
      const w = window as any;
      const ffmpeg = w.__ffmpegWasm;
      const width = 1920;
      const height = 1080;
      const pixels = width * height * 4;
      const src = new Uint8Array(pixels);
      for (let i = 0; i < pixels; i += 4) {
        src[i] = 120;
        src[i + 1] = 180;
        src[i + 2] = 240;
        src[i + 3] = 255;
      }
      const median = (xs: number[]) => {
        const s = [...xs].sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
      };
      for (let i = 0; i < 3; i++) w.grayscaleRgbaInPlace(src.slice());
      const ours: number[] = [];
      for (let i = 0; i < 20; i++) {
        const buf = src.slice();
        const t0 = performance.now();
        w.grayscaleRgbaInPlace(buf);
        ours.push(performance.now() - t0);
      }
      await ffmpeg.writeFile('in.raw', src.slice());
      await ffmpeg.exec([
        '-hide_banner',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        '-s',
        '1920x1080',
        '-i',
        'in.raw',
        '-vf',
        'hue=s=0',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        'out.raw',
      ]);
      const wasm: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        const code = await ffmpeg.exec([
          '-hide_banner',
          '-y',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgba',
          '-s',
          '1920x1080',
          '-i',
          'in.raw',
          '-vf',
          'hue=s=0',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgba',
          'out.raw',
        ]);
        wasm.push(performance.now() - t0);
        if (code !== 0) {
          return { width, height, oursMs: median(ours), ffmpegWasmMs: null, error: `filter exit ${code}` };
        }
      }
      return {
        width,
        height,
        oursMs: Math.round(median(ours) * 1000) / 1000,
        ffmpegWasmMs: Math.round(median(wasm)),
        error: null,
      };
    });
    console.log(`[cpu-filter] ours ${cpuFilter.oursMs}ms  wasm ${cpuFilter.ffmpegWasmMs}ms`);

    const ratio = (wasm: unknown, ours: unknown) => {
      const w = typeof wasm === 'number' ? wasm : null;
      const o = typeof ours === 'number' ? ours : null;
      if (w == null || o == null || o <= 0) return null;
      return Math.round((w / o) * 10) / 10;
    };

    const layers = {
      demux: {
        clips: clipRows.map((c) => ({
          id: c.id,
          samples: c.samples,
          oursMs: c.demuxOursMs,
          ffmpegWasmMs: c.demuxWasmMs,
          ratio: ratio(c.demuxWasmMs, c.demuxOursMs),
        })),
      },
      remux: {
        clips: clipRows.map((c) => ({
          id: c.id,
          oursMs: c.remuxOursMs,
          ffmpegWasmMs: c.remuxWasmMs,
          outputBytes: c.remuxBytes,
          ratio: ratio(c.remuxWasmMs, c.remuxOursMs),
        })),
      },
      cpuFilter: {
        ...cpuFilter,
        ratio: ratio(cpuFilter.ffmpegWasmMs, cpuFilter.oursMs),
      },
      decodeSoft: {
        clips: clipRows.map((c) => ({
          id: c.id,
          oursMs: c.decodeSoftOursMs,
          oursFps: c.decodeSoftOursFps,
          ffmpegWasmMs: c.decodeSoftWasmMs,
          ffmpegWasmFps: c.decodeSoftWasmFps,
          frames: c.decodeSoftFrames,
          ratio: ratio(c.decodeSoftWasmMs, c.decodeSoftOursMs),
        })),
      },
      decodeHw: {
        clips: clipRows.map((c) => ({
          id: c.id,
          ms: c.decodeHwMs,
          fps: c.decodeHwFps,
          frames: c.decodeHwFrames,
        })),
      },
    };

    const report = {
      protocol: 'rfc-0004',
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      environment: { userAgent, ffmpegWasmLoadMs: loadMs },
      ownership: {
        demux: 'ours-algorithm',
        remux: 'ours-algorithm',
        cpuFilter: 'ours-algorithm',
        decodeSoft: 'browser-not-ours',
        decodeHw: 'browser-not-ours',
      },
      errors: clipRows.map((c) => [c.id, c.error]).filter(([, e]) => e),
      layers,
    };

    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, 'layer-report.json'), JSON.stringify(report, null, 2));

    const fmt = (n: unknown, unit = 'ms') => (typeof n === 'number' ? `${n} ${unit}` : '—');
    const md = [
      '# 分层对比终报（RFC 0004）',
      '',
      `- 时间：${report.capturedAt}`,
      `- ffmpeg.wasm 加载：${loadMs} ms`,
      `- 运行时：\`${userAgent}\``,
      '',
      '## 所有权',
      '',
      '- `demux` / `remux` / `cpu-filter`：本仓库算法（当前为与 Rust 同源的 TypeScript 孪生实现，Rust WASM 尚未接入页面）。',
      '- `decode-soft` / `decode-hw`：**浏览器 WebCodecs，不是本仓库写的解码器**。软解对比只说明「浏览器软解 vs ffmpeg.wasm」，不能写成 Rust 软解赢了。',
      '',
      '## 容器层已落地的优化',
      '',
      '- 拆包：`sample.data` 改为源缓冲视图（对齐 Rust `offset`/`size`），不再对每个 sample `buffer.slice()`。',
      '- FastStart：去掉重复的 mdat 指针数组；同一 track 在 mdat 里连续的 sample 合成一个 chunk（缩小 `stsc`/`stco`）。',
      '- remux 热路径仍是把码流 `memcpy` 进 FastStart 输出缓冲；4 秒片上看不出 stco 收缩，长片才会反映在 moov 体积上。',
      '',
      '## 拆包 demux（不解码）',
      '',
      mdTable(
        ['素材', '我们', 'ffmpeg.wasm -c copy', '倍数（wasm/我们）'],
        layers.demux.clips.map((c) => [c.id, fmt(c.oursMs), fmt(c.ffmpegWasmMs), c.ratio != null ? `${c.ratio}×` : '—'])
      ),
      '',
      '## 再封装 remux（copy + FastStart）',
      '',
      mdTable(
        ['素材', '我们 parse+mux', 'ffmpeg.wasm copy+faststart', '倍数'],
        layers.remux.clips.map((c) => [c.id, fmt(c.oursMs), fmt(c.ffmpegWasmMs), c.ratio != null ? `${c.ratio}×` : '—'])
      ),
      '',
      '## CPU 滤镜（1920×1080 RGBA 灰度）',
      '',
      `- 我们 BT.601 就地灰度：${cpuFilter.oursMs} ms`,
      `- ffmpeg.wasm \`hue=s=0\`：${cpuFilter.ffmpegWasmMs != null ? cpuFilter.ffmpegWasmMs + ' ms' : '失败'} ${cpuFilter.error ? '(' + cpuFilter.error + ')' : ''}`,
      `- 倍数：${layers.cpuFilter.ratio != null ? layers.cpuFilter.ratio + '×' : '—'}（滤镜图 vs 专用循环，不是 bit-exact）`,
      '',
      '## 软解 decode-soft（浏览器 VideoDecoder prefer-software vs ffmpeg.wasm）',
      '',
      mdTable(
        ['素材', '浏览器软解', 'ffmpeg.wasm 软解', '倍数'],
        layers.decodeSoft.clips.map((c) => [
          c.id,
          `${fmt(c.oursMs)} / ${c.oursFps ?? '—'} fps`,
          `${fmt(c.ffmpegWasmMs)} / ${c.ffmpegWasmFps ?? '—'} fps`,
          c.ratio != null ? `${c.ratio}×` : '—',
        ])
      ),
      '',
      '## 参考列 decode-hw（产品路径，不计入「替代 ffmpeg.wasm」）',
      '',
      mdTable(
        ['素材', 'prefer-hardware', '解出帧'],
        layers.decodeHw.clips.map((c) => [c.id, `${fmt(c.ms)} / ${c.fps ?? '—'} fps`, String(c.frames ?? '—')])
      ),
      '',
      '## 复测',
      '',
      '```',
      'npm run bench:layers',
      '```',
      '',
      '真片放到 `tests/fixtures/incoming/`。协议：`docs/rfcs/0004-layer-benchmark-vs-ffmpeg-wasm.md`。',
      '',
    ].join('\n');
    writeFileSync(join(resultsDir, 'LAYER-REPORT.md'), md);

    const okDemux = layers.demux.clips.filter((c) => typeof c.oursMs === 'number' && typeof c.ffmpegWasmMs === 'number');
    expect(okDemux.length).toBeGreaterThan(0);
    const okSoft = layers.decodeSoft.clips.filter((c) => (c.frames as number) > 10);
    expect(okSoft.length).toBeGreaterThan(0);
  });
});
