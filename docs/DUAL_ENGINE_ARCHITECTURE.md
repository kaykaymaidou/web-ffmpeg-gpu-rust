# Web-FFmpeg-GPU: 双轮驱动通用架构白皮书 (Dual-Engine Architecture Blueprint)

> **战略核心**：坚持“双轮驱动”（Two-Engine Strategy）—— 既以 **Web 端（WebCodecs + WebGPU + WebRTC）** 做到极致免安装、零 CPU 占用与实时图形着色器协同；又以 **底层 SDK（纯 Rust Core + C-ABI Native）** 提供通用、独立、可直接嵌入桌面端与系统服务的 FFmpeg 替代底座。

---

## 1. 双轮驱动架构全景 (Dual-Engine Topography)

```
                                  ┌─────────────────────────────────────────────────┐
                                  │           crates/core (纯 Rust 共享中枢)          │
                                  │ • ISOBMFF (MP4/fMP4) 纯 Rust 递归解复用/封装     │
                                  │ • MPEG-TS / WebM(MKV) EBML / Enhanced FLV 解复用 │
                                  │ • H.264 / HEVC / AV1 / AAC / Opus 码流语法引擎   │
                                  │ • 分数相位音频重采样器 & ITU-R BS.775 矩阵混音器 │
                                  │ • FFmpeg 风格 -vf Filtergraph 声明式语法解析器   │
                                  │ • 约束：Zero-OS-I/O & Zero-Panic (无任何系统调用) │
                                  └────────────────────────┬────────────────────────┘
                                                           │
                      ┌────────────────────────────────────┴────────────────────────────────────┐
                      ▼                                                                         ▼
   ┌──────────────────────────────────────────────┐                          ┌──────────────────────────────────────────────┐
   │         【方向一：全面 Web 浏览器引擎】        │                          │          【方向二：通用底层 Native SDK】       │
   │           packages/core (@web-ffmpeg-gpu)    │                          │          crates/native (C-ABI 动态链接库)     │
   ├──────────────────────────────────────────────┤                          ├──────────────────────────────────────────────┤
   │ 1. WebCodecs 专用显卡硬件通道                 │                          │ 1. 标准 C99 / C++ C-ABI 符号导出              │
   │    • 调度 NVDEC / QuickSync / VideoToolbox   │                          │    • web_ffmpeg_native.h 头文件开箱即用      │
   │    • 硬件硬解跑满 500 ~ 700+ FPS              │                          │ 2. 多语言直接 FFI 绑定                       │
   │ 2. WebGPU 实时 WGSL 着色器管线                │                          │    • C/C++、C# (.NET P/Invoke)、Python、Rust │
   │    • importExternalTexture 显存零拷贝直通    │                          │    • Electron / Tauri 桌面客户端直接链接     │
   │    • Lanczos 升采样、双边降噪、3D LUT 调色   │                          │ 3. 跨平台操作系统硬件集成                    │
   │ 3. 超低延迟 WebRTC 直播协议栈                │                          │    • Windows DirectX (D3D11VA / DXVA2)       │
   │    • WHIP 推流 / WHEP 播放客户端 (RFC 0003)  │                          │    • NVIDIA NVCODEC / Linux VAAPI 硬件硬解   │
   │    • N-way Mesh 多路混流与定向反向 PLI 自愈  │                          │ 4. 无头后台守护服务 (apps/windows-service)   │
   │ 4. WebAudio 绝对主时钟与 1.05x 口型平滑对齐   │                          │    • 7x24 小时文件夹自动监听与批量高吞吐转码 │
   └──────────────────────────────────────────────┘                          └──────────────────────────────────────────────┘
```

---

## 2. 浏览器端引擎 (WebCodecs + WebGPU + WebRTC)

### 1. 技术定位与设计目标
- **定位**：替代传统臃肿、纯 CPU 软解的 `ffmpeg.wasm`（体积从 30MB 锐减至 ~169KB，Gzip ~65KB）。
- **WebCodecs (硬件编解码)**：
  - 调用浏览器的 `VideoDecoder` 与 `VideoEncoder`，直通现代显卡专用硅片（NVDEC / NVENC / Intel QuickSync / Apple VideoToolbox）；
  - 突破传统 WASM 软解上限，1080p 解码实测 **695 FPS**，CPU 占用率从 100% 降至 < 5%。
- **WebGPU (图形与通用计算)**：
  - 核心利器：`device.importExternalTexture({ source: videoFrame })`；
  - 消除像素回传内存，显存直通 WGSL 计算着色器，双边滤波降噪单帧只需 **0.42 ms**（快传统 CPU 66 倍）。
