/**
 * WebRTC DataChannel P2P Live Streaming Engine (RFC 0002).
 * 
 * Provides:
 * - LiveP2PSender: Broadcaster (Captures -> WebCodecs realtime encode -> RFC 6184 RTP -> RTCDataChannel -> Reverse PLI listener)
 * - LiveP2PReceiver: Viewer (RTCDataChannel -> RtpStreamDemuxer -> FAIL-09 defense -> WebCodecs decode -> WebGPU/Canvas render -> Reverse PLI trigger)
 */

import { HardwareVideoEncoder } from '../encoder/hardware-encoder';
import { HardwareVideoDecoder } from '../decoder/hardware-decoder';
import { RtpStreamDemuxer, type AssembledRtpFrame } from './rtp-demuxer';
import type { SignalingChannel, SignalingMessage } from './p2p-signaling';

export interface P2PSenderOptions {
  roomId: string;
  signaling: SignalingChannel;
  peerId?: string;
  rtcConfiguration?: RTCConfiguration;
  width?: number;
  height?: number;
  framerate?: number;
  bitrate?: number;
  onStateChange?: (state: RTCPeerConnectionState) => void;
  onMetrics?: (metrics: P2PSenderMetrics) => void;
  onError?: (err: Error) => void;
}

export interface P2PSenderMetrics {
  connectionState: RTCPeerConnectionState;
  dataChannelState: RTCDataChannelState | 'closed';
  ingestFps: number;
  bitrateKbps: number;
  rtpPacketsSent: number;
  keyframeRequests: number;
  isRunning: boolean;
}

export interface P2PReceiverOptions {
  roomId: string;
  signaling: SignalingChannel;
  peerId?: string;
  rtcConfiguration?: RTCConfiguration;
  renderCanvas?: HTMLCanvasElement;
  onStateChange?: (state: RTCPeerConnectionState) => void;
  onMetrics?: (metrics: P2PReceiverMetrics) => void;
  onError?: (err: Error) => void;
}

export interface P2PReceiverMetrics {
  connectionState: RTCPeerConnectionState;
  dataChannelState: RTCDataChannelState | 'closed';
  playoutFps: number;
  rtpPacketsReceived: number;
  packetsDropped: number;
  fail09Rescues: number;
  glassToGlassLatencyMs: number;
  isRunning: boolean;
}

const DEFAULT_RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

/**
 * LiveP2PSender:
 * Broadcasts video live stream to remote peers over WebRTC DataChannel.
 */
export class LiveP2PSender {
  private options: P2PSenderOptions;
  public peerId: string;
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private encoder: HardwareVideoEncoder | null = null;
  private isRunning: boolean = false;
  private animTimerId: any = null;
  private captureCanvas: HTMLCanvasElement | null = null;
  private captureCtx: CanvasRenderingContext2D | null = null;

  // RTP & Codec state
  private rtpSeq: number = 1;
  private rtpSsrc: number = 0x2468ace0;
  private mtu: number = 1200; // conservative MTU for SCTP/DataChannel
  private forceNextKeyframe: boolean = true;
  private cachedEncoderDescription: Uint8Array | null = null;

  // Telemetry
  private metrics: P2PSenderMetrics = {
    connectionState: 'new',
    dataChannelState: 'closed',
    ingestFps: 0,
    bitrateKbps: 0,
    rtpPacketsSent: 0,
    keyframeRequests: 0,
    isRunning: false,
  };
  private encodedFramesCount: number = 0;
  private encodedBytesWindow: number = 0;
  private lastStatsTime: number = 0;

  constructor(options: P2PSenderOptions) {
    this.options = options;
    this.peerId = options.peerId || `sender-${Math.random().toString(36).substring(2, 9)}`;
  }

  public getMetrics(): P2PSenderMetrics {
    return { ...this.metrics };
  }

