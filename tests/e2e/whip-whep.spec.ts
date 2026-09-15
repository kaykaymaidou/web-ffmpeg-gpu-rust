import { test, expect } from '@playwright/test';

test.describe('WHIP / WHEP Broadcast Clients (RFC 0003)', () => {
  test('CASE-09/10: Loopback WHIP publish + WHEP play should connect ICE and deliver frames', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => typeof (window as any).WhipClient !== 'undefined');

    const supported = await page.evaluate(() => {
      return typeof RTCPeerConnection !== 'undefined' && typeof HTMLCanvasElement !== 'undefined';
    });
    if (!supported) {
      test.skip();
      return;
    }

    const started = await page.evaluate(async () => {
      const { WhipClient, WhepClient, LoopbackWhipWhepGateway } = window as any;
      const gateway = new LoopbackWhipWhepGateway();
      (window as any).__whipGateway = gateway;

      const whip = new WhipClient({
        endpoint: gateway.whipEndpoint,
        fetchImpl: gateway.fetchImpl,
        width: 320,
        height: 180,
        framerate: 24,
        includeAudio: false,
      });
      const whep = new WhepClient({
        endpoint: gateway.whepEndpoint,
        fetchImpl: gateway.fetchImpl,
      });

      (window as any).__whipClient = whip;
      (window as any).__whepClient = whep;

      await whip.publish();
      await new Promise((resolve) => setTimeout(resolve, 400));
      await whep.play();
      return true;
    });

    expect(started).toBe(true);

    const startTime = Date.now();
    let connected = false;
    let framesReceived = 0;
    let bytesSent = 0;
    let bytesReceived = 0;

    while (Date.now() - startTime < 15000) {
      const metrics = await page.evaluate(() => {
        const whip = (window as any).__whipClient;
        const whep = (window as any).__whepClient;
        return {
          whip: whip?.getMetrics?.(),
          whep: whep?.getMetrics?.(),
        };
      });

      bytesSent = metrics.whip?.bytesSent ?? 0;
      bytesReceived = metrics.whep?.bytesReceived ?? 0;
      framesReceived = metrics.whep?.framesReceived ?? 0;

      const whipUp =
        metrics.whip?.connectionState === 'connected' ||
        metrics.whip?.iceConnectionState === 'connected' ||
        metrics.whip?.iceConnectionState === 'completed';
      const whepUp =
        metrics.whep?.connectionState === 'connected' ||
        metrics.whep?.iceConnectionState === 'connected' ||
        metrics.whep?.iceConnectionState === 'completed';

      if (whipUp && whepUp && (framesReceived >= 1 || bytesReceived > 0)) {
        connected = true;
        break;
      }
      await page.waitForTimeout(250);
    }

    expect(connected).toBe(true);
    expect(bytesSent).toBeGreaterThan(0);
    expect(bytesReceived + framesReceived).toBeGreaterThan(0);

    const pipeline = await page.evaluate(() => {
      const whip = (window as any).__whipClient?.getMetrics();
      return {
        gpuPipelineActive: whip?.gpuPipelineActive,
        filteredFrames: whip?.filteredFrames,
        insertable: typeof (window as any).MediaStreamTrackGenerator !== 'undefined',
      };
    });
    if (pipeline.insertable) {
      expect(pipeline.gpuPipelineActive).toBe(true);
      expect(pipeline.filteredFrames).toBeGreaterThan(0);
    }

    const closed = await page.evaluate(async () => {
      await (window as any).__whipClient?.stop();
      await (window as any).__whepClient?.stop();
      (window as any).__whipGateway?.destroy();
      return {
        whip: (window as any).__whipClient?.getMetrics?.(),
        whep: (window as any).__whepClient?.getMetrics?.(),
      };
    });

    expect(closed.whip.connectionState).toBe('closed');
    expect(closed.whep.connectionState).toBe('closed');
    expect(closed.whip.isPublishing).toBe(false);
    expect(closed.whep.isPlaying).toBe(false);
  });

  test('CASE-11: HTTP DELETE must run on stop and local PeerConnection must close', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => typeof (window as any).WhipClient !== 'undefined');

    const result = await page.evaluate(async () => {
      if (typeof RTCPeerConnection === 'undefined') {
        return { skipped: true };
      }

      const { WhipClient, LoopbackWhipWhepGateway } = window as any;
      const gateway = new LoopbackWhipWhepGateway();
      let deleteSeen = false;
      const innerFetch = gateway.fetchImpl.bind(gateway);
      const wrappedFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.method === 'DELETE') {
          deleteSeen = true;
        }
        return innerFetch(request);
      };

      const whip = new WhipClient({
        endpoint: gateway.whipEndpoint,
        fetchImpl: wrappedFetch,
        width: 160,
        height: 90,
        framerate: 15,
        includeAudio: false,
      });

      await whip.publish();
      const pcBefore = whip.getPeerConnection();
      const resourceBefore = whip.getMetrics().resourceUrl;
      await whip.stop();
      gateway.destroy();

      return {
        skipped: false,
        deleteSeen,
        resourceBefore,
        pcStateAfter: pcBefore?.connectionState ?? 'closed',
        publishing: whip.getMetrics().isPublishing,
      };
    });

    if (result.skipped) {
      test.skip();
      return;
    }

    expect(result.deleteSeen).toBe(true);
    expect(result.resourceBefore).toContain('/whip/resource/');
    expect(result.pcStateAfter).toBe('closed');
    expect(result.publishing).toBe(false);
  });
});
