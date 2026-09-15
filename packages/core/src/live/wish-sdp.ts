/**
 * WHIP/WHEP SDP & ICE helpers (RFC 9725 / RFC 8840).
 */

export interface ParsedIceFragment {
  ufrag?: string;
  pwd?: string;
  mid?: string;
  mediaKind: 'audio' | 'video' | 'application';
  candidates: RTCIceCandidateInit[];
  endOfCandidates: boolean;
}

function readQuotedParam(source: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i');
  const quoted = source.match(re);
  if (quoted) {
    return quoted[1];
  }
  const bare = source.match(new RegExp(`${name}\\s*=\\s*([^;\\s]+)`, 'i'));
  return bare?.[1];
}

/**
 * Parse RFC 9725 `Link: <stun:...>; rel="ice-server"` headers into RTCIceServer[].
 */
export function parseIceServerLinks(linkHeader: string | null | undefined): RTCIceServer[] {
  if (!linkHeader) {
    return [];
  }

  const parts = linkHeader.split(/,(?=\s*<)/);
  const servers: RTCIceServer[] = [];

  for (const part of parts) {
    if (!/rel\s*=\s*"?ice-server"?/i.test(part)) {
      continue;
    }
    const urlMatch = part.match(/<([^>]+)>/);
    if (!urlMatch) {
      continue;
    }

    const server: RTCIceServer = { urls: urlMatch[1] };
    const username = readQuotedParam(part, 'username');
    const credential = readQuotedParam(part, 'credential');
    if (username) {
      server.username = username;
    }
    if (credential) {
      server.credential = credential;
    }
    servers.push(server);
  }

  return servers;
}

export function extractIceCredentials(sdp: string): { ufrag: string; pwd: string } {
  const ufrag = sdp.match(/^a=ice-ufrag:(.+)$/m)?.[1]?.trim() ?? '';
  const pwd = sdp.match(/^a=ice-pwd:(.+)$/m)?.[1]?.trim() ?? '';
  return { ufrag, pwd };
}

export function extractMidForKind(sdp: string, kind: 'audio' | 'video'): string {
  const blocks = sdp.split(/^m=/m);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block.startsWith(kind)) {
      continue;
    }
    const mid = block.match(/^a=mid:(.+)$/m)?.[1]?.trim();
    if (mid) {
      return mid;
    }
  }
  return kind === 'audio' ? '1' : '0';
}

export function buildTrickleIceSdpfrag(options: {
  ufrag: string;
  pwd: string;
  mid: string;
  mediaKind: 'audio' | 'video';
  candidate?: string;
  endOfCandidates?: boolean;
}): string {
  const lines = [
    `a=ice-ufrag:${options.ufrag}`,
    `a=ice-pwd:${options.pwd}`,
    `m=${options.mediaKind} 9 UDP/TLS/RTP/SAVPF 0`,
    `a=mid:${options.mid}`,
  ];

  if (options.candidate) {
    const value = options.candidate.startsWith('candidate:')
      ? options.candidate
      : `candidate:${options.candidate}`;
    lines.push(`a=${value}`);
  }

  if (options.endOfCandidates) {
    lines.push('a=end-of-candidates');
  }

  return `${lines.join('\r\n')}\r\n`;
}

export function parseTrickleIceSdpfrag(sdpfrag: string): ParsedIceFragment {
  let ufrag: string | undefined;
  let pwd: string | undefined;
  let mid: string | undefined;
  let mediaKind: ParsedIceFragment['mediaKind'] = 'video';
  let endOfCandidates = false;

  const rawLines = sdpfrag.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (const line of rawLines) {
    if (line.startsWith('a=ice-ufrag:')) {
      ufrag = line.slice('a=ice-ufrag:'.length);
    } else if (line.startsWith('a=ice-pwd:')) {
      pwd = line.slice('a=ice-pwd:'.length);
    } else if (line.startsWith('a=mid:')) {
      mid = line.slice('a=mid:'.length);
    } else if (line.startsWith('m=')) {
      const kind = line.slice(2).split(' ')[0];
      if (kind === 'audio' || kind === 'video' || kind === 'application') {
        mediaKind = kind;
      }
    } else if (line === 'a=end-of-candidates') {
      endOfCandidates = true;
    }
  }

  const candidates: RTCIceCandidateInit[] = [];
  for (const line of rawLines) {
    if (!line.startsWith('a=candidate:')) {
      continue;
    }
    candidates.push({
      candidate: line.slice(2),
      sdpMid: mid ?? '0',
      usernameFragment: ufrag,
    });
  }

  return { ufrag, pwd, mid, mediaKind, candidates, endOfCandidates };
}

export function resolveResourceUrl(location: string, baseUrl: string): string {
  try {
    return new URL(location, baseUrl).href;
  } catch {
    return location;
  }
}

export function preferInteropCodecs(pc: RTCPeerConnection): void {
  if (typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function') {
    return;
  }

  for (const transceiver of pc.getTransceivers()) {
    const kind = (transceiver.sender.track?.kind || transceiver.receiver.track?.kind) as
      | 'audio'
      | 'video'
      | undefined;
    if (kind !== 'audio' && kind !== 'video') {
      continue;
    }
    if (typeof transceiver.setCodecPreferences !== 'function') {
      continue;
    }

    const caps = RTCRtpSender.getCapabilities(kind);
    if (!caps) {
      continue;
    }

    const preferredMime = kind === 'video' ? 'video/h264' : 'audio/opus';
    const preferred = caps.codecs.filter((codec) => codec.mimeType.toLowerCase() === preferredMime);
    const rest = caps.codecs.filter((codec) => codec.mimeType.toLowerCase() !== preferredMime);
    if (preferred.length > 0) {
      transceiver.setCodecPreferences([...preferred, ...rest]);
    }
  }
}

export function waitForIceGatheringComplete(pc: RTCPeerConnection, timeoutMs = 2500): Promise<void> {
  if (pc.iceGatheringState === 'complete') {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') {
        finish();
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}
