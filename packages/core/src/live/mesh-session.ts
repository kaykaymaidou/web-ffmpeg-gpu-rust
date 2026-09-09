/**
 * WebRTC Multi-Peer Mesh Live Session Engine (RFC 0002 Phase 4).
 * 
 * Provides:
 * - Full N-way / 1vN WebRTC DataChannel Mesh topology management.
 * - Deterministic glare-free SDP/ICE handshake with lexicographical tie-breaking.
 * - Direct ingestion into WebGpuMultiStreamCompositor & MultiTrackAudioMixer.
 * - Targeted Reverse PLI: Per-peer isolated keyframe requests without cross-channel disruption.
 * - Strict Zero VRAM / Memory Leak guarantee on peer join, stream decoding, and leave.
 */

import { HardwareVideoEncoder } from '../encoder/hardware-encoder';
import { HardwareVideoDecoder } from '../decoder/hardware-decoder';
import { HardwareAudioEncoder } from '../codec/audio-encoder';
import { HardwareAudioDecoder } from '../codec/audio-decoder';
import { RtpStreamDemuxer, type AssembledRtpFrame } from './rtp-demuxer';
import { OpusRtpPacketizer, OpusRtpDemuxer, type AssembledOpusPacket } from './opus-rtp';
import type { WebGpuMultiStreamCompositor, CompositorLayoutPreset } from '../renderer/multi-compositor';
import type { MultiTrackAudioMixer } from './audio-mixer';
import type { SignalingChannel, SignalingMessage } from './p2p-signaling';

export type MeshPeerRole = 'host' | 'guest' | 'viewer';

export interface MultiPeerMeshSessionOptions {
  roomId: string;
  peerId?: string;
  role?: MeshPeerRole; // default: 'guest'
  signaling: SignalingChannel;
  rtcConfiguration?: RTCConfiguration;
  width?: number; // default: 640
  height?: number; // default: 360
  framerate?: number; // default: 30
  bitrate?: number; // default: 1_200_000
  enableAudio?: boolean; // default: true
  audioBitrate?: number; // default: 64000
  compositor?: WebGpuMultiStreamCompositor;
  audioMixer?: MultiTrackAudioMixer;
  renderCanvas?: HTMLCanvasElement;
  onPeerJoin?: (peerId: string) => void;
  onPeerLeave?: (peerId: string) => void;
  onPeerMetrics?: (peerId: string, metrics: RemotePeerMetrics) => void;
  onMetrics?: (metrics: MeshSessionMetrics) => void;
  onError?: (err: Error) => void;
}

export interface RemotePeerMetrics {
  peerId: string;
  connectionState: RTCPeerConnectionState;
  videoDataChannelState: RTCDataChannelState | 'closed';
  audioDataChannelState: RTCDataChannelState | 'closed';
  playoutFps: number;
  rtpPacketsReceived: number;
  audioPacketsReceived: number;
  packetsDropped: number;
  fail09Rescues: number;
}

export interface MeshSessionMetrics {
  peerId: string;
  roomId: string;
  role: MeshPeerRole;
  activePeersCount: number;
  totalVideoPacketsSent: number;
  totalAudioPacketsSent: number;
  targetedPliSent: number;
  targetedPliReceived: number;
  ingestFps: number;
  bitrateKbps: number;
  isRunning: boolean;
}

interface RemotePeerState {
  peerId: string;
  pc: RTCPeerConnection;
  videoChannel: RTCDataChannel | null;
  audioChannel: RTCDataChannel | null;
  videoDemuxer: RtpStreamDemuxer | null;
  videoDecoder: HardwareVideoDecoder | null;
  audioDemuxer: OpusRtpDemuxer | null;
  audioDecoder: HardwareAudioDecoder | null;
  decoderConfiguredWithDescription: boolean;
  hasReceivedFirstKeyframe: boolean;
  waitingForPliRecoveryKeyframe: boolean;
  metrics: RemotePeerMetrics;
  decodedFramesCount: number;
  lastStatsTime: number;
}

