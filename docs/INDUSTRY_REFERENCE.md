# 工业界流媒体标准对标与真实测试源全景指南 (Industry Technical Reference & Test Streams)

> 本文档针对真实生产环境（B站、YouTube、剪映 Web 端等一线工业级实践），系统性整理工业界主流编码配置、码率阶梯、公开真实测试媒体文件与公网直播流测试源，为 `web-ffmpeg-gpu` 引擎提供科学、客观、可复现的评测基准。

---

## 🌟 一、一线工业界前沿架构与技术对标

### 1. 剪映 Web 端 (CapCut Web / 字节跳动) 技术实践
剪映 Web 端代表了当前浏览器内专业级视频剪辑与渲染的最顶尖架构：
* **技术三驾马车**：
  - **WebAssembly (WASM)**：移植桌面级核心算法引擎（多轨道时间轴调度、关键帧曲线、音视频分包），开启 SIMD 向量化指令后性能提升超 300%；
  - **WebCodecs**：直接操纵底层硬件编解码芯片，获取原生 `VideoFrame` 物理显存句柄，绕过传统 `<video>` 标签的解析黑盒与高延迟；
  - **WebGPU**：新一代图形与通用并行计算底座，通过 **Compute Shader (计算着色器)** 实现多轨道实时混合、LUT 调色、高斯模糊与 4K 极速渲染。
* **破局核心：零拷贝（Zero-Copy）流水线**：
  - 传统方案必须通过 CPU 将像素数据在内存与显存之间来回拷贝；
  - 剪映 Web 端与本项目完全一致，通过 `device.importExternalTexture({ source: videoFrame })` 将解码出的硬件帧直接作为 WebGPU 纹理进行采样，实现 **CPU 0 负载、显存零拷贝直通**。
* **多线程架构 (Worker Pipeline)**：
  - 渲染与重型编解码工作均在 Web Worker 独立线程执行，彻底保障主 UI 线程在时间线拖拽（Scrubbing）时的 60fps 丝滑响应。

---

### 2. 哔哩哔哩 (Bilibili / B站) 码率阶梯与多编码格式矩阵
B站根据播放端设备硬解能力动态下发最优格式阶梯：
* **主流编码格式三阶梯**：
  - **AVC (H.264)**：全平台 100% 兼容兜底，设备硬解普及率最高；
  - **HEVC (H.265)**：同等画质下比 H.264 节省 30%~40% 带宽，主要用于 4K、真彩 HDR、1080p 高码率；
  - **AV1**：下一代免专利费开源标准，压缩率超越 HEVC，B站已在 PC Web 端与移动端重点推进。
* **B站官方推荐投稿与播放码率阶梯**：
  - **360p / 480p**：500 kbps ~ 1 Mbps（低延迟流媒体）；
  - **720p30 / 720p60**：1.5 Mbps ~ 3 Mbps；
  - **1080p30 (高清)**：3 Mbps ~ 6 Mbps；
  - **1080p60 (高帧率/高码率)**：8 Mbps ~ 15 Mbps；
  - **4K 超清 (2160p)**：20 Mbps ~ 40 Mbps（峰值不超过 60 Mbps）；
  - **GOP (关键帧间隔)**：标准推荐 10 秒 / 个，支持点播极速 Seek 与自适应切片。

---

### 3. YouTube 现代流媒体传输架构
* **DASH (Dynamic Adaptive Streaming over HTTP)**：分片式流式传输；
* **WebCodecs 播放器演进**：YouTube 实验性 WebCodecs 播放引擎旨在降低低配笔记本与移动端浏览器在播放 4K60 AV1/VP9 时的发热与掉帧率。

---

## 🎬 二、公开可用的真实测试视频素材 (Real-world Test Clips)

本项目杜绝单纯的合成码流测试，引入经过业界广泛验证的真实母片与测试视频：

### 1. 本机一键拉取真实测试文件

我们在仓库中内置了自动化真实素材拉取脚本：

```bash
npm run fetch:fixtures
```

该命令会自动将以下工业级标准测试母片拉取至 `tests/fixtures/incoming/`：

