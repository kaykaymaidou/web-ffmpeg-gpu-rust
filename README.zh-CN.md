# Web-FFmpeg-GPU 🚀

**中文** | [English](README.md)

下一代 Web 媒体处理引擎 —— 汲取 **FFmpeg** 经典流式管线哲学，融合 **Rust** 极致内存安全，打通 **WebCodecs** 显卡专用硬件编解码与 **WebGPU** WGSL 实时着色器滤镜。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Engine: Rust + WebGPU + WebCodecs](https://img.shields.io/badge/Engine-Rust%20%2B%20WebGPU%20%2B%20WebCodecs-orange.svg)](#)

---

## 🌟 痛点与核心价值

在 Web 浏览器端处理视频，开发者长期面临两难困境：

1. **`ffmpeg.wasm` 性能之痛**：
   - 纯 C 代码经 Emscripten 编译至 WebAssembly，**100% 依赖 CPU 软解/软编**；
   - 播放或转码 1080p/4K 视频时 CPU 占满、风扇狂转、极易内存溢出或卡顿掉帧；
   - 无法调度用户电脑里强大的独立显卡或集成显卡编解码芯片（NVDEC/NVENC, Intel QuickSync, Apple VideoToolbox）。
2. **原生 WebCodecs 的生态荒漠**：
   - 仅支持少数已规范的裸流格式，缺乏通用的容器解封装（Demuxer）和封装（Muxer）能力，没有丰富的滤镜库支持。

### 本项目的解决方案：智能混合编排引擎

```
┌─────────────────────────────────────────────────────────────┐
│                    用户输入任意音视频容器文件                  │
│                     (MP4, MKV, FLV, MOV, TS)                │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Rust / WASM 智能流分发调度中枢                │
│    (PTS/DTS 时间戳有序调度, B 帧防乱序队列, 显存生命周期 RAII)   │
└──────────────────────────────┬──────────────────────────────┘
                               │
            ┌──────────────────┴──────────────────┐
            ▼                                     ▼
┌───────────────────────────────┐     ┌───────────────────────┐
│     [主通路] 硬件级极速硬解      │     │    [兜底] CPU 软解     │
│   WebCodecs VideoDecoder      │     │   FFmpeg WASM 软解    │
│  (H.264, HEVC, VP9, AV1)      │     │  (ProRes, MPEG2 等)   │
│   CPU < 10%, 4K 60FPS 秒解     │     │       安全兼容保底    │
└───────────────┬───────────────┘     └───────────┬───────────┘
                │                                 │
                └────────────────┬────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────┐
│                 WebGPU 硬件渲染与 WGSL 滤镜管线              │
│       (零拷贝 importExternalTexture, 色彩空间精准转换,       │
│        实时高斯模糊, 胶片调色 LUT, 灰度/反色等 60fps 滤镜)   │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                   导出通道或 Canvas 极速呈现                 │
│      WebCodecs VideoEncoder (显卡硬编) -> 封装输出           │
└─────────────────────────────────────────────────────────────┘
```

---

## ⚡ 性能预期对比

| 指标 | 传统 `ffmpeg.wasm` (CPU 软解) | **Web-FFmpeg-GPU (本项目)** | 提升倍数 |
| :--- | :--- | :--- | :--- |
| **4K 60fps 解码** | 5 ~ 12 FPS (严重掉帧卡死) | **60 FPS (硬件满帧稳定播放)** | **5 ~ 10 倍 🚀** |
| **CPU 占用率** | 90% ~ 100% (发热降频) | **< 10% (几乎不占 CPU)** | **降低 90%** |
| **1080p 滤镜延迟** | 15 ~ 35 ms (CPU 逐像素计算) | **< 0.5 ms (WebGPU 着色器)** | **50 倍 ⚡** |
| **显存生命周期** | 频繁 GC 内存突增 | **Rust RAII + 严格显存回收** | **零显存泄漏** |

---

## 🛠️ 项目工程结构

```
web-ffmpeg-gpu/
├── crates/
│   ├── core/               # Rust 核心库：Packet、Frame、Timeline B 帧队列、WASM 绑定
│   └── filter-webgpu/      # Rust WebGPU 滤镜参数与着色器抽象
├── web/
│   ├── src/
│   │   ├── core/           # WebCodecs 硬解通道、WebGPU 渲染器、MP4 解复用器
│   │   ├── shaders/        # 高性能 WGSL 着色器（YUV->RGB、滤镜调色管线）
│   │   ├── main.ts         # 测试工作台控制器
│   │   └── style.css       # 暗黑极客风格界面
│   └── index.html          # 交互式硬件遥测与滤镜测试工作台
├── Cargo.toml              # Rust 工作区配置
├── package.json            # 前端工程与构建脚本配置
└── vite.config.ts          # Vite 配置（配置 COOP/COEP 隔离标头）
```

---

## 🚀 快速开始与本地运行

### 1. 运行 Web 演示工作台

确保本地已安装 Node.js (>= 18)：

```bash
# 进入项目目录
cd d:/Project/web-ffmpeg-gpu

# 安装依赖
npm install

# 启动本地开发服务器
npm run dev
```

在支持 WebGPU 的浏览器（如 **Google Chrome 113+** 或 **Microsoft Edge 113+**）中访问 `http://localhost:3000`：
- 拖入任意本地 MP4 (H.264/HEVC) 视频；
- 即可体验实时硬件硬解、秒级 WGSL 实时滤镜切换与实时 FPS 监控看板！

### 2. 编译 Rust WASM 核心模块（可选）

安装 Rust 与 wasm-pack：
```bash
# 增加 wasm 编译目标
rustup target add wasm32-unknown-unknown

# 检查工作区
cargo check --workspace
```
