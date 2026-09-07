/**
 * Action determined by Master Clock Synchronizer to maintain lip-sync without cracking or stalling.
 */
export type SyncActionType = 'RENDER_NORMAL' | 'SMOOTH_CATCHUP' | 'SEEK_KEYFRAME' | 'DROP_FRAME';

export interface SyncDecision {
  action: SyncActionType;
  driftMs: number;
  playbackRate: number;
}

export interface ClockSyncConfig {
  tightThresholdMs?: number;    // Default: 40ms (below this is normal render)
  catchupThresholdMs?: number;  // Default: 500ms (between tight and catchup, apply 1.05x smooth speed)
  catchupRate?: number;         // Default: 1.05 (no audible pitch change)
}

/**
 * WebCodecs Audio-Video Master Clock Synchronizer (RFC 0002).
 * Anchored to AudioContext hardware output clock to solve the 30-minute dual-clock drift problem.
 */
export class MasterClockSync {
  private tightThresholdMs: number;
  private catchupThresholdMs: number;
  private catchupRate: number;

  private audioCtx: AudioContext | null = null;
  private audioBaseTime: number = 0;
  private streamBasePtsUs: number = 0;
  private isInitialized: boolean = false;

  constructor(config: ClockSyncConfig = {}, audioCtx?: AudioContext) {
    this.tightThresholdMs = config.tightThresholdMs ?? 40;
    this.catchupThresholdMs = config.catchupThresholdMs ?? 500;
    this.catchupRate = config.catchupRate ?? 1.05;
    if (audioCtx) {
      this.audioCtx = audioCtx;
    }
  }

  /**
   * Initialize or re-anchor the clock synchronization against the first synchronized audio/video timestamp.
   */
  public anchor(initialPtsUs: number): void {
    this.streamBasePtsUs = initialPtsUs;
    this.audioBaseTime = this.getCurrentHardwareTimeSec();
    this.isInitialized = true;
  }

  /**
   * Get current master clock time in microseconds.
   */
  public getMasterClockUs(): number {
    if (!this.isInitialized) {
      return 0;
    }
    const elapsedSec = this.getCurrentHardwareTimeSec() - this.audioBaseTime;
    return this.streamBasePtsUs + Math.round(elapsedSec * 1_000_000);
  }

  /**
   * Evaluate a video frame timestamp against the master clock to decide sync action.
   */
  public evaluateFrameSync(videoPtsUs: number): SyncDecision {
    if (!this.isInitialized) {
      this.anchor(videoPtsUs);
      return {
        action: 'RENDER_NORMAL',
        driftMs: 0,
        playbackRate: 1.0,
      };
    }

    const masterClockUs = this.getMasterClockUs();
    // drift = videoPts - masterClock (positive means video is ahead, negative means video is late)
    const driftMs = (videoPtsUs - masterClockUs) / 1000;

    // 1. Video is way too late (drift < -catchupThresholdMs): video lagging by > 500ms
    if (driftMs < -this.catchupThresholdMs) {
      return {
        action: 'SEEK_KEYFRAME',
        driftMs,
        playbackRate: 1.0,
      };
    }

    // 2. Video is slightly late (-catchupThresholdMs <= drift < -tightThresholdMs): apply smooth catchup
    if (driftMs < -this.tightThresholdMs) {
      return {
        action: 'SMOOTH_CATCHUP',
        driftMs,
        playbackRate: this.catchupRate,
      };
    }

    // 3. Video is way ahead of audio (video was decoded too fast, need to wait)
    if (driftMs > this.tightThresholdMs) {
      return {
        action: 'DROP_FRAME', // Or delay render
        driftMs,
        playbackRate: 1.0 / this.catchupRate,
      };
    }

    // 4. In sync within tight 40ms lip-sync window
    return {
      action: 'RENDER_NORMAL',
      driftMs,
      playbackRate: 1.0,
    };
  }

  public reset(): void {
    this.isInitialized = false;
    this.audioBaseTime = 0;
    this.streamBasePtsUs = 0;
  }

  private getCurrentHardwareTimeSec(): number {
    if (this.audioCtx && typeof this.audioCtx.currentTime === 'number') {
      const latency = (this.audioCtx.outputLatency || 0) + (this.audioCtx.baseLatency || 0);
      return Math.max(0, this.audioCtx.currentTime - latency);
    }
    return performance.now() / 1000;
  }
}