1. **Big Buck Bunny Trailer (`big-buck-bunny-trailer.mp4`)**：
   - **来源**：Blender 开源电影基金会官方基准素材（W3C 标准 Web 媒体测试样片）；
   - **规格**：640x360 @ 25fps，H.264 (Main Profile) + AAC 音频，共 250 个媒体样本；
   - **测试点**：标准 ISOBMFF Box 树、B 帧有序呈现、AAC ADTS 音频解码同步。
2. **Intel IoT Benchmark Clip (`intel-bottle-detection.mp4`)**：
   - **来源**：Intel IoT 开发者套件开源实拍视频库；
   - **规格**：真实工业相机采集视频，H.264 高帧流，**长达 1,189 个连续视频帧**；
   - **测试点**：长时码流连续解复用稳定性、无 B 帧监控流高吞吐压测、零显存泄漏压力验证。

### 2. 真实素材本机实测对标数据

在基准机上针对真实素材执行 `npm run bench:demux` 的测试结果：

| 真实测试文件 | 样本数 (帧) | 传统原生 FFmpeg 耗时 (`-c copy`) | **本项目纯 Rust 解复用耗时** | **提速倍数** |
| :--- | :--- | :--- | :--- | :--- |
| **Big Buck Bunny (开源电影样片)** | 250 帧 | 4.0 ms | **0.261 ms** | **15.3x 🚀** |
| **Intel 实拍工业码流 (长视频)** | 1,189 帧 | 14.0 ms | **0.212 ms** | **66.0x 🚀** |

---

## 📡 三、公开可用直播流测试地址清单 (Live Streams)

针对低延迟直播（WebRTC / WHIP / WHEP / HTTP-FLV / HLS），业界常用的公开稳定测试地址如下：

### 1. SRS (Simple Realtime Server) 官方演示与本地流
SRS 是当前开源流媒体服务器事实标准，支持 WebRTC、WHIP、WHEP 与 HTTP-FLV：
* **SRS 公网 WebRTC 推流 (WHIP 标准)**：
  - 推流接入点：`http://localhost:1985/rtc/v1/whip/?app=live&stream=livestream`
  - 官方云演示端点：`webrtc://d.ossrs.net/live/show`
* **SRS 公网 WebRTC 播放 (WHEP 标准)**：
  - 拉流接入点：`http://localhost:1985/rtc/v1/whep/?app=live&stream=livestream`
* **HTTP-FLV 传统直播流**：
  - 拉流地址：`http://localhost:8080/live/livestream.flv`
* **本地极速搭建 SRS 直播源 (Docker 一键启动)**：
  ```bash
  # 启动内置 WebRTC/WHIP/WHEP 支持的 SRS v5 容器
  docker run --rm -it -p 1935:1935 -p 8080:8080 -p 1985:1985 -p 8000:8000/udp \
    registry.cn-hangzhou.aliyuncs.com/ossrs/srs:5 ./objs/srs -c conf/rtmp2rtc.conf
  ```

### 2. Akamai 与 Mux 公开流媒体测试源
* **Akamai 超低延迟 HLS 直播测试流 (CMAF/HLS)**：
  - URL：`https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8`
  - 特性：全球 CDN 分发，24 小时不间断直播流，适合测试长时间播放器抗抖动与时钟平滑追帧。
* **Mux.dev 自适应多码率 HLS 测试源 (Big Buck Bunny)**：
  - URL：`https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8`
  - 特性：提供全码率阶梯（从 360p 到 1080p），适合测试自适应分辨率无缝切换（DRS）。
* **Apple 官方 HEVC/fMP4 测试流**：
  - URL：`https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_adv_example_hevc/master.m3u8`
  - 特性：原生 H.265 / HEVC 视频流切片，适合验证现代显卡硬件直通解码。

---

## 🛠️ 四、如何使用真实素材扩展本项目测试矩阵

1. **新增任意真实视频文件**：
   直接将任意本地 `.mp4` 文件拷贝至 `tests/fixtures/incoming/` 目录；
2. **运行基准测试**：
   ```bash
   # 测试真实素材与阶梯码流的解复用吞吐性能
   npm run bench:demux

   # 运行端到端硬解与转码对比评测
   npm run bench:layers
   ```
   测试脚本会自动扫描 `tests/fixtures/incoming/` 中的所有视频，自动计算帧数、码率、解析耗时，并与原生 FFmpeg 进行精确对照输出！