  public async start(mediaTrack?: MediaStreamTrack): Promise<void> {
    if (this.isRunning) {
      throw new Error('LiveP2PSender is already running');
    }

    const width = this.options.width || 640;
    const height = this.options.height || 360;
    const framerate = this.options.framerate || 30;
    const bitrate = this.options.bitrate || 1_500_000;

    this.isRunning = true;
    this.metrics.isRunning = true;
    this.lastStatsTime = performance.now();
    this.forceNextKeyframe = true;

    // 1. Connect signaling and listen for peer messages
    await this.options.signaling.connect();
    this.options.signaling.onMessage(async (msg: SignalingMessage) => {
      if (msg.roomId !== this.options.roomId || msg.senderId === this.peerId) return;

      try {
        if (msg.type === 'join') {
          // A viewer joined! Initiate WebRTC Offer
          await this.initiatePeerConnection();
        } else if (msg.type === 'answer' && this.pc) {
          if (msg.sdp) {
            await this.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          }
        } else if (msg.type === 'candidate' && this.pc) {
          if (msg.candidate) {
            await this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          }
        } else if (msg.type === 'pli') {
          // Received reverse PLI feedback from viewer
          this.requestKeyframe();
        }
      } catch (err: any) {
        this.options.onError?.(err);
      }
    });

    // 2. Initialize Hardware VideoEncoder
    this.encoder = new HardwareVideoEncoder((chunk, metadata) => {
      this.encodedFramesCount++;
      this.encodedBytesWindow += chunk.byteLength;

      // Ingest parameter sets
      if (metadata?.decoderConfig?.description) {
        const desc = new Uint8Array(metadata.decoderConfig.description as ArrayBuffer);
        this.cachedEncoderDescription = desc;
        this.extractAndSendSpsPps(desc, chunk.timestamp);
      } else if (chunk.type === 'key' && this.cachedEncoderDescription) {
        // Resend parameter sets on keyframes
        this.extractAndSendSpsPps(this.cachedEncoderDescription, chunk.timestamp);
      }

      // Packetize into RFC 6184 RTP
      const chunkBytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(chunkBytes);
      this.packetizeAndTransmitChunk(chunkBytes, chunk.timestamp);
    }, (err) => {
      this.options.onError?.(err);
    });

    await this.encoder.configure({
      codec: 'avc1.42001f',
      width,
      height,
      bitrate,
      framerate,
      latencyMode: 'realtime',
    });

    // 3. Start Video Source (MediaTrack or Synthetic Animation)
    if (mediaTrack && typeof (window as any).MediaStreamTrackProcessor !== 'undefined') {
      this.startTrackProcessor(mediaTrack);
    } else {
      this.startSyntheticSource(width, height, framerate);
    }

    // 4. Start periodic telemetry
    this.startTelemetryLoop();

    // 5. Announce presence to any waiting receivers in the room
    await this.options.signaling.sendMessage({
      type: 'join',
      roomId: this.options.roomId,
      senderId: this.peerId,
    });
  }

  public requestKeyframe(): void {
    this.forceNextKeyframe = true;
    this.metrics.keyframeRequests++;
  }

  public stop(): void {
    this.isRunning = false;
    this.metrics.isRunning = false;

    if (this.animTimerId) {
      clearInterval(this.animTimerId);
      this.animTimerId = null;
    }

    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }

    if (this.encoder) {
      this.encoder.close();
      this.encoder = null;
    }

