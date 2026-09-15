/**
 * Standard WHIP publisher client (RFC 9725).
 */

import { WishHttpClient } from './wish-http';
import {
  buildTrickleIceSdpfrag,
  extractIceCredentials,
  extractMidForKind,
  preferInteropCodecs,
  waitForIceGatheringComplete,
} from './wish-sdp';
import { createSyntheticMediaStream, type SyntheticMediaHandle } from './synthetic-media';
import { WhipGpuTrackBridge, isInsertableTrackSupported } from './gpu-track-bridge';
import { WhipWebCodecsInjector } from './whip-webcodecs-inject';
import type { FilterSettings } from '../types';

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export interface WhipClientOptions {
  endpoint: string;
  token?: string;
  iceServers?: RTCIceServer[];
  fetchImpl?: typeof fetch;
  rtcConfiguration?: RTCConfiguration;
  trickleIce?: boolean;
  width?: number;
  height?: number;
  framerate?: number;
  includeAudio?: boolean;
  bitrate?: number;
  filter?: FilterSettings;
  useGpuPipeline?: boolean;
  webCodecsInject?: boolean;
  onStateChange?: (state: RTCPeerConnectionState) => void;
  onIceStateChange?: (state: RTCIceConnectionState) => void;
  onMetrics?: (metrics: WhipClientMetrics) => void;
  onError?: (err: Error) => void;
}

export interface WhipClientMetrics {
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  iceGatheringState: RTCIceGatheringState;
  resourceUrl: string | null;
  trickleSupported: boolean;
  bytesSent: number;
  packetsSent: number;
  framesSent: number;
  bitrateKbps: number;
  rttMs: number;
  isPublishing: boolean;
  gpuPipelineActive: boolean;
  webCodecsInjectActive: boolean;
  filteredFrames: number;
  droppedFrames: number;
}

export class WhipClient {
  private readonly options: WhipClientOptions;
  private http: WishHttpClient;
  private pc: RTCPeerConnection | null = null;
  private ownedMedia: SyntheticMediaHandle | null = null;
  private gpuBridge: WhipGpuTrackBridge | null = null;
  private webCodecsInjector: WhipWebCodecsInjector | null = null;
  private pendingCandidates: Array<RTCIceCandidate | null> = [];
  private trickleSupported = true;
  private isPublishing = false;
  private statsTimer: number | null = null;
  private abort: AbortController | null = null;
  private lastBytesSent = 0;
  private lastStatsAt = 0;
  private metrics: WhipClientMetrics = this.emptyMetrics();

  constructor(options: WhipClientOptions) {
    this.options = options;
    this.http = new WishHttpClient({
      endpoint: options.endpoint,
      token: options.token,
      fetchImpl: options.fetchImpl,
    });
  }

  public getMetrics(): WhipClientMetrics {
    this.syncLiveMetrics();
    return { ...this.metrics };
  }

  public getPeerConnection(): RTCPeerConnection | null {
    return this.pc;
  }

  public async publish(stream?: MediaStream): Promise<void> {
    if (this.isPublishing) {
      throw new Error('WhipClient is already publishing');
    }

    this.http = new WishHttpClient({
      endpoint: this.options.endpoint,
      token: this.options.token,
      fetchImpl: this.options.fetchImpl,
    });
    this.abort = new AbortController();
    this.trickleSupported = this.options.trickleIce !== false;
    this.pendingCandidates = [];

    const media = stream ?? this.createOwnedStream();
    const outgoing = await this.buildOutgoingStream(media);
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

    for (const track of outgoing.getTracks()) {
      this.pc.addTrack(track, outgoing);
    }
    preferInteropCodecs(this.pc);
    await this.attachCodecControls();

    this.isPublishing = true;
    this.metrics.isPublishing = true;
    this.startTelemetryLoop();

    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      if (this.options.trickleIce === false) {
        await waitForIceGatheringComplete(this.pc);
      }

      const localSdp = this.pc.localDescription?.sdp;
      if (!localSdp) {
        throw new Error('WhipClient failed to produce a local SDP offer');
      }

      const session = await this.http.postOffer(localSdp, this.abort.signal);
      if (session.iceServers.length > 0) {
        try {
          this.pc.setConfiguration({
            ...this.pc.getConfiguration(),
            iceServers: [...iceServers, ...session.iceServers],
          });
        } catch {
          // Some browsers reject late ICE-server mutation; STUN from constructor still applies.
        }
      }

      await this.pc.setRemoteDescription({ type: 'answer', sdp: session.answerSdp });
      await this.flushPendingCandidates();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.options.onError?.(error);
      await this.stop();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.isPublishing = false;
    this.metrics.isPublishing = false;
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

    if (this.webCodecsInjector) {
      this.webCodecsInjector.destroy();
      this.webCodecsInjector = null;
    }
    if (this.gpuBridge) {
      this.gpuBridge.destroy();
      this.gpuBridge = null;
    }

    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.onconnectionstatechange = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.close();
      this.pc = null;
    }

    if (this.ownedMedia) {
      this.ownedMedia.stop();
      this.ownedMedia = null;
    }

