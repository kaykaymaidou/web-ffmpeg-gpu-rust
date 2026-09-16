# Web-FFmpeg-GPU: 两步走战略与演化路线图 (Roadmap)

## 项目定位 (Project Positioning)

**基于 Rust WASM 的下一代高性能 Web 媒体处理引擎** —— 专为前端音视频转码、剪辑与播放提供 GPU 硬件加速，并在安全可靠的 Rust 体系下逐步演进、承接传统 `ffmpeg.wasm` 的通用生态。

---

## 第一阶段：GPU 硬件加速与转码管线 (Phase 1: High-Performance GPU Transcoder)

> **目标**：以轻量体积（~100KB），覆盖浏览器端核心视频转码、高帧率播放与着色器后处理场景，实现远超传统软件转码的硬件直通性能。

- [x] **纯 Rust MP4 容器解复用器 (ISOBMFF)**：原生高效解析 Box 树，毫秒级提取 Track 与样本流。
- [x] **纯 Rust H.264 语法解析器**：NAL 单元分割、指数哥伦布(Exp-Golomb) SPS 参数提取、动态 AVCC Extradata 构建。
- [x] **B 帧防乱序优先队列 (Timeline Scheduler)**：纯 Rust 最小堆调度，杜绝时间戳倒放。
- [x] **WebCodecs 硬件直通通道**：调用显卡专用编解码硬件（NVDEC/NVENC, QuickSync, Apple VideoToolbox）。
- [x] **WebGPU 零拷贝着色器管线**：实现 `importExternalTexture` 极速渲染与 WGSL 滤镜链（调色、灰度、反色等）。
- [x] **纯 Rust CPU SIMD 滤镜备选实现**：支持对小图或 CPU 内存帧的直接就地向量化处理。
- [x] **工业级 Monorepo 解耦**：`crates/core` (Rust) + `packages/core` (SDK) + `apps/playground` (测试台)。
- [x] **Playwright 性能评测与压测矩阵**：60fps 满帧率检测、异常码流容错、1000 帧显存泄漏监控。
- [x] **纯 Rust FastStart MP4 封装器 (Muxer)**：将 WebCodecs 编码帧与源 AAC 音频流打包为标准 MP4，强制 `moov` 置顶。
- [x] **端到端硬件转码调度管线**：实现预设档位（720p/1080p/原画瘦身）转码，实时回传 10x-realtime 倍速与压缩率。

---

## 第二阶段：超低延迟 Web 直播与 WebRTC 引擎 (Phase 2: Ultra-Low-Latency Live & RTC Engine)

> **目标**：彻底解决传统 WebRTC 推流 CPU 飙高（干掉 `canvas.captureStream()`）与 WebCodecs 播放器音画不同步、网络抖动崩溃四大行业顽疾，打造新一代直播引擎。
> **详见规范**：[RFC 0002: 低延迟 Web 直播与 WebRTC 引擎架构](file:///d:/Project/web-ffmpeg-gpu/docs/rfcs/0002-webrtc-web-live-streaming.md)

- [x] **WebGPU 零拷贝滤镜推流引擎 (Live Ingest)**：
  - 摄像头/桌面 `MediaStreamTrackProcessor` 直通显存与 WebCodecs 实时低延迟编码；
  - 导出 `LiveStreamIngestPipeline`，支持背压丢帧限流与实时遥测指标；
  - 纯 GPU 着色器滤镜管线集成就绪。
- [x] **纯 Rust 工业级 Jitter Buffer (流式抗抖动引擎)**：
  - RFC 3550 动态抖动方差自适应延迟平滑窗（50ms~250ms），智能重排 B 帧；
  - 迟到丢包错误隐藏与非 IDR 脏帧自愈丢弃，杜绝解码器崩溃。
- [x] **音频绝对主时钟与动态平滑追帧 (Audio Master Clock Engine)**：
  - 以 `AudioContext.currentTime` + `outputLatency` 为硬件基准主时钟；
  - 1.05x 平滑声画微调对齐，消除长期直播口型漂移（Lip-sync Drift），零破音。
- [x] **标准 WHIP / WHEP 广播推拉流客户端 (RFC 0003)**：
  - HTTP POST SDP Offer/Answer、PATCH ICE Trickle、DELETE 优雅下线；
  - 标准 RTP Track 对接 SRS / Janus / MediaSoup / LiveKit / Cloudflare Stream；
  - Playground Loopback 网关与 Playwright 协议/连通性验收。

---

## 第三阶段：渐进式 FFmpeg 功能生态迁移 (Phase 3: Progressive FFmpeg Feature Port)

> **目标**：使用现代内存安全的 Rust，逐步重写替换传统 C 语言 FFmpeg 中的核心能力，告别 30MB 庞大二进制与繁琐的 Emscripten 构建。

- [ ] **多容器解复用扩展 (Demuxers)**：
  - [ ] WebM / MKV (Matroska) 纯 Rust 解复用器
  - [ ] TS (MPEG-TS) 流式分包器
- [x] **音频处理管线 (Audio DSP & Codecs)**：
  - [x] AAC / Opus / MP3 音频帧分包与 WebAudio 同步 (与 Google Chromium Symphonia 100% 互通)
  - [x] 纯 Rust 多相 FIR 重采样（Resampler）、ITU-R BS.775 多声道混音与软限制器
- [ ] **通用滤镜图 (Filtergraph) 抽象**：
  - [ ] 类似 FFmpeg `-vf` 的声明式链式滤镜语法解析
  - [ ] 自动根据分辨率与数据源选择最优算力：**小图/音频走 Rust CPU SIMD，大图视频流走 WebGPU WGSL**
- [ ] **冷门格式软件兜底编解码 (Safe Fallback Codecs)**：
  - [ ] 针对 WebCodecs 不支持的专业级格式（如 Apple ProRes、DNxHD、Motion JPEG）集成轻量级 Rust 软解。
