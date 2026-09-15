---
name: monorepo-architect
description: >-
  Audits, enforces, and scaffolds the multi-platform Monorepo architecture for Web-FFmpeg-GPU.
  Use when creating or refactoring Rust core primitives, Web SDK, Desktop Native bindings,
  Windows background services, or Agent harnesses to ensure strict boundary isolation and Zero-Panic/Zero-Leak invariants.
---

# Monorepo Master Architect Skill (`monorepo-architect`)

Use this skill when designing, auditing, or adding components across the `web-ffmpeg-gpu` Monorepo.

## 1. Architectural Boundary Checks

Before adding or modifying code, verify the component's strict boundary:

| Layer | Path | Allowed Dependencies | Prohibited Dependencies |
|---|---|---|---|
| **Rust Core** | `crates/core/` | Standard library (no I/O in core), bitstream crates | Web APIs, Node.js, direct filesystem/socket I/O |
| **Web SDK** | `packages/core/` | WebCodecs, WebGPU, Web Audio, `crates/core` (WASM) | Native C-ABI, Node-only modules (`node:fs`, `node:net`) |
| **Desktop SDK** | `crates/native/` | OS hardware encoders (NVENC, DXVA, VideoToolbox), `crates/core` | Browser-specific APIs (`window`, DOM) |
| **Agent Harness**| `packages/agent/` | Independent `dsh` runtime, Zod, Model APIs | Tight coupling to specific UI views |
| **Windows Service** | `apps/windows-service/` | Native Windows APIs, IPC, `crates/native` | Web-only dependencies |

## 2. Invariant Enforcement Checklist

1. **Rust Zero-IO**: Does `crates/core` perform file reads or network calls?
   - If yes: REFACTOR. Pass data via `&[u8]` buffers or memory streams.
2. **Rust Zero-Panic**: Does the bitstream parser have `.unwrap()` on external slice indexing?
   - If yes: Replace with `get()` or checked slices returning `Err(MediaError)`.
3. **Web Zero-VRAM-Leak**: Is every `VideoFrame` explicitly closed synchronously?
   - Check decoder callbacks, intermediate canvas textures, and channel replacement.
4. **Git Hygiene**: Run `git status` to ensure no `target/`, `node_modules/`, `*.mp4`, or `playwright-report/` files are tracked.

## 3. Verification Commands

Always run the full suite before committing:
```powershell
# 1. Rust Core & Workspace Verification (Zero-Panic)
$env:RUSTUP_HOME = "D:\RustConfig\.rustup"
$env:CARGO_HOME = "D:\RustConfig\.cargo"
$env:Path = "D:\RustConfig\.cargo\bin;" + $env:Path
cargo test --workspace

# 2. Monorepo Build Verification
npm run build

# 3. Web & E2E Verification (Zero-Leak, Zero-Desync)
npx playwright test
```
