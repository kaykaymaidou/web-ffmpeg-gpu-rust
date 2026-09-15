# RFC 0002: 低延迟 Web 直播与 WebRTC 引擎架构 (Live Ingest & Egress Engine)

- **状态**: Accepted (P2P / Mesh / 混流 / Agent 已落地；WHIP/WHEP 见 RFC 0003)
- **提出时间**: 2026-09-08
- **后续切片**: [RFC 0003: 标准 WHIP / WHEP 广播推拉流客户端](./0003-whip-whep-broadcast-clients.md)
- **参考研究**: [Web 直播与 RTC 实战深度调研报告](file:///d:/Project/web-ffmpeg-gpu/docs/research/live-streaming-industry-analysis.md)
- **责任模块**: `crates/core` (Rust FLV/fMP4/MoQ Demuxer & JitterBuffer), `packages/core` (LiveStreamer & LivePlayer), `apps/playground` (实时流媒体演示台)

---

## 1. 核心目标与破局定位

本 RFC 针对传统 Web 直播与 WebRTC 领域的四大真实顽疾，制定统一的端到端技术标准：
1. **解决开播推流 CPU 爆炸与切后台断流**：用 WebGPU 零拷贝滤镜 + Dedicated Worker 彻底替代高开销的 `canvas.captureStream()`；
2. **解决 WebCodecs 播放器音画脱节 (Lip-sync Drift)**：建立以 `AudioContext.outputLatency` 为硬件基准的单一主时钟，结合 1.05x 无感声画变速平滑消除累计延迟；
3. **解决网络抖动与解码器崩溃 (InvalidStateError)**：在纯 Rust 侧落地轻量级自适应 Jitter Buffer，智能重排 B 帧，缺失参考帧时自动容错自愈；
4. **统一支持现代高压缩比编码**：支持 H.264 / H.265 / AV1 全硬解，通过 WebGPU WGSL 实时完成 HDR 色调映射与色彩空间转换。

---

## 2. 详细设计：推流引擎 (Live Ingest Pipeline)

### 2.1 数据拓扑
```
[摄像头/桌面 MediaStreamTrack] 
       │ (MediaStreamTrackProcessor)
       ▼
[VideoFrame (显存句柄)] 
       │ (device.importExternalTexture)
       ▼
[WebGPU WGSL 着色器管线] ─── (美颜磨皮 / 绿幕抠图 / 3D LUT / 视口旋转)
       │ (WebGPU 纹理导出 VideoFrame)
       ▼
[WebCodecs Hardware VideoEncoder] ─── (NVENC/QSV/Apple 硬编，功耗 < 5% CPU)
       │ (EncodedVideoChunk)
       ▼
[纯 Rust Muxer (crates/core)] ─── (封装为 fMP4 Chunks / Enhanced FLV / MoQ)
       │
   ┌───┴────────────────────────┐
   ▼                            ▼
[WHIP (RFC 9725)]        [WebTransport (HTTP/3 QUIC)]
(兼容既有 WebRTC SFU)    (下一代低延迟大直播，延迟 < 300ms)
```

### 2.2 核心不变式
- **Worker 独立线程不变式**：所有 WebGPU 滤镜与 WebCodecs 编码均运行在 Dedicated Worker 中，确保标签页在后台或被遮挡时不被降频调度。
- **显存零回读不变式**：从摄像头采集到 WebCodecs 编码产出，帧像素数据全程保留在 GPU 显存内，禁止任何向 CPU 内存的 Readback 拷贝。

---

## 3. 详细设计：播放引擎 (Live Egress Pipeline)

### 3.1 数据拓扑
```
[网络输入: WebSocket-FLV / HTTP-FLV / WebTransport MoQ]
       │ (Uint8Array 字节流)
       ▼
[纯 Rust WASM 实时流解复用器 (crates/core)]
       │ (提取 NALU 与 AAC/Opus 压缩包)
       ▼
[纯 Rust 动态 Jitter Buffer] ─── (B 帧重排序、网络抖动平滑窗、丢包错误隐藏)
       │
   ┌───┴────────────────────────┐
   ▼ (有序视频 NALU)             ▼ (音频包)
[WebCodecs VideoDecoder]   [WebCodecs AudioDecoder / AudioWorklet]
   │ (GPU 显存 VideoFrame)       │ (AudioData PCM)
   ▼                             ▼
[WebGPU 视口与色调映射]    [AudioContext (硬件主时钟基准)]
   │                             │
   └──────────────┬──────────────┘
                  ▼
         [单主时钟微调对齐状态机]
   - 偏差 < 40ms: 正常逐帧投递渲染
   - 40ms ~ 500ms: 1.05x 平滑无感变速追帧
   - > 500ms: 极速关键帧跳跃 + 声画重锚定
```

---

## 4. 关键接口规范

### 4.1 纯 Rust JitterBuffer API (`crates/core/src/live/jitter_buffer.rs`)
```rust
pub struct JitterBufferConfig {
    pub min_delay_ms: u32,  // 默认 50ms
    pub max_delay_ms: u32,  // 默认 200ms
}

pub struct JitterBuffer {
    // 内部基于 PTS 的最小堆与环形帧缓冲
}

impl JitterBuffer {
    pub fn new(config: JitterBufferConfig) -> Self;
    pub fn push_packet(&mut self, packet: StreamPacket) -> Result<(), JitterError>;
    pub fn pop_ready_frame(&mut self, current_playback_pts: u64) -> Option<StreamPacket>;
    pub fn handle_packet_loss(&mut self, lost_seq: u32);
}
```

### 4.2 TypeScript 播放器核心调度器 (`packages/core/src/live/player.ts`)
```typescript
export interface LivePlayerConfig {
    sourceUrl: string;
    protocol: 'websocket-flv' | 'http-flv' | 'webtransport-moq' | 'whip-whep';
    canvas: HTMLCanvasElement | OffscreenCanvas;
    lowLatencyTargetMs?: number; // 默认 300ms
}

export class WebFfmpegLivePlayer {
    async start(): Promise<void>;
    pause(): void;
    resume(): void;
    destroy(): void;
    
    // 实时指标
    getStats(): LivePlayerStats; // 延迟、FPS、网络丢包率、Jitter 方差、音画差值
}
```

---

## 5. 验收标准与真实场景用例

1. **推流性能验收**：1080p 60fps 摄像头捕获 + WebGPU 美颜着色器 + 硬件编码推流，CPU 占用率 `<= 10%`，后台最小化保持 60fps 不降频。
2. **播放长效稳定性**：连续播放 12 小时 HTTP-FLV / WebTransport 直播流，音画偏差控制在 `|diff| <= 35ms`，显存与内存维持恒定不发生 OOM。
3. **网络抖动与弱网抗性**：在 10% 随机网络丢包与 100ms 抖动环境下，画面不卡死绿屏，网络恢复后在 2 秒内通过平滑微加速恢复到 300ms 延迟以内。
