# Web-FFmpeg-GPU 测试用例与健壮性敲打矩阵 (Test Harness Matrix)

FFmpeg 能够成为音视频领域事实标准的关键，在于其经历过全球各种诡异码流、畸变容器、恶心元数据的二十年敲打。
为了让 `web-ffmpeg-gpu` 具备真正的工业级可靠性，我们建立以下阶梯式真实用例库，并通过 Playwright + 自动化探针递归测试：

---

## 阶梯测试矩阵 (Test Matrix)

| 类别代号 | 场景名称 | 典型测试用例 (Cases) | 潜在炸裂点 (Failure Modes) | 预期验证指标 |
| :--- | :--- | :--- | :--- | :--- |
| **CASE-01** | **标准转码基准** | 1080p 30fps H.264 + AAC 恒定帧率 (CFR) | 内存缓慢上升、音画时间戳微小偏差 | 10x 实时速、零显存泄漏、音画同步误差 < 5ms |
| **CASE-02** | **B 帧乱序深渊** | 60fps 高画质游戏录像，含深层 B 帧金字塔 (PTS != DTS) | 解码出的画面时空倒流、画面抽搐跳跃 | `TimelineQueue` 最小堆强制单调递增 PTS 排序 |
| **CASE-03** | **手机实拍旋转矩阵** | iPhone / Android 竖拍或倒置视频 (`tkhd` 90°/180°/270° 矩阵) | 转码后画面被压扁拉伸、变成横向或颠倒 | 纯 Rust 解析 `tkhd` 矩阵，WebGPU 自动执行视口旋转矩阵转换 |
| **CASE-04** | **动态帧率 (VFR) 漂移** | 微信/短视频导出的动态帧率视频 (15fps ~ 60fps 跳跃) | 转码后音频提前放完或严重滞后、爆音卡死 | 绝对微秒级 PTS 映射，维持原始时间戳间距 |
| **CASE-05** | **HDR / 10-bit 色彩失真** | iPhone HDR (Dolby Vision / HLG / PQ) 视频 | 直接转码后画面严重发白、褪色、过曝 | WebGPU 自动着色器执行 Reinhard / ACES Tone Mapping |
| **CASE-06** | **异常截断与容错** | `moov` 位于末尾且被截断、丢失 SPS/PPS、缺失 I 帧开头 | 浏览器进程崩溃、WASM panic 抛异常未捕获 | Rust 解复用器优雅返回 Err，不 panic，抛出可读诊断 |
| **CASE-07** | **极限高码率与显存压测** | 4K 60fps 60Mbps 运动极限视频连续转码 10 分钟 | WebCodecs `VideoFrame` 显存爆满、GPU 驱动重置 (TDR) | 背压控制机制 (Backpressure)，限制同时挂起的 GPU 帧数 <= 5 |
| **CASE-08** | **WHIP/WHEP 信令协议** | Link ice-server、trickle-ice-sdpfrag、相对 Location、PATCH 405、Bearer 401 | 错误 Content-Type / 丢 Location / 401 仍占用 PeerConnection | RFC 9725 握手字段完整，401 立即失败 |
| **CASE-09** | **WHIP Loopback 推流** | 同页 Loopback 网关 + 合成 Canvas Track | ICE 失败、无 outbound RTP | `connectionState=connected` 且 bytesSent > 0 |
| **CASE-10** | **WHEP Loopback 拉流** | WHIP 发布后再 WHEP 订阅 | 无远端 Track、画面全黑 | inbound framesDecoded 或 bytesReceived > 0 |
| **CASE-11** | **DELETE 优雅下线** | stop() 必须 DELETE Location 再 close PC | 服务器会话泄漏、本地 PC 悬挂 | DELETE 已发出，PC `closed` |

---

## 自动化运行与采集指南

1. 每次提交核心模块（解复用、编解码、封装）必须在 `apps/playground` 与 Playwright e2e 中通过对应的 CASE 校验。
2. 当社区或用户反馈特殊格式 bug 时，脱敏提取前 5 秒切片追加至 `tests/fixtures/`，纳入回归测试集。
