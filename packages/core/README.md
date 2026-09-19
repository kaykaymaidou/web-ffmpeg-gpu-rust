# @web-ffmpeg-gpu/core

独立媒体引擎 SDK。格间 / Nest **只通过包名安装**，不要 `import` 本仓 `src/` 路径。

## 安装（Nest / Node 22）

发布到 registry 之后：

```bash
pnpm add @web-ffmpeg-gpu/core
```

本仓尚未发 npm 时，用打包产物（推荐）或本地 file 协议：

```bash
# 在 web-ffmpeg-gpu 仓
npm run pack:core
# 得到 packages/core/web-ffmpeg-gpu-core-0.1.0.tgz

# 在格间仓
pnpm add ../web-ffmpeg-gpu/packages/core/web-ffmpeg-gpu-core-0.1.0.tgz
```

开发联调也可以：

```bash
pnpm add @web-ffmpeg-gpu/core@file:../web-ffmpeg-gpu/packages/core
```

`file:` 仍走 `package.json` 的 `exports`，装的是编译后的 `dist/`，不是 TypeScript 源文件。

## Node API（`import` 自动走 `exports["."].node`）

```ts
import { concatCopy, probe, trimCopy } from "@web-ffmpeg-gpu/core";

const info = await probe(partBytes);
const out = await concatCopy([clipA, clipB]); // Uint8Array，faststart MP4
```

这条路径 **不加载** WebCodecs、WebGPU、WASM。像素 API（`concatXfade` / `extractStills`）在 Node 会抛 `code: 'NOT_IMPLEMENTED'`。

浏览器请用同一包名；打包器走 default export（含 WebCodecs）。需要强制浏览器入口：

```ts
import { HardwareVideoDecoder } from "@web-ffmpeg-gpu/core/web";
```

## 不要

- `from "../../web-ffmpeg-gpu/packages/core/src/concat/concat-copy.ts"`
- spawn 系统 ffmpeg / 引入 `ffmpeg.wasm` 当产品路径
- 为 `concatCopy` 去加载 `pkg/*.wasm`（那是 Rust 解析器实验入口，不是 Nest 成片 API）
