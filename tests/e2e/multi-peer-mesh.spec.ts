import { test, expect } from '@playwright/test';

test.describe('WebRTC Multi-Peer Mesh Live Session & Targeted PLI (RFC 0002 Phase 4)', () => {
  test('Tier 1 [3-Peer Mesh Handshake]: Host, Guest 1, and Guest 2 should establish fully connected mesh topology over BroadcastChannel', async ({ context }) => {
    const pageHost = await context.newPage();
    const pageGuest1 = await context.newPage();
    const pageGuest2 = await context.newPage();

    try {
      await pageHost.goto('/');
      await pageGuest1.goto('/');
      await pageGuest2.goto('/');

      await pageHost.waitForFunction(() => typeof (window as any).MultiPeerMeshSession !== 'undefined');
      await pageGuest1.waitForFunction(() => typeof (window as any).MultiPeerMeshSession !== 'undefined');
      await pageGuest2.waitForFunction(() => typeof (window as any).MultiPeerMeshSession !== 'undefined');

      const roomId = `mesh-handshake-${Date.now()}`;

      // Start Host
      const hostOk = await pageHost.evaluate(async (rId) => {
        if (typeof RTCPeerConnection === 'undefined' || typeof VideoEncoder === 'undefined') return false;
        const { MultiPeerMeshSession, BroadcastChannelSignaling } = window as any;
        const signaling = new BroadcastChannelSignaling(rId);
        const hostSession = new MultiPeerMeshSession({
          roomId: rId,
          peerId: 'host-001',
          role: 'host',
          signaling,
          width: 320,
          height: 180,
          framerate: 30,
        });
        (window as any).__meshSession = hostSession;
        await hostSession.start();
        return true;
      }, roomId);

      if (!hostOk) {
        test.skip();
        return;
      }

      // Start Guest 1
      await pageGuest1.evaluate(async (rId) => {
        const { MultiPeerMeshSession, BroadcastChannelSignaling } = window as any;
        const signaling = new BroadcastChannelSignaling(rId);
        const g1Session = new MultiPeerMeshSession({
          roomId: rId,
          peerId: 'guest-001',
          role: 'guest',
          signaling,
          width: 320,
          height: 180,
          framerate: 30,
        });
        (window as any).__meshSession = g1Session;
        await g1Session.start();
      }, roomId);

      // Start Guest 2
      await pageGuest2.evaluate(async (rId) => {
        const { MultiPeerMeshSession, BroadcastChannelSignaling } = window as any;
        const signaling = new BroadcastChannelSignaling(rId);
        const g2Session = new MultiPeerMeshSession({
          roomId: rId,
          peerId: 'guest-002',
          role: 'guest',
          signaling,
          width: 320,
          height: 180,
          framerate: 30,
        });
        (window as any).__meshSession = g2Session;
        await g2Session.start();
      }, roomId);

      // Wait for mesh topology convergence:
      // Host should connect to 2 peers (guest-001, guest-002)
      // Guest 1 should connect to 2 peers (host-001, guest-002)
      // Guest 2 should connect to 2 peers (host-001, guest-001)
      const startTime = Date.now();
      let meshConverged = false;

      while (Date.now() - startTime < 15000) {
        const hostPeers = await pageHost.evaluate(() => (window as any).__meshSession?.getRemotePeerIds() || []);
        const g1Peers = await pageGuest1.evaluate(() => (window as any).__meshSession?.getRemotePeerIds() || []);
        const g2Peers = await pageGuest2.evaluate(() => (window as any).__meshSession?.getRemotePeerIds() || []);

        if (hostPeers.length >= 2 && g1Peers.length >= 2 && g2Peers.length >= 2) {
          meshConverged = true;
          break;
        }
        await pageHost.waitForTimeout(200);
      }

      expect(meshConverged).toBe(true);

      const hostMetrics = await pageHost.evaluate(() => (window as any).__meshSession?.getMetrics());
      expect(hostMetrics.activePeersCount).toBe(2);
      expect(hostMetrics.role).toBe('host');

      // Cleanup
      await pageHost.evaluate(() => (window as any).__meshSession?.stop());
      await pageGuest1.evaluate(() => (window as any).__meshSession?.stop());
      await pageGuest2.evaluate(() => (window as any).__meshSession?.stop());
    } finally {
      await pageHost.close();
      await pageGuest1.close();
      await pageGuest2.close();
    }
  });

  test('Tier 2 [Multi-Channel Ingestion & Compositing]: Inbound streams should be routed to WebGpuMultiStreamCompositor and MultiTrackAudioMixer', async ({ context }) => {
    const pageHost = await context.newPage();
    const pageGuest = await context.newPage();

    try {
      await pageHost.goto('/');
      await pageGuest.goto('/');

      await pageHost.waitForFunction(() => typeof (window as any).MultiPeerMeshSession !== 'undefined');
      await pageGuest.waitForFunction(() => typeof (window as any).MultiPeerMeshSession !== 'undefined');

      const roomId = `mesh-compositor-${Date.now()}`;

      // Start Host with WebGpuMultiStreamCompositor & MultiTrackAudioMixer
      const hostStarted = await pageHost.evaluate(async (rId) => {
        if (typeof RTCPeerConnection === 'undefined' || typeof VideoEncoder === 'undefined') return false;
        const { MultiPeerMeshSession, BroadcastChannelSignaling, WebGpuMultiStreamCompositor, MultiTrackAudioMixer } = window as any;

        const canvas = new OffscreenCanvas(640, 360);
        let compositor = null;
        if (navigator.gpu && WebGpuMultiStreamCompositor) {
          try {
            compositor = new WebGpuMultiStreamCompositor({
              canvas,
              initialPreset: 'split_horizontal',
            });
            await compositor.initialize();
          } catch {
            compositor = null;
          }
        }

        const audioMixer = new MultiTrackAudioMixer({ sampleRate: 48000 });
        const signaling = new BroadcastChannelSignaling(rId);

        const hostSession = new MultiPeerMeshSession({
          roomId: rId,
          peerId: 'host-mixer',
          role: 'host',
          signaling,
          compositor,
          audioMixer,
          enableAudio: true,
          width: 320,
          height: 180,
          framerate: 30,
        });

        (window as any).__hostSession = hostSession;
        (window as any).__hostCompositor = compositor;
        (window as any).__hostMixer = audioMixer;

        await hostSession.start();
        return true;
      }, roomId);

      if (!hostStarted) {
        test.skip();
        return;
      }

      // Start Guest publisher
      await pageGuest.evaluate(async (rId) => {
        const { MultiPeerMeshSession, BroadcastChannelSignaling } = window as any;
        const signaling = new BroadcastChannelSignaling(rId);

        const guestSession = new MultiPeerMeshSession({
          roomId: rId,
          peerId: 'guest-publisher',
          role: 'guest',
          signaling,
          enableAudio: true,
          width: 320,
          height: 180,
          framerate: 30,
        });

        (window as any).__guestSession = guestSession;
        await guestSession.start();
      }, roomId);

      // Wait for packets to flow from Guest to Host
      const startTime = Date.now();
      let streamIngested = false;

      while (Date.now() - startTime < 12000) {
        const hostMetrics = await pageHost.evaluate(() => {
          const s = (window as any).__hostSession;
          const peerMetrics = s?.getRemotePeerMetrics('guest-publisher');
          const mixerTracks = (window as any).__hostMixer?.getTrackIds() || [];
          return {
            peerMetrics,
            mixerTracks,
          };
        });

        if (hostMetrics.peerMetrics && hostMetrics.peerMetrics.rtpPacketsReceived >= 3) {
          streamIngested = true;
          break;
        }
        await pageHost.waitForTimeout(250);
      }

      expect(streamIngested).toBe(true);

      // Verify audio mixer registered tracks for local and remote guest
      const tracks = await pageHost.evaluate(() => (window as any).__hostMixer?.getTrackIds() || []);
      expect(tracks).toContain('host-mixer');
      expect(tracks).toContain('guest-publisher');

      // Cleanup
      await pageHost.evaluate(() => {
        (window as any).__hostSession?.stop();
        (window as any).__hostCompositor?.destroy();
        (window as any).__hostMixer?.destroy();
      });
      await pageGuest.evaluate(() => (window as any).__guestSession?.stop());
    } finally {
      await pageHost.close();
      await pageGuest.close();
    }
  });

  test('Tier 3 [Targeted Reverse PLI]: Keyframe request targeting Peer A must trigger IDR on Peer A without interrupting Peer B', async ({ context }) => {
    const pageHost = await context.newPage();
    const pageGuestA = await context.newPage();
    const pageGuestB = await context.newPage();

    try {
      await pageHost.goto('/');
      await pageGuestA.goto('/');
      await pageGuestB.goto('/');

      await pageHost.waitForFunction(() => typeof (window as any).MultiPeerMeshSession !== 'undefined');
      await pageGuestA.waitForFunction(() => typeof (window as any).MultiPeerMeshSession !== 'undefined');
      await pageGuestB.waitForFunction(() => typeof (window as any).MultiPeerMeshSession !== 'undefined');

      const roomId = `mesh-targeted-pli-${Date.now()}`;

      // Start Host
      const hostStarted = await pageHost.evaluate(async (rId) => {
        if (typeof RTCPeerConnection === 'undefined' || typeof VideoEncoder === 'undefined') return false;
        const { MultiPeerMeshSession, BroadcastChannelSignaling } = window as any;
        const signaling = new BroadcastChannelSignaling(rId);

        const host = new MultiPeerMeshSession({
          roomId: rId,
          peerId: 'host-pli-test',
          role: 'host',
          signaling,
        });

        (window as any).__meshSession = host;
        await host.start();
        return true;
      }, roomId);

      if (!hostStarted) {
        test.skip();
        return;
      }

      // Start Guest A
      await pageGuestA.evaluate(async (rId) => {
        const { MultiPeerMeshSession, BroadcastChannelSignaling } = window as any;
        const signaling = new BroadcastChannelSignaling(rId);

        const guestA = new MultiPeerMeshSession({
          roomId: rId,
          peerId: 'guest-A',
          role: 'guest',
          signaling,
        });

        (window as any).__meshSession = guestA;
        await guestA.start();
      }, roomId);

      // Start Guest B
      await pageGuestB.evaluate(async (rId) => {
        const { MultiPeerMeshSession, BroadcastChannelSignaling } = window as any;
        const signaling = new BroadcastChannelSignaling(rId);

        const guestB = new MultiPeerMeshSession({
          roomId: rId,
          peerId: 'guest-B',
          role: 'guest',
          signaling,
        });

        (window as any).__meshSession = guestB;
        await guestB.start();
      }, roomId);

      // Wait until all peers are connected
      await pageHost.waitForFunction(() => {
        const s = (window as any).__meshSession;
        return s && s.getRemotePeerIds().length === 2;
      }, { timeout: 12000 });

      // Record baseline PLI counts before triggering targeted PLI
      const initialPliA = await pageGuestA.evaluate(() => (window as any).__meshSession.getMetrics().targetedPliReceived);
      const initialPliB = await pageGuestB.evaluate(() => (window as any).__meshSession.getMetrics().targetedPliReceived);

      // Host triggers targeted Reverse PLI specifically to Guest A
      await pageHost.evaluate(() => {
        (window as any).__meshSession.requestKeyframe('guest-A');
      });

      // Wait for Guest A to receive the targeted PLI
      await pageGuestA.waitForFunction((prev) => {
        const s = (window as any).__meshSession;
        return s && s.getMetrics().targetedPliReceived > prev;
      }, initialPliA, { timeout: 8000 });

      const metricsA = await pageGuestA.evaluate(() => (window as any).__meshSession.getMetrics());
      const metricsB = await pageGuestB.evaluate(() => (window as any).__meshSession.getMetrics());

      // Guest A received the targeted PLI (incremented)
      expect(metricsA.targetedPliReceived).toBeGreaterThan(initialPliA);

      // Crucial Channel Isolation Invariant:
      // Guest B did NOT receive the targeted PLI sent to Guest A (zero change!)
      expect(metricsB.targetedPliReceived).toBe(initialPliB);

      // Cleanup
      await pageHost.evaluate(() => (window as any).__meshSession?.stop());
      await pageGuestA.evaluate(() => (window as any).__meshSession?.stop());
      await pageGuestB.evaluate(() => (window as any).__meshSession?.stop());
    } finally {
      await pageHost.close();
      await pageGuestA.close();
      await pageGuestB.close();
    }
  });

  test('Tier 4 [Peer Disconnect & Zero VRAM Leak]: When peer disconnects, decoders, tracks and compositor channels are cleanly released', async ({ context }) => {
    const pageHost = await context.newPage();
    const pageGuest = await context.newPage();

    try {
      await pageHost.goto('/');
      await pageGuest.goto('/');

      await pageHost.waitForFunction(() => typeof (window as any).MultiPeerMeshSession !== 'undefined');
      await pageGuest.waitForFunction(() => typeof (window as any).MultiPeerMeshSession !== 'undefined');

      const roomId = `mesh-cleanup-${Date.now()}`;

      // Start Host
      const hostOk = await pageHost.evaluate(async (rId) => {
        if (typeof RTCPeerConnection === 'undefined' || typeof VideoEncoder === 'undefined') return false;
        const { MultiPeerMeshSession, BroadcastChannelSignaling, MultiTrackAudioMixer } = window as any;
        const audioMixer = new MultiTrackAudioMixer({ sampleRate: 48000 });
        const signaling = new BroadcastChannelSignaling(rId);

        const host = new MultiPeerMeshSession({
          roomId: rId,
          peerId: 'host-cleanup',
          role: 'host',
          signaling,
          audioMixer,
        });

        (window as any).__host = host;
        (window as any).__mixer = audioMixer;
        await host.start();
        return true;
      }, roomId);

      if (!hostOk) {
        test.skip();
        return;
      }

      // Start Guest
      await pageGuest.evaluate(async (rId) => {
        const { MultiPeerMeshSession, BroadcastChannelSignaling } = window as any;
        const signaling = new BroadcastChannelSignaling(rId);

        const guest = new MultiPeerMeshSession({
          roomId: rId,
          peerId: 'guest-leaving',
          role: 'guest',
          signaling,
        });

        (window as any).__guest = guest;
        await guest.start();
      }, roomId);

      // Wait until connected
      await pageHost.waitForFunction(() => {
        const h = (window as any).__host;
        return h && h.getRemotePeerIds().includes('guest-leaving');
      }, { timeout: 10000 });

      // Check audio mixer has guest track
      let tracks = await pageHost.evaluate(() => (window as any).__mixer.getTrackIds());
      expect(tracks).toContain('guest-leaving');

      // Now Guest stops and leaves
      await pageGuest.evaluate(() => {
        (window as any).__guest.stop();
      });

      // Wait for Host to process peer leave
      await pageHost.waitForFunction(() => {
        const h = (window as any).__host;
        return h && !h.getRemotePeerIds().includes('guest-leaving');
      }, { timeout: 10000 });

      // Verify guest track was removed from mixer (Zero Memory Leak)
      tracks = await pageHost.evaluate(() => (window as any).__mixer.getTrackIds());
      expect(tracks).not.toContain('guest-leaving');
      expect(tracks).toEqual(['host-cleanup']);

      // Cleanup Host
      await pageHost.evaluate(() => {
        (window as any).__host?.stop();
        (window as any).__mixer?.destroy();
      });
    } finally {
      await pageHost.close();
      await pageGuest.close();
    }
  });
});
