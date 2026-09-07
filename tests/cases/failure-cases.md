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

---

## 自动化敲打与矫正落地规范

所有上述失败案例均在 `tests/harness/failure-correction.spec.ts` 中以真实代码形式进行自动化回归测试，任何一次代码改动如果破坏了上述某一项自愈矫正机制，CI 将立即判定失败红灯拦截！
