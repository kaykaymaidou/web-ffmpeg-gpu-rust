/**
 * WebRTC P2P Signaling Layer (RFC 0002).
 * 
 * Provides:
 * - Common SignalingMessage protocol for SDP Offer/Answer and ICE candidates.
 * - BroadcastChannelSignaling: Zero-server, cross-tab, zero-latency signaling within the same origin.
 * - WebSocketSignaling: Pluggable remote signaling adapter for WAN / multi-host deployments.
 */

export interface SignalingMessage {
  type: 'join' | 'leave' | 'offer' | 'answer' | 'candidate' | 'pli' | 'ping' | 'pong';
  roomId: string;
  senderId: string;
  targetId?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  payload?: any;
  timestamp?: number;
}

export interface SignalingChannel {
  connect(): Promise<void>;
  disconnect(): void;
  sendMessage(message: SignalingMessage): Promise<void>;
  onMessage(callback: (msg: SignalingMessage) => void): void;
}

/**
 * BroadcastChannelSignaling:
 * Uses browser-native BroadcastChannel API to exchange WebRTC signaling messages
 * across different browser tabs, windows, or iframes with zero server overhead.
 */
export class BroadcastChannelSignaling implements SignalingChannel {
  private channel: BroadcastChannel | null = null;
  private channelName: string;
  private messageListeners: Array<(msg: SignalingMessage) => void> = [];

  constructor(roomId: string) {
    this.channelName = `web-ffmpeg-gpu-p2p-${roomId}`;
  }

  public async connect(): Promise<void> {
    if (typeof BroadcastChannel === 'undefined') {
      throw new Error('BroadcastChannel API is not supported in this browser environment');
    }

    if (!this.channel) {
      this.channel = new BroadcastChannel(this.channelName);
      this.channel.onmessage = (event: MessageEvent) => {
        const msg: SignalingMessage = event.data;
        if (msg && msg.type) {
          for (const listener of this.messageListeners) {
            try {
              listener(msg);
            } catch (err) {
              console.error('[BroadcastChannelSignaling] Listener error:', err);
            }
          }
        }
      };
    }
  }

  public disconnect(): void {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    this.messageListeners = [];
  }

  public async sendMessage(message: SignalingMessage): Promise<void> {
    if (!this.channel) {
      throw new Error('BroadcastChannel is not connected. Call connect() first.');
    }
    message.timestamp = performance.now();
    this.channel.postMessage(message);
  }

  public onMessage(callback: (msg: SignalingMessage) => void): void {
    this.messageListeners.push(callback);
  }
}

/**
 * WebSocketSignaling:
 * Remote WebSocket signaling client for wide-area network P2P negotiation.
 */
export class WebSocketSignaling implements SignalingChannel {
  private ws: WebSocket | null = null;
  private url: string;
  private roomId: string;
  private senderId: string;
  private messageListeners: Array<(msg: SignalingMessage) => void> = [];

  constructor(url: string, roomId: string, senderId: string) {
    this.url = url;
    this.roomId = roomId;
    this.senderId = senderId;
  }

  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
        this.ws.onopen = () => {
          this.sendMessage({
            type: 'join',
            roomId: this.roomId,
            senderId: this.senderId,
          });
          resolve();
        };
        this.ws.onerror = (e) => reject(new Error(`WebSocket connection failed: ${e}`));
        this.ws.onmessage = (event) => {
          try {
            const msg: SignalingMessage = JSON.parse(event.data);
            for (const listener of this.messageListeners) {
              listener(msg);
            }
          } catch (err) {
            console.error('[WebSocketSignaling] Failed to parse message:', err);
          }
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  public disconnect(): void {
    if (this.ws) {
      try {
        this.sendMessage({
          type: 'leave',
          roomId: this.roomId,
          senderId: this.senderId,
        });
      } catch {
        // ignore
      }
      this.ws.close();
      this.ws = null;
    }
    this.messageListeners = [];
  }

  public async sendMessage(message: SignalingMessage): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    message.timestamp = performance.now();
    this.ws.send(JSON.stringify(message));
  }

  public onMessage(callback: (msg: SignalingMessage) => void): void {
    this.messageListeners.push(callback);
  }
}
