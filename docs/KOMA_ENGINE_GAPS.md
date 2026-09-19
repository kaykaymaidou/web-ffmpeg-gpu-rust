# 格间需要 `@web-ffmpeg-gpu/core` 补的能力

格间 Nest 只下载 http(s) 字节，不 spawn 系统 ffmpeg。引擎以 **独立 npm 包** `@web-ffmpeg-gpu/core` 引入（`pnpm add` / `.tgz` / `file:` 协议），**禁止** `import` 本仓 `src/` 路径。不还原 ffmpeg：不对 `-c copy` / ffmpeg.wasm 做 bit-exact。

```bash
pnpm add @web-ffmpeg-gpu/core
# 未发 registry 时：在引擎仓 npm run pack:core，再 pnpm add <tgz>
```

```ts
import { concatCopy, probe } from "@web-ffmpeg-gpu/core";
```

| 优先级 | API | 格间用途 | 运行时 | 状态 |
|---|---|---|---|---|
| P0 | `concatCopy(parts: Uint8Array[]): Promise<Uint8Array>` | `POST /api/timeline/concat` 无损成片 | **Node** remux | 已实现 |
| P0 | `probe(bytes: Uint8Array)` | 时长 / 分辨率 / 有无音轨，替代 ffprobe | **Node** demux | 已实现 |
| P0 | Node `exports["."].node` | Nest `import("@web-ffmpeg-gpu/core")` 不拉 WebGPU | Node | 已实现 |
| P1 | `extractStills(bytes, { first, last })` | 成片抽首尾帧 JPEG，作下一镜锚点 | 浏览器 WebCodecs；Nest 无硬解 → `NOT_IMPLEMENTED` | 浏览器路径已实现 |
| P1 | `concatXfade(parts, { durationSec, height: 720 })` | `transition=fade`，720p、无音频 | 同上 | 浏览器路径已实现 |
| P1 | `concatTranscode(parts, { preset })` | copy 失败后统一分辨率再拼（SPEC-004 非目标，契约先给） | 浏览器 WebCodecs | 浏览器路径已实现 |
| P2 | `trimCopy(bytes, { startUs, endUs })` | 关键帧对齐裁切（审片 trim 现不进 concat） | **Node** remux | 已实现 |
| — | contact sheet (`tile=3x1`) | continuity 脚本 | 像素 | 未做 |
| — | 帧精确 trim / NAPI 软解 | Nest 抽帧不靠浏览器 | Native | 未做 |

失败规则：分辨率 / codec / extradata 不一致 **抛错**，禁止静默硬拼。
