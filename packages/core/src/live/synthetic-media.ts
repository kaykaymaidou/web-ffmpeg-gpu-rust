/**
 * Synthetic MediaStream helper for WHIP publish tests and playground demos.
 */

export interface SyntheticMediaOptions {
  width?: number;
  height?: number;
  framerate?: number;
  includeAudio?: boolean;
  label?: string;
}

export interface SyntheticMediaHandle {
  stream: MediaStream;
  stop: () => void;
}

export function createSyntheticMediaStream(options: SyntheticMediaOptions = {}): SyntheticMediaHandle {
  const width = options.width ?? 640;
  const height = options.height ?? 360;
  const framerate = options.framerate ?? 30;
  const label = options.label ?? 'web-ffmpeg-gpu';

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to acquire 2D context for synthetic WHIP source');
  }

  let frameIndex = 0;
  const intervalMs = Math.max(16, Math.round(1000 / framerate));
  const timerId = window.setInterval(() => {
    frameIndex++;
    const hue = (frameIndex * 3) % 360;
    ctx.fillStyle = `hsl(${hue}, 45%, 18%)`;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = `${Math.max(18, Math.round(height / 10))}px ui-monospace, monospace`;
    ctx.fillText(label, 16, height / 2 - 12);
    ctx.fillStyle = '#38bdf8';
    ctx.font = '14px ui-monospace, monospace';
    ctx.fillText(`WHIP ${width}x${height} @${framerate}  frame=${frameIndex}`, 16, height / 2 + 16);
  }, intervalMs);

  const stream = canvas.captureStream(framerate);
  const tracksToStop: MediaStreamTrack[] = [...stream.getTracks()];
  let audioCtx: AudioContext | null = null;

  if (options.includeAudio && typeof AudioContext !== 'undefined') {
    try {
      audioCtx = new AudioContext();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const dest = audioCtx.createMediaStreamDestination();
      osc.frequency.value = 440;
      gain.gain.value = 0.05;
      osc.connect(gain);
      gain.connect(dest);
      osc.start();
      for (const track of dest.stream.getAudioTracks()) {
        stream.addTrack(track);
        tracksToStop.push(track);
      }
    } catch {
      audioCtx = null;
    }
  }

  return {
    stream,
    stop: () => {
      clearInterval(timerId);
      for (const track of tracksToStop) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      if (audioCtx) {
        audioCtx.close().catch(() => undefined);
      }
    },
  };
}
