# RFC 0005: Nest 内存多段成片（`concatCopy`）

- **状态**: Accepted
- **提出时间**: 2026-09-19
- **责任模块**: `packages/core`（TS remux）、`apps/cli`（`wff concat` 薄封装）

---

## 1. 动机

格间 Nest 下载多段 http(s) MP4 后需要在内存里合成可播成片，写入 `storage/exports/*.mp4`。现有 `wff concat` 丢音频、写死 SPS/PPS、只认 H.264、无一致性校验，不能作为产品路径。

本 RFC **不还原 ffmpeg**。不引入 `ffmpeg.wasm`、不绑定 rust-ffmpeg、不 spawn 系统 ffmpeg。传统 concat copy 里静默硬拼、时间戳跳变、只拷视频等实现一律不做。

验收：成片可播、音画不断、Node 能 `import("@web-ffmpeg-gpu/core")` 拿到 `concatCopy` 且不加载 WebCodecs/WebGPU。不对 ffmpeg 输出做 bit-exact。

---

## 2. API

```ts
export function concatCopy(parts: Uint8Array[]): Promise<Uint8Array>
export function probe(bytes: Uint8Array): Promise<ProbeInfo>
```

P1 像素路径（浏览器 WebCodecs；Node 抛 `code = 'NOT_IMPLEMENTED'`）：

```ts
export function concatXfade(parts: Uint8Array[], opts?: { durationSec?: number; height?: 720 }): Promise<Uint8Array>
export function extractStills(bytes: Uint8Array, opts?: { first?: boolean; last?: boolean }): Promise<{ first?: Uint8Array; last?: Uint8Array }>
export function concatTranscode(parts: Uint8Array[], opts?: { preset?: 'social-720p' | 'hd-1080p' | 'original-slim' }): Promise<Uint8Array>
```

另见 [KOMA_ENGINE_GAPS.md](../KOMA_ENGINE_GAPS.md)。 `probe` / `trimCopy` 为 Node remux，不解码。

---

## 3. 行为契约（自研 remux，非 `-c copy` 对位）

1. 纯内存：`Uint8Array[]` → `Uint8Array`。不读盘。
2. `parts.length < 2` 失败。
3. 每段必须是带 `moov` 的 ISOBMFF；必须有视频轨。
4. **第一段为模板**：宽高、codec 族（AVC / HEVC）、视频 `description`（avcC/hvcC）、音频有无、音频 codec/采样率/声道。
5. 后续段与模板不一致（分辨率、codec 族、extradata 字节、音频布局）→ **抛明确错误**，禁止糊过去。
6. timescale 不同：映射到第一段 timescale（主动重写，不要求同源 timebase）。
7. 每段视频必须从 key sample 开始。
8. 跨段 DTS 单调：`offset += 前段时长`；CTTS 原样保留（随 timescale 映射）。
9. 音视频 sample 都写入；全段无音频则输出无音轨。
10. 输出 FastStart：`moov` 在 `mdat` 之前。
11. 不解码、不缩放、不重编码。像素活（xfade / 抽帧）不在本 RFC 实现范围。

---

## 4. 独立包，不要源码直引

`@web-ffmpeg-gpu/core` 是给格间 **pnpm 安装** 的库，不是把本仓 `src/` 当相对路径 import。

- Nest：`pnpm add @web-ffmpeg-gpu/core`（或 `.tgz` / `file:../web-ffmpeg-gpu/packages/core`）
- Node `import "@web-ffmpeg-gpu/core"` 解析到 `dist/node.js`：只 remux，**不加载** WebCodecs / WebGPU / WASM
- `concatCopy` 的产品路径是这份 JS remux，不是 `pkg/*.wasm`，也不是 ffmpeg.wasm

浏览器仍走 `dist/index.js`。详见 [`packages/core/README.md`](../../packages/core/README.md)。

---

## 5. 不在范围

重编码拼接、帧精确 trim、contact sheet、NAPI、wasm 调 rust concat、与 ffmpeg.wasm 对拍。