    this.captureCanvas = null;
    this.captureCtx = null;
    this.options.signaling.disconnect();
  }

  private async initiatePeerConnection(): Promise<void> {
    if (this.pc) {
      this.pc.close();
    }

    const config = this.options.rtcConfiguration || DEFAULT_RTC_CONFIG;
    this.pc = new RTCPeerConnection(config);

    this.pc.onconnectionstatechange = () => {
      if (this.pc) {
        this.metrics.connectionState = this.pc.connectionState;
        this.options.onStateChange?.(this.pc.connectionState);
      }
    };

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.options.signaling.sendMessage({
          type: 'candidate',
          roomId: this.options.roomId,
          senderId: this.peerId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    // Create low-latency unreliable/unordered RTCDataChannel for RTP stream
    this.dataChannel = this.pc.createDataChannel('video-stream', {
      ordered: false,
      maxRetransmits: 0,
    });
    this.dataChannel.binaryType = 'arraybuffer';

    this.dataChannel.onopen = () => {
      if (this.dataChannel) {
        this.metrics.dataChannelState = this.dataChannel.readyState;
      }
      // Trigger an immediate keyframe when the channel opens so viewer gets instant picture
      this.requestKeyframe();
    };

    this.dataChannel.onclose = () => {
      this.metrics.dataChannelState = 'closed';
    };

    this.dataChannel.onmessage = (event) => {
      // Reverse feedback from viewer: PLI / latency telemetry
      try {
        if (typeof event.data === 'string') {
          const data = JSON.parse(event.data);
          if (data.type === 'pli') {
            this.requestKeyframe();
          }
        }
      } catch {
        // non-json message
      }
    };

    // Create and send SDP Offer
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    await this.options.signaling.sendMessage({
      type: 'offer',
      roomId: this.options.roomId,
      senderId: this.peerId,
      sdp: offer,
    });
  }

  private startTrackProcessor(track: MediaStreamTrack): void {
    const processor = new (window as any).MediaStreamTrackProcessor({ track });
    const reader = processor.readable.getReader();

    const readLoop = async () => {
      while (this.isRunning) {
        const { done, value } = await reader.read();
        if (done || !value) break;

        const frame: VideoFrame = value;
        const keyFrame = this.forceNextKeyframe;
        this.forceNextKeyframe = false;

        this.encoder?.encode(frame, { keyFrame });
        frame.close(); // Zero VRAM leak
      }
    };

    readLoop().catch((err) => this.options.onError?.(err));
  }

  private startSyntheticSource(width: number, height: number, framerate: number): void {
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

      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, w, h);

      // Moving scanning bar
      const barX = (frameIndex * 8) % w;
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(barX, 0, 16, h);

      // Rotating radar circle
      const angle = (frameIndex * 0.1) % (Math.PI * 2);
      ctx.strokeStyle = '#34d399';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 50, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(w / 2, h / 2);
      ctx.lineTo(w / 2 + Math.cos(angle) * 50, h / 2 + Math.sin(angle) * 50);
      ctx.stroke();

      // Text overlay
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 18px monospace';
      ctx.fillText(`WebRTC P2P Sender | Frame: ${frameIndex}`, 20, 40);
      ctx.fillText(`Room: ${this.options.roomId} | Sent: ${this.metrics.rtpPacketsSent}`, 20, 70);

      const frame = new VideoFrame(this.captureCanvas, {
        timestamp: ptsUs,
      });

      const keyFrame = this.forceNextKeyframe || (frameIndex % 60 === 0);
      this.forceNextKeyframe = false;

      this.encoder?.encode(frame, { keyFrame });
      frame.close(); // Zero VRAM leak

      frameIndex++;
    }, intervalMs);
  }

  private extractAndSendSpsPps(avcC: Uint8Array, timestampUs: number): void {
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
      this.transmitSingleRtpPacket(sps, timestampUs, false);
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
        this.transmitSingleRtpPacket(pps, timestampUs, false);
      }
    }
  }

  private packetizeAndTransmitChunk(chunkData: Uint8Array, timestampUs: number): void {
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
      this.packetizeNal(nal, timestampUs, isLastNal);
    }
  }

  private packetizeNal(nal: Uint8Array, timestampUs: number, isLastNalOfFrame: boolean): void {
    if (nal.length === 0) return;

    const maxPayload = this.mtu - 12;

    if (nal.length <= maxPayload) {
      this.transmitSingleRtpPacket(nal, timestampUs, isLastNalOfFrame);
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

        const marker = isLast && isLastNalOfFrame;
        const packet = new Uint8Array(12 + 2 + (end - off));
        this.writeRtpHeader(packet, marker, timestampUs);
        packet[12] = fuIndicator;
        packet[13] = fuHeader;
        packet.set(rawData.subarray(off, end), 14);

        this.sendPacket(packet);
        off = end;
      }
    }
  }

  private transmitSingleRtpPacket(nal: Uint8Array, timestampUs: number, marker: boolean): void {
    const packet = new Uint8Array(12 + nal.length);
    this.writeRtpHeader(packet, marker, timestampUs);
    packet.set(nal, 12);
    this.sendPacket(packet);
  }

  private writeRtpHeader(out: Uint8Array, marker: boolean, timestampUs: number): void {
    const ts90k = Math.floor((timestampUs * 90) / 1000) >>> 0;

    out[0] = 0x80; // V=2
    out[1] = (marker ? 0x80 : 0x00) | 96; // PT=96
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
    this.metrics.rtpPacketsSent++;
  }

  private sendPacket(packet: Uint8Array): void {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      try {
        this.dataChannel.send(packet as any);
      } catch (err) {
        console.warn('[LiveP2PSender] DataChannel buffer full or send error:', err);
      }
    }
  }

  private startTelemetryLoop(): void {
    const statsTimer = setInterval(() => {
      if (!this.isRunning) {
        clearInterval(statsTimer);
        return;
      }

      const now = performance.now();
      const elapsedSec = (now - this.lastStatsTime) / 1000;

      if (elapsedSec >= 0.5) {
        this.metrics.ingestFps = Math.round(this.encodedFramesCount / elapsedSec);
        this.metrics.bitrateKbps = Math.round((this.encodedBytesWindow * 8) / elapsedSec / 1000);

        this.encodedFramesCount = 0;
        this.encodedBytesWindow = 0;
        this.lastStatsTime = now;

        this.options.onMetrics?.(this.getMetrics());
      }
    }, 500);
  }
}

