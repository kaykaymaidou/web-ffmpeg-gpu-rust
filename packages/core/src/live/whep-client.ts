/**
 * Standard WHEP playback client (draft-ietf-wish-whep).
 */

import { WishHttpClient } from './wish-http';
import {
  buildTrickleIceSdpfrag,
  extractIceCredentials,
  extractMidForKind,
  preferInteropCodecs,
  waitForIceGatheringComplete,
} from './wish-sdp';

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export interface WhepClientOptions {
  endpoint: string;
  token?: string;
  iceServers?: RTCIceServer[];
  fetchImpl?: typeof fetch;
  rtcConfiguration?: RTCConfiguration;
  trickleIce?: boolean;
  onStateChange?: (state: RTCPeerConnectionState) => void;
  onIceStateChange?: (state: RTCIceConnectionState) => void;
  onTrack?: (stream: MediaStream, track: MediaStreamTrack) => void;
  onMetrics?: (metrics: WhepClientMetrics) => void;
  onError?: (err: Error) => void;
}

export interface WhepClientMetrics {
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  iceGatheringState: RTCIceGatheringState;
  resourceUrl: string | null;
  trickleSupported: boolean;
  bytesReceived: number;
  packetsReceived: number;
  framesReceived: number;
  bitrateKbps: number;
  rttMs: number;
  isPlaying: boolean;
}

export class WhepClient {
  private readonly options: WhepClientOptions;
  private http: WishHttpClient;
  private pc: RTCPeerConnection | null = null;
  private remoteStream: MediaStream;
  private attachedVideo: HTMLVideoElement | null = null;
  private pendingCandidates: Array<RTCIceCandidate | null> = [];
  private trickleSupported = true;
  private isPlaying = false;
  private statsTimer: number | null = null;
  private abort: AbortController | null = null;
  private lastBytesReceived = 0;
  private lastStatsAt = 0;
  private metrics: WhepClientMetrics = this.emptyMetrics();

  constructor(options: WhepClientOptions) {
    this.options = options;
    this.http = new WishHttpClient({
      endpoint: options.endpoint,
      token: options.token,
      fetchImpl: options.fetchImpl,
    });
    this.remoteStream = new MediaStream();
  }

  public getMetrics(): WhepClientMetrics {
    this.syncLiveMetrics();
    return { ...this.metrics };
  }

  public getRemoteStream(): MediaStream | null {
    return this.isPlaying ? this.remoteStream : null;
  }

  public getPeerConnection(): RTCPeerConnection | null {
    return this.pc;
  }

  public async play(target?: HTMLVideoElement): Promise<MediaStream> {
    if (this.isPlaying) {
      throw new Error('WhepClient is already playing');
    }

    this.http = new WishHttpClient({
      endpoint: this.options.endpoint,
      token: this.options.token,
      fetchImpl: this.options.fetchImpl,
    });
    this.abort = new AbortController();
    this.trickleSupported = this.options.trickleIce !== false;
    this.pendingCandidates = [];
    this.remoteStream = new MediaStream();
    this.attachedVideo = target ?? null;

    const iceServers = [
      ...DEFAULT_ICE_SERVERS,
      ...(this.options.iceServers ?? []),
      ...(this.options.rtcConfiguration?.iceServers ?? []),
    ];

    this.pc = new RTCPeerConnection({
      ...this.options.rtcConfiguration,
      iceServers,
    });

    this.bindPeerEvents();
    this.pc.addTransceiver('video', { direction: 'recvonly' });
    this.pc.addTransceiver('audio', { direction: 'recvonly' });
    preferInteropCodecs(this.pc);

    this.isPlaying = true;
    this.metrics.isPlaying = true;
    this.startTelemetryLoop();

    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      if (this.options.trickleIce === false) {
        await waitForIceGatheringComplete(this.pc);
      }

      const localSdp = this.pc.localDescription?.sdp;
      if (!localSdp) {
        throw new Error('WhepClient failed to produce a local SDP offer');
      }

      const session = await this.http.postOffer(localSdp, this.abort.signal);
      if (session.iceServers.length > 0) {
        try {
          this.pc.setConfiguration({
            ...this.pc.getConfiguration(),
            iceServers: [...iceServers, ...session.iceServers],
          });
        } catch {
          // Ignore immutable ICE-server configurations.
        }
      }

      await this.pc.setRemoteDescription({ type: 'answer', sdp: session.answerSdp });
      await this.flushPendingCandidates();
      return this.remoteStream;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.options.onError?.(error);
      await this.stop();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.isPlaying = false;
    this.metrics.isPlaying = false;
    this.metrics.connectionState = 'closed';
    this.metrics.iceConnectionState = 'closed';

    if (this.abort) {
      this.abort.abort();
      this.abort = null;
    }
    if (this.statsTimer !== null) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }

    await this.http.terminate();

