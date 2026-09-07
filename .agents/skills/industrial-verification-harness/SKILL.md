---
name: industrial-verification-harness
description: >-
  工业级自动化测试与多 Agent 并发 Fuzzing Harness 技能。
  用于对 WebCodecs、纯 Rust 容器解析器、转码管线与 WebGPU 着色器进行极端码流敲打、
  畸变 NAL 单元注入、多模型并发审计与千帧显存防泄漏压测。
---

# 工业级自动化测试与多 Agent 并发 Harness 规范 (Industrial Verification Harness)

FFmpeg 能够支撑全球几十亿设备音视频处理的核心护城河，是其经历过全球最恶劣畸变码流二十年残酷敲打的稳定性。
本项目绝不满足于只跑通“标准 MP4 视频”的玩具级测试，必须建立严格的工业级 Fuzzing 与多 Agent 并发敲打系统。

---

## 一、 “三零法则”工业级门禁标准 (The Three-Zeros Invariant)

任何新增的解复用器、硬件编解码管线或着色器滤镜，合入前必须通过以下自动化门禁：

1. **零 Panic (Zero Panic)**：
   - 面对任何格式损坏、切片截断、SPS 越界参数或乱序 NAL 单元，纯 Rust WASM 核心严禁 `panic!`；
   - 必须优雅返回 `Err` 或安全跳过坏块，并向控制台抛出可诊断的 Warning。
2. **零显存泄漏 (Zero VRAM Leak)**：
   - 连续高频解码、渲染或转码 1,000 帧后，WebCodecs `VideoFrame` 显存句柄必须闭环归还，GPU 显存净增量必须 `< 5MB`；
   - 严禁触发任何操作系统级 GPU TDR（驱动重置）或标签页 OOM。
3. **零音画漂移 (Zero Desync Drift)**：
   - 连续流式播放或转码处理 30 分钟以上，音频与视频时间戳物理偏差必须保持 `|diff| < 40ms`（人耳视觉无感区）。

---

## 二、 “三权分立”多 Agent 并发分工体系

```
[Agent A: 变异用例构造器 (Test Generator)]
       │  (注入畸变 SPS/PPS、深层 B 帧金字塔、损坏 NAL、乱序时间戳)
       ▼
[Agent B: 高并发执行器 (Stress Runner)]
       │  (并发驱动 Playwright、WebCodecs 硬解硬编、WebGPU 着色器全速运转)
       ▼
[Agent C: 显存与指标审计官 (Metric Auditor)]
          (采样 VRAM 显存句柄、监测 GPU 丢帧率与音画差值，输出工业级质检报告)
```

---

## 三、 测试用例变异生成规范 (`tests/harness/fuzzer.ts`)

Harness 必须程序化生成以下四类极端攻击用例：
1. **SPS/PPS 越界变异**：
   - 注入非法 profile_idc、非法 level_idc、越界宽高（如 16384x16384）、负数裁剪偏移。
2. **B 帧乱序深渊 (Deep B-Pyramid)**：
   - 构造多层 B 帧金字塔，DTS 顺序单调递增，但 PTS 跨度剧烈交错跳跃（如 PTS: 0, 80, 40, 20, 60），验证 `TimelineQueue` 最小堆单调还原能力。
3. **截断与残损数据注入 (Corrupted Payloads)**：
   - 随机剥离 NAL 头部的 `0x00000001` Start Code；
   - 随机在关键帧中间插入全是 `0xFF` 的脏垃圾字节；
   - 在未收到 IDR 帧前故意连续灌入 P 帧与 B 帧。
4. **动态帧率突变 (Extreme VFR)**：
   - 相邻帧微秒时间差从 1,000μs (1000fps) 剧烈突变为 500,000μs (2fps)，验证自适应时钟稳定性。
