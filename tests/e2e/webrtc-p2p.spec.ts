import { test, expect } from '@playwright/test';

test.describe('WebRTC DataChannel P2P Live Direct Streaming & Reverse PLI (RFC 0002 Phase 2)', () => {
  test('P2P Direct Streaming: Cross-tab SDP/ICE handshake and realtime RTP video delivery via DataChannel', async ({ context }) => {
    const pageSender = await context.newPage();
    const pageReceiver = await context.newPage();

    try {
      // 1. Load both pages
      await pageSender.goto('/');
      await pageReceiver.goto('/');

      await pageSender.waitForFunction(() => typeof (window as any).LiveP2PSender !== 'undefined');
      await pageReceiver.waitForFunction(() => typeof (window as any).LiveP2PReceiver !== 'undefined');

      const roomId = `p2p-room-${Date.now()}`;

      // 2. Start LiveP2PSender in Page 1
      const senderSupported = await pageSender.evaluate(async (rId) => {
        if (typeof VideoEncoder === 'undefined' || typeof RTCPeerConnection === 'undefined') {
          return false;
        }

        const { LiveP2PSender, BroadcastChannelSignaling } = (window as any);
        const signaling = new BroadcastChannelSignaling(rId);

        const sender = new LiveP2PSender({
          roomId: rId,
          signaling,
          width: 320,
          height: 180,
          framerate: 30,
          bitrate: 800_000,
        });

        (window as any).__p2pSender = sender;
        await sender.start();
        return true;
      }, roomId);

      if (!senderSupported) {
        test.skip();
        return;
      }

      // 3. Start LiveP2PReceiver in Page 2
      const receiverSupported = await pageReceiver.evaluate(async (rId) => {
        if (typeof VideoDecoder === 'undefined' || typeof RTCPeerConnection === 'undefined') {
          return false;
        }

        const { LiveP2PReceiver, BroadcastChannelSignaling } = (window as any);
        const signaling = new BroadcastChannelSignaling(rId);
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;

        const receiver = new LiveP2PReceiver({
          roomId: rId,
          signaling,
          renderCanvas: canvas,
        });

        (window as any).__p2pReceiver = receiver;
        await receiver.start();
        return true;
      }, roomId);

      if (!receiverSupported) {
        test.skip();
        return;
      }

      // 4. Wait for P2P DataChannel connection and RTP transmission across tabs
      const startTime = Date.now();
      let connected = false;
      let packetsSent = 0;
      let packetsReceived = 0;

      while (Date.now() - startTime < 12000) {
        const senderMetrics = await pageSender.evaluate(() => (window as any).__p2pSender?.getMetrics());
        const receiverMetrics = await pageReceiver.evaluate(() => (window as any).__p2pReceiver?.getMetrics());

        if (senderMetrics && receiverMetrics) {
          packetsSent = senderMetrics.rtpPacketsSent;
          packetsReceived = receiverMetrics.rtpPacketsReceived;

          if (
            senderMetrics.dataChannelState === 'open' &&
            receiverMetrics.dataChannelState === 'open' &&
            packetsSent >= 5 &&
            packetsReceived >= 3
          ) {
            connected = true;
            break;
          }
        }
        await pageSender.waitForTimeout(200);
      }

      expect(connected).toBe(true);
      expect(packetsSent).toBeGreaterThanOrEqual(5);
      expect(packetsReceived).toBeGreaterThanOrEqual(3);

      // Clean up
      await pageSender.evaluate(() => (window as any).__p2pSender?.stop());
      await pageReceiver.evaluate(() => (window as any).__p2pReceiver?.stop());
    } finally {
      await pageSender.close();
      await pageReceiver.close();
    }
  });

  test('P2P Direct Streaming: Reverse PLI feedback message from Viewer must trigger IDR Keyframe on Broadcaster', async ({ context }) => {
    const pageSender = await context.newPage();
    const pageReceiver = await context.newPage();

    try {
      await pageSender.goto('/');
      await pageReceiver.goto('/');

      await pageSender.waitForFunction(() => typeof (window as any).LiveP2PSender !== 'undefined');
      await pageReceiver.waitForFunction(() => typeof (window as any).LiveP2PReceiver !== 'undefined');

      const roomId = `p2p-pli-room-${Date.now()}`;

      // Start Sender
      await pageSender.evaluate(async (rId) => {
        const { LiveP2PSender, BroadcastChannelSignaling } = (window as any);
        const signaling = new BroadcastChannelSignaling(rId);

        const sender = new LiveP2PSender({
          roomId: rId,
          signaling,
          width: 320,
          height: 180,
          framerate: 30,
        });

        (window as any).__p2pSender = sender;
        await sender.start();
      }, roomId);

      // Start Receiver
      await pageReceiver.evaluate(async (rId) => {
        const { LiveP2PReceiver, BroadcastChannelSignaling } = (window as any);
        const signaling = new BroadcastChannelSignaling(rId);

        const receiver = new LiveP2PReceiver({
          roomId: rId,
          signaling,
        });

        (window as any).__p2pReceiver = receiver;
        await receiver.start();
      }, roomId);

      // Wait until connected and receiving packets
      let connected = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 10000) {
        const rMetrics = await pageReceiver.evaluate(() => (window as any).__p2pReceiver?.getMetrics());
        if (rMetrics?.dataChannelState === 'open' && rMetrics?.rtpPacketsReceived >= 2) {
          connected = true;
          break;
        }
        await pageSender.waitForTimeout(200);
      }
      expect(connected).toBe(true);

      // Record initial sender keyframe requests
      const initialKeyframeRequests = await pageSender.evaluate(() => (window as any).__p2pSender?.getMetrics().keyframeRequests || 0);

      // Trigger reverse PLI from Receiver
      await pageReceiver.evaluate(() => {
        (window as any).__p2pReceiver?.requestKeyframe();
      });

      // Verify that Sender received reverse PLI feedback and incremented keyframeRequests
      let pliTriggered = false;
      const t1 = Date.now();
      while (Date.now() - t1 < 4000) {
        const currentRequests = await pageSender.evaluate(() => (window as any).__p2pSender?.getMetrics().keyframeRequests || 0);
        if (currentRequests > initialKeyframeRequests) {
          pliTriggered = true;
          break;
        }
        await pageSender.waitForTimeout(100);
      }

      expect(pliTriggered).toBe(true);

      // Clean up
      await pageSender.evaluate(() => (window as any).__p2pSender?.stop());
      await pageReceiver.evaluate(() => (window as any).__p2pReceiver?.stop());
    } finally {
      await pageSender.close();
      await pageReceiver.close();
    }
  });
});
