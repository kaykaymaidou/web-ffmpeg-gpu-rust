import {
  WebFfmpegEngine,
  WebFfmpegTranscoder,
  SimpleMp4Demuxer,
  WebGpuComputeEngine,
  LiveLoopbackSession,
} from '@web-ffmpeg-gpu/core';
import type { FilterMode, FilterSettings, PlaybackMetrics, TranscodePreset, TranscodeResult } from '@web-ffmpeg-gpu/core';

(window as any).WebGpuComputeEngine = WebGpuComputeEngine;
(window as any).LiveLoopbackSession = LiveLoopbackSession;

// DOM Elements
const canvas = document.getElementById('gpu-canvas') as HTMLCanvasElement;
const dropzone = document.getElementById('dropzone') as HTMLDivElement;
const emptyState = document.getElementById('empty-state') as HTMLDivElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const btnSelectFile = document.getElementById('btn-select-file') as HTMLButtonElement;
const btnPlayPause = document.getElementById('btn-play-pause') as HTMLButtonElement;
const trackInfo = document.getElementById('track-info') as HTMLDivElement;

// Status badges
const gpuStatusBadge = document.getElementById('gpu-status-badge') as HTMLSpanElement;
const webcodecsBadge = document.getElementById('webcodecs-badge') as HTMLSpanElement;

// Telemetry values
const metricFps = document.getElementById('metric-fps') as HTMLSpanElement;
const metricLatency = document.getElementById('metric-latency') as HTMLSpanElement;
const metricFrames = document.getElementById('metric-frames') as HTMLSpanElement;
const metricDevice = document.getElementById('metric-device') as HTMLSpanElement;

// Filter controls
const filterChips = document.querySelectorAll('.btn-chip') as NodeListOf<HTMLButtonElement>;
const sliderBrightness = document.getElementById('slider-brightness') as HTMLInputElement;
const sliderContrast = document.getElementById('slider-contrast') as HTMLInputElement;
const sliderSaturation = document.getElementById('slider-saturation') as HTMLInputElement;
const valBrightness = document.getElementById('val-brightness') as HTMLSpanElement;
const valContrast = document.getElementById('val-contrast') as HTMLSpanElement;
const valSaturation = document.getElementById('val-saturation') as HTMLSpanElement;
const btnResetFilters = document.getElementById('btn-reset-filters') as HTMLButtonElement;

// Transcoding DOM Elements
const selectPreset = document.getElementById('select-preset') as HTMLSelectElement;
const checkMute = document.getElementById('check-mute') as HTMLInputElement;
const btnStartTranscode = document.getElementById('btn-start-transcode') as HTMLButtonElement;
const transcodeProgressSection = document.getElementById('transcode-progress-section') as HTMLDivElement;
const transcodeStatusLabel = document.getElementById('transcode-status-label') as HTMLSpanElement;
const transcodePercent = document.getElementById('transcode-percent') as HTMLSpanElement;
const progressFill = document.getElementById('progress-fill') as HTMLDivElement;
const statFps = document.getElementById('stat-fps') as HTMLSpanElement;
const statCompression = document.getElementById('stat-compression') as HTMLSpanElement;
const btnDownloadMp4 = document.getElementById('btn-download-mp4') as HTMLButtonElement;
const transcodedVideoPreview = document.getElementById('transcoded-video-preview') as HTMLVideoElement;
const boxTreeContent = document.getElementById('box-tree-content') as HTMLDivElement;

// RTC Live Loopback Elements
const btnToggleRtc = document.getElementById('btn-toggle-rtc') as HTMLButtonElement;
const btnRtcPli = document.getElementById('btn-rtc-pli') as HTMLButtonElement;
const sliderRtcLoss = document.getElementById('slider-rtc-loss') as HTMLInputElement;
const sliderRtcJitter = document.getElementById('slider-rtc-jitter') as HTMLInputElement;
const valRtcLoss = document.getElementById('val-rtc-loss') as HTMLSpanElement;
const valRtcJitter = document.getElementById('val-rtc-jitter') as HTMLSpanElement;
const metricRtcLatency = document.getElementById('metric-rtc-latency') as HTMLSpanElement;
const metricRtcFps = document.getElementById('metric-rtc-fps') as HTMLSpanElement;
const metricRtcPackets = document.getElementById('metric-rtc-packets') as HTMLSpanElement;
const metricRtcRescues = document.getElementById('metric-rtc-rescues') as HTMLSpanElement;

