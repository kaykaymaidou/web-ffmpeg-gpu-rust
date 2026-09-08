# 恶性失败用例集与自愈矫正机制 (Failure Cases & Self-Correction Matrix)

> **核心工程哲学**：  
> **“成功只有一种可能，而失败有千万种边界。”**  
> 视频处理引擎要达到工业级（比肩 FFmpeg 二十年抗打能力），最关键的不是测试在标准视频下的顺畅运行，而是**在成百上千种畸变、破损、脏数据和恶性异常轰炸下，系统如何优雅自愈、校正时间线并保障最终任务不崩溃**。

---

## 恶性失败与自愈校正全景表 (Failure & Autocorrection Matrix)

| 失败编号 | 恶性边界故障场景 (Failure Scenario) | 传统方案/未防御时的致命后果 | web-ffmpeg-gpu 引擎自愈校正机制 (Autocorrection) | 工业级验收准则 |
| :--- | :--- | :--- | :--- | :--- |
| **FAIL-01** | **首帧非 IDR 脏帧流 (Dirty Non-IDR Start)**<br>网络推流、切片或录像由于丢包，开头只有 P 帧/B 帧，缺失 IDR 关键帧 | `VideoDecoder` 抛出 `EncodingError`，播放器开头持续绿屏或马赛克卡死 | **脏帧自愈丢弃器 (Dirty Prefix Dropper)**：解复用与解码调度器自动识别 NAL 单元类型，丢弃开头的全部 P/B 帧，静候首个合法 IDR 帧才开始送解 | 画面 0 绿屏，首帧 PTS 自动重锚定为 0 |
| **FAIL-02** | **SPS 畸变与指数哥伦布越界 (Malformed SPS Bitstream)**<br>伪造的 SPS 比特流，包含死循环的 `ue(v)` 编码或非法 Profile/Level | Rust 产生越界 panic 或死循环挂起，整条 WASM 引擎死锁 | **安全边界扫描与 Baseline 降级**：Rust `ExpGolombReader` 每次位移严格校验 `bit_pos < total_bits`，溢出立即返回 `None`；引擎记录 warning 并回退至安全预设 | Rust 核心 0 panic，转码任务不中断 |
| **FAIL-03** | **时间戳时空倒流 (Negative PTS / Timestamp Inversion)**<br>损坏的码流中存在 PTS 倒退 2 秒以上的恶性时间戳错误 | 渲染管线画面疯狂闪烁、时空倒放，WebAudio 破音爆音 | **单调递增时钟矫正器 (Monotonic PTS Clamping)**：`TimelineQueue` 最小堆监测时间戳，若检测到连续倒流，自动平滑 clamp 为 `last_pts + 1ms` 强制推进 | 时间戳严格单调递增，音画时间线不倒流 |
| **FAIL-04** | **损坏的 AAC 音频流 (Corrupted Audio Track in MP4)**<br>MP4 中视频完好，但音频轨道采样率声明错误或 AAC 包严重截断 | 音频解码器抛错，导致整个 2 小时视频转码任务彻底被连累中断 | **音频故障降级隔离 (Audio Fault Isolation)**：音频解封装遇到残损包时，自动跳过坏包并插入静音补偿帧；严重损坏时自动降级为无声导出 | 视频 100% 成功转码导出，给出容错诊断 |
| **FAIL-05** | **文件尾部截断 (Truncated MP4 / Missing moov Box)**<br>文件只下载了 30% 即被强行中断，未写入位于末尾的 `moov` 索引 | 传统 `ffmpeg.wasm` 抛出 `Invalid data found` 退出码 1 彻底报废 | **流式 NAL 提取自救模式**：在纯 Rust 侧扫描残存的 `mdat`，提取内嵌的 Annex-B SPS/PPS 与视频切片，抢救可播放的切片片段 | 提取残存可用帧，不发生未捕获异常崩溃 |
| **FAIL-06** | **并发显存雪崩 (VRAM Backpressure Spike)**<br>瞬时涌入上百个 4K 60fps 帧，编码队列 `encodeQueueSize` 飙升 | 浏览器显存耗尽，触发 Windows GPU TDR（显卡驱动重置蓝屏/黑屏） | **背压刹车与队列限流**：`waitForBackpressure(8)` 严格挂起解码任务，必要时对非参考 B 帧进行有序丢帧降温 | 挂起显存帧严格 <= 8，GPU 驱动平稳无崩溃 |
| **FAIL-07** | **时间戳碰撞与零时长 (PTS Collision & Zero Duration)**<br>弱网重复分包或编码器异常导致多个连续帧拥有完全相同的时间戳 `pts[n] == pts[n-1]` 或 `duration == 0` | WebCodecs 解码器丢弃后续所有时间戳未前进的帧，播放器出现卡顿停滞或音画死锁 | **单调递增步进与非零时长矫正 (Monotonic PTS Advance)**：`TimelineQueue` 与管线监测到相同或滞后时间戳时，强制按 `pts = max(pts, last_pts + 1)` 递增推进，并补正非零安全时长（默认 33333 µs） | 所有输出帧时间线严格单调前进，解码器零停滞 |
| **FAIL-08** | **直播动态分辨率突变 (Dynamic Resolution Switching / DRS)**<br>OBS/WebRTC 弱网自适应码率突然从 1080p 骤降为 720p，或横竖屏动态切换 | 渲染器与 Canvas 初始纹理尺寸固定，后续尺寸不匹配导致 WebGPU 抛出异常崩溃、画面撕裂变形或黑屏 | **动态视口与信箱模式自适应 (Adaptive Viewport Re-layout)**：渲染管线监测输入 `VideoFrame.displayWidth / displayHeight` 变更，自动动态调整画布视口尺寸与 Letterbox/Pillarbox 黑边保护 | 分辨率骤变时渲染管线零崩溃，画面平滑过度无拉伸 |
| **FAIL-09** | **WebRTC RTP 分片丢失与残损熔断 (RTP FU-A / FU Packet Loss)**<br>弱网环境下，一个 4K/1080p 帧由 40+ 个 FU-A/FU 分片组成，中间某分片丢失（如丢第 18 包） | 传统解包器将缺损的分片拼合，脏数据喂入 `VideoDecoder` 导致致命 `EncodingError` 崩溃抛错，画面永久绿屏或持续马赛克 | **分片连续性校验与坏帧熔断清空 (Corrupt Buffer Purge)**：解包器实时监控 `expected_seq`，检测到分片间隙断裂立即熔断当前分片缓存，拒绝向解码器输出不完整 NAL，并在统计中标记丢包等待下一合法关键帧 | WebCodecs 零抛错，解码管道平稳无死锁 |
| **FAIL-10** | **16 位 RTP 序列号越界与 90kHz 时钟回环 (RTP Sequence Wrap-around 65535->0)**<br>高码率 60fps 码流推流 1~2 分钟后序列号达到 65535 并跨越回 0 | 简单无符号比较 `seq < last_seq` 误将新包判定为过期的远古历史包，Jitter Buffer 触发毁灭性丢包雪崩，直播断流 | **RFC 3550 模运算连续解环绕器 (Modular 16-bit Unroller)**：使用 `(seq.wrapping_sub(max_seq)) as i16` 模算距离展开为 64 位单调递增包序与 90kHz 微秒 PTS，平滑越过 65535 边界 | 跨越 65535 临界点 0 丢包，时间戳平滑单调前进 |



---

## 自动化敲打与矫正落地规范

所有上述失败案例均在 `tests/harness/failure-correction.spec.ts` 中以真实代码形式进行自动化回归测试，任何一次代码改动如果破坏了上述某一项自愈矫正机制，CI 将立即判定失败红灯拦截！
