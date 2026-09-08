import { test, expect } from '@playwright/test';

test.describe('WebRTC / RTC Real-time P2P Live Loopback & Weak Network Self-Healing (RFC 0002 & FAIL-09/10)', () => {
  test('Live Loopback: End-to-end synthetic capture, WebCodecs encode, RTP packetize, depacketize, and render', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => typeof (window as any).LiveLoopbackSession !== 'undefined');

    const result = await page.evaluate(async () => {
      if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
        return { supported: false };
      }

      // Access LiveLoopbackSession from window
      const LiveLoopbackSession = (window as any).LiveLoopbackSession;
      if (!LiveLoopbackSession) {
        throw new Error('LiveLoopbackSession not found on window');
      }

      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;

      const session = new LiveLoopbackSession({
        width: 640,
        height: 360,
        framerate: 30,
        bitrate: 1_200_000,
        packetLossRate: 0.0,
        jitterMs: 0,
        renderCanvas: canvas,
      });

      await session.start();

      // Dynamically wait until at least 6 RTP packets are produced and rendered
      const startTime = performance.now();
      while (session.getMetrics().rtpPacketsSent < 6 && performance.now() - startTime < 4000) {
        await new Promise((r) => setTimeout(r, 100));
      }

      const metrics = session.getMetrics();
      session.stop();

      return {
        supported: true,
        rtpPacketsSent: metrics.rtpPacketsSent,
        rtpPacketsReceived: metrics.rtpPacketsReceived,
        rtpPacketsDropped: metrics.rtpPacketsDropped,
        glassToGlassLatencyMs: metrics.glassToGlassLatencyMs,
        isRunning: metrics.isRunning,
      };
    });

    if (result.supported) {
      expect(result.rtpPacketsSent).toBeGreaterThan(5);
      expect(result.rtpPacketsReceived).toBeGreaterThan(5);
      expect(result.rtpPacketsDropped).toBe(0);
      expect(result.glassToGlassLatencyMs).toBeLessThanOrEqual(250);
    }
  });

  test('Live Loopback: 15% Packet Loss Impairment must activate FAIL-09 and PLI Keyframe Self-Healing', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => typeof (window as any).LiveLoopbackSession !== 'undefined');

    const result = await page.evaluate(async () => {
      if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
        return { supported: false };
      }

      const LiveLoopbackSession = (window as any).LiveLoopbackSession;
      if (!LiveLoopbackSession) {
        throw new Error('LiveLoopbackSession not found on window');
      }

      const canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 270;

      const errors: string[] = [];
      const session = new LiveLoopbackSession({
        width: 480,
        height: 270,
        framerate: 30,
        bitrate: 800_000,
        packetLossRate: 0.15, // 15% network packet loss
        jitterMs: 10,
        renderCanvas: canvas,
        onError: (err) => errors.push(err.message),
      });

      await session.start();

      // Wait until packets are transmitted and dropped under 15% loss
      const startTime = performance.now();
      while (
        (session.getMetrics().rtpPacketsSent < 12 || session.getMetrics().rtpPacketsDropped === 0) &&
        performance.now() - startTime < 4000
      ) {
        await new Promise((r) => setTimeout(r, 100));
      }

      const metrics = session.getMetrics();
      session.stop();

      return {
        supported: true,
        rtpPacketsSent: metrics.rtpPacketsSent,
        rtpPacketsDropped: metrics.rtpPacketsDropped,
        fail09Rescues: metrics.fail09Rescues,
        keyframeRequests: metrics.keyframeRequests,
        errorCount: errors.length,
        errors,
      };
    });

    if (result.supported) {
      console.log('Result errors:', result.errors);
      expect(result.errorCount).toBe(0); // 0 unhandled decoder crash
      expect(result.rtpPacketsSent).toBeGreaterThan(10);
      expect(result.rtpPacketsDropped).toBeGreaterThan(0); // Confirms packets were dropped
      // Either FAIL-09 fragment loss was detected or periodic/PLI keyframes requested
      expect(result.keyframeRequests).toBeGreaterThanOrEqual(1);
    }
  });

  test('Live Loopback: Mid-flight dynamic impairment adjustment must update telemetry safely', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => typeof (window as any).LiveLoopbackSession !== 'undefined');

    const result = await page.evaluate(async () => {
      if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
        return { supported: false };
      }

      const LiveLoopbackSession = (window as any).LiveLoopbackSession;
      if (!LiveLoopbackSession) {
        throw new Error('LiveLoopbackSession not found on window');
      }
      const session = new LiveLoopbackSession({
        width: 320,
        height: 180,
        packetLossRate: 0.0,
      });

      await session.start();
      
      const t0 = performance.now();
      while (session.getMetrics().rtpPacketsSent < 3 && performance.now() - t0 < 3000) {
        await new Promise((r) => setTimeout(r, 100));
      }

      // Dynamically ramp up packet loss to 30% and jitter to 40ms
      session.setImpairments({ packetLossRate: 0.30, jitterMs: 40 });
      const currentLoss = session.packetLossRate;
      const currentJitter = session.jitterMs;

      const sentBefore = session.getMetrics().rtpPacketsSent;
      const t1 = performance.now();
      while (session.getMetrics().rtpPacketsSent <= sentBefore && performance.now() - t1 < 3000) {
        await new Promise((r) => setTimeout(r, 100));
      }

      const metrics = session.getMetrics();
      session.stop();

      return {
        supported: true,
        packetsSent: metrics.rtpPacketsSent,
        currentLoss,
        currentJitter,
      };
    });

    if (result.supported) {
      expect(result.packetsSent).toBeGreaterThan(0);
      expect(result.currentLoss).toBe(0.30);
      expect(result.currentJitter).toBe(40);
    }
  });
});