let rtcSession: LiveLoopbackSession | null = null;

// State
let engine: WebFfmpegEngine | null = null;
let currentFileBuffer: ArrayBuffer | null = null;
let currentFileName: string = '';
let lastTranscodeResult: TranscodeResult | null = null;
let currentFilterSettings: FilterSettings = {
  mode: 'none',
  brightness: 0.0,
  contrast: 1.0,
  saturation: 1.0,
};

async function init() {
  setupEventListeners();

  const hasWebCodecs = typeof VideoDecoder !== 'undefined';
  if (hasWebCodecs) {
    webcodecsBadge.textContent = 'WebCodecs: 硬件就绪';
    webcodecsBadge.className = 'badge badge-success';
  } else {
    webcodecsBadge.textContent = 'WebCodecs: 不受支持';
    webcodecsBadge.className = 'badge';
  }

  try {
    engine = new WebFfmpegEngine(canvas);
    await engine.initialize({
      onMetrics: (metrics: PlaybackMetrics) => {
        metricFps.textContent = `${metrics.currentFps}`;
        metricLatency.textContent = `${metrics.avgFrameRenderTimeMs} ms`;
        metricFrames.textContent = `${metrics.totalDecodedFrames}`;
        metricDevice.textContent = metrics.gpuDeviceName;
      },
      onFallback: (reason, config) => {
        console.warn(`[Playground Fallback Notice]: ${reason}`, config);
      },
      onError: (err) => {
        console.error(`[Playground Error Notice]:`, err);
      },
    });

    gpuStatusBadge.textContent = 'WebGPU: 硬件加速已激活';
    gpuStatusBadge.className = 'badge badge-success';
  } catch (err: any) {
    console.warn('WebGPU Init Failed:', err);
    gpuStatusBadge.textContent = 'WebGPU: 不受支持 / 未开启';
    gpuStatusBadge.className = 'badge';
  }
}

