import {
  WebFfmpegEngine,
  WebFfmpegTranscoder,
  SimpleMp4Demuxer,
  WebGpuComputeEngine,
  LiveLoopbackSession,
  LiveP2PSender,
  LiveP2PReceiver,
  BroadcastChannelSignaling,
  WebSocketSignaling,
  HardwareAudioEncoder,
  HardwareAudioDecoder,
  OpusRtpPacketizer,
  OpusRtpDemuxer,
  WebAudioLivePlayer,
  WebGpuMultiStreamCompositor,
  MultiTrackAudioMixer,
} from '@web-ffmpeg-gpu/core';
import { MediaAutopilotAgent, type AgentThoughtStep, type AutopilotDirective } from '@web-ffmpeg-gpu/agent';
import type { FilterMode, FilterSettings, PlaybackMetrics, TranscodePreset, TranscodeResult } from '@web-ffmpeg-gpu/core';

(window as any).WebGpuComputeEngine = WebGpuComputeEngine;
(window as any).WebGpuMultiStreamCompositor = WebGpuMultiStreamCompositor;
(window as any).MultiTrackAudioMixer = MultiTrackAudioMixer;
(window as any).LiveLoopbackSession = LiveLoopbackSession;
(window as any).LiveP2PSender = LiveP2PSender;
(window as any).LiveP2PReceiver = LiveP2PReceiver;
(window as any).BroadcastChannelSignaling = BroadcastChannelSignaling;
(window as any).WebSocketSignaling = WebSocketSignaling;
(window as any).HardwareAudioEncoder = HardwareAudioEncoder;
(window as any).HardwareAudioDecoder = HardwareAudioDecoder;
(window as any).OpusRtpPacketizer = OpusRtpPacketizer;
(window as any).OpusRtpDemuxer = OpusRtpDemuxer;
(window as any).WebAudioLivePlayer = WebAudioLivePlayer;
(window as any).MediaAutopilotAgent = MediaAutopilotAgent;

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

// P2P Multi-Peer Direct Streaming Elements
const selectP2pRole = document.getElementById('select-p2p-role') as HTMLSelectElement;
const inputP2pRoom = document.getElementById('input-p2p-room') as HTMLInputElement;
const checkboxP2pAudio = document.getElementById('checkbox-p2p-audio') as HTMLInputElement;
const btnToggleP2p = document.getElementById('btn-toggle-p2p') as HTMLButtonElement;
const btnP2pPli = document.getElementById('btn-p2p-pli') as HTMLButtonElement;
const p2pStatusBadge = document.getElementById('p2p-status-badge') as HTMLSpanElement;
const metricP2pFps = document.getElementById('metric-p2p-fps') as HTMLSpanElement;
const metricP2pPackets = document.getElementById('metric-p2p-packets') as HTMLSpanElement;
const metricP2pAudio = document.getElementById('metric-p2p-audio') as HTMLSpanElement;
const metricP2pLipSync = document.getElementById('metric-p2p-lipsync') as HTMLSpanElement;

// Multi-Stream Compositor Elements
const selectCompositorLayout = document.getElementById('select-compositor-layout') as HTMLSelectElement;
const metricCompositorChannels = document.getElementById('metric-compositor-channels') as HTMLSpanElement;
const metricCompositorVram = document.getElementById('metric-compositor-vram') as HTMLSpanElement;
const metricCompositorFps = document.getElementById('metric-compositor-fps') as HTMLSpanElement;
const btnToggleCompositor = document.getElementById('btn-toggle-compositor') as HTMLButtonElement;

let activeCompositor: WebGpuMultiStreamCompositor | null = null;
let compositorAnimationId: number | null = null;

// AI Media Autopilot Elements
const checkboxAutopilotEnable = document.getElementById('checkbox-autopilot-enable') as HTMLInputElement;
const selectAutopilotEngine = document.getElementById('select-autopilot-engine') as HTMLSelectElement;
const autopilotStatusBadge = document.getElementById('autopilot-status-badge') as HTMLSpanElement;
const autopilotDirectiveBadge = document.getElementById('autopilot-directive-badge') as HTMLSpanElement;
const autopilotTerminal = document.getElementById('autopilot-terminal') as HTMLDivElement;
const btnAutopilotSimulate = document.getElementById('btn-autopilot-simulate') as HTMLButtonElement;

