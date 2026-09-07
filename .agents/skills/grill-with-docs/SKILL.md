---
name: grill-with-docs
description: >-
  Interactive RFC interview and requirements engineering skill.
  Use before implementing any major feature, codec module, or refactor.
  Progressively interviews the user with deep architectural questions, edge-case inquiries,
  and trade-offs, then solidifies decisions into formal RFC documents under docs/rfcs/
  and executable test harness cases.
---

# Grill-with-Docs Skill

This skill enforces an **Interview-First & RFC-Driven** development methodology for `web-ffmpeg-gpu`.
FFmpeg reached its monumental capability over 20+ years of being hammered by real-world edge cases.
We achieve similar industrial robustness not by writing massive chunks of unverified code, but by:
1. Thoroughly interviewing on requirements, constraints, and edge cases.
2. Solidifying architectural decisions into numbered RFCs (`docs/rfcs/`).
3. Collecting real-world sample cases and edge cases into the test harness.
4. Implementing in verifiable, incremental slices.

---

## The 4-Phase Workflow

```
[Phase 1: Deep Grill Interview]
       │  (Ask structured questions on trade-offs, edge cases, bitstream variations)
       ▼
[Phase 2: Formal RFC Solidification]
       │  (Write/Update docs/rfcs/XXXX-<name>.md with architecture & invariants)
       ▼
[Phase 3: Case Inventory & Test Harness Setup]
       │  (Define specific test media: abnormal headers, B-frame jitter, audio drift)
       ▼
[Phase 4: Sliced Execution & Verification]
          (Implement step-by-step with zero regressions and zero VRAM leaks)
```

---

## Phase 1: Deep Grill Interview (Interrogation Protocol)

When a new feature or stage is proposed, **DO NOT jump to code**.
First, formulate 3 to 5 high-impact questions across these dimensions:

1. **Functional Scope & Edge Cases**:
   - What happens with Variable Frame Rate (VFR) vs Constant Frame Rate (CFR)?
   - How to handle missing SPS/PPS, audio packet drift, or non-keyframe starts?
   - What resolution limits, aspect ratios, and color spaces (BT.709 vs BT.2020 10-bit) are supported?

2. **Architectural Trade-offs (Rust CPU vs WebGPU vs WebCodecs)**:
   - Where should computation live? (Rust SIMD vs WebGPU shader vs WebCodecs ASIC)
   - What are the zero-copy implications? Does passing data through WASM linear memory cause PCIe bottleneck?

3. **User Experience & API Ergonomics**:
   - What events must be emitted? (Progress, FPS, VRAM consumption, frame drops)
   - Synchronous vs Asynchronous stream API? Web Worker offloading requirements?

4. **Failure Modes & Fallbacks**:
   - If WebCodecs hardware encoding fails (e.g. unsupported profile/resolution), what is the error strategy?

---

## Phase 2: Formal RFC Solidification

Create a new file in `docs/rfcs/` following the format:
- `docs/rfcs/XXXX-title.md` (e.g. `0001-video-transcoder-compression.md`)

Each RFC must contain:
1. **Summary & Motivation**: Why this feature is needed and problem being solved.
2. **Detailed Design**:
   - Rust data structures & WASM ABI
   - WebCodecs / WebGPU pipeline topology
   - ISOBMFF Box / Bitstream specification compliance
3. **Invariants & Constraints**:
   - Zero VRAM leak: Exact lifecycle for `VideoFrame.close()`
   - Monotonic PTS: Handling B-frames via `TimelineQueue`
   - Memory budgets (e.g. max buffer pool size)
4. **Test & Benchmark Criteria**:
   - Target transcoding speed (e.g. >5x real-time on 1080p)
   - Maximum CPU usage (<15%)
   - Output validity check (ffprobe / mp4box verification)

---

## Phase 3: Case Inventory & Test Harness

Before implementation, catalog real-world test cases in `tests/cases/`:
- Standard Baseline: 1080p H.264 + AAC (Constant 30fps)
- B-Frame Torture: 60fps video with deep B-pyramid (PTS != DTS)
- High-Bitrate / 4K: 4K 60Mbps action video for VRAM & throughput stress
- iPhone HDR / Matrix: Video with `tkhd` 90-degree rotation matrix and HLG/PQ color metadata
- Corrupted / Truncated: Missing `moov` at file end or truncated NAL units

---

## Phase 4: Sliced Execution

Implement strictly in accordance with the approved RFC in small, atomic commits:
- Step A: Pure Rust Bitstream / Box level changes + cargo unit tests.
- Step B: TypeScript WebCodecs / WebGPU integration + headless tests.
- Step C: Playground UI interactive workbench update.
- Step D: Playwright automated verification against real sample media.