/**
 * LiveP2PReceiver:
 * Receives WebRTC DataChannel RTP stream, demuxes with FAIL-09 defense, decodes via WebCodecs, and renders.
 */
export class LiveP2PReceiver {
  private options: P2PReceiverOptions;
  public peerId: string;
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private decoder: HardwareVideoDecoder | null = null;
  private demuxer: RtpStreamDemuxer | null = null;
  private isRunning: boolean = false;

  // Keyframe & recovery state
  private hasReceivedFirstKeyframe: boolean = false;
  private waitingForPliRecoveryKeyframe: boolean = false;
  private decoderConfiguredWithDescription: boolean = false;

  // Latency & metrics
  private decodedFramesCount: number = 0;
  private lastStatsTime: number = 0;
  private metrics: P2PReceiverMetrics = {
    connectionState: 'new',
    dataChannelState: 'closed',
    playoutFps: 0,
    rtpPacketsReceived: 0,
    packetsDropped: 0,
    fail09Rescues: 0,
    glassToGlassLatencyMs: 0,
    isRunning: false,
  };

  constructor(options: P2PReceiverOptions) {
    this.options = options;
    this.peerId = options.peerId || `receiver-${Math.random().toString(36).substring(2, 9)}`;
  }

  public getMetrics(): P2PReceiverMetrics {
    return { ...this.metrics };
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('LiveP2PReceiver is already running');
    }

    this.isRunning = true;
    this.metrics.isRunning = true;
    this.lastStatsTime = performance.now();

    // 1. Initialize RTP Demuxer with FAIL-09/FAIL-10 defense
    this.demuxer = new RtpStreamDemuxer({ isHevc: false, clockRate: 90000 });

    // 2. Initialize Hardware VideoDecoder
    this.decoder = new HardwareVideoDecoder((frame, _meta) => {
      this.decodedFramesCount++;

      // Render to target canvas
      if (this.options.renderCanvas) {
        const renderCtx = this.options.renderCanvas.getContext('2d');
        if (renderCtx) {
          renderCtx.drawImage(frame, 0, 0, this.options.renderCanvas.width, this.options.renderCanvas.height);
        }
      }

      // Zero VRAM leak: synchronously close frame
      frame.close();
    }, (err) => {
      this.options.onError?.(err);
    });

    await this.decoder.configure({
      codec: 'avc1.42001f',
      hardwareAcceleration: 'prefer-hardware',
    });

    // 3. Connect signaling and register offer/candidate listeners
    await this.options.signaling.connect();
    this.options.signaling.onMessage(async (msg: SignalingMessage) => {
      if (msg.roomId !== this.options.roomId || msg.senderId === this.peerId) return;

      try {
        if (msg.type === 'offer') {
          if (msg.sdp) {
            await this.handleRemoteOffer(msg.sdp, msg.senderId);
          }
        } else if (msg.type === 'candidate' && this.pc) {
          if (msg.candidate) {
            await this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          }
        }
      } catch (err: any) {
        this.options.onError?.(err);
      }
    });

    // 4. Start periodic telemetry
    this.startTelemetryLoop();