let p2pSender: LiveP2PSender | null = null;
let p2pReceiver: LiveP2PReceiver | null = null;

const autopilotAgent = new MediaAutopilotAgent({
  engineMode: 'rules-engine',
  onThought: (step: AgentThoughtStep) => {
    const line = document.createElement('div');
    line.style.color = '#38bdf8';
    line.textContent = `[Thought ${step.iteration}] ${step.thought}`;
    autopilotTerminal.appendChild(line);
    if (step.action) {
      const actLine = document.createElement('div');
      actLine.style.color = '#f59e0b';
      actLine.textContent = `  ↳ Action: ${step.action.tool}(${JSON.stringify(step.action.input)})`;
      autopilotTerminal.appendChild(actLine);
    }
    if (step.observation) {
      const obsLine = document.createElement('div');
      obsLine.style.color = '#94a3b8';
      obsLine.textContent = `  ↳ Obs: ${step.observation.substring(0, 100)}...`;
      autopilotTerminal.appendChild(obsLine);
    }
    autopilotTerminal.scrollTop = autopilotTerminal.scrollHeight;
  },
  onDirective: (directive: AutopilotDirective) => {
    autopilotDirectiveBadge.textContent = directive.type;
    autopilotDirectiveBadge.style.color = '#a855f7';
    const dirLine = document.createElement('div');
    dirLine.style.color = '#34d399';
    dirLine.style.fontWeight = 'bold';
    dirLine.textContent = `⚡ [Directive] ${directive.type} -> ${directive.reason}`;
    autopilotTerminal.appendChild(dirLine);
    autopilotTerminal.scrollTop = autopilotTerminal.scrollHeight;

    if (directive.type === 'TRIGGER_PLI') {
      p2pReceiver?.requestKeyframe();
      rtcSession?.requestKeyframe();
    }
  },
});
(window as any).autopilotAgent = autopilotAgent;

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

            if (checkboxAutopilotEnable.checked) {
              const lossNum = Number(lossPct);
              if (lossNum >= 8 || m.fail09Rescues > 0) {
                autopilotAgent.feedTelemetry('loopback', {
                  packetLossRate: lossNum,
                  fps: m.playoutFps,
                  rttMs: m.glassToGlassLatencyMs,
                  failCode: m.fail09Rescues > 0 ? 'FAIL-09' : undefined,
                }).catch(() => {});
              }
            }
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

    // P2P Direct Streaming Handlers
    selectP2pRole.addEventListener('change', () => {
      const isSender = selectP2pRole.value === 'sender';
      btnToggleP2p.textContent = isSender ? '▶ 启动 P2P 推流' : '▶ 启动 P2P 接收';
    });

    btnP2pPli.addEventListener('click', () => {
      if (p2pReceiver) {
        p2pReceiver.requestKeyframe();
      } else if (p2pSender) {
        p2pSender.requestKeyframe();
      }
    });

    btnToggleP2p.addEventListener('click', async () => {
      if (p2pSender || p2pReceiver) {
        if (p2pSender) {
          p2pSender.stop();
          p2pSender = null;
        }
        if (p2pReceiver) {
          p2pReceiver.stop();
          p2pReceiver = null;
        }
        btnToggleP2p.textContent = selectP2pRole.value === 'sender' ? '▶ 启动 P2P 推流' : '▶ 启动 P2P 接收';
        btnToggleP2p.className = 'btn btn-primary';
        btnP2pPli.disabled = true;
        p2pStatusBadge.textContent = '已断开 (Disconnected)';
        p2pStatusBadge.style.color = '#cbd5e1';
        metricP2pAudio.textContent = '0 pkts (关闭)';
        metricP2pLipSync.textContent = '-- ms (对齐)';
        metricP2pLipSync.style.color = '#34d399';
        return;
      }

      const roomId = inputP2pRoom.value.trim() || 'live-room-alpha';
      const role = selectP2pRole.value;
      const enableAudio = checkboxP2pAudio.checked;
      const signaling = new BroadcastChannelSignaling(roomId);

      try {
        btnToggleP2p.disabled = true;
        btnToggleP2p.textContent = '连接信令通道中...';
        emptyState.style.display = 'none';

        if (role === 'sender') {
          p2pSender = new LiveP2PSender({
            roomId,
            signaling,
            enableAudio,
            onStateChange: (st) => {
              p2pStatusBadge.textContent = `P2P 状态: ${st}`;
              p2pStatusBadge.style.color = st === 'connected' ? '#34d399' : '#f59e0b';
            },
            onMetrics: (m) => {
              metricP2pFps.textContent = `${m.ingestFps} FPS / ${m.bitrateKbps} kbps`;
              metricP2pPackets.textContent = `${m.rtpPacketsSent} pkts (PLI: ${m.keyframeRequests})`;
              metricP2pAudio.textContent = `${m.audioPacketsSent} pkts (${enableAudio ? '发送中' : '已禁用'})`;
              metricP2pLipSync.textContent = enableAudio ? '发射基准时钟 (Master)' : '未启用音频';
              metricP2pLipSync.style.color = '#38bdf8';
            },
            onError: (err) => console.error('[LiveP2PSender Error]', err),
          });

          await p2pSender.start();
          p2pStatusBadge.textContent = '主播正在推流 (Broadcasting)';
          p2pStatusBadge.style.color = '#38bdf8';
          btnToggleP2p.textContent = '⏹ 停止 P2P 推流';
          btnToggleP2p.className = 'btn btn-danger';
          btnToggleP2p.disabled = false;
          btnP2pPli.disabled = false;
        } else {
          p2pReceiver = new LiveP2PReceiver({
            roomId,
            signaling,
            renderCanvas: canvas,
            enableAudio,
            onStateChange: (st) => {
              p2pStatusBadge.textContent = `P2P 状态: ${st}`;
              p2pStatusBadge.style.color = st === 'connected' ? '#34d399' : '#f59e0b';
            },
            onMetrics: (m) => {
              metricP2pFps.textContent = `${m.playoutFps} FPS`;
              metricP2pPackets.textContent = `${m.rtpPacketsReceived} pkts (丢 ${m.packetsDropped} / 自愈 ${m.fail09Rescues})`;
              metricP2pAudio.textContent = `${m.audioPacketsReceived} pkts (${enableAudio ? '解码中' : '已禁用'})`;
              if (enableAudio && m.lipSyncStatus !== 'NO_AUDIO') {
                const absDrift = Math.abs(m.avDriftMs);
                const driftColor = absDrift <= 40 ? '#34d399' : (absDrift <= 80 ? '#f59e0b' : '#ef4444');
                metricP2pLipSync.textContent = `${m.avDriftMs.toFixed(1)} ms (${m.lipSyncStatus})`;
                metricP2pLipSync.style.color = driftColor;
              } else {
                metricP2pLipSync.textContent = '未启用或暂无音频';
                metricP2pLipSync.style.color = '#94a3b8';
              }

              if (checkboxAutopilotEnable.checked) {
                if (m.packetsDropped > 0 || (m.lipSyncStatus !== 'NO_AUDIO' && Math.abs(m.avDriftMs) > 40)) {
                  autopilotAgent.feedTelemetry('p2p-receiver', {
                    packetLossRate: m.packetsDropped > 0 ? 15 : 0,
                    avDriftMs: m.avDriftMs,
                    fps: m.playoutFps,
                    failCode: m.fail09Rescues > 0 ? 'FAIL-09' : undefined,
                  }).catch(() => {});
                }
              }
            },
            onError: (err) => console.error('[LiveP2PReceiver Error]', err),
          });

          await p2pReceiver.start();
          p2pStatusBadge.textContent = '已就绪，等待主播推流 (Listening)';
          p2pStatusBadge.style.color = '#a78bfa';
          btnToggleP2p.textContent = '⏹ 停止 P2P 接收';
          btnToggleP2p.className = 'btn btn-danger';
          btnToggleP2p.disabled = false;
          btnP2pPli.disabled = false;
        }
      } catch (err: any) {
        console.error('Failed to start P2P session:', err);
        alert(`启动 P2P 会话失败: ${err.message || err}`);
        btnToggleP2p.textContent = role === 'sender' ? '▶ 启动 P2P 推流' : '▶ 启动 P2P 接收';
        btnToggleP2p.className = 'btn btn-primary';
        btnToggleP2p.disabled = false;
        p2pSender = null;
        p2pReceiver = null;
      }
    });

    // Multi-Stream Compositor Event Listeners
    selectCompositorLayout.addEventListener('change', () => {
      activeCompositor?.setLayoutPreset(selectCompositorLayout.value as any);
    });

    btnToggleCompositor.addEventListener('click', async () => {
      if (activeCompositor) {
        if (compositorAnimationId) {
          cancelAnimationFrame(compositorAnimationId);
          compositorAnimationId = null;
        }
        activeCompositor.destroy();
        activeCompositor = null;
        btnToggleCompositor.textContent = '▶ 启动 WebGPU 实时多路合成演示';
        btnToggleCompositor.className = 'btn btn-primary';
        metricCompositorChannels.textContent = '0 路';
        metricCompositorVram.textContent = '0 句柄 (0泄漏)';
        metricCompositorFps.textContent = '0 FPS';
        emptyState.style.display = 'block';
        return;
      }

      try {
        btnToggleCompositor.disabled = true;
        btnToggleCompositor.textContent = '初始化 WebGPU 多路合成管线中...';
        emptyState.style.display = 'none';

        activeCompositor = new WebGpuMultiStreamCompositor({
          canvas,
          initialPreset: selectCompositorLayout.value as any,
        });
        await activeCompositor.initialize();

        activeCompositor.addChannel('host');
        activeCompositor.addChannel('guest_1');
        activeCompositor.addChannel('screen');

        const cHost = new OffscreenCanvas(640, 360);
        const ctxHost = cHost.getContext('2d')!;
        const cGuest = new OffscreenCanvas(320, 180);
        const ctxGuest = cGuest.getContext('2d')!;
        const cScreen = new OffscreenCanvas(640, 360);
        const ctxScreen = cScreen.getContext('2d')!;

        let frameIdx = 0;
        let lastFpsTime = performance.now();
        let fpsCounter = 0;

        const renderLoop = () => {
          if (!activeCompositor) return;

          frameIdx++;
          fpsCounter++;

          // 1. Draw animated Host canvas
          const grad = ctxHost.createLinearGradient(0, 0, 640, 360);
          grad.addColorStop(0, '#1e1b4b');
          grad.addColorStop(0.5, '#4338ca');
          grad.addColorStop(1, '#06b6d4');
          ctxHost.fillStyle = grad;
          ctxHost.fillRect(0, 0, 640, 360);
          ctxHost.fillStyle = '#ffffff';
          ctxHost.font = 'bold 24px system-ui, sans-serif';
          ctxHost.fillText(`🎤 主播视频流 (Host Channel) #${frameIdx}`, 30, 50);

          // 2. Draw animated Guest canvas
          ctxGuest.fillStyle = '#0f172a';
          ctxGuest.fillRect(0, 0, 320, 180);
          ctxGuest.fillStyle = '#38bdf8';
          const ballX = 160 + Math.sin(frameIdx * 0.08) * 80;
          const ballY = 90 + Math.cos(frameIdx * 0.08) * 40;
          ctxGuest.beginPath();
          ctxGuest.arc(ballX, ballY, 20, 0, Math.PI * 2);
          ctxGuest.fill();
          ctxGuest.fillStyle = '#f8fafc';
          ctxGuest.font = '14px system-ui, sans-serif';
          ctxGuest.fillText('👤 连麦嘉宾 (Guest 1)', 20, 30);

          // 3. Draw animated Screen canvas
          ctxScreen.fillStyle = '#020617';
          ctxScreen.fillRect(0, 0, 640, 360);
          ctxScreen.strokeStyle = '#334155';
          ctxScreen.lineWidth = 1;
          for (let x = 0; x < 640; x += 40) {
            ctxScreen.beginPath();
            ctxScreen.moveTo(x, 0);
            ctxScreen.lineTo(x, 360);
            ctxScreen.stroke();
          }
          ctxScreen.fillStyle = '#10b981';
          ctxScreen.font = 'bold 20px monospace';
          ctxScreen.fillText(`🖥️ 屏幕共享: 实时计算中 (Frame: ${frameIdx})`, 30, 40);

          // Push frames into compositor (strict RAII internally)
          const fHost = new VideoFrame(cHost, { timestamp: frameIdx * 16666 });
          const fGuest = new VideoFrame(cGuest, { timestamp: frameIdx * 16666 });
          const fScreen = new VideoFrame(cScreen, { timestamp: frameIdx * 16666 });

          activeCompositor.pushFrame('host', fHost);
          activeCompositor.pushFrame('guest_1', fGuest);
          activeCompositor.pushFrame('screen', fScreen);

          // Perform hardware multi-pass composition
          activeCompositor.composite();

          // Metrics update every 500ms
          const now = performance.now();
          if (now - lastFpsTime >= 500) {
            const currentFps = Math.round((fpsCounter * 1000) / (now - lastFpsTime));
            metricCompositorFps.textContent = `${currentFps} FPS`;
            metricCompositorChannels.textContent = `${activeCompositor.getChannelIds().length} 路`;
            metricCompositorVram.textContent = `${activeCompositor.getActiveFrameCount()} 句柄 (0泄漏)`;
            fpsCounter = 0;
            lastFpsTime = now;
          }

          compositorAnimationId = requestAnimationFrame(renderLoop);
        };

        compositorAnimationId = requestAnimationFrame(renderLoop);

        btnToggleCompositor.textContent = '⏹ 停止 WebGPU 多路混流';
        btnToggleCompositor.className = 'btn btn-danger';
        btnToggleCompositor.disabled = false;
      } catch (err: any) {
        console.error('Failed to start multi-stream compositor:', err);
        alert(`启动多路混流失败: ${err.message || err}`);
        btnToggleCompositor.textContent = '▶ 启动 WebGPU 实时多路合成演示';
        btnToggleCompositor.className = 'btn btn-primary';
        btnToggleCompositor.disabled = false;
        activeCompositor = null;
      }
    });

    // AI Media Autopilot Event Listeners
    selectAutopilotEngine.addEventListener('change', () => {
      autopilotAgent.setEngineMode(selectAutopilotEngine.value as any);
      const line = document.createElement('div');
      line.style.color = '#c084fc';
      line.textContent = `[Engine Switched] Decision engine set to: ${selectAutopilotEngine.value}`;
      autopilotTerminal.appendChild(line);
      autopilotTerminal.scrollTop = autopilotTerminal.scrollHeight;
    });

    checkboxAutopilotEnable.addEventListener('change', () => {
      autopilotStatusBadge.textContent = checkboxAutopilotEnable.checked ? '巡检守护中 (Active)' : '已休眠 (Disabled)';
      autopilotStatusBadge.style.color = checkboxAutopilotEnable.checked ? '#34d399' : '#94a3b8';
    });

    btnAutopilotSimulate.addEventListener('click', async () => {
      btnAutopilotSimulate.disabled = true;
      const initialText = btnAutopilotSimulate.textContent;
      btnAutopilotSimulate.textContent = '⏳ AI 正在诊断与编排自愈中...';
      try {
        await autopilotAgent.diagnoseAlert({
          type: 'PACKET_LOSS',
          severity: 'critical',
          source: p2pReceiver ? 'p2p-receiver' : 'loopback',
          metrics: {
            packetLossRate: 22,
            rttMs: 95,
            bitrateKbps: 900,
            failCode: 'FAIL-09',
          },
          timestamp: Date.now(),
        });
      } catch (err) {
        console.error('Autopilot simulation failed:', err);
      } finally {
        btnAutopilotSimulate.disabled = false;
        btnAutopilotSimulate.textContent = initialText;
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