    this.pendingCandidates = [];
  }

  public setFilter(settings: FilterSettings): void {
    this.gpuBridge?.setFilter(settings);
  }

  private async buildOutgoingStream(source: MediaStream): Promise<MediaStream> {
    const outgoing = new MediaStream();
    const video = source.getVideoTracks()[0];
    const useGpu = this.options.useGpuPipeline !== false && !!video && isInsertableTrackSupported();

    if (useGpu && video) {
      this.gpuBridge = new WhipGpuTrackBridge({
        filter: this.options.filter,
        onError: this.options.onError,
      });
      try {
        const filtered = await this.gpuBridge.start(video);
        outgoing.addTrack(filtered);
      } catch (err) {
        this.gpuBridge.destroy();
        this.gpuBridge = null;
        outgoing.addTrack(video);
        this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    } else if (video) {
      outgoing.addTrack(video);
    }

    for (const track of source.getAudioTracks()) {
      outgoing.addTrack(track);
    }
    return outgoing;
  }

  private async attachCodecControls(): Promise<void> {
    if (!this.pc) {
      return;
    }
    const sender = this.pc.getSenders().find((item) => item.track?.kind === 'video');
    if (!sender) {
      return;
    }

    const bitrate = this.options.bitrate || 2_500_000;
    try {
      const params = sender.getParameters();
      if (params.encodings && params.encodings[0]) {
        params.encodings[0].maxBitrate = bitrate;
        await sender.setParameters(params);
      }
    } catch {
      // Some browsers reject setParameters before negotiation completes.
    }

    if (this.options.webCodecsInject === false || typeof VideoEncoder === 'undefined') {
      return;
    }

    const settings = sender.track?.getSettings() ?? {};
    this.webCodecsInjector = new WhipWebCodecsInjector({
      width: settings.width || this.options.width || 640,
      height: settings.height || this.options.height || 360,
      bitrate,
      framerate: settings.frameRate || this.options.framerate || 30,
    });
    const attached = await this.webCodecsInjector.attach(sender);
    if (!attached) {
      this.webCodecsInjector.destroy();
      this.webCodecsInjector = null;
      return;
    }
    this.gpuBridge?.setOnFilteredFrame((frame) => this.webCodecsInjector?.acceptFrame(frame));
  }

  private createOwnedStream(): MediaStream {
    this.ownedMedia = createSyntheticMediaStream({
      width: this.options.width,
      height: this.options.height,
      framerate: this.options.framerate,
      includeAudio: this.options.includeAudio ?? true,
      label: 'WhipClient',
    });
    return this.ownedMedia.stream;
  }

  private bindPeerEvents(): void {
    if (!this.pc) {
      return;
    }

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
    const kind = candidate.sdpMid && /audio/i.test(candidate.sdpMid) ? 'audio' : guessCandidateKind(sdp, candidate);
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
    this.metrics.isPublishing = this.isPublishing;
    const gpu = this.gpuBridge?.getStats();
    this.metrics.gpuPipelineActive = gpu?.gpuActive ?? false;
    this.metrics.webCodecsInjectActive = this.webCodecsInjector?.active ?? false;
    this.metrics.filteredFrames = gpu?.filteredFrames ?? 0;
    this.metrics.droppedFrames = gpu?.droppedFrames ?? 0;
  }

  private startTelemetryLoop(): void {
    this.lastStatsAt = performance.now();
    this.lastBytesSent = 0;
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
      let bytesSent = 0;
      let packetsSent = 0;
      let framesSent = 0;
      let rttMs = 0;

      stats.forEach((report) => {
        if (report.type === 'outbound-rtp') {
          bytesSent += Number(report.bytesSent || 0);
          packetsSent += Number(report.packetsSent || 0);
          framesSent += Number(report.framesEncoded || report.framesSent || 0);
        }
        if (report.type === 'candidate-pair' && (report as { state?: string }).state === 'succeeded') {
          const rtt = Number((report as { currentRoundTripTime?: number }).currentRoundTripTime || 0);
          rttMs = Math.round(rtt * 1000);
        }
      });

      const now = performance.now();
      const elapsedSec = (now - this.lastStatsAt) / 1000;
      const bitrateKbps = elapsedSec > 0 ? Math.round(((bytesSent - this.lastBytesSent) * 8) / elapsedSec / 1000) : 0;
      this.lastBytesSent = bytesSent;
      this.lastStatsAt = now;

      this.metrics.bytesSent = bytesSent;
      this.metrics.packetsSent = packetsSent;
      this.metrics.framesSent = framesSent;
      this.metrics.bitrateKbps = Math.max(0, bitrateKbps);
      this.metrics.rttMs = rttMs;
      this.options.onMetrics?.({ ...this.metrics });
    } catch {
      this.options.onMetrics?.({ ...this.metrics });
    }
  }

  private emptyMetrics(): WhipClientMetrics {
    return {
      connectionState: 'new',
      iceConnectionState: 'new',
      iceGatheringState: 'new',
      resourceUrl: null,
      trickleSupported: true,
      bytesSent: 0,
      packetsSent: 0,
      framesSent: 0,
      bitrateKbps: 0,
      rttMs: 0,
      isPublishing: false,
      gpuPipelineActive: false,
      webCodecsInjectActive: false,
      filteredFrames: 0,
      droppedFrames: 0,
    };
  }
}

function guessCandidateKind(sdp: string, candidate: RTCIceCandidate): 'audio' | 'video' {
  if (candidate.sdpMLineIndex == null) {
    return 'video';
  }
  const mLines = [...sdp.matchAll(/^m=(audio|video)/gm)].map((match) => match[1] as 'audio' | 'video');
  return mLines[candidate.sdpMLineIndex] ?? 'video';
}
