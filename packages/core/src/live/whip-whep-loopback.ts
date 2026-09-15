/**
 * In-process WHIP/WHEP loopback gateway for playground demos and e2e tests.
 * Acts as a same-realm SFU: WHIP ingest PC receives RTP, WHEP egress PC forwards those tracks.
 */

import { parseTrickleIceSdpfrag, waitForIceGatheringComplete } from './wish-sdp';
import { createSyntheticMediaStream, type SyntheticMediaHandle } from './synthetic-media';

const LOOPBACK_ORIGIN = 'http://whip.loopback.local';

interface LoopbackPeerSession {
  id: string;
  kind: 'whip' | 'whep';
  pc: RTCPeerConnection;
  etag: string;
}

export class LoopbackWhipWhepGateway {
  public readonly whipEndpoint = `${LOOPBACK_ORIGIN}/whip`;
  public readonly whepEndpoint = `${LOOPBACK_ORIGIN}/whep`;

  private sessions = new Map<string, LoopbackPeerSession>();
  private publishedStream = new MediaStream();
  private fallbackMedia: SyntheticMediaHandle | null = null;
  private nextId = 1;

  public readonly fetchImpl: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    return this.dispatch(request);
  };

  public destroy(): void {
    for (const session of this.sessions.values()) {
      session.pc.close();
    }
    this.sessions.clear();
    this.stopFallbackMedia();
    for (const track of this.publishedStream.getTracks()) {
      this.publishedStream.removeTrack(track);
    }
  }

  private async dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== LOOPBACK_ORIGIN) {
      return new Response('Not a loopback WHIP/WHEP URL', { status: 404 });
    }

    const method = request.method.toUpperCase();
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }

    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/whip' && method === 'POST') {
      return this.handleWhipPost(await request.text());
    }
    if (path === '/whep' && method === 'POST') {
      return this.handleWhepPost(await request.text());
    }

    const whipMatch = path.match(/^\/whip\/resource\/([^/]+)$/);
    if (whipMatch) {
      return this.handleResource(whipMatch[1], method, request);
    }
    const whepMatch = path.match(/^\/whep\/resource\/([^/]+)$/);
    if (whepMatch) {
      return this.handleResource(whepMatch[1], method, request);
    }

    return new Response('Unknown WHIP/WHEP path', { status: 404 });
  }

  private async handleWhipPost(offerSdp: string): Promise<Response> {
    const id = `whip-${this.nextId++}`;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

    pc.ontrack = (event) => {
      if (!this.publishedStream.getTracks().some((track) => track.id === event.track.id)) {
        this.publishedStream.addTrack(event.track);
      }
    };

    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc);

    const session: LoopbackPeerSession = { id, kind: 'whip', pc, etag: '"1"' };
    this.sessions.set(id, session);

    return this.createdResponse(
      `${this.whipEndpoint}/resource/${id}`,
      pc.localDescription?.sdp ?? '',
      session.etag
    );
  }

  private async handleWhepPost(offerSdp: string): Promise<Response> {
    const id = `whep-${this.nextId++}`;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const media = this.ensurePublishedMedia();

    for (const track of media.getTracks()) {
      pc.addTrack(track, media);
    }

    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc);

    const session: LoopbackPeerSession = { id, kind: 'whep', pc, etag: '"1"' };
    this.sessions.set(id, session);

    return this.createdResponse(
      `${this.whepEndpoint}/resource/${id}`,
      pc.localDescription?.sdp ?? '',
      session.etag
    );
  }

  private async handleResource(id: string, method: string, request: Request): Promise<Response> {
    const session = this.sessions.get(id);
    if (!session) {
      return new Response('Unknown WHIP/WHEP resource', { status: 404 });
    }

    if (method === 'PATCH') {
      const ifMatch = request.headers.get('If-Match');
      if (ifMatch && session.etag && ifMatch !== session.etag) {
        return new Response('ETag mismatch', { status: 412 });
      }
      const sdpfrag = await request.text();
      const parsed = parseTrickleIceSdpfrag(sdpfrag);
      for (const candidate of parsed.candidates) {
        try {
          await session.pc.addIceCandidate(candidate);
        } catch {
          // Ignore stale or unmatched trickle fragments.
        }
      }
      return new Response(null, { status: 204, headers: { ETag: session.etag } });
    }

    if (method === 'DELETE') {
      session.pc.close();
      this.sessions.delete(id);
      if (session.kind === 'whip' && this.noActiveWhipSessions()) {
        for (const track of this.publishedStream.getTracks()) {
          this.publishedStream.removeTrack(track);
        }
      }
      return new Response(null, { status: 200 });
    }

    return new Response('Method Not Allowed', { status: 405 });
  }

  private ensurePublishedMedia(): MediaStream {
    if (this.publishedStream.getTracks().length > 0) {
      return this.publishedStream;
    }
    if (!this.fallbackMedia) {
      this.fallbackMedia = createSyntheticMediaStream({
        width: 320,
        height: 180,
        framerate: 24,
        includeAudio: false,
        label: 'LoopbackWHEP',
      });
    }
    return this.fallbackMedia.stream;
  }

  private noActiveWhipSessions(): boolean {
    for (const session of this.sessions.values()) {
      if (session.kind === 'whip') {
        return false;
      }
    }
    return true;
  }

  private stopFallbackMedia(): void {
    if (this.fallbackMedia) {
      this.fallbackMedia.stop();
      this.fallbackMedia = null;
    }
  }

  private createdResponse(location: string, sdp: string, etag: string): Response {
    return new Response(sdp, {
      status: 201,
      headers: {
        'Content-Type': 'application/sdp',
        Location: location,
        ETag: etag,
        Link: '<stun:stun.l.google.com:19302>; rel="ice-server"',
      },
    });
  }
}
