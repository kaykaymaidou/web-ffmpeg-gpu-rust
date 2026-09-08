/**
 * Multi-Track Audio Mixer & Broadcast Dynamics Limiter (RFC 0002 Phase 4).
 * 
 * Provides:
 * - Multi-source audio mixing (Host mic, Guest streams, Screen audio, BGM).
 * - Master DynamicsCompressorNode hardware limiter to eliminate clipping / distortion.
 * - Per-track independent gain, mute, and stereo pan controls.
 * - Guaranteed synchronous closure of AudioData handles (Zero memory leak invariant).
 */

export interface TrackOptions {
  trackId: string;
  volume?: number;     // 0.0 to 2.0 (default 1.0)
  pan?: number;        // -1.0 (left) to 1.0 (right), default 0.0 (center)
  muted?: boolean;     // default false
}

export interface AudioMixerOptions {
  sampleRate?: number; // default: 48000
  numberOfChannels?: number; // default: 2
  masterVolume?: number; // default: 1.0
}

interface TrackNodeState {
  trackId: string;
  gainNode: GainNode;
  pannerNode: StereoPannerNode | null;
  volume: number;
  muted: boolean;
  nextPlayTime: number;
  totalSamplesScheduled: number;
}

export class MultiTrackAudioMixer {
  private audioCtx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private streamDestination: MediaStreamAudioDestinationNode | null = null;
  private tracks = new Map<string, TrackNodeState>();
  private sampleRate: number = 48000;
  private isInitialized: boolean = false;

  public get isReady(): boolean {
    return this.isInitialized;
  }

