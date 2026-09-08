/**
 * Web Audio API Live Stream Playout Engine & Master Clock Anchor (RFC 0002).
 * 
 * Provides:
 * - Gapless low-latency scheduling of decoded AudioData into Web Audio output.
 * - Hardware master clock anchoring for MasterClockSync to eliminate Lip-Sync drift.
 * - Guaranteed synchronous closure of AudioData handles (Zero memory leak).
 */

export interface AudioPlayerOptions {
  sampleRate?: number; // default: 48000
  numberOfChannels?: number; // default: 2
  volume?: number; // 0.0 to 1.0
}

export class WebAudioLivePlayer {
  private audioCtx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private nextPlayTime: number = 0;
  private sampleRate: number = 48000;
  private numberOfChannels: number = 2;
  private isInitialized: boolean = false;
  private totalSamplesQueued: number = 0;

  constructor(options?: AudioPlayerOptions) {
    if (options?.sampleRate) this.sampleRate = options.sampleRate;
    if (options?.numberOfChannels) this.numberOfChannels = options.numberOfChannels;
  }

  public ensureContext(): AudioContext {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error('Web Audio API (AudioContext) is not supported in this browser.');
      }
      this.audioCtx = new AudioContextClass({
        sampleRate: this.sampleRate,
        latencyHint: 'interactive',
      });

      this.gainNode = this.audioCtx.createGain();
      this.gainNode.connect(this.audioCtx.destination);
      this.nextPlayTime = this.audioCtx.currentTime;
      this.isInitialized = true;
    }

    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }

    return this.audioCtx;
  }

  public getAudioContext(): AudioContext | null {
    return this.audioCtx;
  }

  public get isReady(): boolean {
    return this.isInitialized;
  }

  public get channels(): number {
    return this.numberOfChannels;
  }

  /**
   * Enqueue a decoded AudioData frame, schedule seamless playback, and immediately close handle.
   * Returns scheduled playback start time in seconds on the AudioContext timeline.
   */
  public enqueueAudioData(data: AudioData): number {
    let startTime = 0;
    try {
      const ctx = this.ensureContext();
      const frames = data.numberOfFrames;
      const channels = data.numberOfChannels;
      const rate = data.sampleRate;

      // Create Web Audio buffer
      const audioBuffer = ctx.createBuffer(channels, frames, rate);

      // Copy planar float32 audio samples
      for (let ch = 0; ch < channels; ch++) {
        const channelBuffer = audioBuffer.getChannelData(ch);
        data.copyTo(channelBuffer, {
          planeIndex: ch,
          format: 'f32-planar',
        });
      }

      // Schedule playout on timeline
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      if (this.gainNode) {
        source.connect(this.gainNode);
      } else {
        source.connect(ctx.destination);
      }

      const now = ctx.currentTime;
      // If queue fell behind (e.g. initial start or network underrun), reset anchor
      startTime = Math.max(now, this.nextPlayTime);
      source.start(startTime);

      this.nextPlayTime = startTime + audioBuffer.duration;
      this.totalSamplesQueued += frames;
      return startTime;
    } catch (err) {
      console.warn('[WebAudioLivePlayer] Failed to schedule audio frame:', err);
      return startTime;
    } finally {
      // Zero memory leak invariant: synchronously close AudioData handle
      data.close();
    }
  }

  public setVolume(volume: number): void {
    if (this.gainNode && this.audioCtx) {
      const clamped = Math.max(0, Math.min(1, volume));
      this.gainNode.gain.setValueAtTime(clamped, this.audioCtx.currentTime);
    }
  }

  public getHardwareTimeSec(): number {
    return this.audioCtx ? this.audioCtx.currentTime : 0;
  }

  public close(): void {
    if (this.audioCtx) {
      try {
        this.audioCtx.close().catch(() => {});
      } catch {
        // ignore
      }
      this.audioCtx = null;
      this.gainNode = null;
      this.isInitialized = false;
    }
  }
}
