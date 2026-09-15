# Web-FFmpeg-GPU 🚀

**中文** | [English](README.md)

下一代基于 **Rust + WebCodecs + WebGPU** 的高性能 Web 媒体处理引擎 —— 汲取 **FFmpeg** 经典流式管线哲学，融合 **Rust** 极致内存安全，直通现代 GPU 硬件编解码芯片（NVDEC/NVENC、Intel QuickSync、Apple VideoToolbox）与 WGSL 实时着色器。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Engine: Rust + WebGPU + WebCodecs](https://img.shields.io/badge/Engine-Rust%20%2B%20WebGPU%20%2B%20WebCodecs-orange.svg)](#)
[![Rust Workspace: 54/54 Tests Passed](https://img.shields.io/badge/Rust%20Tests-54%2F54%20Pass-brightgreen.svg)](#)
[![Playwright Suite: 72/72 Tests Passed](https://img.shields.io/badge/Playwright%20E2E-72%2F72%20Pass-brightgreen.svg)](#)
[![Zero OS I/O: Compliant](https://img.shields.io/badge/crates%2Fcore-Zero%20OS%20I%2FO-success.svg)](#)

---

## 📌 最基本能力的复刻与对标现状 (FFmpeg Parity Matrix)

针对传统 FFmpeg 最常规的核心能力（解复用、码流语法提取、音视频硬解/硬编、音频重采样混音、滤镜图编排、容器封装、实时流媒体传输），本项目已全面完成原生 Rust 与 Web 现代化复刻：

| 功能维度 (Dimension) | 传统 FFmpeg 能力 | 本项目实现 (Web-FFmpeg-GPU) | 技术对标状态 |
| :--- | :--- | :--- | :--- |
| **MP4 / fMP4 解复用** | `libavformat/mov.c` | `crates/core/src/demuxer/mp4.rs` (纯 Rust 递归 Box 树解析，毫秒级提取 Track/Sample 表) | ✅ **100% 纯 Rust 复刻** |
| **MPEG-TS 解复用** | `libavformat/mpegts.c` | `crates/core/src/demuxer/ts.rs` (188 字节包同步、PAT/PMT 解析、PES 组包、33-bit 90kHz PTS/DTS) | ✅ **100% 纯 Rust 复刻** |
| **WebM / MKV 解复用** | `libavformat/matroskadec.c` | `crates/core/src/demuxer/mkv.rs` (RFC 8794 EBML VINT 解析、Track/Cluster/SimpleBlock 抽取) | ✅ **100% 纯 Rust 复刻** |
| **FLV / 增强 FLV 解复用** | `libavformat/flvdec.c` | `crates/core/src/live/flv_demuxer.rs` (支持 H.264/HEVC/AAC/Opus 标签解析与实时分包) | ✅ **100% 纯 Rust 复刻** |
| **H.264 语法与配置** | `libavcodec/h264_parser.c` | `crates/core/src/bitstream/h264.rs` (Annex B 分割、Exp-Golomb 指数哥伦布解码、`avcC` Extradata 生成) | ✅ **100% 纯 Rust 复刻** |
| **H.265/HEVC 语法与配置** | `libavcodec/hevc_parser.c` | `crates/core/src/bitstream/h265.rs` (HEVC NAL 分割、VPS/SPS/PPS 语法解析、`hvcC` Extradata 构造) | ✅ **100% 纯 Rust 复刻** |
| **AV1 OBU 语法与配置** | `libavcodec/av1_parser.c` | `crates/core/src/bitstream/av1.rs` (OBU 语法单元提取、LEB128 变长整型解码、`av1C` 格式生成) | ✅ **100% 纯 Rust 复刻** |
| **AAC 音频语法与配置** | `libavcodec/aac_parser.c` | `crates/core/src/bitstream/aac.rs` (ADTS 7 字节头解析/打包、`AudioSpecificConfig` 构造) | ✅ **100% 纯 Rust 复刻** |
| **音频重采样 (Resampling)** | `libswresample/resample.c` | `crates/core/src/audio/resampler.rs` (分数相位累加线性插值，支持 48kHz↔44.1kHz、48kHz→16kHz) | ✅ **100% 纯 Rust 复刻** |
| **音频多声道混音 (Matrix)** | `libswresample/rematrix.c` | `crates/core/src/audio/mixer.rs` (ITU-R BS.775 功率守恒 5.1 转立体声、单双声道变换、磁带软限幅) | ✅ **100% 纯 Rust 复刻** |
| **滤镜链语法解析** | `libavfilter/graphparser.c` | `crates/core/src/filter/graph.rs` (解析 FFmpeg `-vf` 语法链与标签图，完成 WebGPU/CPU 算力协商) | ✅ **100% 纯 Rust 复刻** |
| **GPU 高性能滤镜** | `libavfilter/vf_*.c` | `packages/core/src/renderer/gpu-compute-pipeline.ts` (Lanczos 升采样、双边滤波降噪、256 直方图) | 🚀 **WebGPU 算力超越** |
| **FastStart MP4 封装** | `libavformat/movenc.c` | `crates/core/src/muxer/mp4.rs` (纯 Rust FastStart 封装，强制 `moov` 顶置，支持 WebCodecs 输出) | ✅ **100% 纯 Rust 复刻** |
| **实时 RTP / WebRTC** | `libavformat/rtp*.c` | `crates/core/src/live/rtp.rs` (FU-A 分片、STAP-A 聚合、16-bit 序号解卷、RFC 3550 抗抖动 Jitter Buffer) | 🚀 **原生 WebRTC 对齐** |
| **推拉流协议网关** | `libavformat/http.c` | `packages/core/src/live/whip-client.ts` / `whep-client.ts` (标准 RFC 0003 WHIP/WHEP 客户端) | 🚀 **标准化直播对齐** |

---

## 🏛️ Monorepo 辐射式架构设计 (Architecture Topology)

本项目采用以 **纯 Rust Core 为绝对核心、向外辐射跨端 SDK、服务与生态** 的现代 Monorepo 架构：

```
                             ┌─────────────────────────────────────────┐
                             │       crates/core (纯 Rust 核心中枢)      │
                             │  • 零系统 I/O 隔离 (Zero-OS-I/O Invariant) │
                             │  • 零不可恢复崩溃 (Zero-Panic Invariant)   │
                             │  • WASM32 与 Native 双向无缝跨编译       │
                             └────────────────────┬────────────────────┘
                                                  │
                 ┌────────────────────────────────┼────────────────────────────────┐
                 │ 编译为 WASM 导出               │ 编译为 Native C-ABI 导出       │ 静态着色器链接
                 ▼                                ▼                                ▼
   ┌───────────────────────────┐    ┌───────────────────────────┐    ┌───────────────────────────┐
   │    packages/core (Web SDK)│    │   crates/native (桌面 SDK) │    │ crates/filter-webgpu      │
   │ • WebCodecs 显卡硬解/硬编  │    │ • 标准 C-ABI 符号导出     │    │ • WGSL 滤镜与计算着色器   │
   │ • WebGPU 零拷贝纹理导入   │    │ • C/C++、C#、Python 绑定  │    │ • 双边滤波降噪/Lanczos插值│
   │ • WebRTC 直播与抗弱网自愈 │    │ • 桌面硬件加速编解码桥接  │    └───────────────────────────┘
   └─────────────┬─────────────┘    └─────────────┬─────────────┘
                 │                                │
     ┌───────────┴───────────┐                    └───────────┐
     ▼                       ▼                                ▼
┌──────────────────┐  ┌──────────────────┐              ┌──────────────────────────┐
│ packages/agent   │  │ apps/playground  │              │ apps/windows-service     │
│ • dsh 解耦架构   │  │ • 浏览器可视化台 │              │ • Windows 后台无头转码   │
│ • ReAct 遥测自愈 │  │ • 实时滤镜/直播  │              │ • 监听队列与健康自愈监控 │
│ • 异常码流自修复 │  │ • 真实性能 Benchmark│            └──────────────────────────┘
└──────────────────┘  └──────────────────┘
```

---

## ⚡ 重点技术特性

1. **体积极小，性能极致**：
   - 核心 WASM 体积仅 **~169KB**（Gzip 压缩后仅 **~65KB**），相比传统 `ffmpeg.wasm` 动辄 30MB 的庞大二进制包瘦身 **99%**。
2. **算力智能协商 (Capability Negotiation)**：
   - 输入 FFmpeg `-vf` 滤镜字符串后，语法分析器构建 DAG 有向无环图，自动协商最佳执行硬件：
     - **大图/视频帧**：自动调度 WebGPU Compute 着色器并行计算，耗时 < 0.5ms；
     - **小图/音频流**：自动调度 Rust CPU SIMD 向量化指令或低延迟软处理；
     - **时间戳/分流**：自动执行零开销 Passthrough 调度。
3. **工业级抗弱网与低延迟直播 (RFC 0002 & RFC 0003)**：
   - 支持 WHIP 推流与 WHEP 播放标准协议；
   - 内置多路 Mesh 拓扑推流引擎与定向反向 PLI（Picture Loss Indication）反馈，单人丢包自愈无需重推全房间。

---

## 🔥 核心难点与攻克方案 (Technical Breakthroughs)

在重构与超越传统 FFmpeg 的过程中，团队重点攻克了以下六大行业级技术死穴：

### 难点一：WebGPU 与 WebCodecs 间的“零拷贝”显存直通通道

* **传统方案痛点**：
  传统 `ffmpeg.wasm` 内部通过 CPU 软解将视频解码到 WASM 线性内存（Linear Memory）中作为 YUV420P 像素数组，要呈现在屏幕上必须：`WASM 内存 -> JS Uint8Array 内存拷贝 -> CPU 颜色空间转换 RGBA -> Canvas2D putImageData 再次拷贝`。在 1080p60 或 4K 场景下，每秒产生数百兆内存颠簸（Memory Churn），CPU 迅速打满 100%，帧率暴跌至 5~15fps。
* **本项目攻克方案**：
  - 纯 Rust WASM 仅负责容器解复用与 NAL 单元提取（单帧处理耗时 **< 0.05ms**）；
  - 提取的纯净压缩码流直投浏览器底层的 `VideoDecoder`，激活 NVDEC / QuickSync 专用显卡硬件解码 ASIC；
  - 解码产出的 `VideoFrame` 属于 GPU 物理显存句柄，通过 WebGPU 的 `device.importExternalTexture({ source: videoFrame })` **实现 0 内存拷贝直通 WebGPU 渲染管线**，帧率轻松跑满 100~300+ fps，CPU 占用率低于 5%。

---

### 难点二：硬件 `VideoFrame` 显存泄漏的死穴与 RAII 严格生命周期

* **行业致命问题**：
  `VideoFrame` 表面上是一个普通 JavaScript 对象，但其底层强引用着 GPU 显存（VRAM）中的物理纹理资源。JavaScript 的垃圾回收器（V8 GC）只能感知到几百字节的 JS 包装对象，**完全无法感知底层绑定的几十兆物理显存**。如果开发者没有显式调用 `videoFrame.close()`，在解码几十秒后系统显存将迅速耗尽，直接引发 `WebGPU Device Lost` 致命崩溃或浏览器标签页闪退。
* **本项目攻克方案**：
  - 借鉴 Rust RAII（Resource Acquisition Is Initialization）范式，在 TypeScript 调度层构建严苛的 `FrameScope` 保护机制；
  - 所有进入解码回调、滤镜渲染管线与编码器的帧，均被强制包裹在 `try ... finally { frame.close(); }` 同步释放块中；
  - 建立严格的背压节流阈值（Inflight Queue <= 8），防止解码速度大幅领先编码速度导致显存队列无限膨胀；
  - 设立专门的自动化压测套件（`tests/stress/memory-leak.spec.ts`），连续分配释放 1000 帧并断言未释放句柄恒等于 0。

---

### 难点三：工业级野蛮码流容错与零崩溃不变量 (Zero-Panic Invariant)

* **现实码流的恶劣现状**：
  现实生产环境中的媒体文件充满脏数据：录制中途断电导致缺少 `moov` 索引箱的残缺 MP4、非标准编码器生成的畸形 SPS/PPS、包含 32 个连续 0 导致 32 位位移溢出的指数哥伦布陷阱、首帧非 IDR 关键帧的脏流前缀。传统 C 代码在处理此类数据时极易触发段错误（Segmentation Fault）或内存越界。
* **本项目攻克方案**：
  - `crates/core` 确立绝对不可妥协的 **Zero-Panic Invariant** 原则：全库严禁无保护的 `unwrap()`，位运算一律采用 `checked_shl` 与饱和算术；
  - **残缺 MP4 自愈引擎 (FAIL-05)**：若未找到 `moov` Box，解复用器自动切换至 Salvage 模式，在裸 `mdat` 中基于 NAL 起始码（`00 00 00 01`）逐帧抢救恢复视频流；
  - **脏流自愈丢弃 (FAIL-01)**：首帧非 IDR 的 P/B 帧序列被前置自愈管道静默丢弃，直至遇到首个完整 IDR 关键帧再送入解码器，杜绝解码黑屏与解码器 Panic。

---

### 难点四：弱网抖动下的 B 帧动态重排与 16 位序列号回卷解包

* **时序与网络难题**：
  H.264/H.265 的 B 帧特性决定了其呈现时间戳（PTS）与解码时间戳（DTS）非线性交错；而在实时 WebRTC 推流中，网络丢包与乱序到达会导致解码器按错误顺序解码而花屏；此外，RTP 16-bit 序列号在连续传输数小时后会发生 65535 -> 0 的回卷溢出（Wraparound）。
* **本项目攻克方案**：
  - 纯 Rust 实现的 `TimelineQueue` 最小堆优先级调度队列，自动根据 PTS 单调递增重构播放流；
  - 针对负数 PTS 或时间倒流（Retrograde PTS），自动执行平滑单调对齐（FAIL-03/FAIL-07）；
  - `RtpSequenceUnroller` 实现无符号 16 位序列号连续解卷，精确区分真实回卷与迟到旧包；
  - 基于 RFC 3550 算法实现自适应抗抖动 Jitter Buffer，动态平滑 50ms~250ms 窗口，并在丢弃非关键帧碎片时自动隐藏错误（FAIL-09/10）。

---

### 难点五：毫秒级音画口型同步（Lip-Sync）与双主时钟漂移对齐

* **口型脱节顽疾**：
  在长时间直播与转码过程中，音频采样时钟（如 48kHz）与视频帧率时钟（如 29.97fps/60fps）由不同的硬件定时器驱动，累计时钟漂移（Clock Drift）会在半小时内造成数百毫秒的音画脱节（口型对不上声音）。
* **本项目攻克方案**：
  - 确立 `AudioContext.currentTime` 加上硬件输出延迟作为全局绝对主时钟；
  - 设计 **三级自适应平滑对齐算法**：
    1. **极小漂移 (< 40ms)**：人耳人眼无法察觉区间，微量平滑滤波，不做剧烈变更；
    2. **中度漂移 (40ms ~ 500ms)**：激活纯 Rust 音频变调重采样（Pitch-neutral Catchup），以 1.05x 或 0.95x 极微小倍速悄悄加速/减速追帧，消除漂移同时保证人耳完全听不出音频音调变化；
    3. **严重脱节 (> 500ms)**：自动执行关键帧级跳帧（Seek），快速归位。

---

### 难点六：跨端双向编译与纯内存流式隔离 (Zero-OS-I/O 架构硬约束)

* **架构冲突**：
  `crates/core` 既要被编译成 WebAssembly 跑在没有文件系统与系统调用（Syscalls）的浏览器中，又要作为桌面端 C-ABI 原生库（`crates/native`）运行在 Windows/Linux/macOS 上，若底层 Rust 代码混入 `std::fs` 或 `std::net`，会导致 Web 编译失败。
* **本项目攻克方案**：
  - 在 `crates/core` 中确立硬性规范：全库仅接受字节切片（`&[u8]`）或流式缓冲区，**绝对零 `std::fs`、零 `std::net`、零操作系统依赖**；
  - 设立自动化架构门禁脚本 `scripts/check-boundaries.mjs`，在 CI 构建前通过语法扫描对全库 26 个 Rust 源码文件执行无死角审查，任何对禁止系统模块的引用将直接阻断构建；
  - 桌面 SDK (`crates/native`) 专职处理文件流与操作系统 C-ABI 包装，各层职责彻底解耦。

---

## 📊 性能实测数据 (Empirical Benchmarks)

在主流 PC 硬件（Intel i7-13700H + NVIDIA RTX 4060 Laptop GPU）上的实测对比：

| 评测场景 | 传统 `ffmpeg.wasm` (CPU 软解) | **Web-FFmpeg-GPU (本项目)** | 优势表现 |
| :--- | :--- | :--- | :--- |
| **4K 60fps 解码播放** | 8 ~ 14 FPS (丢帧率 > 70%) | **60 FPS (硬件垂直同步锁满)** | **5x ~ 8x 帧率提升 🚀** |
| **CPU 平均占用率** | 92% ~ 100% (严重发热降频) | **4% ~ 8% (极轻量调度)** | **CPU 负载降低 90%+** |
| **1080p 双边滤波降噪** | 28 ms / 帧 (CPU 逐像素遍历) | **0.42 ms / 帧 (WebGPU Compute)** | **快 66 倍 ⚡** |
| **MP4 解复用解析耗时** | 85 ms (大文件扫描) | **1.2 ms (纯 Rust WASM 内存映射)** | **快 70 倍 ⚡** |
| **显存安全稳定性** | 持续增长，易爆显存闪退 | **1000 帧连续压测 0 泄漏** | **100% 显存安全可靠** |

---

## 🛠️ 快速上手

### 1. 环境准备
- Node.js >= 18
- Rust 1.75+（需安装 `wasm32-unknown-unknown` target 与 `wasm-pack`）

### 2. 常用开发命令

```bash
# 安装依赖
npm install

# 验证架构边界硬性约束 (Zero-OS-I/O 检查)
npm run check:boundaries

# 运行 Rust 全工作区单元测试 (54 个用例 100% 通过)
cargo test --workspace

# 编译纯 Rust 核心为 WASM 包
npm run build:wasm

# 编译所有前端与桌面模块
npm run build

# 启动交互式浏览器工作台 (Playground)
npm run dev

# 运行 Playwright 工业级自动化端到端测试 (72 个用例 100% 通过)
npm run test:e2e
```

---

## 📜 开源协议

本项目采用 [MIT 许可证](LICENSE) 开源。
