import { WebFfmpegPipeline } from './core/pipeline';
import type { FilterMode, FilterSettings, PlaybackMetrics } from './core/types';

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

// State
let pipeline: WebFfmpegPipeline | null = null;
let currentFilterSettings: FilterSettings = {
  mode: 'none',
  brightness: 0.0,
  contrast: 1.0,
  saturation: 1.0,
};

async function init() {
  // 1. Detect WebCodecs Support
  const hasWebCodecs = typeof VideoDecoder !== 'undefined';
  if (hasWebCodecs) {
    webcodecsBadge.textContent = 'WebCodecs: 硬件就绪';
    webcodecsBadge.className = 'badge badge-success';
  } else {
    webcodecsBadge.textContent = 'WebCodecs: 不受支持';
    webcodecsBadge.className = 'badge';
  }

  // 2. Detect & Init WebGPU
  try {
    pipeline = new WebFfmpegPipeline(canvas);
    await pipeline.initialize((metrics: PlaybackMetrics) => {
      metricFps.textContent = `${metrics.currentFps}`;
      metricLatency.textContent = `${metrics.avgFrameRenderTimeMs} ms`;
      metricFrames.textContent = `${metrics.totalDecodedFrames}`;
      metricDevice.textContent = metrics.gpuDeviceName;
    });

    gpuStatusBadge.textContent = 'WebGPU: 硬件加速已激活';
    gpuStatusBadge.className = 'badge badge-success';
  } catch (err: any) {
    console.error('WebGPU Init Failed:', err);
    gpuStatusBadge.textContent = 'WebGPU: 不受支持 / 未开启';
    gpuStatusBadge.className = 'badge';
    alert(`初始化 WebGPU 失败: ${err.message || err}`);
  }

  setupEventListeners();
}

function setupEventListeners() {
  btnSelectFile.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (e: Event) => {
    const target = e.target as HTMLInputElement;
    if (target.files && target.files[0]) {
      await loadFile(target.files[0]);
    }
  });

  // Drag & Drop
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

  // Play / Pause
  btnPlayPause.addEventListener('click', () => {
    if (!pipeline) return;
    pipeline.togglePlay();
    const isPlaying = btnPlayPause.textContent?.includes('暂停');
    btnPlayPause.textContent = isPlaying ? '▶ 播放' : '⏸ 暂停';
  });

  // Filter Presets
  filterChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      filterChips.forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      const mode = (chip.dataset.filter || 'none') as FilterMode;
      currentFilterSettings.mode = mode;
      applyFilters();
    });
  });

  // Sliders
  sliderBrightness.addEventListener('input', () => {
    currentFilterSettings.brightness = parseFloat(sliderBrightness.value);
    valBrightness.textContent = sliderBrightness.value;
    applyFilters();
  });

  sliderContrast.addEventListener('input', () => {
    currentFilterSettings.contrast = parseFloat(sliderContrast.value);
    valContrast.textContent = sliderContrast.value;
    applyFilters();
  });

  sliderSaturation.addEventListener('input', () => {
    currentFilterSettings.saturation = parseFloat(sliderSaturation.value);
    valSaturation.textContent = sliderSaturation.value;
    applyFilters();
  });

  // Reset Filters
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
}

function applyFilters() {
  if (pipeline) {
    pipeline.setFilters(currentFilterSettings);
  }
}

async function loadFile(file: File) {
  if (!pipeline) return;
  try {
    trackInfo.textContent = `解析容器与流信息: ${file.name}...`;
    const buffer = await file.arrayBuffer();
    const info = await pipeline.loadMedia(buffer);

    trackInfo.textContent = `${file.name} | ${info.codec} | ${info.width}x${info.height} | ~${info.fps} fps`;
    emptyState.style.display = 'none';
    btnPlayPause.disabled = false;
    btnPlayPause.textContent = '⏸ 暂停';

    // Auto play
    pipeline.play();
  } catch (err: any) {
    console.error('Failed to load media:', err);
    alert(`加载或解复用视频失败: ${err.message || err}`);
    trackInfo.textContent = `加载失败: ${err.message || err}`;
  }
}

// Start
init();