    // 5. Send join message to trigger sender to produce an offer
    await this.options.signaling.sendMessage({
      type: 'join',
      roomId: this.options.roomId,
      senderId: this.peerId,
    });
  }

  public requestKeyframe(): void {
    // Send reverse feedback: PLI over DataChannel (fastest) and signaling (fallback)
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      try {
        this.dataChannel.send(JSON.stringify({ type: 'pli' }));
      } catch {
        // ignore
      }
    }
    this.options.signaling.sendMessage({
      type: 'pli',
      roomId: this.options.roomId,
      senderId: this.peerId,
    }).catch(() => {});
  }

  public stop(): void {
    this.isRunning = false;
    this.metrics.isRunning = false;

    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }

    if (this.decoder) {
      this.decoder.close();
      this.decoder = null;
    }

    this.demuxer = null;
    this.decoderConfiguredWithDescription = false;
    this.hasReceivedFirstKeyframe = false;
    this.waitingForPliRecoveryKeyframe = false;
    this.options.signaling.disconnect();
  }

  private async handleRemoteOffer(offer: RTCSessionDescriptionInit, remoteSenderId: string): Promise<void> {
    if (this.pc) {
      this.pc.close();
    }

    const config = this.options.rtcConfiguration || DEFAULT_RTC_CONFIG;
    this.pc = new RTCPeerConnection(config);

    this.pc.onconnectionstatechange = () => {
      if (this.pc) {
        this.metrics.connectionState = this.pc.connectionState;
        this.options.onStateChange?.(this.pc.connectionState);
      }
    };

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.options.signaling.sendMessage({
          type: 'candidate',
          roomId: this.options.roomId,
          senderId: this.peerId,
          targetId: remoteSenderId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    this.pc.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this.dataChannel.binaryType = 'arraybuffer';

      this.dataChannel.onopen = () => {
        if (this.dataChannel) {
          this.metrics.dataChannelState = this.dataChannel.readyState;
        }
        // Send immediate PLI on open to ensure keyframe is dispatched
        this.requestKeyframe();
      };

      this.dataChannel.onclose = () => {
        this.metrics.dataChannelState = 'closed';
      };

      this.dataChannel.onmessage = (msgEvent) => {
        if (msgEvent.data instanceof ArrayBuffer) {
          const packet = new Uint8Array(msgEvent.data);
          this.handleRtpPacket(packet);
        }
      };
    };

    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    await this.options.signaling.sendMessage({
      type: 'answer',
      roomId: this.options.roomId,
      senderId: this.peerId,
      targetId: remoteSenderId,
      sdp: answer,
    });
  }

  private handleRtpPacket(packet: Uint8Array): void {
    if (!this.demuxer || !this.decoder) return;

    this.metrics.rtpPacketsReceived++;

    const prevFragmentLossEvents = this.demuxer.getStats().fragmentLossEvents;
    const prevPacketsDropped = this.demuxer.getStats().packetsDropped;
    const assembledFrame: AssembledRtpFrame | null = this.demuxer.pushPacket(packet);
    const newFragmentLossEvents = this.demuxer.getStats().fragmentLossEvents;
    const newPacketsDropped = this.demuxer.getStats().packetsDropped;

    // FAIL-09 Self-Healing Check
    if (newFragmentLossEvents > prevFragmentLossEvents || newPacketsDropped > prevPacketsDropped) {
      this.metrics.fail09Rescues++;
      this.metrics.packetsDropped += (newPacketsDropped - prevPacketsDropped);
      this.waitingForPliRecoveryKeyframe = true;
      this.requestKeyframe();
    }

    if (assembledFrame) {
      // Reconfigure decoder with AVCDecoderConfigurationRecord description as soon as SPS/PPS arrives
      if (!this.decoderConfiguredWithDescription) {
        const desc = this.demuxer.getAvcDescription();
        if (desc) {
          this.decoder.configure({
            codec: 'avc1.42001f',
            description: desc,
            hardwareAcceleration: 'prefer-hardware',
          });
          this.decoderConfiguredWithDescription = true;
        }
      }

      // FAIL-01 & FAIL-09 Defense: Never feed orphaned delta frames or keyframes without parameter sets to decoder
      if (assembledFrame.isKeyframe) {
        if (!this.decoderConfiguredWithDescription) {
          this.requestKeyframe();
          return;
        }
        this.hasReceivedFirstKeyframe = true;
        this.waitingForPliRecoveryKeyframe = false;
      } else if (!this.hasReceivedFirstKeyframe || this.waitingForPliRecoveryKeyframe) {
        return;
      }

      // Reconstruct AVCC format
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

      this.decoder.decodeChunk(chunk);
    }
  }

  private startTelemetryLoop(): void {
    const statsTimer = setInterval(() => {
      if (!this.isRunning) {
        clearInterval(statsTimer);
        return;
      }

      const now = performance.now();
      const elapsedSec = (now - this.lastStatsTime) / 1000;

      if (elapsedSec >= 0.5) {
        this.metrics.playoutFps = Math.round(this.decodedFramesCount / elapsedSec);
        this.decodedFramesCount = 0;
        this.lastStatsTime = now;

        this.options.onMetrics?.(this.getMetrics());
      }
    }, 500);
  }
}