- **WebRTC & WebAudio (超低延迟与时钟同步)**：
  - 标准 WHIP / WHEP 广播客户端（RFC 0003），无缝对接 SRS、Janus、Cloudflare Stream；
  - N-way Mesh 拓扑网络，支持定向反向 PLI（单人丢包无需全员重发）；
  - 以 `AudioContext.currentTime` 为硬件基准主时钟，三级自适应算法在 40~500ms 漂移区间悄悄执行 1.05x 变调追帧，实现长期直播零口型脱节。

---

## 3. 通用底层 Native SDK (Pure Rust / C-ABI)

### 1. 技术定位与设计目标
- **定位**：不依赖任何浏览器 DOM、Node.js 运行时或 WASM 沙盒的**工业级通用 C-ABI 动态链接库**（`web_ffmpeg_native.dll` / `.so` / `.dylib`）。
- **C-ABI 接口标准 (`include/web_ffmpeg_native.h`)**：
  - **容器解复用**：`web_ffmpeg_native_demux_mp4_summary`、`web_ffmpeg_native_demux_mkv_summary`；
  - **码流转换**：`web_ffmpeg_native_annex_b_to_avcc`、`web_ffmpeg_native_avcc_to_annex_b`；
  - **音频 DSP**：`web_ffmpeg_native_resample_audio`（分数相位插值）、`web_ffmpeg_native_mix_51_to_stereo`（ITU-R BS.775）、`web_ffmpeg_native_mix_stereo_to_mono`；
  - **滤镜图解析**：`web_ffmpeg_native_parse_filtergraph_count`；
  - **内存管理**：`web_ffmpeg_native_free_audio`、`web_ffmpeg_native_free_bytes`，严格保证跨 FFI 边界无泄漏、无野指针。
- **性能优势**：
  - 编译为原生机器码（x86-64 / AVX2 / LTO Opt-level 3），解复用性能比原生 FFmpeg 命令行快 **2 ~ 15 倍**；
  - 处理千帧级真实视频（如 Intel IoT 1,189 帧工业流），纯 Rust 解析耗时仅 **0.212 ms**（FFmpeg CLI 耗时 14 ms，**快 66 倍**）。
- **应用落地**：
  - 桌面客户端（Tauri / Electron / Qt / WPF）；
  - Windows 后台无头转码服务（`apps/windows-service`）；
  - Linux/服务端高性能媒体预处理微服务。

---

## 4. 引擎特性对照矩阵

| 能力项 | 方向一：Web 浏览器端 (`packages/core`) | 方向二：通用底层 Native SDK (`crates/native`) |
| :--- | :--- | :--- |
| **执行环境** | Chrome 113+ / Edge 113+ (WASM) | Windows / Linux / macOS (Native x86_64/ARM64) |
| **容器格式支持** | MP4, fMP4, WebM/MKV, TS, FLV | MP4, fMP4, WebM/MKV, TS, FLV |
| **解码加速技术** | WebCodecs API (NVDEC, VideoToolbox) | C-ABI 桥接操作系统硬件解码 (D3D11VA, NVCODEC) |
| **滤镜加速技术** | WebGPU WGSL Compute Shaders | 原生 GPU Compute Shader / Rust CPU SIMD 指令集 |
| **直播推拉流** | WHIP / WHEP / WebRTC DataChannel | RTP 分片组包器 / Socket 直通流 |
| **安装部署成本** | **零安装**，打开网页即用 | 引入单头文件 `#include "web_ffmpeg_native.h"` 与动态库 |
| **内存与显存管理** | RAII FrameScope 严控 `VideoFrame.close()` | 明确的分配与 `free_*` C-ABI 函数指针回收 |
| **真实母片解析性能** | 0.08 ms ~ 0.26 ms (内存切片视图) | 0.21 ms ~ 5.0 ms (包含磁盘 I/O 读取) |

---

## 5. 总结

通过将核心逻辑收敛在 **`crates/core`**，本项目实现：
1. **共享核心计算逻辑**：既能以 WASM + WebGPU + WebCodecs 支持前端高画质、低延迟媒体管线；又能以 C-ABI 原生库形式在桌面端与服务端提供独立轻量的高性能底层能力。
2. **多环境部署对齐**：在浏览器内实现显存零拷贝与硬件直通，在原生环境提供严格的内存控制与高吞吐并发支持，满足工业级多场景需求。
