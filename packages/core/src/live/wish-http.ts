/**
 * Shared WHIP/WHEP HTTP signaling (RFC 9725).
 */

import { parseIceServerLinks, resolveResourceUrl } from './wish-sdp';

export interface WishHttpOptions {
  endpoint: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export interface WishSessionInfo {
  answerSdp: string;
  resourceUrl: string;
  etag?: string;
  iceServers: RTCIceServer[];
}

export type IcePatchResult = 'ok' | 'not-supported' | 'precondition-failed' | 'error';

export class WishProtocolError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'WishProtocolError';
    this.status = status;
    this.body = body;
  }
}

function authHeaders(token?: string): Record<string, string> {
  if (!token) {
    return {};
  }
  const value = token.toLowerCase().startsWith('bearer ') ? token : `Bearer ${token}`;
  return { Authorization: value };
}

export class WishHttpClient {
  private readonly endpoint: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private resourceUrl: string | null = null;
  private etag: string | null = null;
  private closed = false;

  constructor(options: WishHttpOptions) {
    this.endpoint = options.endpoint;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  public getResourceUrl(): string | null {
    return this.resourceUrl;
  }

  public getEtag(): string | null {
    return this.etag;
  }

  public async postOffer(sdp: string, signal?: AbortSignal): Promise<WishSessionInfo> {
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sdp',
        Accept: 'application/sdp',
        ...authHeaders(this.token),
      },
      body: sdp,
      signal,
    });

    const body = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new WishProtocolError('WHIP/WHEP authorization failed', response.status, body);
    }
    if (response.status !== 201) {
      throw new WishProtocolError(
        `WHIP/WHEP POST expected 201 Created, got ${response.status}`,
        response.status,
        body
      );
    }

    const location = response.headers.get('Location');
    if (!location) {
      throw new WishProtocolError('WHIP/WHEP 201 missing Location header', 201, body);
    }

    this.resourceUrl = resolveResourceUrl(location, this.endpoint);
    this.etag = response.headers.get('ETag');
    const iceServers = parseIceServerLinks(response.headers.get('Link'));

    if (!body.trim()) {
      throw new WishProtocolError('WHIP/WHEP 201 missing SDP answer body', 201, body);
    }

    return {
      answerSdp: body,
      resourceUrl: this.resourceUrl,
      etag: this.etag ?? undefined,
      iceServers,
    };
  }

  public async patchIceFragment(sdpfrag: string, signal?: AbortSignal): Promise<IcePatchResult> {
    if (!this.resourceUrl || this.closed) {
      return 'error';
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/trickle-ice-sdpfrag',
      ...authHeaders(this.token),
    };
    if (this.etag) {
      headers['If-Match'] = this.etag;
    }

    try {
      const response = await this.fetchImpl(this.resourceUrl, {
        method: 'PATCH',
        headers,
        body: sdpfrag,
        signal,
      });

      if (response.status === 204 || response.status === 200) {
        const nextEtag = response.headers.get('ETag');
        if (nextEtag) {
          this.etag = nextEtag;
        }
        return 'ok';
      }
      if (response.status === 405) {
        return 'not-supported';
      }
      if (response.status === 412) {
        return 'precondition-failed';
      }
      return 'error';
    } catch {
      return 'error';
    }
  }

  public async terminate(): Promise<void> {
    this.closed = true;
    if (!this.resourceUrl) {
      return;
    }

    const url = this.resourceUrl;
    this.resourceUrl = null;

    try {
      await this.fetchImpl(url, {
        method: 'DELETE',
        headers: {
          ...authHeaders(this.token),
        },
      });
    } catch {
      // Local teardown must not be blocked by a failed DELETE.
    }
  }
}
