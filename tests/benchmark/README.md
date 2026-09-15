# 分层性能对比（RFC 0004）

同一 Chrome 页里对比本仓库 CPU/容器路径与 `ffmpeg.wasm`。不要拿桌面 ffmpeg CLI 或硬解 WebCodecs 当「Rust ffmpeg.wasm」的结论。

## 跑一次

```powershell
# 若 3000 被占用
$env:PLAYGROUND_PORT='3010'
npm run bench:layers
```

真片放到 `tests/fixtures/incoming/*.mp4`。合成阶梯由 `node scripts/bench-vs-ffmpeg.mjs` 生成（只出片，不计时）。

## 产物

- `tests/benchmark/results/layer-report.json`
- `tests/benchmark/results/LAYER-REPORT.md`

协议：`docs/rfcs/0004-layer-benchmark-vs-ffmpeg-wasm.md`
