---
name: show-me
description: >-
  Interactive visual demonstration, Generative UI, and real-time telemetry skill.
  Use when explaining architectures, demonstrating pipeline data flows, inspecting ISOBMFF box trees,
  rendering comparative benchmarks, or presenting interactive visual controls for web multimedia engines.
---

# Show-Me Skill

Multimedia development (video codecs, bitstreams, color spaces, GPU buffers) is inherently visual.
Relying solely on console logs or text dumps leads to misunderstandings.
This skill instructs the agent to create **visual, interactive, and telemetry-rich experiences** whenever explaining concepts or validating implementations.

---

## Modalities

### 1. Inline Generative UI Widgets (Chat Embedded)
Use Antigravity's `generative_ui` skill to create self-contained HTML artifacts with Tailwind CSS and inject them inline:
```html
<agent-embed src="file:///<artifact_path>/pipeline_viz.html"></agent-embed>
```
Common Generative UI Widgets:
- **ISOBMFF Box Tree Inspector**: Collapsible visual tree of `ftyp`, `moov`, `mvhd`, `trak`, `mdia`, `minf`, `stbl`, `stsd`, `mdat`.
- **PTS/DTS Reordering Waterfall**: Visual timeline showing B-frame decode order vs presentation order and `TimelineQueue` states.
- **Hardware Transcoding Pipeline Diagram**: Interactive animated flow showing Rust Demuxer -> WebCodecs Decoder -> WebGPU Texture/ToneMapping -> WebCodecs Encoder -> Rust Muxer.
- **CPU vs GPU Performance Matrix**: Live visual charts comparing `ffmpeg.wasm` (CPU 100%, 0.8x realtime) vs `web-ffmpeg-gpu` (CPU 8%, 12x realtime).

### 2. Live Playground Workbench (`apps/playground`)
Ensure `apps/playground` is not just a toy button, but a professional multimedia debugging cockpit:
- Dual-pane video comparison: Original Video vs GPU Transcoded Video side-by-side.
- Real-time Telemetry: Transcoding FPS, Real-time Factor (e.g. 14.2x), Target File Size, VRAM estimation.
- Bitstream & SPS Inspector: Parsed profile (Baseline/Main/High), level, resolution, aspect ratio, audio sample rate/channels.
- Download & Verification: Instant download of the transcoded faststart MP4 file.

### 3. Visual Verification Artifacts
- Whenever testing a codec filter (e.g. Grayscale, Invert, Tone Mapping), render before/after snapshot comparisons or interactive canvas visualizers.
