import { test, expect } from '@playwright/test';

test.describe('WHIP / WHEP Protocol Helpers (RFC 0003 CASE-08)', () => {
  test('CASE-08: Link ice-server parsing, trickle SDP fragment, relative Location', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => typeof (window as any).parseIceServerLinks === 'function');

    const result = await page.evaluate(() => {
      const {
        parseIceServerLinks,
        buildTrickleIceSdpfrag,
        parseTrickleIceSdpfrag,
        extractIceCredentials,
        resolveResourceUrl,
      } = window as any;

      const servers = parseIceServerLinks(
        '<stun:stun.example.net>; rel="ice-server", <turn:turn.example.net?transport=udp>; rel="ice-server"; username="alice"; credential="secret"; credential-type="password"'
      );

      const frag = buildTrickleIceSdpfrag({
        ufrag: 'u1',
        pwd: 'p1',
        mid: '0',
        mediaKind: 'video',
        candidate: 'candidate:1 1 UDP 2122260223 192.0.2.1 51234 typ host',
      });
      const parsed = parseTrickleIceSdpfrag(frag);
      const creds = extractIceCredentials(
        'v=0\r\na=ice-ufrag:AbCd\r\na=ice-pwd:XyZ123\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n'
      );
      const absolute = resolveResourceUrl('/whip/resource/abc', 'https://srs.local/rtc/v1/whip/?app=live');
      const alreadyAbs = resolveResourceUrl('https://cdn.example/res/1', 'https://unused.local/whip');

      const endFrag = buildTrickleIceSdpfrag({
        ufrag: 'u1',
        pwd: 'p1',
        mid: '0',
        mediaKind: 'video',
        endOfCandidates: true,
      });
      const endParsed = parseTrickleIceSdpfrag(endFrag);

      return { servers, parsed, creds, absolute, alreadyAbs, endParsed };
    });

    expect(result.servers).toHaveLength(2);
    expect(result.servers[0].urls).toBe('stun:stun.example.net');
    expect(result.servers[1].urls).toContain('turn:turn.example.net');
    expect(result.servers[1].username).toBe('alice');
    expect(result.servers[1].credential).toBe('secret');

    expect(result.parsed.ufrag).toBe('u1');
    expect(result.parsed.pwd).toBe('p1');
    expect(result.parsed.mid).toBe('0');
    expect(result.parsed.candidates).toHaveLength(1);
    expect(result.parsed.candidates[0].candidate).toContain('192.0.2.1');

    expect(result.creds.ufrag).toBe('AbCd');
    expect(result.creds.pwd).toBe('XyZ123');
    expect(result.absolute).toBe('https://srs.local/whip/resource/abc');
    expect(result.alreadyAbs).toBe('https://cdn.example/res/1');
    expect(result.endParsed.endOfCandidates).toBe(true);
  });

  test('CASE-08/12: WishHttpClient POST 201 + PATCH 405 trickle fallback + Bearer 401', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => typeof (window as any).WishHttpClient === 'function');

    const result = await page.evaluate(async () => {
      const { WishHttpClient, WishProtocolError } = window as any;
      const calls: Array<{ method: string; url: string; auth?: string | null; contentType?: string | null }> = [];

      const mockFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        calls.push({
          method: request.method,
          url: request.url,
          auth: request.headers.get('Authorization'),
          contentType: request.headers.get('Content-Type'),
        });

        if (request.url.includes('/denied')) {
          return new Response('nope', { status: 401 });
        }
        if (request.method === 'POST') {
          return new Response('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n', {
            status: 201,
            headers: {
              Location: '/whip/resource/sess-1',
              ETag: '"etag-1"',
              Link: '<stun:stun.l.google.com:19302>; rel="ice-server"',
              'Content-Type': 'application/sdp',
            },
          });
        }
        if (request.method === 'PATCH') {
          return new Response('trickle disabled', { status: 405 });
        }
        if (request.method === 'DELETE') {
          return new Response(null, { status: 200 });
        }
        return new Response('no', { status: 404 });
      };

      const client = new WishHttpClient({
        endpoint: 'https://media.example/whip',
        token: 'secret-token',
        fetchImpl: mockFetch,
      });

      const session = await client.postOffer('v=0');
      const patchResult = await client.patchIceFragment('a=ice-ufrag:x\r\n');
      await client.terminate();

      let authErrorStatus: number | null = null;
      try {
        const denied = new WishHttpClient({
          endpoint: 'https://media.example/denied',
          token: 'bad',
          fetchImpl: mockFetch,
        });
        await denied.postOffer('v=0');
      } catch (err: any) {
        authErrorStatus = err.status ?? null;
        if (!(err instanceof WishProtocolError) && err.name !== 'WishProtocolError') {
          authErrorStatus = -1;
        }
      }

      return { session, patchResult, calls, authErrorStatus };
    });

    expect(result.session.resourceUrl).toBe('https://media.example/whip/resource/sess-1');
    expect(result.session.iceServers[0].urls).toContain('stun.l.google.com');
    expect(result.patchResult).toBe('not-supported');
    expect(result.calls[0].auth).toBe('Bearer secret-token');
    expect(result.calls[0].contentType).toBe('application/sdp');
    expect(result.calls[1].contentType).toBe('application/trickle-ice-sdpfrag');
    expect(result.calls[2].method).toBe('DELETE');
    expect(result.authErrorStatus).toBe(401);
  });
});
