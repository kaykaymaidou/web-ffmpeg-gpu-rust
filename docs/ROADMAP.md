# Web-FFmpeg-GPU: 两步走战略与演化路线图 (Roadmap)

## 📌 项目定位

**基于 Rust WASM 的下一代高性能 Web 媒体处理引擎** —— 专为前端音视频转码、剪辑与播放提供 GPU 硬件加速，并在安全可靠的 Rust 体系下逐步演进、承接传统 `ffmpeg.wasm` 的通用生态。

---

## 🚀 第一步：GPU 硬件加速与性能突围 (Phase 1: High-Performance GPU Transcoder)

> **目标**：以极小体积（~100KB），攻克浏览器端 80% 最核心的视频转码、高帧率播放与滤镜后处理场景，性能全面碾压传统 `ffmpeg.wasm`。

- [x] **纯 Rust MP4 容器解复用器 (ISOBMFF)**：原生高效解析 Box 树，毫秒级提取 Track 与样本流。
- [x] **纯 Rust H.264 语法解析器**：NAL 单元分割、指数哥伦布(Exp-Golomb) SPS 参数提取、动态 AVCC Extradata 构建。
- [x] **B 帧防乱序优先队列 (Timeline Scheduler)**：纯 Rust 最小堆调度，杜绝时间戳倒放。
- [x] **WebCodecs 硬件直通通道**：调用显卡专用编解码硬件（NVDEC/NVENC, QuickSync, Apple VideoToolbox）。
- [x] **WebGPU 零拷贝着色器管线**：实现 `importExternalTexture` 极速渲染与 WGSL 滤镜链（调色、灰度、反色等）。
- [x] **纯 Rust CPU SIMD 滤镜备选实现**：支持对小图或 CPU 内存帧的直接就地向量化处理。
- [x] **工业级 Monorepo 解耦**：`crates/core` (Rust) + `packages/core` (SDK) + `apps/playground` (测试台)。
- [x] **Playwright 性能评测与压测矩阵**：60fps 满帧率检测、异常码流容错、1000 帧显存泄漏监控。
- [ ] **WebCodecs VideoEncoder 导出通道**：支持在浏览器内将处理后的帧通过显卡硬件编码快速打包导出 MP4。

---

## 🌐 第二步：渐进式 FFmpeg 功能生态迁移 (Phase 2: Progressive FFmpeg Feature Port)

> **目标**：使用现代内存安全的 Rust，逐步重写替换传统 C 语言 FFmpeg 中的核心能力，告别 30MB 庞大二进制与繁琐的 Emscripten 构建。

- [ ] **多容器解复用扩展 (Demuxers)**：
  - [ ] WebM / MKV (Matroska) 纯 Rust 解复用器
  - [ ] FLV (Flash Video) / TS (MPEG-TS) 流式分包器
- [ ] **音频处理管线 (Audio DSP & Codecs)**：
  - [ ] AAC / Opus / MP3 音频帧分包与 WebAudio 同步
  - [ ] 纯 Rust 音频重采样（Resampler）与多声道混音
- [ ] **通用滤镜图 (Filtergraph) 抽象**：
  - [ ] 类似 FFmpeg `-vf` 的声明式链式滤镜语法解析
  - [ ] 自动根据分辨率与数据源选择最优算力：**小图/音频走 Rust CPU SIMD，大图视频流走 WebGPU WGSL**
- [ ] **冷门格式软件兜底编解码 (Safe Fallback Codecs)**：
  - [ ] 针对 WebCodecs 不支持的专业级格式（如 Apple ProRes、DNxHD、Motion JPEG）集成轻量级 Rust 软解。