    if (this.attachedVideo) {
      this.attachedVideo.srcObject = null;
      this.attachedVideo = null;
    }

    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.close();
      this.pc = null;
    }

    for (const track of this.remoteStream.getTracks()) {
      this.remoteStream.removeTrack(track);
      try {
        track.stop();
      } catch {
        // Remote tracks may already be ended.
      }
    }

    this.pendingCandidates = [];
  }

  private bindPeerEvents(): void {
    if (!this.pc) {
      return;
    }

    this.pc.ontrack = (event) => {
      if (!this.remoteStream.getTracks().some((track) => track.id === event.track.id)) {
        this.remoteStream.addTrack(event.track);
      }
      if (this.attachedVideo) {
        this.attachedVideo.srcObject = this.remoteStream;
        this.attachedVideo.autoplay = true;
        this.attachedVideo.playsInline = true;
        this.attachedVideo.muted = true;
        void this.attachedVideo.play().catch(() => undefined);
      }
      const stream = event.streams[0] ?? this.remoteStream;
      this.options.onTrack?.(stream, event.track);
    };

    this.pc.onconnectionstatechange = () => {
      if (!this.pc) {
        return;
      }
      this.metrics.connectionState = this.pc.connectionState;
      this.options.onStateChange?.(this.pc.connectionState);
    };

    this.pc.oniceconnectionstatechange = () => {
      if (!this.pc) {
        return;
      }
      this.metrics.iceConnectionState = this.pc.iceConnectionState;
      this.options.onIceStateChange?.(this.pc.iceConnectionState);
    };

    this.pc.onicegatheringstatechange = () => {
      if (!this.pc) {
        return;
      }
      this.metrics.iceGatheringState = this.pc.iceGatheringState;
      if (this.pc.iceGatheringState === 'complete') {
        void this.sendEndOfCandidates();
      }
    };

    this.pc.onicecandidate = (event) => {
      void this.handleLocalCandidate(event.candidate);
    };
  }

  private async handleLocalCandidate(candidate: RTCIceCandidate | null): Promise<void> {
    if (!this.trickleSupported) {
      return;
    }
    if (!this.http.getResourceUrl()) {
      this.pendingCandidates.push(candidate);
      return;
    }
    if (!candidate) {
      return;
    }
    await this.patchCandidate(candidate);
  }

  private async flushPendingCandidates(): Promise<void> {
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of queued) {
      if (candidate) {
        await this.patchCandidate(candidate);
      }
    }
  }

  private async patchCandidate(candidate: RTCIceCandidate): Promise<void> {
    const pc = this.pc;
    const sdp = pc?.localDescription?.sdp;
    if (!pc || !sdp || !this.trickleSupported) {
      return;
    }

    const { ufrag, pwd } = extractIceCredentials(sdp);
    const kind: 'audio' | 'video' =
      candidate.sdpMid && /audio/i.test(candidate.sdpMid) ? 'audio' : 'video';
    const mid = candidate.sdpMid || extractMidForKind(sdp, kind);
    const sdpfrag = buildTrickleIceSdpfrag({
      ufrag,
      pwd,
      mid,
      mediaKind: kind,
      candidate: candidate.candidate,
    });

    const result = await this.http.patchIceFragment(sdpfrag, this.abort?.signal);
    if (result === 'not-supported') {
      this.trickleSupported = false;
      this.metrics.trickleSupported = false;
    }
  }

  private async sendEndOfCandidates(): Promise<void> {
    const pc = this.pc;
    const sdp = pc?.localDescription?.sdp;
    if (!pc || !sdp || !this.trickleSupported || !this.http.getResourceUrl()) {
      return;
    }
    const { ufrag, pwd } = extractIceCredentials(sdp);
    const videoFrag = buildTrickleIceSdpfrag({
      ufrag,
      pwd,
      mid: extractMidForKind(sdp, 'video'),
      mediaKind: 'video',
      endOfCandidates: true,
    });
    await this.http.patchIceFragment(videoFrag, this.abort?.signal);
  }

  private syncLiveMetrics(): void {
    if (this.pc) {
      this.metrics.connectionState = this.pc.connectionState;
      this.metrics.iceConnectionState = this.pc.iceConnectionState;
      this.metrics.iceGatheringState = this.pc.iceGatheringState;
    }
    this.metrics.resourceUrl = this.http.getResourceUrl();
    this.metrics.trickleSupported = this.trickleSupported;
    this.metrics.isPlaying = this.isPlaying;
  }

  private startTelemetryLoop(): void {
    this.lastStatsAt = performance.now();
    this.lastBytesReceived = 0;
    this.statsTimer = window.setInterval(() => {
      void this.refreshStats();
    }, 1000);
  }

  private async refreshStats(): Promise<void> {
    if (!this.pc) {
      return;
    }

    this.syncLiveMetrics();

    try {
      const stats = await this.pc.getStats();
      let bytesReceived = 0;
      let packetsReceived = 0;
      let framesReceived = 0;
      let rttMs = 0;

      stats.forEach((report) => {
        if (report.type === 'inbound-rtp') {
          bytesReceived += Number(report.bytesReceived || 0);
          packetsReceived += Number(report.packetsReceived || 0);
          framesReceived += Number(report.framesDecoded || report.framesReceived || 0);
        }
        if (report.type === 'candidate-pair' && (report as { state?: string }).state === 'succeeded') {
          const rtt = Number((report as { currentRoundTripTime?: number }).currentRoundTripTime || 0);
          rttMs = Math.round(rtt * 1000);
        }
      });

      const now = performance.now();
      const elapsedSec = (now - this.lastStatsAt) / 1000;
      const bitrateKbps =
        elapsedSec > 0 ? Math.round(((bytesReceived - this.lastBytesReceived) * 8) / elapsedSec / 1000) : 0;
      this.lastBytesReceived = bytesReceived;
      this.lastStatsAt = now;

      this.metrics.bytesReceived = bytesReceived;
      this.metrics.packetsReceived = packetsReceived;
      this.metrics.framesReceived = framesReceived;
      this.metrics.bitrateKbps = Math.max(0, bitrateKbps);
      this.metrics.rttMs = rttMs;
      this.options.onMetrics?.({ ...this.metrics });
    } catch {
      this.options.onMetrics?.({ ...this.metrics });
    }
  }

  private emptyMetrics(): WhepClientMetrics {
    return {
      connectionState: 'new',
      iceConnectionState: 'new',
      iceGatheringState: 'new',
      resourceUrl: null,
      trickleSupported: true,
      bytesReceived: 0,
      packetsReceived: 0,
      framesReceived: 0,
      bitrateKbps: 0,
      rttMs: 0,
      isPlaying: false,
    };
  }
}
