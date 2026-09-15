# RFC 0003: 标准 WHIP (RFC 9725) / WHEP 广播推拉流客户端

- **状态**: Accepted (路线图选项 A，已对齐执行)
- **提出时间**: 2026-09-11
- **上游规范**: [RFC 0002: 低延迟 Web 直播与 WebRTC 引擎](./0002-webrtc-web-live-streaming.md)
- **协议依据**: IETF RFC 9725 (WHIP)、draft-ietf-wish-whep (WHEP)、RFC 8840 (Trickle ICE SDP Fragment)
- **责任模块**: `packages/core/src/live` (`WhipClient` / `WhepClient` / `LoopbackWhipWhepGateway`), `apps/playground`, `tests/e2e/whip-whep.spec.ts`

---

## 1. Summary & Motivation

RFC 0002 已完成单对单 P2P、多路硬件混流、多端 Mesh 与 Agent 自愈底座。这些通道均走 **RTCDataChannel + 自研 RTP 封包**，无法对接 OBS / SRS / Janus / MediaSoup / LiveKit / Cloudflare Stream 等工业级媒体服务器。

本 RFC 落地标准 **WHIP 推流客户端** 与 **WHEP 拉流客户端**：

- 用 HTTP POST SDP Offer/Answer 替代自定义信令房间；
- 用 HTTP PATCH `application/trickle-ice-sdpfrag` 完成 ICE Trickle；
- 用 HTTP DELETE 做资源级优雅下线；
- 媒体面走 **标准 RTP `RTCPeerConnection.addTrack` / `ontrack`**，以便 SFU/CDN 直接转发。

---

## 2. Aligned Architectural Decisions

| 决策点 | 选定方案 | 原因 |
| :--- | :--- | :--- |
| 媒体面 | 标准 WebRTC RTP Track，禁止 DataChannel 承载音视频 | WHIP/WHEP 服务器只认 SDP `m=video` / `m=audio` |
| 编码器 | WebGPU 滤镜后走 `MediaStreamTrackGenerator`；若 `createEncodedStreams` 可用则注入 WebCodecs `HardwareVideoEncoder` Annex-B NALU | 滤镜与码率/GOP 由引擎控制，RTP 仍对 SFU 兼容 |
| 滤镜接入 | `WhipClient` 内建 `WhipGpuTrackBridge`，`setFilter()` 热更新 | 不再把滤镜甩给调用方自建 Generator |
| 鉴权 | `Authorization: Bearer <token>` | RFC 9725 推荐；对接 Cloudflare / SRS 令牌 |
| ICE | 201 `Link: rel="ice-server"` + PATCH Trickle；405 则降级为非 Trickle | 兼容只支持 gathering-complete 的旧网关 |
| 重定向 | 跟随 307/308，保持 POST + SDP body | RFC 9725 禁止 301/302 把 POST 变成 GET |
| 测试网关 | 同页 `LoopbackWhipWhepGateway`（可注入 `fetchImpl`） | 无真实 SFU 时仍可做 ICE/RTP 端到端验收 |

**明确不做（本切片）**：Dedicated Worker 离屏保活（选项 B）、WebTransport/MoQ（选项 C）。WebGPU 滤镜与 WebCodecs 硬编注入已纳入本切片。

---

## 3. Detailed Design

### 3.1 数据拓扑

```
[Camera / Desktop / Synthetic Track]
       │  MediaStreamTrackProcessor (VideoFrame)
       ▼
[WebGPU WGSL 滤镜 OffscreenCanvas]  ── frame.close() RAII
       │  MediaStreamTrackGenerator
       ▼
[可选 WebCodecs HardwareVideoEncoder → Encoded Transform 注入 NALU]
       │
       ▼
[WhipClient RTCPeerConnection.addTrack]  ── POST/PATCH/DELETE ──►  [WHIP Endpoint]
```

### 3.2 HTTP 信令状态机

```
IDLE ──publish/play──► POST application/sdp
                           │
                    201 + Location + SDP Answer
                           │
                           ▼
                      NEGOTIATED ──onicecandidate──► PATCH trickle-ice-sdpfrag
                           │                              │
                           │                         204 / 200
                           │                         405 → 关闭 Trickle
                           ▼
                      CONNECTED (iceConnectionState connected|completed)
                           │
                      DELETE Location
                           ▼
                         IDLE
```

### 3.3 TypeScript API

```typescript
export class WhipClient {
  constructor(options: WhipClientOptions);
  publish(stream?: MediaStream): Promise<void>;
  stop(): Promise<void>;
  getMetrics(): WhipClientMetrics;
}

export class WhepClient {
  constructor(options: WhepClientOptions);
  play(target?: HTMLVideoElement): Promise<MediaStream>;
  stop(): Promise<void>;
  getRemoteStream(): MediaStream | null;
  getMetrics(): WhepClientMetrics;
}
```

`WhipClientOptions` / `WhepClientOptions` 共用：`endpoint`、`token`、`iceServers`、`fetchImpl`、`trickleIce`、状态/指标回调。

### 3.4 Trickle ICE SDP Fragment (RFC 8840)

```
a=ice-ufrag:<ufrag>
a=ice-pwd:<pwd>
m=video 9 UDP/TLS/RTP/SAVPF 0
a=mid:0
a=candidate:...
a=end-of-candidates
```

- 资源 URL 未返回前，ICE candidate 进入队列，201 后一次性 flush。
- `a=end-of-candidates` 在 `iceGatheringState === 'complete'` 时发送；服务器 4xx 时忽略。

---

## 4. Invariants & Constraints

1. **互操作不变式**：媒体只能走 RTP Track，不得复用 RFC 0002 DataChannel 封包。
2. **资源生命周期不变式**：`stop()` 必须先 HTTP DELETE，再 `pc.close()`；DELETE 失败不得阻塞本地关闭。
3. **显存不变式**：本模块不持有 `VideoFrame`。调用方若用 `MediaStreamTrackProcessor` 做 WebGPU 滤镜，必须在写入 Generator 后立即 `frame.close()`。
4. **鉴权不变式**：所有 POST/PATCH/DELETE 携带同一 Bearer；401/403 视为不可恢复错误。
5. **时钟不变式**：WHEP 播放音画同步交给浏览器 WebRTC jitter buffer；与 RFC 0002 DataChannel 播放器的 `MasterClockSync` 解耦。

---

## 5. Test & Benchmark Criteria

| 编号 | 场景 | 验收 |
| :--- | :--- | :--- |
| CASE-08 | Link / SDP-frag / Location / 405 降级协议解析 | 纯函数 + mock fetch 全绿 |
| CASE-09 | Loopback WHIP 推流 ICE 连通 | `connectionState === 'connected'`，outbound 字节 > 0 |
| CASE-10 | Loopback WHEP 拉流出画 | inbound `framesDecoded >= 1` 或 video 元素 `videoWidth > 0` |
| CASE-11 | DELETE 优雅下线 | 资源 404/200，本地 PC `closed` |
| CASE-12 | Bearer 401 | `publish()` reject，不泄漏 PeerConnection |

性能目标（对接真实 SRS/LiveKit 时）：1080p30 推流 CPU < 15%（无额外 Canvas 滤镜时），建连 < 2s（含 STUN）。