  constructor(options?: AudioMixerOptions) {
    if (options?.sampleRate) this.sampleRate = options.sampleRate;
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

      // Master Dynamics Compressor: Professional broadcast limiter preventing clipping
      this.compressor = this.audioCtx.createDynamicsCompressor();
      this.compressor.threshold.setValueAtTime(-14, this.audioCtx.currentTime); // dB
      this.compressor.knee.setValueAtTime(10, this.audioCtx.currentTime);        // dB
      this.compressor.ratio.setValueAtTime(12, this.audioCtx.currentTime);       // 12:1 limiting
      this.compressor.attack.setValueAtTime(0.003, this.audioCtx.currentTime);   // 3ms attack
      this.compressor.release.setValueAtTime(0.25, this.audioCtx.currentTime);   // 250ms release

      this.masterGain = this.audioCtx.createGain();
      this.compressor.connect(this.masterGain);
      this.masterGain.connect(this.audioCtx.destination);

      // Create optional MediaStream destination for WebRTC egress
      if (typeof this.audioCtx.createMediaStreamDestination === 'function') {
        this.streamDestination = this.audioCtx.createMediaStreamDestination();
        this.masterGain.connect(this.streamDestination);
      }

      this.isInitialized = true;
    }

    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }

    return this.audioCtx;
  }

  /**
   * Register a new audio track into the mixer bus.
   */
  public addTrack(options: TrackOptions): void {
    const ctx = this.ensureContext();
    if (this.tracks.has(options.trackId)) return;

    const gainNode = ctx.createGain();
    const volume = options.volume !== undefined ? options.volume : 1.0;
    const muted = options.muted || false;
    gainNode.gain.setValueAtTime(muted ? 0 : volume, ctx.currentTime);

    let pannerNode: StereoPannerNode | null = null;
    if (typeof ctx.createStereoPanner === 'function') {
      pannerNode = ctx.createStereoPanner();
      const pan = options.pan !== undefined ? options.pan : 0.0;
      pannerNode.pan.setValueAtTime(pan, ctx.currentTime);
      gainNode.connect(pannerNode);
      pannerNode.connect(this.compressor!);
    } else {
      gainNode.connect(this.compressor!);
    }

    this.tracks.set(options.trackId, {
      trackId: options.trackId,
      gainNode,
      pannerNode,
      volume,
      muted,
      nextPlayTime: ctx.currentTime,
      totalSamplesScheduled: 0,
    });
  }

  /**
   * Remove an audio track from the mixer bus.
   */
  public removeTrack(trackId: string): void {
    const track = this.tracks.get(trackId);
    if (!track) return;

    try {
      track.gainNode.disconnect();
      track.pannerNode?.disconnect();
    } catch {}

    this.tracks.delete(trackId);
  }

  /**
   * Schedule decoded AudioData on a specific track with guaranteed synchronous closure.
   */
  public scheduleAudioData(trackId: string, data: AudioData): void {
    try {
      const ctx = this.ensureContext();
      let track = this.tracks.get(trackId);
      if (!track) {
        this.addTrack({ trackId });
        track = this.tracks.get(trackId)!;
      }

      const numChannels = data.numberOfChannels;
      const numFrames = data.numberOfFrames;
      const sampleRate = data.sampleRate;

      const audioBuffer = ctx.createBuffer(numChannels, numFrames, sampleRate);

      for (let ch = 0; ch < numChannels; ch++) {
        const channelData = audioBuffer.getChannelData(ch);
        data.copyTo(channelData, {
          planeIndex: ch,
          format: 'f32-planar',
        });
      }

      const now = ctx.currentTime;
      if (track.nextPlayTime < now) {
        track.nextPlayTime = now + 0.015; // 15ms lead-in jitter cushion
      }

      const sourceNode = ctx.createBufferSource();
      sourceNode.buffer = audioBuffer;
      sourceNode.connect(track.gainNode);
      sourceNode.start(track.nextPlayTime);

      const duration = numFrames / sampleRate;
      track.nextPlayTime += duration;
      track.totalSamplesScheduled += numFrames;
    } finally {
      // Zero Memory Leak: strictly close AudioData handle
      data.close();
    }
  }

  public setTrackVolume(trackId: string, volume: number): void {
    const track = this.tracks.get(trackId);
    if (!track || !this.audioCtx) return;
    track.volume = Math.max(0, Math.min(2.0, volume));
    if (!track.muted) {
      track.gainNode.gain.setValueAtTime(track.volume, this.audioCtx.currentTime);
    }
  }

  public setTrackMuted(trackId: string, muted: boolean): void {
    const track = this.tracks.get(trackId);
    if (!track || !this.audioCtx) return;
    track.muted = muted;
    track.gainNode.gain.setValueAtTime(muted ? 0 : track.volume, this.audioCtx.currentTime);
  }

  public setTrackPan(trackId: string, pan: number): void {
    const track = this.tracks.get(trackId);
    if (!track || !track.pannerNode || !this.audioCtx) return;
    const clampedPan = Math.max(-1.0, Math.min(1.0, pan));
    track.pannerNode.pan.setValueAtTime(clampedPan, this.audioCtx.currentTime);
  }

  public setMasterVolume(volume: number): void {
    if (!this.masterGain || !this.audioCtx) return;
    const clamped = Math.max(0, Math.min(2.0, volume));
    this.masterGain.gain.setValueAtTime(clamped, this.audioCtx.currentTime);
  }

  public getMasterStream(): MediaStream | null {
    return this.streamDestination?.stream || null;
  }

  public getTrackIds(): string[] {
    return Array.from(this.tracks.keys());
  }

  public getStats(): { activeTracks: number; compressorReductionDb: number; currentTime: number } {
    return {
      activeTracks: this.tracks.size,
      compressorReductionDb: this.compressor?.reduction || 0,
      currentTime: this.audioCtx?.currentTime || 0,
    };
  }

  public destroy(): void {
    for (const track of this.tracks.values()) {
      try {
        track.gainNode.disconnect();
        track.pannerNode?.disconnect();
      } catch {}
    }
    this.tracks.clear();

    if (this.audioCtx) {
      try {
        this.audioCtx.close();
      } catch {}
      this.audioCtx = null;
    }

    this.masterGain = null;
    this.compressor = null;
    this.streamDestination = null;
    this.isInitialized = false;
  }
}
