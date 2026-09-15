# RFC 0004: 浏览器内分层性能对比协议（vs ffmpeg.wasm）

- **状态**: Accepted
- **提出时间**: 2026-09-11
- **责任模块**: `crates/core`（目标实现）、`packages/core`（当前孪生实现）、`tests/benchmark/`（Harness）、`apps/playground`（同页加载 ffmpeg.wasm）

---

## 1. 动机

`ffmpeg.wasm` 的瓶颈是 **浏览器里的 CPU 软解/软编与通用滤镜图**。对比必须满足：

1. **同一运行时**：Chrome 同一页面，禁止桌面 `ffmpeg` CLI（进程启动会污染容器层数字）。
2. **同一工作负载**：每一层只比这一层该做的事（拆包不解码，软解不编码）。
3. **所有权标注**：浏览器 WebCodecs / WebGPU 不是本仓库写的编解码器，可以测产品路径，但不能写成「Rust ffmpeg.wasm 赢了」。

当前热路径（截至本 RFC）仍是 TypeScript 解复用 + WebCodecs 编解码。`crates/core` 的 WASM 尚未接入 playground。Harness 对「我们的代码」使用 **与 Rust 同源算法的 TS 孪生实现**，并在报告里写明 `ownership`。

---

## 2. 分层矩阵

| 层 ID | 工作负载 | 本仓库实现 | ffmpeg.wasm 命令 | 所有权 |
| :--- | :--- | :--- | :--- | :--- |
| `demux` | 只拆容器，不解码 | `SimpleMp4Demuxer.parse()`（孪生 `Mp4Demuxer`） | `-i in.mp4 -c copy -an -f null -` | `ours-algorithm` |
| `remux` | 拆包 + FastStart 再封装 | parse + `FastStartMp4Muxer` | `-i in.mp4 -c copy -an -movflags +faststart out.mp4` | `ours-algorithm` |
| `cpu-filter` | 1080p RGBA 灰度（BT.601） | `grayscaleRgbaInPlace`（孪生 `RustCpuFilter::grayscale_rgba`） | `-f rawvideo -pix_fmt rgba -s 1920x1080 -i in.raw -vf hue=s=0 -f rawvideo out.raw` | `ours-algorithm`（输出不必 bit-exact） |
| `decode-soft` | 解出全部视频帧 | `VideoDecoder` + `prefer-software` | `-i in.mp4 -an -f null -` | **`browser-not-ours`** |
| `decode-hw` | 同上，产品路径参考列 | `VideoDecoder` + `prefer-hardware` | （不与 wasm 硬解对位，wasm 无硬解） | **`browser-not-ours`** |

禁止再把 `decode-hw` 的倍数写进「我们替代了 ffmpeg.wasm」的结论。软解对比的结论只允许来自 `decode-soft`。

---

## 3. 测试方法

1. 合成码率阶梯：`node scripts/bench-vs-ffmpeg.mjs`（只负责出片，不参与计时）。
2. 用户真片：放入 `tests/fixtures/incoming/*.mp4`。
3. 同步 wasm 核心：`node scripts/sync-ffmpeg-wasm.mjs`。
4. 同页执行：`npm run bench:layers`（Playwright Chromium，`PLAYGROUND_PORT` 可覆盖）。
5. 计时规则：
   - 解析 / CPU 滤镜：预热 3 次，取 20 次中位数。
   - ffmpeg.wasm 与解码：预热 1 次，取 3 次中位数（wasm 启动贵）。
   - `VideoFrame` 必须在回调里 `close()`。
   - 写入 ffmpeg.wasm 的 `Uint8Array` 必须是拷贝，避免 `writeFile` 分离 `ArrayBuffer`。
6. 产物（覆盖写）：
   - `tests/benchmark/results/layer-report.json` — 机器可读
   - `tests/benchmark/results/LAYER-REPORT.md` — 人可读终报

---

## 4. 报告 schema（`layer-report.json`）

```json
{
  "protocol": "rfc-0004",
  "schemaVersion": 1,
  "capturedAt": "ISO-8601",
  "environment": { "userAgent": "", "ffmpegWasmLoadMs": 0 },
  "ownership": { "demux": "ours-algorithm", "decodeSoft": "browser-not-ours" },
  "layers": {
    "demux": { "clips": [{ "id": "", "oursMs": 0, "ffmpegWasmMs": 0, "ratio": 0 }] },
    "cpuFilter": { "width": 1920, "height": 1080, "oursMs": 0, "ffmpegWasmMs": 0 }
  }
}
```

`ratio = ffmpegWasmMs / oursMs`（>1 表示我们更快）。缺测层写 `null` 并填 `error`，禁止用 0 冒充。

---

## 5. 通过标准（本阶段）

- 协议跑通：五个阶梯片 `demux` / `remux` / `decode-soft` 均有样本数 > 0。
- 报告必须同时列出所有权。Rust WASM 接入 playground 之后，把 `ours-algorithm` 改为 `ours-rust-wasm`，命令行不变。