function setupEventListeners() {
  btnSelectFile.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (e: Event) => {
    const target = e.target as HTMLInputElement;
    if (target.files && target.files[0]) {
      await loadFile(target.files[0]);
    }
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer && e.dataTransfer.files[0]) {
      await loadFile(e.dataTransfer.files[0]);
    }
  });

  btnPlayPause.addEventListener('click', () => {
    if (!engine) return;
    engine.togglePlay();
    const isPlaying = btnPlayPause.textContent?.includes('暂停');
    btnPlayPause.textContent = isPlaying ? '▶ 播放' : '⏸ 暂停';
  });

  filterChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      filterChips.forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      const mode = (chip.dataset.filter || 'none') as FilterMode;
      currentFilterSettings.mode = mode;
      applyFilters();
    });
  });

  const onBrightness = () => {
    currentFilterSettings.brightness = parseFloat(sliderBrightness.value);
    valBrightness.textContent = sliderBrightness.value;
    applyFilters();
  };
  sliderBrightness.addEventListener('input', onBrightness);
  sliderBrightness.addEventListener('change', onBrightness);

  const onContrast = () => {
    currentFilterSettings.contrast = parseFloat(sliderContrast.value);
    valContrast.textContent = sliderContrast.value;
    applyFilters();
  };
  sliderContrast.addEventListener('input', onContrast);
  sliderContrast.addEventListener('change', onContrast);

  const onSaturation = () => {
    currentFilterSettings.saturation = parseFloat(sliderSaturation.value);
    valSaturation.textContent = sliderSaturation.value;
    applyFilters();
  };
  sliderSaturation.addEventListener('input', onSaturation);
  sliderSaturation.addEventListener('change', onSaturation);

  btnResetFilters.addEventListener('click', () => {
    currentFilterSettings = {
      mode: 'none',
      brightness: 0.0,
      contrast: 1.0,
      saturation: 1.0,
    };
    sliderBrightness.value = '0.0';
    sliderContrast.value = '1.0';
    sliderSaturation.value = '1.0';
    valBrightness.textContent = '0.0';
    valContrast.textContent = '1.0';
    valSaturation.textContent = '1.0';
    filterChips.forEach((c) => c.classList.remove('active'));
    filterChips[0].classList.add('active');
    applyFilters();
  });

    btnStartTranscode.addEventListener('click', async () => {
      if (!currentFileBuffer) return;
      await startTranscoding();
    });

    btnDownloadMp4.addEventListener('click', () => {
      if (!lastTranscodeResult) return;
      const blob = new Blob([lastTranscodeResult.mp4Buffer as any], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gpu_transcoded_faststart_${currentFileName || 'output.mp4'}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });

    // RTC Live Loopback Handlers
    sliderRtcLoss.addEventListener('input', () => {
      valRtcLoss.textContent = `${sliderRtcLoss.value}%`;
      rtcSession?.setImpairments({ packetLossRate: Number(sliderRtcLoss.value) / 100 });
    });

    sliderRtcJitter.addEventListener('input', () => {
      valRtcJitter.textContent = `${sliderRtcJitter.value} ms`;
      rtcSession?.setImpairments({ jitterMs: Number(sliderRtcJitter.value) });
    });

    btnRtcPli.addEventListener('click', () => {
      rtcSession?.requestKeyframe();
    });

    btnToggleRtc.addEventListener('click', async () => {
      if (rtcSession) {
        rtcSession.stop();
        rtcSession = null;
        btnToggleRtc.textContent = '▶ 启动 RTC 实时环回';
        btnToggleRtc.className = 'btn btn-primary';
        btnRtcPli.disabled = true;
        return;
      }

      try {
        emptyState.style.display = 'none';
        btnToggleRtc.disabled = true;
        btnToggleRtc.textContent = '初始化 RTC 编解码器...';

        rtcSession = new LiveLoopbackSession({
          width: 640,
          height: 360,
          framerate: 30,
          bitrate: 1_200_000,
          packetLossRate: Number(sliderRtcLoss.value) / 100,
          jitterMs: Number(sliderRtcJitter.value),
          renderCanvas: canvas,
          onMetrics: (m) => {
            metricRtcLatency.textContent = `${m.glassToGlassLatencyMs} ms`;
            metricRtcFps.textContent = `${m.ingestFps} / ${m.playoutFps} FPS`;
            const lossPct = m.rtpPacketsSent > 0 ? ((m.rtpPacketsDropped / m.rtpPacketsSent) * 100).toFixed(1) : '0.0';
            metricRtcPackets.textContent = `${m.rtpPacketsSent} / ${m.rtpPacketsDropped} (丢 ${lossPct}%)`;
            metricRtcRescues.textContent = `${m.fail09Rescues} 次 (PLI ${m.keyframeRequests})`;
          },
          onError: (err) => {
            console.error('RTC Session Error:', err);
          },
        });

        await rtcSession.start();
        btnToggleRtc.textContent = '⏹ 停止 RTC 环回';
        btnToggleRtc.className = 'btn btn-danger';
        btnToggleRtc.disabled = false;
        btnRtcPli.disabled = false;
      } catch (err: any) {
        console.error('Failed to start RTC Loopback:', err);
        alert(`启动 RTC 实时环回失败: ${err.message || err}`);
        btnToggleRtc.textContent = '▶ 启动 RTC 实时环回';
        btnToggleRtc.className = 'btn btn-primary';
        btnToggleRtc.disabled = false;
        rtcSession = null;
      }
    });
  }

  function applyFilters() {
    if (engine) {
      engine.setFilters(currentFilterSettings);
    }
  }

  async function loadFile(file: File) {
    if (!engine) return;
    try {
      trackInfo.textContent = `解析容器与流信息: ${file.name}...`;
      const buffer = await file.arrayBuffer();
      currentFileBuffer = buffer;
      currentFileName = file.name;

      const info = await engine.loadMedia(buffer);

      trackInfo.textContent = `${file.name} | ${info.codec} | ${info.width}x${info.height} | ~${info.fps} fps`;
      emptyState.style.display = 'none';
      btnPlayPause.disabled = false;
      btnPlayPause.textContent = '⏸ 暂停';
      btnStartTranscode.disabled = false;

      // Update Box Tree Inspector
      try {
        const demuxer = new SimpleMp4Demuxer(buffer);
        const tracks = demuxer.parse();
        let treeText = `📦 Container: ISOBMFF (${(file.size / (1024 * 1024)).toFixed(2)} MB)\n`;
        tracks.forEach((t) => {
          const isVid = t.codec.startsWith('avc1') || t.codec.startsWith('hvc1');
          treeText += `├── 🎞️ Track #${t.id} (${isVid ? 'Video' : 'Audio'}): ${t.codec}\n`;
          if (isVid) {
            treeText += `│   ├── 分辨率: ${t.width}x${t.height}\n`;
            treeText += `│   ├── 样本帧数: ${t.samples.length} frames\n`;
            treeText += `│   └── 时钟基数: ${t.timescale}\n`;
          } else {
            treeText += `│   ├── 时钟基数: ${t.timescale}\n`;
            treeText += `│   └── 样本包数: ${t.samples.length} packets\n`;
          }
        });
        treeText += `└── ⚡ 导出格式: 纯 Rust FastStart MP4 (moov 置前秒开)`;
        boxTreeContent.textContent = treeText;
      } catch (err) {
        boxTreeContent.textContent = `Box 解析警告: ${err}`;
      }

      engine.play();
    } catch (err: any) {
      console.error('Failed to load media:', err);
      alert(`加载或解复用视频失败: ${err.message || err}`);
      trackInfo.textContent = `加载失败: ${err.message || err}`;
    }
  }

  async function startTranscoding() {
    if (!currentFileBuffer) return;
    try {
      btnStartTranscode.disabled = true;
      transcodeProgressSection.style.display = 'block';
      transcodeStatusLabel.textContent = '⚡ GPU 硬件硬编转码中...';
      transcodePercent.textContent = '0%';
      progressFill.style.width = '0%';
      btnDownloadMp4.style.display = 'none';
      transcodedVideoPreview.style.display = 'none';

      const preset = selectPreset.value as TranscodePreset;
      const muteAudio = checkMute.checked;

      const transcoder = new WebFfmpegTranscoder();
      const result = await transcoder.transcode(currentFileBuffer, {
        preset,
        muteAudio,
        onProgress: (p) => {
          transcodePercent.textContent = `${p.percent}%`;
          progressFill.style.width = `${p.percent}%`;
          statFps.textContent = `${p.fps} FPS (${p.xRealtime}x 实况速)`;
          const estRatio = Math.max(0, Math.round((1 - p.currentOutputBytes / p.originalSizeBytes) * 100));
          statCompression.textContent = `预估节省 ~${estRatio}% 体积`;
        },
      });

      lastTranscodeResult = result;
      transcodePercent.textContent = '100%';
      progressFill.style.width = '100%';
      transcodeStatusLabel.textContent = `✅ 转码完成! 耗时 ${(result.totalTimeMs / 1000).toFixed(2)}s (平均 ${result.avgFps} FPS, ${result.avgRealtime}x 极速)`;

      const origMb = (result.originalSizeBytes / (1024 * 1024)).toFixed(1);
      const outMb = (result.outputSizeBytes / (1024 * 1024)).toFixed(1);
      statCompression.textContent = `${origMb}MB ➔ ${outMb}MB (瘦身 ${Math.round(result.compressionRatio * 100)}%)`;

      // Show download button and preview
      btnDownloadMp4.style.display = 'block';
      const blob = new Blob([result.mp4Buffer as any], { type: 'video/mp4' });
      transcodedVideoPreview.src = URL.createObjectURL(blob);
      transcodedVideoPreview.style.display = 'block';
    } catch (err: any) {
      console.error('Transcode Failed:', err);
      transcodeStatusLabel.textContent = `❌ 转码失败: ${err.message || err}`;
      alert(`转码失败: ${err.message || err}`);
    } finally {
      btnStartTranscode.disabled = false;
    }
  }

  init();
