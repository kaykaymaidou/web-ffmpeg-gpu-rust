import { test, expect } from '@playwright/test';

test.describe('Real-time Audio Pipeline & Lip-Sync Synchronization (RFC 0002 Phase 3)', () => {
  test('Opus Codec & RFC 7587 RTP: WebCodecs AudioEncoder/AudioDecoder roundtrip with sequence unrolling and PTS microsecond conversion', async ({ page }) => {
    await page.goto('/');

    await page.waitForFunction(() => typeof (window as any).HardwareAudioEncoder !== 'undefined');

    const result = await page.evaluate(async () => {
      if (typeof AudioEncoder === 'undefined' || typeof AudioDecoder === 'undefined' || typeof AudioData === 'undefined') {
        return { supported: false, reason: 'WebCodecs Audio API not supported in this browser' };
      }

      const {
        HardwareAudioEncoder,
        HardwareAudioDecoder,
        OpusRtpPacketizer,
        OpusRtpDemuxer,
        WebAudioLivePlayer,
      } = (window as any);

      const isEncoderSupported = await HardwareAudioEncoder.isSupported({
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: 2,
      });

      const isDecoderSupported = await HardwareAudioDecoder.isSupported({
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: 2,
      });

      if (!isEncoderSupported || !isDecoderSupported) {
        return { supported: false, reason: 'Opus 48kHz stereo codec configuration unsupported' };
      }

      // 1. Initialize Player, Demuxer, Packetizer
      const player = new WebAudioLivePlayer({ sampleRate: 48000, numberOfChannels: 2 });
      const packetizer = new OpusRtpPacketizer({ payloadType: 111, clockRate: 48000 });
      const demuxer = new OpusRtpDemuxer({ payloadType: 111, clockRate: 48000 });

      const decodedFrames: { numberOfFrames: number; sampleRate: number; numberOfChannels: number; timestamp: number }[] = [];
      let packetizerCount = 0;
      let demuxerCount = 0;

      // 2. Initialize Hardware Decoder
      const decoder = new HardwareAudioDecoder(
        (data: AudioData) => {
          decodedFrames.push({
            numberOfFrames: data.numberOfFrames,
            sampleRate: data.sampleRate,
            numberOfChannels: data.numberOfChannels,
            timestamp: data.timestamp,
          });
          // Zero memory leak invariant: enqueueAudioData schedules playback and synchronously closes AudioData handle
          player.enqueueAudioData(data);
        },
        (err: any) => console.error('[Test AudioDecoder error]', err)
      );

      await decoder.configure({
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: 2,
      });

      // 3. Initialize Hardware Encoder
      const encoder = new HardwareAudioEncoder(
        (chunk: EncodedAudioChunk) => {
          // Packetize into RFC 7587 RTP datagram
          const opusBytes = new Uint8Array(chunk.byteLength);
          chunk.copyTo(opusBytes);
          const rtpPacket = packetizer.packetize(opusBytes, chunk.timestamp);
          packetizerCount++;

          // Demux RTP datagram
          const demuxed = demuxer.demux(rtpPacket);
          if (demuxed) {
            demuxerCount++;
            // Feed to decoder
            const audioChunk = new EncodedAudioChunk({
              type: chunk.type,
              timestamp: demuxed.ptsUs,
              data: demuxed.payload,
            });
            decoder.decode(audioChunk);
          }
        },
        (err: any) => console.error('[Test AudioEncoder error]', err)
      );

      await encoder.configure({
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 64000,
      });

      // 4. Generate synthetic 440Hz sine wave PCM frames (20ms = 960 samples @ 48kHz)
      const sampleRate = 48000;
      const channels = 2;
      const framesPerChunk = 960;
      const numFrames = 5;

      const pcmPlanar = new Float32Array(framesPerChunk * channels);
      for (let i = 0; i < framesPerChunk; i++) {
        const val = Math.sin(2 * Math.PI * 440 * (i / sampleRate)) * 0.5;
        pcmPlanar[i] = val; // Left channel
        pcmPlanar[framesPerChunk + i] = val; // Right channel
      }

      for (let f = 0; f < numFrames; f++) {
        const timestampUs = f * 20000; // 20ms per frame in microseconds
        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate,
          numberOfFrames: framesPerChunk,
          numberOfChannels: channels,
          timestamp: timestampUs,
          data: pcmPlanar,
        });

        encoder.encode(audioData);
        audioData.close();
      }

      // 5. Flush pipeline
      await encoder.flush();
      await decoder.flush();

      // Clean up
      player.close();
      encoder.close();
      decoder.close();

      return {
        supported: true,
        packetizerCount,
        demuxerCount,
        decodedCount: decodedFrames.length,
        firstFrame: decodedFrames[0],
      };
    });

    if (!result.supported) {
      test.skip(true, result.reason);
      return;
    }

    expect(result.packetizerCount).toBeGreaterThanOrEqual(5);
    expect(result.demuxerCount).toBeGreaterThanOrEqual(5);
    expect(result.decodedCount).toBeGreaterThanOrEqual(5);
    expect(result.firstFrame).toBeDefined();
    expect(result.firstFrame?.numberOfFrames).toBe(960);
    expect(result.firstFrame?.numberOfChannels).toBe(2);
    expect(result.firstFrame?.sampleRate).toBe(48000);
  });

  test('Dual-Channel P2P Direct Streaming: Video + Audio concurrent real-time transmission with Lip-Sync drift alignment', async ({ context }) => {
    const pageSender = await context.newPage();
    const pageReceiver = await context.newPage();

    try {
      await pageSender.goto('/');
      await pageReceiver.goto('/');

      await pageSender.waitForFunction(() => typeof (window as any).LiveP2PSender !== 'undefined');
      await pageReceiver.waitForFunction(() => typeof (window as any).LiveP2PReceiver !== 'undefined');

      const roomId = `p2p-av-room-${Date.now()}`;

      // Start Broadcaster with Audio enabled
      const senderStarted = await pageSender.evaluate(async (rId) => {
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
          enableAudio: true,
        });

        (window as any).__p2pSender = sender;
        await sender.start();
        return true;
      }, roomId);

      if (!senderStarted) {
        test.skip();
        return;
      }

      // Start Receiver with Audio enabled
      const receiverStarted = await pageReceiver.evaluate(async (rId) => {
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
          enableAudio: true,
        });

        (window as any).__p2pReceiver = receiver;
        await receiver.start();
        return true;
      }, roomId);

      if (!receiverStarted) {
        test.skip();
        return;
      }

      // Wait for dual-channel (video-stream + audio-stream) connection, data flow, and lip-sync stabilization
      let dualChannelReady = false;
      let packetsVideoSent = 0;
      let packetsVideoRecv = 0;
      let packetsAudioSent = 0;
      let packetsAudioRecv = 0;
      let lastReceiverMetrics: any = null;

      const startTime = Date.now();
      while (Date.now() - startTime < 15000) {
        const sMetrics = await pageSender.evaluate(() => (window as any).__p2pSender?.getMetrics());
        const rMetrics = await pageReceiver.evaluate(() => (window as any).__p2pReceiver?.getMetrics());

        if (sMetrics && rMetrics) {
          packetsVideoSent = sMetrics.rtpPacketsSent;
          packetsAudioSent = sMetrics.audioPacketsSent;
          packetsVideoRecv = rMetrics.rtpPacketsReceived;
          packetsAudioRecv = rMetrics.audioPacketsReceived;
          lastReceiverMetrics = rMetrics;

          if (
            sMetrics.dataChannelState === 'open' &&
            sMetrics.audioDataChannelState === 'open' &&
            rMetrics.dataChannelState === 'open' &&
            rMetrics.audioDataChannelState === 'open' &&
            packetsVideoSent >= 5 &&
            packetsVideoRecv >= 3 &&
            packetsAudioSent >= 5 &&
            packetsAudioRecv >= 3 &&
            rMetrics.lipSyncStatus !== 'NO_AUDIO' &&
            Math.abs(rMetrics.avDriftMs) <= 40
          ) {
            dualChannelReady = true;
            break;
          }
        }
        await pageSender.waitForTimeout(250);
      }

      expect(dualChannelReady).toBe(true);
      expect(packetsVideoSent).toBeGreaterThanOrEqual(5);
      expect(packetsVideoRecv).toBeGreaterThanOrEqual(3);
      expect(packetsAudioSent).toBeGreaterThanOrEqual(5);
      expect(packetsAudioRecv).toBeGreaterThanOrEqual(3);

      // Verify Lip-Sync metrics
      expect(lastReceiverMetrics).toBeDefined();
      expect(typeof lastReceiverMetrics.avDriftMs).toBe('number');
      // Drift must be strictly bounded within ±40ms tight threshold under direct streaming
      expect(Math.abs(lastReceiverMetrics.avDriftMs)).toBeLessThanOrEqual(40);
      expect(['LIP_SYNC_ALIGNED', 'VIDEO_LAGGING', 'VIDEO_LEADING']).toContain(lastReceiverMetrics.lipSyncStatus);

      // Clean up
      await pageSender.evaluate(() => (window as any).__p2pSender?.stop());
      await pageReceiver.evaluate(() => (window as any).__p2pReceiver?.stop());
    } finally {
      await pageSender.close();
      await pageReceiver.close();
    }
  });
});