const DEFAULT_RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export class MultiPeerMeshSession {
  public readonly peerId: string;
  public readonly roomId: string;
  public readonly role: MeshPeerRole;

  private options: MultiPeerMeshSessionOptions;
  private remotePeers = new Map<string, RemotePeerState>();
  private isRunning: boolean = false;

  // Local Media Pipeline (if publishing: 'host' | 'guest')
  private videoEncoder: HardwareVideoEncoder | null = null;
  private audioEncoder: HardwareAudioEncoder | null = null;
  private audioPacketizer: OpusRtpPacketizer | null = null;
  private rtpSeq: number = 1;
  private rtpSsrc: number = 0x31415926;
  private mtu: number = 1200;
  private forceNextKeyframe: boolean = true;
  private cachedEncoderDescription: Uint8Array | null = null;

  // Timers & Canvases
  private animTimerId: any = null;
  private audioTimerId: any = null;
  private telemetryTimerId: any = null;
  private captureCanvas: HTMLCanvasElement | null = null;
  private captureCtx: CanvasRenderingContext2D | null = null;

  // Session Telemetry
  private metrics: MeshSessionMetrics;
  private encodedFramesCount: number = 0;
  private encodedBytesWindow: number = 0;
  private lastStatsTime: number = 0;

  constructor(options: MultiPeerMeshSessionOptions) {
    this.options = options;
    this.roomId = options.roomId;
    this.role = options.role || 'guest';
    this.peerId = options.peerId || `peer-${Math.random().toString(36).substring(2, 9)}`;

    this.metrics = {
      peerId: this.peerId,
      roomId: this.roomId,
      role: this.role,
      activePeersCount: 0,
      totalVideoPacketsSent: 0,
      totalAudioPacketsSent: 0,
      targetedPliSent: 0,
      targetedPliReceived: 0,
      ingestFps: 0,
      bitrateKbps: 0,
      isRunning: false,
    };
  }

  public getMetrics(): MeshSessionMetrics {
    return {
      ...this.metrics,
      activePeersCount: this.remotePeers.size,
    };
  }

  public getRemotePeerMetrics(peerId: string): RemotePeerMetrics | null {
    const peer = this.remotePeers.get(peerId);
    return peer ? { ...peer.metrics } : null;
  }

  public getAllRemotePeerMetrics(): RemotePeerMetrics[] {
    return Array.from(this.remotePeers.values()).map((p) => ({ ...p.metrics }));
  }

  public getRemotePeerIds(): string[] {
    return Array.from(this.remotePeers.keys());
  }

  /**
   * Adjust WebGPU layout preset across active peers.
   */
  public setLayoutPreset(preset: CompositorLayoutPreset): void {
    this.options.compositor?.setLayoutPreset(preset);
  }

  /**
   * Set volume for a remote peer's audio track.
   */
  public setPeerAudioVolume(peerId: string, volume: number): void {
    this.options.audioMixer?.setTrackVolume(peerId, volume);
  }

  /**
   * Mute or unmute a remote peer's audio track.
   */
  public setPeerAudioMuted(peerId: string, muted: boolean): void {
    this.options.audioMixer?.setTrackMuted(peerId, muted);
  }

  /**
   * Start the Multi-Peer Mesh live session.
   */
  public async start(mediaTrack?: MediaStreamTrack, audioTrack?: MediaStreamTrack): Promise<void> {
    if (this.isRunning) {
      throw new Error('MultiPeerMeshSession is already running');
    }

    const width = this.options.width || 640;
    const height = this.options.height || 360;
    const framerate = this.options.framerate || 30;
    const bitrate = this.options.bitrate || 1_200_000;
    const enableAudio = this.options.enableAudio !== false;

    this.isRunning = true;
    this.metrics.isRunning = true;
    this.lastStatsTime = performance.now();
    this.forceNextKeyframe = true;

    // 1. Initialize Compositor and AudioMixer for local preview if publishing
    if (this.role !== 'viewer') {
      this.options.compositor?.addChannel(this.peerId);
      if (enableAudio) {
        this.options.audioMixer?.addTrack({ trackId: this.peerId });
      }
    }

    // 2. Setup Local Video Pipeline if publishing ('host' | 'guest')
    if (this.role !== 'viewer') {
      this.videoEncoder = new HardwareVideoEncoder((chunk, metadata) => {
        this.encodedFramesCount++;
        this.encodedBytesWindow += chunk.byteLength;

        if (metadata?.decoderConfig?.description) {
          const desc = new Uint8Array(metadata.decoderConfig.description as ArrayBuffer);
          this.cachedEncoderDescription = desc;
          this.extractAndBroadcastSpsPps(desc, chunk.timestamp);
        } else if (chunk.type === 'key' && this.cachedEncoderDescription) {
          this.extractAndBroadcastSpsPps(this.cachedEncoderDescription, chunk.timestamp);
        }

        const chunkBytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(chunkBytes);
        this.packetizeAndBroadcastVideoChunk(chunkBytes, chunk.timestamp);
      }, (err) => {
        this.options.onError?.(err);
      });

      await this.videoEncoder.configure({
        codec: 'avc1.42001f',
        width,
        height,
        bitrate,
        framerate,
        latencyMode: 'realtime',
      });

      // 3. Setup Local Audio Pipeline if enabled
      if (enableAudio) {
        this.audioPacketizer = new OpusRtpPacketizer({ payloadType: 111, clockRate: 48000 });
        this.audioEncoder = new HardwareAudioEncoder((chunk) => {
          if (!this.audioPacketizer) return;
          const opusBytes = new Uint8Array(chunk.byteLength);
          chunk.copyTo(opusBytes);
          const rtpPacket = this.audioPacketizer.packetize(opusBytes, chunk.timestamp);
          this.broadcastAudioPacket(rtpPacket);
        }, (err) => {
          this.options.onError?.(new Error(`AudioEncoder Error: ${err.message}`));
        });

        await this.audioEncoder.configure({
          codec: 'opus',
          sampleRate: 48000,
          numberOfChannels: 2,
          bitrate: this.options.audioBitrate || 64000,
        });

        if (audioTrack && typeof (window as any).MediaStreamTrackProcessor !== 'undefined') {
          this.startAudioTrackProcessor(audioTrack);
        } else {
          this.startSyntheticAudioSource();
        }
      }

      // 4. Start Video Capture (MediaTrack or Synthetic Animation)
      if (mediaTrack && typeof (window as any).MediaStreamTrackProcessor !== 'undefined') {
        this.startVideoTrackProcessor(mediaTrack);
      } else {
        this.startSyntheticVideoSource(width, height, framerate);
      }
    }

    // 5. Connect signaling channel and bind message dispatcher
    await this.options.signaling.connect();
    this.options.signaling.onMessage((msg: SignalingMessage) => {
      this.handleSignalingMessage(msg).catch((err) => this.options.onError?.(err));
    });

    // 6. Start telemetry monitoring loop
    this.startTelemetryLoop();

    // 7. Broadcast join presence to mesh network
    await this.options.signaling.sendMessage({
      type: 'join',
      roomId: this.roomId,
      senderId: this.peerId,
      payload: { role: this.role },
    });
  }

  /**
   * Request an IDR keyframe.
   * If targetPeerId is specified, sends targeted reverse PLI only to that peer.
   * Otherwise broadcasts PLI to all peers.
   */
  public requestKeyframe(targetPeerId?: string): void {
    if (targetPeerId) {
      const peer = this.remotePeers.get(targetPeerId);
      let sentViaDc = false;
      if (peer?.videoChannel && peer.videoChannel.readyState === 'open') {
        try {
          peer.videoChannel.send(JSON.stringify({ type: 'pli' }));
          sentViaDc = true;
        } catch {
          // ignore
        }
      }
      if (!sentViaDc) {
        this.options.signaling.sendMessage({
          type: 'pli',
          roomId: this.roomId,
          senderId: this.peerId,
          targetId: targetPeerId,
        }).catch(() => {});
      }
      this.metrics.targetedPliSent++;
    } else {
      let anySent = false;
      for (const peer of this.remotePeers.values()) {
        if (peer.videoChannel && peer.videoChannel.readyState === 'open') {
          try {
            peer.videoChannel.send(JSON.stringify({ type: 'pli' }));
            anySent = true;
          } catch {
            // ignore
          }
        }
      }
      if (!anySent) {
        this.options.signaling.sendMessage({
          type: 'pli',
          roomId: this.roomId,
          senderId: this.peerId,
        }).catch(() => {});
      }
      this.metrics.targetedPliSent++;
    }
  }

  /**
   * Stop the session, gracefully disconnect from all peers and clean up resources (Zero Leak).
   */
  public stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.metrics.isRunning = false;

    // Send leave signal
    this.options.signaling.sendMessage({
      type: 'leave',
      roomId: this.roomId,
      senderId: this.peerId,
    }).catch(() => {});

    // Clear timers
    if (this.animTimerId) {
      clearInterval(this.animTimerId);
      this.animTimerId = null;
    }
    if (this.audioTimerId) {
      clearInterval(this.audioTimerId);
      this.audioTimerId = null;
    }
    if (this.telemetryTimerId) {
      clearInterval(this.telemetryTimerId);
      this.telemetryTimerId = null;
    }

    // Clean up all remote peer connections and decoders
    for (const peerId of Array.from(this.remotePeers.keys())) {
      this.teardownRemotePeer(peerId);
    }
    this.remotePeers.clear();

    // Close local encoders
    if (this.videoEncoder) {
      this.videoEncoder.close();
      this.videoEncoder = null;
    }
    if (this.audioEncoder) {
      this.audioEncoder.close();
      this.audioEncoder = null;
    }

    // Remove local channels from compositor and audio mixer
    this.options.compositor?.removeChannel(this.peerId);
    this.options.audioMixer?.removeTrack(this.peerId);

    this.captureCanvas = null;
    this.captureCtx = null;
    this.options.signaling.disconnect();
  }

  // =========================================================================
  // Signaling & Mesh Handshake Protocol (Lexicographical Glare Resolution)
  // =========================================================================

  private async handleSignalingMessage(msg: SignalingMessage): Promise<void> {
    if (msg.roomId !== this.roomId || msg.senderId === this.peerId) return;

    // Direct routing check
    if (msg.targetId && msg.targetId !== this.peerId) return;

    switch (msg.type) {
      case 'join':
        await this.handlePeerJoin(msg.senderId);
        break;
      case 'offer':
        if (msg.sdp) {
          await this.handleRemoteOffer(msg.senderId, msg.sdp);
        }
        break;
      case 'answer':
        if (msg.sdp) {
          await this.handleRemoteAnswer(msg.senderId, msg.sdp);
        }
        break;
      case 'candidate':
        if (msg.candidate) {
          await this.handleRemoteCandidate(msg.senderId, msg.candidate);
        }
        break;
      case 'pli':
        // Targeted Reverse PLI received!
        if (this.role !== 'viewer') {
          this.forceNextKeyframe = true;
          this.metrics.targetedPliReceived++;
        }
        break;
      case 'leave':
        this.teardownRemotePeer(msg.senderId);
        break;
    }
  }

  /**
   * Deterministic Glare Resolution:
   * The peer with lexicographically smaller ID initiates the WebRTC offer.
   */
  private shouldInitiateOffer(remotePeerId: string): boolean {
    return this.peerId < remotePeerId;
  }

  private async handlePeerJoin(remotePeerId: string): Promise<void> {
    if (this.remotePeers.has(remotePeerId)) {
      return;
    }

    if (this.shouldInitiateOffer(remotePeerId)) {
      // We are the offerer: initialize connection and send offer
      await this.initiatePeerOffer(remotePeerId);
    } else {
      // The other peer should be the offerer: notify them of our presence
      await this.options.signaling.sendMessage({
        type: 'join',
        roomId: this.roomId,
        senderId: this.peerId,
        targetId: remotePeerId,
      });
    }
  }

  private async initiatePeerOffer(remotePeerId: string): Promise<void> {
    const peer = this.createRemotePeerState(remotePeerId);

    // Create DataChannels (Offerer side)
    const videoChannel = peer.pc.createDataChannel('video-stream', {
      ordered: false,
      maxRetransmits: 0,
    });
    this.setupVideoDataChannel(peer, videoChannel);

    if (this.options.enableAudio !== false) {
      const audioChannel = peer.pc.createDataChannel('audio-stream', {
        ordered: false,
        maxRetransmits: 1,
      });
      this.setupAudioDataChannel(peer, audioChannel);
    }

    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);

    await this.options.signaling.sendMessage({
      type: 'offer',
      roomId: this.roomId,
      senderId: this.peerId,
      targetId: remotePeerId,
      sdp: offer,
    });
  }

  private async handleRemoteOffer(remotePeerId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    let peer = this.remotePeers.get(remotePeerId);
    if (!peer) {
      peer = this.createRemotePeerState(remotePeerId);
    }

    await peer.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);

    await this.options.signaling.sendMessage({
      type: 'answer',
      roomId: this.roomId,
      senderId: this.peerId,
      targetId: remotePeerId,
      sdp: answer,
    });
  }

  private async handleRemoteAnswer(remotePeerId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    const peer = this.remotePeers.get(remotePeerId);
    if (peer && peer.pc.signalingState !== 'stable') {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  }

  private async handleRemoteCandidate(remotePeerId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const peer = this.remotePeers.get(remotePeerId);
    if (peer && peer.pc.remoteDescription) {
      try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn(`[MultiPeerMeshSession] Failed to add ICE candidate for ${remotePeerId}:`, err);
      }
    }
  }

  // =========================================================================
  // Peer State Creation & Inbound Pipeline Wiring
  // =========================================================================

  private createRemotePeerState(remotePeerId: string): RemotePeerState {
    const config = this.options.rtcConfiguration || DEFAULT_RTC_CONFIG;
    const pc = new RTCPeerConnection(config);

    const peer: RemotePeerState = {
      peerId: remotePeerId,
      pc,
      videoChannel: null,
      audioChannel: null,
      videoDemuxer: new RtpStreamDemuxer({ isHevc: false, clockRate: 90000 }),
      videoDecoder: null,
      audioDemuxer: new OpusRtpDemuxer({ clockRate: 48000 }),
      audioDecoder: null,
      decoderConfiguredWithDescription: false,
      hasReceivedFirstKeyframe: false,
      waitingForPliRecoveryKeyframe: false,
      metrics: {
        peerId: remotePeerId,
        connectionState: 'new',
        videoDataChannelState: 'closed',
        audioDataChannelState: 'closed',
        playoutFps: 0,
        rtpPacketsReceived: 0,
        audioPacketsReceived: 0,
        packetsDropped: 0,
        fail09Rescues: 0,
      },
      decodedFramesCount: 0,
      lastStatsTime: performance.now(),
    };

    // Initialize Hardware Video Decoder for this remote peer
    peer.videoDecoder = new HardwareVideoDecoder((frame) => {
      peer.decodedFramesCount++;

      if (this.options.compositor) {
        // WebGPU Compositor takes ownership and closes previous frame (Zero Leak)
        this.options.compositor.pushFrame(remotePeerId, frame);
      } else if (this.options.renderCanvas) {
        const ctx = this.options.renderCanvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(frame, 0, 0, this.options.renderCanvas.width, this.options.renderCanvas.height);
        }
        frame.close();
      } else {
        frame.close();
      }
    }, (err) => {
      this.options.onError?.(new Error(`VideoDecoder [${remotePeerId}] Error: ${err.message}`));
    });

    peer.videoDecoder.configure({
      codec: 'avc1.42001f',
      hardwareAcceleration: 'prefer-hardware',
    }).catch((err) => this.options.onError?.(err));

    // Initialize Hardware Audio Decoder for this remote peer if audio enabled
    if (this.options.enableAudio !== false) {
      peer.audioDecoder = new HardwareAudioDecoder((audioData) => {
        if (this.options.audioMixer) {
          // AudioMixer schedules buffer and synchronously closes audioData (Zero Leak)
          this.options.audioMixer.scheduleAudioData(remotePeerId, audioData);
        } else {
          audioData.close();
        }
      }, (err) => {
        this.options.onError?.(new Error(`AudioDecoder [${remotePeerId}] Error: ${err.message}`));
      });

      peer.audioDecoder.configure({
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: 2,
      }).catch((err) => this.options.onError?.(err));
    }

    // Register channel/track in compositor and mixer
    this.options.compositor?.addChannel(remotePeerId);
    if (this.options.enableAudio !== false) {
      this.options.audioMixer?.addTrack({ trackId: remotePeerId });
    }

    pc.onconnectionstatechange = () => {
      peer.metrics.connectionState = pc.connectionState;
      if (pc.connectionState === 'connected') {
        this.options.onPeerJoin?.(remotePeerId);
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.teardownRemotePeer(remotePeerId);
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.options.signaling.sendMessage({
          type: 'candidate',
          roomId: this.roomId,
          senderId: this.peerId,
          targetId: remotePeerId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    // Inbound DataChannel handler (Answerer side)
    pc.ondatachannel = (event) => {
      const channel = event.channel;
      if (channel.label === 'video-stream') {
        this.setupVideoDataChannel(peer, channel);
      } else if (channel.label === 'audio-stream') {
        this.setupAudioDataChannel(peer, channel);
      }
    };

    this.remotePeers.set(remotePeerId, peer);
    return peer;
  }

  private setupVideoDataChannel(peer: RemotePeerState, channel: RTCDataChannel): void {
    peer.videoChannel = channel;
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      peer.metrics.videoDataChannelState = channel.readyState;
      // Request initial keyframe from remote peer
      this.requestKeyframe(peer.peerId);
    };

    channel.onclose = () => {
      peer.metrics.videoDataChannelState = 'closed';
    };

    channel.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'pli') {
            this.forceNextKeyframe = true;
            this.metrics.targetedPliReceived++;
          }
        } catch {
          // ignore
        }
      } else if (event.data instanceof ArrayBuffer) {
        const packet = new Uint8Array(event.data);
        this.handleRemoteVideoPacket(peer, packet);
      }
    };
  }

  private setupAudioDataChannel(peer: RemotePeerState, channel: RTCDataChannel): void {
    peer.audioChannel = channel;
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      peer.metrics.audioDataChannelState = channel.readyState;
    };

    channel.onclose = () => {
      peer.metrics.audioDataChannelState = 'closed';
    };

    channel.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        const packet = new Uint8Array(event.data);
        this.handleRemoteAudioPacket(peer, packet);
      }
    };
  }

  // =========================================================================
  // Inbound Media Processing & Targeted Reverse PLI Self-Healing
  // =========================================================================

  private handleRemoteVideoPacket(peer: RemotePeerState, packet: Uint8Array): void {
    if (!peer.videoDemuxer || !peer.videoDecoder) return;

    peer.metrics.rtpPacketsReceived++;

    const prevFragmentLoss = peer.videoDemuxer.getStats().fragmentLossEvents;
    const prevPacketsDropped = peer.videoDemuxer.getStats().packetsDropped;
    const assembledFrame: AssembledRtpFrame | null = peer.videoDemuxer.pushPacket(packet);
    const newFragmentLoss = peer.videoDemuxer.getStats().fragmentLossEvents;
    const newPacketsDropped = peer.videoDemuxer.getStats().packetsDropped;

    // FAIL-09 Targeted Self-Healing: packet loss isolated to this peer!
    if (newFragmentLoss > prevFragmentLoss || newPacketsDropped > prevPacketsDropped) {
      peer.metrics.fail09Rescues++;
      peer.metrics.packetsDropped += (newPacketsDropped - prevPacketsDropped);
      peer.waitingForPliRecoveryKeyframe = true;

      // Reverse PLI targeted strictly to this peer!
      this.requestKeyframe(peer.peerId);
    }

    if (assembledFrame) {
      if (!peer.decoderConfiguredWithDescription) {
        const desc = peer.videoDemuxer.getAvcDescription();
        if (desc) {
          peer.videoDecoder.configure({
            codec: 'avc1.42001f',
            description: desc,
            hardwareAcceleration: 'prefer-hardware',
          });
          peer.decoderConfiguredWithDescription = true;
        }
      }

      if (assembledFrame.isKeyframe) {
        if (!peer.decoderConfiguredWithDescription) {
          this.requestKeyframe(peer.peerId);
          return;
        }
        peer.hasReceivedFirstKeyframe = true;
        peer.waitingForPliRecoveryKeyframe = false;
      } else if (!peer.hasReceivedFirstKeyframe || peer.waitingForPliRecoveryKeyframe) {
        return;
      }

      let totalSize = 0;
      for (const nal of assembledFrame.nals) {
        totalSize += 4 + nal.length;
      }

      const avccBytes = new Uint8Array(totalSize);
      let offset = 0;
      for (const nal of assembledFrame.nals) {
        avccBytes[offset] = (nal.length >> 24) & 0xff;
        avccBytes[offset + 1] = (nal.length >> 16) & 0xff;
        avccBytes[offset + 2] = (nal.length >> 8) & 0xff;
        avccBytes[offset + 3] = nal.length & 0xff;
        avccBytes.set(nal, offset + 4);
        offset += 4 + nal.length;
      }

      const chunk = new EncodedVideoChunk({
        type: assembledFrame.isKeyframe ? 'key' : 'delta',
        timestamp: assembledFrame.ptsUs,
        data: avccBytes,
      });

      peer.videoDecoder.decodeChunk(chunk);
    }
  }

  private handleRemoteAudioPacket(peer: RemotePeerState, packet: Uint8Array): void {
    if (!peer.audioDemuxer || !peer.audioDecoder) return;

    const assembled: AssembledOpusPacket | null = peer.audioDemuxer.pushPacket(packet);
    if (assembled) {
      peer.metrics.audioPacketsReceived++;

      const chunk = new EncodedAudioChunk({
        type: 'key',
        timestamp: assembled.ptsUs,
        data: assembled.payload,
      });

      peer.audioDecoder.decode(chunk);
    }
  }

  // =========================================================================
  // Outbound Media Encoding & Mesh Broadcasting
  // =========================================================================

  private packetizeAndBroadcastVideoChunk(chunkData: Uint8Array, timestampUs: number): void {
    const view = new DataView(chunkData.buffer, chunkData.byteOffset, chunkData.byteLength);
    let offset = 0;
    const nals: Uint8Array[] = [];

    while (offset + 4 <= chunkData.byteLength) {
      const nalLen = view.getUint32(offset, false);
      offset += 4;
      if (offset + nalLen > chunkData.byteLength) break;
      nals.push(chunkData.subarray(offset, offset + nalLen));
      offset += nalLen;
    }

    for (let i = 0; i < nals.length; i++) {
      const nal = nals[i];
      const isLastNal = i === nals.length - 1;
      this.packetizeAndBroadcastNal(nal, timestampUs, isLastNal);
    }
  }

  private packetizeAndBroadcastNal(nal: Uint8Array, timestampUs: number, isLastNal: boolean): void {
    if (nal.length === 0) return;

    const maxPayload = this.mtu - 12;

    if (nal.length <= maxPayload) {
      const packet = new Uint8Array(12 + nal.length);
      this.writeRtpHeader(packet, isLastNal, timestampUs);
      packet.set(nal, 12);
      this.broadcastVideoPacket(packet);
    } else {
      const nalHeader = nal[0];
      const nri = nalHeader & 0x60;
      const nalType = nalHeader & 0x1f;
      const fuIndicator = nri | 28;

      const rawData = nal.subarray(1);
      const chunkSize = maxPayload - 2;
      let off = 0;

      while (off < rawData.length) {
        const end = Math.min(off + chunkSize, rawData.length);
        const isFirst = off === 0;
        const isLast = end === rawData.length;

        let fuHeader = nalType;
        if (isFirst) fuHeader |= 0x80;
        if (isLast) fuHeader |= 0x40;

        const marker = isLast && isLastNal;
        const packet = new Uint8Array(12 + 2 + (end - off));
        this.writeRtpHeader(packet, marker, timestampUs);
        packet[12] = fuIndicator;
        packet[13] = fuHeader;
        packet.set(rawData.subarray(off, end), 14);

        this.broadcastVideoPacket(packet);
        off = end;
      }
    }
  }

  private extractAndBroadcastSpsPps(avcC: Uint8Array, timestampUs: number): void {
    if (avcC.length < 8) return;

    let offset = 5;
    const numSps = avcC[offset] & 0x1f;
    offset += 1;

    for (let i = 0; i < numSps; i++) {
      if (offset + 2 > avcC.length) break;
      const spsLen = (avcC[offset] << 8) | avcC[offset + 1];
      offset += 2;
      if (offset + spsLen > avcC.length) break;
      const sps = avcC.subarray(offset, offset + spsLen);
      offset += spsLen;

      const packet = new Uint8Array(12 + sps.length);
      this.writeRtpHeader(packet, false, timestampUs);
      packet.set(sps, 12);
      this.broadcastVideoPacket(packet);
    }

    if (offset < avcC.length) {
      const numPps = avcC[offset];
      offset += 1;
      for (let i = 0; i < numPps; i++) {
        if (offset + 2 > avcC.length) break;
        const ppsLen = (avcC[offset] << 8) | avcC[offset + 1];
        offset += 2;
        if (offset + ppsLen > avcC.length) break;
        const pps = avcC.subarray(offset, offset + ppsLen);
        offset += ppsLen;

        const packet = new Uint8Array(12 + pps.length);
        this.writeRtpHeader(packet, false, timestampUs);
        packet.set(pps, 12);
        this.broadcastVideoPacket(packet);
      }
    }
  }

  private writeRtpHeader(out: Uint8Array, marker: boolean, timestampUs: number): void {
    const ts90k = Math.floor((timestampUs * 90) / 1000) >>> 0;

    out[0] = 0x80;
    out[1] = (marker ? 0x80 : 0x00) | 96;
    out[2] = (this.rtpSeq >> 8) & 0xff;
    out[3] = this.rtpSeq & 0xff;
    out[4] = (ts90k >> 24) & 0xff;
    out[5] = (ts90k >> 16) & 0xff;
    out[6] = (ts90k >> 8) & 0xff;
    out[7] = ts90k & 0xff;
    out[8] = (this.rtpSsrc >> 24) & 0xff;
    out[9] = (this.rtpSsrc >> 16) & 0xff;
    out[10] = (this.rtpSsrc >> 8) & 0xff;
    out[11] = this.rtpSsrc & 0xff;

    this.rtpSeq = (this.rtpSeq + 1) & 0xffff;
    this.metrics.totalVideoPacketsSent++;
  }

  private broadcastVideoPacket(packet: Uint8Array): void {
    for (const peer of this.remotePeers.values()) {
      if (peer.videoChannel && peer.videoChannel.readyState === 'open') {
        try {
          peer.videoChannel.send(packet as any);
        } catch (err) {
          console.warn(`[MultiPeerMeshSession] Broadcast video to ${peer.peerId} error:`, err);
        }
      }
    }
  }

  private broadcastAudioPacket(packet: Uint8Array): void {
    this.metrics.totalAudioPacketsSent++;
    for (const peer of this.remotePeers.values()) {
      if (peer.audioChannel && peer.audioChannel.readyState === 'open') {
        try {
          peer.audioChannel.send(packet as any);
        } catch (err) {
          console.warn(`[MultiPeerMeshSession] Broadcast audio to ${peer.peerId} error:`, err);
        }
      }
    }
  }

  // =========================================================================
  // Synthetic & MediaStream Ingest Sources
  // =========================================================================

  private startVideoTrackProcessor(track: MediaStreamTrack): void {
    const processor = new (window as any).MediaStreamTrackProcessor({ track });
    const reader = processor.readable.getReader();

    const readLoop = async () => {
      while (this.isRunning) {
        const { done, value } = await reader.read();
        if (done || !value) break;

        const frame: VideoFrame = value;
        const keyFrame = this.forceNextKeyframe;
        this.forceNextKeyframe = false;

        this.videoEncoder?.encode(frame, { keyFrame });

        // If compositor available, push local preview (using cloned frame)
        if (this.options.compositor) {
          try {
            const previewClone = frame.clone();
            this.options.compositor.pushFrame(this.peerId, previewClone);
          } catch {
            // ignore
          }
        }

        frame.close();
      }
    };

    readLoop().catch((err) => this.options.onError?.(err));
  }

  private startAudioTrackProcessor(track: MediaStreamTrack): void {
    const processor = new (window as any).MediaStreamTrackProcessor({ track });
    const reader = processor.readable.getReader();

    const readLoop = async () => {
      while (this.isRunning && this.audioEncoder) {
        const { done, value } = await reader.read();
        if (done || !value) break;

        const audioData: AudioData = value;
        this.audioEncoder.encode(audioData);
        audioData.close();
      }
    };

    readLoop().catch((err) => this.options.onError?.(err));
  }

  private startSyntheticVideoSource(width: number, height: number, framerate: number): void {
    this.captureCanvas = document.createElement('canvas');
    this.captureCanvas.width = width;
    this.captureCanvas.height = height;
    this.captureCtx = this.captureCanvas.getContext('2d')!;

    let frameIndex = 0;
    const intervalMs = 1000 / framerate;

    this.animTimerId = setInterval(() => {
      if (!this.isRunning || !this.captureCtx || !this.captureCanvas) return;

      const ptsUs = Math.round(frameIndex * (1_000_000 / framerate));
      const ctx = this.captureCtx;
      const w = width;
      const h = height;

      ctx.fillStyle = this.role === 'host' ? '#0f172a' : '#1e1b4b';
      ctx.fillRect(0, 0, w, h);

      // Scanning radar line
      const barX = (frameIndex * 8) % w;
      ctx.fillStyle = this.role === 'host' ? '#38bdf8' : '#a855f7';
      ctx.fillRect(barX, 0, 16, h);

      // Center geometric pulse
      const angle = (frameIndex * 0.1) % (Math.PI * 2);
      ctx.strokeStyle = this.role === 'host' ? '#34d399' : '#ec4899';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 45, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(w / 2, h / 2);
      ctx.lineTo(w / 2 + Math.cos(angle) * 45, h / 2 + Math.sin(angle) * 45);
      ctx.stroke();

      // Text status overlay
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 16px monospace';
      ctx.fillText(`Mesh [${this.role.toUpperCase()}] ID: ${this.peerId}`, 20, 35);
      ctx.fillText(`Room: ${this.roomId} | Active Peers: ${this.remotePeers.size}`, 20, 60);
      ctx.fillText(`Sent: V=${this.metrics.totalVideoPacketsSent} A=${this.metrics.totalAudioPacketsSent} | PLI: ${this.metrics.targetedPliSent}`, 20, 85);

      const frame = new VideoFrame(this.captureCanvas, {
        timestamp: ptsUs,
      });

      const keyFrame = this.forceNextKeyframe || (frameIndex % 60 === 0);
      this.forceNextKeyframe = false;

      this.videoEncoder?.encode(frame, { keyFrame });

      // Local compositor preview
      if (this.options.compositor) {
        try {
          const previewFrame = new VideoFrame(this.captureCanvas, { timestamp: ptsUs });
          this.options.compositor.pushFrame(this.peerId, previewFrame);
        } catch {
          // ignore
        }
      }

      frame.close();
      frameIndex++;
    }, intervalMs);
  }

  private startSyntheticAudioSource(): void {
    let audioSampleIndex = 0;
    let audioPtsUs = 0;
    const samplesPerFrame = 960; // 20ms @ 48kHz
    const intervalMs = 20;
    // Host tone = 440Hz (A4), Guest tone = 554.37Hz (C#5)
    const baseFreq = this.role === 'host' ? 440 : 554.37;

    this.audioTimerId = setInterval(() => {
      if (!this.isRunning || !this.audioEncoder) return;

      const pcmData = new Float32Array(samplesPerFrame * 2);
      for (let i = 0; i < samplesPerFrame; i++) {
        const t = (audioSampleIndex + i) / 48000;
        const sample = Math.sin(2 * Math.PI * baseFreq * t) * 0.2;
        pcmData[i * 2] = sample;
        pcmData[i * 2 + 1] = sample;
      }

      const audioData = new AudioData({
        format: 'f32',
        sampleRate: 48000,
        numberOfFrames: samplesPerFrame,
        numberOfChannels: 2,
        timestamp: audioPtsUs,
        data: pcmData,
      });

      this.audioEncoder.encode(audioData);
      audioData.close();

      audioSampleIndex += samplesPerFrame;
      audioPtsUs += 20000;
    }, intervalMs);
  }

  // =========================================================================
  // Teardown & Zero Leak Resource Management
  // =========================================================================

  private teardownRemotePeer(remotePeerId: string): void {
    const peer = this.remotePeers.get(remotePeerId);
    if (!peer) return;

    if (peer.videoChannel) {
      peer.videoChannel.close();
      peer.videoChannel = null;
    }
    if (peer.audioChannel) {
      peer.audioChannel.close();
      peer.audioChannel = null;
    }

    if (peer.pc) {
      peer.pc.close();
    }

    if (peer.videoDecoder) {
      peer.videoDecoder.close();
      peer.videoDecoder = null;
    }
    if (peer.audioDecoder) {
      peer.audioDecoder.close();
      peer.audioDecoder = null;
    }

    peer.videoDemuxer = null;
    peer.audioDemuxer = null;

    // Zero VRAM Leak: Remove channel from compositor and mixer
    this.options.compositor?.removeChannel(remotePeerId);
    this.options.audioMixer?.removeTrack(remotePeerId);

    this.remotePeers.delete(remotePeerId);
    this.options.onPeerLeave?.(remotePeerId);
  }

  private startTelemetryLoop(): void {
    this.telemetryTimerId = setInterval(() => {
      if (!this.isRunning) return;

      const now = performance.now();
      const elapsedSec = (now - this.lastStatsTime) / 1000;

      if (elapsedSec >= 0.5) {
        this.metrics.ingestFps = Math.round(this.encodedFramesCount / elapsedSec);
        this.metrics.bitrateKbps = Math.round((this.encodedBytesWindow * 8) / elapsedSec / 1000);
        this.encodedFramesCount = 0;
        this.encodedBytesWindow = 0;
        this.lastStatsTime = now;

        // Update remote peers playout metrics
        for (const peer of this.remotePeers.values()) {
          const peerElapsed = (now - peer.lastStatsTime) / 1000;
          if (peerElapsed >= 0.5) {
            peer.metrics.playoutFps = Math.round(peer.decodedFramesCount / peerElapsed);
            peer.decodedFramesCount = 0;
            peer.lastStatsTime = now;
            this.options.onPeerMetrics?.(peer.peerId, { ...peer.metrics });
          }
        }

        this.options.onMetrics?.(this.getMetrics());
      }
    }, 500);
  }
}
