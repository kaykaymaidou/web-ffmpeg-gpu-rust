# Web-FFmpeg-GPU 🚀

**中文** | [English](README.md)

> **下一代 Web 媒体处理引擎与自主 AI 实时直播/连麦管线**  
> 汲取 **FFmpeg** 经典流式管线哲学，融合 **Rust** 极致内存安全，打通 **WebCodecs** 显卡专用硬件编解码与 **WebGPU** WGSL 实时多流画面合成着色器，并由 **DeepSeek Harness (`dsh`)** 自主决策 Agent 驱动自愈。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Engine: Rust + WebGPU + WebCodecs](https://img.shields.io/badge/Engine-Rust%20%2B%20WebGPU%20%2B%20WebCodecs-orange.svg)](#)
[![WebRTC: P2P + Multi--Peer Mesh](https://img.shields.io/badge/WebRTC-P2P%20%7C%20Mesh%20%E6%8B%93%E6%89%91%E7%BD%91%E7%BB%9C-brightgreen.svg)](#)
[![AI Agent: DeepSeek Harness](https://img.shields.io/badge/AI%20Autopilot-DeepSeek%20Harness%20dsh-purple.svg)](#)
[![Quality: Three--Zeros Invariant](https://img.shields.io/badge/Quality-Three--Zeros%20%E4%B8%89%E9%9B%B6%E4%B8%8D%E5%8F%98%E5%BC%8F-success.svg)](#)

---

## 🌟 痛点与核心价值

在 Web 浏览器端处理高吞吐媒体与实时互动直播，开发者长期面临四大顽疾：

1. **`ffmpeg.wasm` CPU 瓶颈与发热**：
   - 纯 C 代码经 Emscripten 编译至 WebAssembly，**100% 依赖 CPU 软解/软编**；
   - 播放或转码 1080p/4K 视频时 CPU 占满 100%、风扇狂转、极易导致浏览器标签页崩溃；
   - 无法调用用户显卡中的专用硬件编解码芯片（NVDEC/NVENC, Intel QuickSync, Apple VideoToolbox）。
2. **原生 WebCodecs 的生态荒漠**：
   - WebCodecs 仅提供底层编解码接口，缺乏多容器解复用（Demuxer）、多路画面硬件合成（Compositor）、动态时间戳重排序以及抗弱网传输协议。
3. **WebRTC 直播连麦的质量滑坡**：
   - `canvas.captureStream()` 导致的 CPU 暴增与后台断流、声画脱节（Lip-sync Drift）、单端弱网丢包引发全局卡顿、以及显存资源泄漏。

### 本项目的解决方案：硬件加速混合管线 Monorepo

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                       输入媒体源 (本地文件 / WebRTC / 实时流)                 │
│                        (MP4, MKV, FLV, H.264/HEVC, Opus, PCM)                 │
└──────────────────────────────────────┬────────────────────────────────────────┘
                                       │
                                       ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                     Rust / WASM 调度中枢 (crates/core)                        │
│      - 严格 B 帧重排序与单调递增 PTS 时间戳对齐                                │
│      - 零崩溃 Exp-Golomb 码流语法解析器 (支持 Annex-B / AVCC / HVCC 互转)       │
│      - FastStart MP4 容器封装 (moov 头部前置优化)                              │
│      - 16 位 RTP 序号回绕平滑展开与 JitterBuffer 抖动抑制                      │
└──────────────────────────────────────┬────────────────────────────────────────┘
                                       │
                    ┌──────────────────┴──────────────────┐
                    ▼                                     ▼
        ┌───────────────────────┐             ┌───────────────────────┐
        │  WebCodecs 硬件级     │             │   WebCodecs 硬件级    │
        │  VideoDecoder (GPU)   │             │   AudioDecoder (Opus) │
        │  H.264, HEVC, AV1     │             │   RFC 7587 48kHz      │
        └───────────┬───────────┘             └───────────┬───────────┘
                    │                                     │
                    ▼                                     ▼
        ┌───────────────────────┐             ┌───────────────────────┐
        │  WebGPU 多路画面      │             │   Web Audio 多轨混音器│
        │  硬件合成器           │             │   - DynamicsCompressor│
        │  - 画中画 (PIP)       │             │     广播级防爆音限制器│
        │  - 左右分屏 / 四宫格  │             │   - 单轨独立音量与声相│
        │  - WGSL SDF 圆角着色器│             │                       │
        └───────────┬───────────┘             └───────────┬───────────┘
                    │                                     │
                    └──────────────────┬──────────────────┘
                                       ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│             WebRTC 多端连麦 Mesh 拓扑网络 (packages/core/src/live)             │
│      - 1vN / NvN 全联通拓扑与字典序无锁确定性防冲突握手 (Glare Resolution)      │
│      - 单路专属逆向 PLI 自愈 (FAIL-09 故障隔离，切断花屏不干扰其他连麦者)        │
│      - MasterClockSync 三级声画对齐状态机 (|Drift| < 40ms 硬件级锁相)         │
└──────────────────────────────────────┬────────────────────────────────────────┘
                                       │
                                       ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│            自主 AI 媒体自愈巡检驾驶舱 (@web-ffmpeg-gpu/agent)                 │
│      - 对齐 DeepSeek Harness (dsh) 微内核解耦架构                             │
│      - ReAct 循环: 遥测异常捕获 -> 思维链分析 (CoT) -> 工具调用自愈修复        │
│      - 0ms 本地规则专家引擎 (FAIL-01 至 FAIL-10 毫秒级兜底)                   │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## ⚡ 性能预期对比

| 指标 | 传统 `ffmpeg.wasm` (CPU 软解) | **Web-FFmpeg-GPU (本项目)** | 性能倍数 |
| :--- | :--- | :--- | :--- |
| **4K 60fps 解码** | 5 ~ 12 FPS (严重卡顿掉帧) | **60 FPS (硬件满帧稳定播放)** | **5 ~ 10 倍 🚀** |
| **CPU 占用率** | 90% ~ 100% (发热降频) | **< 10% (极低 CPU 开销)** | **降低 90%** |
| **多流画面硬件合成** | 15 ~ 35 ms (CPU 像素回读) | **< 0.5 ms (WebGPU WGSL 着色器)** | **50 倍 ⚡** |
| **显存与内存生命周期** | 频繁 GC 尖刺与内存溢出 | **全链路同步 RAII 回收** | **零显存泄漏 (Zero Leak)** |
| **声画同步对齐误差** | > 150 ms 累积延迟 | **MasterClockSync 锁定在 40ms 以内** | **完美声画对齐** |

---

## 💎 工业级“三零不变式”质量保证

1. **零恐慌 (Zero-Panic)**：
   - 纯 Rust 码流解析器严格防范 32-zero Exp-Golomb 位移溢出陷阱、截断 NAL 损坏、非法 SPS，针对破损或缺失 moov 的 MP4 容器具备全自动残帧打捞自愈能力。
2. **零不同步 (Zero-Desync)**：
   - `MasterClockSync` 动态以 `AudioContext.outputLatency` 为硬件基准时钟，在 40–500ms 内执行 1.05x 无感声调保真微变速，>500ms 时自动重置关键帧锚定。
3. **零显存泄漏 (Zero-VRAM-Leak)**：
   - 所有 `VideoFrame` 与 `AudioData` 句柄均由 RAII 保证严格闭环销毁。在并发 1,000 帧的多流高频推入下，活跃显存句柄数恒定 $\le N_{\text{channels}}$，会话销毁后绝对归 0。

---

## 📦 Monorepo 工程结构

```
web-ffmpeg-gpu/
├── packages/
│   ├── core/               # @web-ffmpeg-gpu/core 媒体核心库
│   │   ├── src/codec/      # WebCodecs 音频硬件编解码器
│   │   ├── src/decoder/    # WebCodecs 视频硬件解码器
│   │   ├── src/encoder/    # WebCodecs 视频硬件编码器
│   │   ├── src/renderer/   # WebGPU 渲染器与 MultiStreamCompositor 多流混流器
│   │   ├── src/shaders/    # 高性能 WGSL 着色器（色彩空间转换、SDF 圆角高光）
│   │   ├── src/live/       # WebRTC P2P、MultiPeerMeshSession、RTP 解复用、混音器
│   │   ├── src/muxer/      # FastStart MP4 Muxer (moov 头部前置优化)
│   │   └── src/pipeline/   # WebFfmpegTranscoder 转码管线 (带背压节流)
│   │
│   ├── agent/              # @web-ffmpeg-gpu/agent (对齐 DeepSeek Harness dsh 架构)
│   │   ├── src/core/       # HarnessRuntime 执行引擎、ReAct 循环、SessionTrajectory 轨迹总线
│   │   ├── src/tools/      # 插件化 ToolRegistry (本地函数工具与 MCP 客户端桥接)
│   │   ├── src/providers/  # ModelProvider (DeepSeek API、离线确定性仿真沙箱)
│   │   ├── src/rules/      # 0ms RulesExpertEngine (FAIL-01 至 FAIL-10 紧急拦截)
│   │   └── src/autopilot/  # MediaAutopilotAgent 高阶自愈巡检智能体
│   │
│   └── mcp-server/         # @web-ffmpeg-gpu/mcp-server
│       └── src/            # 标准 Model Context Protocol (MCP) JSON-RPC 2.0 服务端
│
├── apps/
│   └── playground/         # 交互式流媒体与 AI 操纵舱 (Vite + WebGPU + WebCodecs)
│
├── crates/
│   ├── core/               # Rust 码流解析、B 帧重排、FastStart MP4、JitterBuffer
│   └── filter-webgpu/      # Rust WebGPU 滤镜着色器抽象
│
└── tests/
    ├── e2e/                # Playwright 端到端测试 (多流合成、Mesh 连麦、P2P)
    ├── harness/            # Agent ReAct 决策沙箱与 FAIL-01~FAIL-10 工业自愈矩阵
    └── stress/             # 1,000 帧极限显存防泄漏压力测试
```

---

## 🛠️ 核心功能组件介绍

### 1. WebGPU 多路画面硬件合成器 (`WebGpuMultiStreamCompositor`)
- **多种预设布局**：画中画 (`pip_br`, `pip_tr`)、左右/上下分屏 (`split_horizontal`, `split_vertical`)、四宫格 (`grid_2x2`) 以及自定义视口坐标；
- **WGSL 着色器增强**：实时 SDF 距离场平滑圆角、描边高光金边、抗锯齿与色彩空间映射。

### 2. 多轨防爆音混音器 (`MultiTrackAudioMixer`)
- **广播级动态限制器**：基于 Web Audio 硬件级 `DynamicsCompressorNode`，设置 12:1 压缩比，杜绝多位主播/嘉宾同时开麦时导致的破音削波；
- **全通道独立控制**：各连麦通道具备独立的音量增益（Gain）、立体声立体声像（Pan）与静音（Mute）开关。

### 3. 多端连麦 Mesh 互动拓扑网络 (`MultiPeerMeshSession`)
- **确定性无锁防冲突握手**：依据节点唯一 ID 的字典序决定发起方，彻底消除并发连麦时的 SDP Offer Glare 碰撞；
- **单路专属逆向 PLI 自愈**：仅对发生丢包/花屏的连麦者定向请求关键帧，完全隔离其余连麦者画面。

### 4. 自主 AI 媒体巡检驾驶舱 (`MediaAutopilotAgent`)
- 全天候遥测摄入，实时感知丢包率、音画偏差（A/V Drift）与码率波动；
- 结合思维链（CoT）自主调用降码率、触发定向关键帧或激活残帧打捞，并配合 0ms 本地规则专家系统进行极速故障拦截。

---

## 🚀 快速开始

### 1. 运行本地 Web 交互式驾驶舱

运行环境要求：Node.js (>= 18) 与支持 WebGPU / WebCodecs 的浏览器（Chrome 113+ 或 Edge 113+）：

```bash
# 克隆仓库
git clone https://github.com/kaykaymaidou/web-ffmpeg-gpu-rust.git
cd web-ffmpeg-gpu-rust

# 安装全量依赖并编译所有 packages
npm install
npm run build

# 启动本地交互式操纵舱
npm run dev
```

浏览器访问 `http://localhost:3000`，即可进入包含视频转码、WebRTC P2P 直连、WebGPU 多流混流、多端连麦 Mesh 网络及 AI 媒体驾驶舱的统一操作台。

### 2. 执行全量自动化测试套件

```bash
# 运行 59 项 Playwright 端到端与压力测试 (启用 WebGPU)
npm run test:e2e

# 运行 28 项 Rust 核心单元与集成测试
cargo test --workspace
```

---

## 📄 开源许可证

MIT License © 2026 Web-FFmpeg-GPU 贡献者团队。
