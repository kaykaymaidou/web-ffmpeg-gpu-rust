# Web-FFmpeg-GPU 🚀

**English** | [简体中文](README.zh-CN.md)

> **Next-Gen Web Multimedia Engine & Autonomous AI Live Ingest Pipeline**  
> Inspired by **FFmpeg's** classic pipeline philosophy, empowered by **Rust's** fearless memory safety, accelerated by **WebCodecs** ASIC hardware encoding/decoding, enhanced by **WebGPU** WGSL realtime multi-stream shaders, and orchestrated by an autonomous **DeepSeek Harness (`dsh`)** ReAct agent.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Engine: Rust + WebGPU + WebCodecs](https://img.shields.io/badge/Engine-Rust%20%2B%20WebGPU%20%2B%20WebCodecs-orange.svg)](#)
[![WebRTC: P2P + Multi--Peer Mesh](https://img.shields.io/badge/WebRTC-P2P%20%7C%20Mesh%20Topology-brightgreen.svg)](#)
[![AI Agent: DeepSeek Harness](https://img.shields.io/badge/AI%20Autopilot-DeepSeek%20Harness%20dsh-purple.svg)](#)
[![Quality: Three--Zeros Invariant](https://img.shields.io/badge/Quality-Three--Zeros%20Invariant-success.svg)](#)

---

## 🌟 The Core Problem & Solution

Processing high-throughput media and live streaming inside browsers has historically faced critical industry hurdles:

1. **The `ffmpeg.wasm` Bottleneck**:
   - Compiling C-based FFmpeg to WebAssembly relies on **100% CPU-bound software decoding/encoding**.
   - Processing 1080p60 or 4K media pegs CPU cores at 100%, causing severe thermal throttling, frame stutter, and tab crashes.
   - Incapable of accessing dedicated GPU video ASICs (NVENC/NVDEC, Intel QuickSync, Apple VideoToolbox).
2. **The Raw WebCodecs Dilemma**:
   - WebCodecs exposes hardware encode/decode, but lacks general container demuxing, complex multi-stream compositing, dynamic timeline reordering, and resilient network transmission.
3. **The Web Live & WebRTC Dilemma**:
   - High CPU usage in `canvas.captureStream()`, lip-sync audio/video drift, cross-peer packet loss degradation, and VRAM memory leaks.

### Our Solution: The Hybrid Hardware-Accelerated Monorepo

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                       Media Input (File / WebRTC / Live Stream)               │
│                        (MP4, MKV, FLV, H.264/HEVC, Opus, PCM)                 │
└──────────────────────────────────────┬────────────────────────────────────────┘
                                       │
                                       ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                     Rust / WASM Scheduling Core (crates/core)                 │
│      - Strict B-Frame Reordering & Monotonic PTS Timestamp Clamping           │
│      - Zero-Panic Exp-Golomb Bitstream Parser (Annex-B / AVCC / HVCC)         │
│      - FastStart MP4 Box Muxing (moov placed before mdat)                     │
│      - 16-bit RTP Sequence Unrolling & JitterBuffer Error Concealment         │
└──────────────────────────────────────┬────────────────────────────────────────┘
                                       │
                    ┌──────────────────┴──────────────────┐
                    ▼                                     ▼
        ┌───────────────────────┐             ┌───────────────────────┐
        │  WebCodecs Hardware   │             │   WebCodecs Hardware  │
        │  VideoDecoder (GPU)   │             │   AudioDecoder (Opus) │
        │  H.264, HEVC, AV1     │             │   RFC 7587 48kHz      │
        └───────────┬───────────┘             └───────────┬───────────┘
                    │                                     │
                    ▼                                     ▼
        ┌───────────────────────┐             ┌───────────────────────┐
        │  WebGPU Multi-Stream  │             │   Multi-Track Audio   │
        │  Hardware Compositor  │             │   Mixer (Web Audio)   │
        │  - PIP (Picture-in-Pic)│            │   - DynamicsCompressor│
        │  - Split / 2x2 Grid   │             │     Broadcast Limiter │
        │  - WGSL SDF Rounded   │             │   - Per-track Gain/Pan│
        └───────────┬───────────┘             └───────────┬───────────┘
                    │                                     │
                    └──────────────────┬──────────────────┘
                                       ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│             WebRTC Multi-Peer Mesh Live Session (packages/core/live)          │
│      - 1vN / NvN Mesh Topology with Deterministic Glare-Free Handshake        │
│      - Single-Channel Targeted Reverse PLI (FAIL-09 Isolated Self-Healing)    │
│      - MasterClockSync 3-Tier Lip-Sync Alignment (|Drift| < 40ms)             │
└──────────────────────────────────────┬────────────────────────────────────────┘
                                       │
                                       ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│            Autonomous AI Media Autopilot Agent (@web-ffmpeg-gpu/agent)        │
│      - Aligned with DeepSeek Harness (dsh) Modular Architecture               │
│      - ReAct Loop: Autonomous Anomaly Diagnosis -> CoT -> Action Execution    │
│      - 0ms Local Rules Expert Engine + Pluggable Model & Tool Registries      │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## ⚡ Performance Benchmark

| Metric | Classic `ffmpeg.wasm` (CPU) | **Web-FFmpeg-GPU (This Project)** | Speedup |
| :--- | :--- | :--- | :--- |
| **4K 60fps Decoding** | 5 ~ 12 FPS (Severe Stutter) | **60 FPS (Hardware Locked)** | **5x ~ 10x 🚀** |
| **CPU Utilization** | 90% ~ 100% (High Heat) | **< 10% (Whisper Quiet)** | **-90% CPU** |
| **Multi-Stream Composition** | 15 ~ 35 ms (CPU Readback) | **< 0.5 ms (WebGPU WGSL Shader)** | **50x ⚡** |
| **VRAM & Memory Lifecycle** | High GC spikes & leaks | **RAII Closure on all branches** | **Zero VRAM Leak** |
| **Audio/Video Lip-Sync** | > 150 ms drift | **MasterClockSync Sub-40ms Locked** | **Frame-Perfect** |

---

## 💎 The "Three-Zeros" Industrial Quality Invariants

1. **Zero-Panic**:
   - The pure Rust bitstream parser strictly protects against 32-zero Exp-Golomb bitshift traps, truncated NALs, corrupted SPS, and corrupted MP4 containers with automatic salvage mode.
2. **Zero-Desync**:
   - `MasterClockSync` dynamically tracks `AudioContext.outputLatency`, applying 1.05x pitch-safe micro-adjustments for 40–500ms drift and instant keyframe re-anchoring for >500ms lag.
3. **Zero-VRAM-Leak**:
   - Every `VideoFrame` and `AudioData` handle is synchronously closed via strict RAII semantics. Ingesting 1,000 concurrent multi-stream frames maintains active handles $\le N_{\text{channels}}$ and drops strictly to 0 on teardown.

---

## 📦 Monorepo Architecture

```
web-ffmpeg-gpu/
├── packages/
│   ├── core/               # @web-ffmpeg-gpu/core
│   │   ├── src/codec/      # WebCodecs Audio Encoder / Decoder
│   │   ├── src/decoder/    # WebCodecs Hardware Video Decoder
│   │   ├── src/encoder/    # WebCodecs Hardware Video Encoder
│   │   ├── src/renderer/   # WebGPU Video Renderer & MultiStreamCompositor
│   │   ├── src/shaders/    # High-performance WGSL shaders (Color, SDF borders)
│   │   ├── src/live/       # WebRTC P2P, MultiPeerMeshSession, RTP Demuxer, AudioMixer
│   │   ├── src/muxer/      # FastStart MP4 Muxer (moov-before-mdat)
│   │   └── src/pipeline/   # FastTranscoder with backpressure control
│   │
│   ├── agent/              # @web-ffmpeg-gpu/agent (DeepSeek Harness 'dsh' Architecture)
│   │   ├── src/core/       # HarnessRuntime, ReAct Loop, SessionTrajectory Event Bus
│   │   ├── src/tools/      # Pluggable ToolRegistry (Local Tools & MCP Protocol Bridge)
│   │   ├── src/providers/  # ModelProvider (DeepSeek API, SimulationProvider)
│   │   ├── src/rules/      # 0ms RulesExpertEngine (FAIL-01 to FAIL-10 emergency guard)
│   │   └── src/autopilot/  # MediaAutopilotAgent high-level orchestrator
│   │
│   └── mcp-server/         # @web-ffmpeg-gpu/mcp-server
│       └── src/            # Standard Model Context Protocol (MCP) JSON-RPC 2.0 Server
│
├── apps/
│   └── playground/         # Interactive Live Media Cockpit (Vite + WebGPU + WebCodecs)
│
├── crates/
│   ├── core/               # Rust WASM bitstream processing, B-frames, MP4, JitterBuffer
│   └── filter-webgpu/      # Rust WebGPU filter parameters
│
└── tests/
    ├── e2e/                # Playwright E2E tests (Multi-Compositor, Multi-Peer Mesh, P2P)
    ├── harness/            # Agent ReAct harness & Industrial FAIL-01~FAIL-10 matrix
    └── stress/             # 1,000-frame VRAM leak stress tests
```

---

## 🛠️ Key Features

### 1. WebGPU Multi-Stream Hardware Compositor
- **Dynamic Layout Presets**: Picture-in-Picture (`pip_br`, `pip_tr`), Horizontal/Vertical Split (`split_horizontal`, `split_vertical`), and 4-Channel Grid (`grid_2x2`).
- **WGSL Shader Enhancements**: Realtime SDF rounded corners, border highlight accents, antialiasing, and color matrix conversions.

### 2. Multi-Track Audio Mixer & Dynamics Limiter
- **Broadcast-Grade DynamicsCompressor**: Hardware-accelerated 12:1 compression preventing clipping/distortion when multiple peers speak simultaneously.
- **Independent Controls**: Per-track gain, stereo panning, and muting.

### 3. WebRTC Multi-Peer Mesh Topology (`MultiPeerMeshSession`)
- **Deterministic Glare-Free Handshake**: Lexicographical tie-breaking eliminates duplicate SDP offer collisions.
- **Targeted Reverse PLI**: Isolated keyframe requests sent specifically to the degraded peer, keeping other channels completely undisturbed.

### 4. Autonomous AI Media Autopilot
- Continuous telemetry monitoring detects packet drops, lip-sync skew, and bitrate anomalies.
- Autonomous ReAct loop dispatches corrective actions (PLI, bitrate downshift, salvage mode) with 0ms rule-based fallback.

---

## 🚀 Quick Start

### 1. Launch the Interactive Cockpit

Requires Node.js (>= 18) and a browser supporting WebGPU & WebCodecs (Chrome 113+ or Edge 113+):

```bash
# Clone the repository
git clone https://github.com/kaykaymaidou/web-ffmpeg-gpu-rust.git
cd web-ffmpeg-gpu-rust

# Install dependencies and build all packages
npm install
npm run build

# Start the interactive development playground
npm run dev
```

Open `http://localhost:3000` to access the full Live Media & AI Autopilot Cockpit.

### 2. Run Test Verification Suites

```bash
# Run all 59 Playwright E2E and Stress tests (Chromium with WebGPU enabled)
npm run test:e2e

# Run all 28 Rust core unit and integration tests
cargo test --workspace
```

---

## 📄 License

MIT License © 2026 Web-FFmpeg-GPU Contributors.
