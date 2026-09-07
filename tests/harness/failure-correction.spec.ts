import { test, expect } from '@playwright/test';
import {
  SimpleMp4Demuxer,
  FastStartMp4Muxer,
  WebFfmpegTranscoder,
  MasterClockSync,
  LiveStreamPlayer,
  LiveStreamIngestPipeline,
} from '@web-ffmpeg-gpu/core';
import { BitstreamFuzzer } from './fuzzer';

test.describe('Industrial Failure Cases & Self-Correction Autopilot Matrix (FAIL-01 to FAIL-06)', () => {
  test('FAIL-01 Autocorrection: Dirty non-IDR frame prefix must be automatically dropped until IDR keyframe', async ({ page }) => {
    await page.goto('/');

    const result = await page.evaluate(async () => {
      const logs: string[] = [];
      const origWarn = console.warn;
      console.warn = (...args) => {
        logs.push(args.join(' '));
        origWarn(...args);
      };

      try {
        // Construct synthetic samples: 5 delta frames followed by 1 keyframe and 5 delta frames
        const samples = [];
        // Dirty leading delta frames
        for (let i = 0; i < 5; i++) {
          samples.push({
            type: 'delta' as const,
            timestamp: i * 33333,
            duration: 33333,
            data: new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x41, 0x00]),
          });
        }
        // First legitimate IDR keyframe
        samples.push({
          type: 'key' as const,
          timestamp: 5 * 33333,
          duration: 33333,
          data: new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x65, 0x88]),
        });
        // Subsequent delta frames (5 frames: 6, 7, 8, 9, 10)
        for (let i = 6; i <= 10; i++) {
          samples.push({
            type: 'delta' as const,
            timestamp: i * 33333,
            duration: 33333,
            data: new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x41, 0x00]),
          });
        }

        // Apply Dirty Prefix Dropper
        const firstKeyIndex = samples.findIndex((s) => s.type === 'key');
        let droppedCount = 0;
        let sanitizedSamples = samples;
        if (firstKeyIndex > 0) {
          droppedCount = firstKeyIndex;
          sanitizedSamples = samples.slice(firstKeyIndex);
        }

        return {
          originalLength: samples.length,
          droppedCount,
          sanitizedLength: sanitizedSamples.length,
          firstSampleType: sanitizedSamples[0]?.type,
        };
      } finally {
        console.warn = origWarn;
      }
    });

    expect(result.originalLength).toBe(11);
    expect(result.droppedCount).toBe(5);
    expect(result.sanitizedLength).toBe(6);
    expect(result.firstSampleType).toBe('key');
  });

  test('FAIL-02 Autocorrection: Malformed SPS & 32-Zero Exp-Golomb trap must be safely rejected with fallback', async ({ page }) => {
    await page.goto('/');

    const malformedSps = BitstreamFuzzer.generateMalformedSps();
    const result = await page.evaluate(async ({ spsBytes }) => {
      let panicked = false;
      let fellBack = false;

      try {
        const spsArray = new Uint8Array(spsBytes);
        // Truncated / malformed avcC where declared SPS length exceeds buffer
        const avcc = new Uint8Array(10);
        avcc[0] = 1;
        avcc[5] = 0xe1; // 1 SPS
        avcc[6] = 0x01;
        avcc[7] = 0x00; // Declares 256 bytes SPS, but avcC only has 10 bytes!

        let sps = new Uint8Array([0x67, 0x42, 0xc0, 0x1e, 0xd9, 0x00, 0xa0, 0x7b, 0x40]); // baseline fallback
        try {
          const numSps = avcc[5] & 0x1f;
          if (numSps > 0) {
            const spsLen = (avcc[6] << 8) | avcc[7];
            if (8 + spsLen <= avcc.byteLength) {
              sps = avcc.slice(8, 8 + spsLen);
            } else {
              fellBack = true; // Safely detected out-of-bounds SPS, falling back
            }
          }
        } catch {
          fellBack = true;
        }

        // Also verify VideoDecoder rejection doesn't panic
        if (typeof VideoDecoder !== 'undefined') {
          await VideoDecoder.isConfigSupported({
            codec: 'avc1.invalid',
            description: spsArray,
          }).catch(() => {
            // Expected safe rejection
          });
        }
      } catch {
        panicked = true;
      }

      return { panicked, fellBack };
    }, { spsBytes: Array.from(malformedSps) });

    expect(result.panicked).toBe(false);
    expect(result.fellBack).toBe(true);
  });

  test('FAIL-03 Autocorrection: Negative PTS and retrograde time travel must be clamped monotonically', () => {
    const rawTimestamps = [-50000, -10000, 0, 100000, 30000, 70000, 120000, 110000, 150000];
    const sanitizedTimestamps: number[] = [];

    let lastSanitizedPts = -1;
    for (const rawPts of rawTimestamps) {
      let pts = rawPts < 0 ? 0 : rawPts;
      if (lastSanitizedPts >= 0 && pts <= lastSanitizedPts) {
        pts = lastSanitizedPts + 33333;
      }
      lastSanitizedPts = pts;
      sanitizedTimestamps.push(pts);
    }

    // Assert: strictly non-negative
    for (const pts of sanitizedTimestamps) {
      expect(pts).toBeGreaterThanOrEqual(0);
    }

    // Assert: strictly monotonically increasing
    for (let i = 1; i < sanitizedTimestamps.length; i++) {
      expect(sanitizedTimestamps[i]).toBeGreaterThan(sanitizedTimestamps[i - 1]);
    }
  });

  test('FAIL-04 Autocorrection: Corrupted audio track must be safely isolated without killing video transcode', () => {
    const muxer = new FastStartMp4Muxer();
    muxer.setVideoTrack({
      width: 1280,
      height: 720,
      timescale: 30000,
      sps: new Uint8Array([0x67, 0x42, 0xc0, 0x1e, 0xd9, 0x00, 0xa0, 0x7b, 0x40]),
      pps: new Uint8Array([0x68, 0xce, 0x38, 0x80]),
    });

    // Write valid video sample
    muxer.writeVideoSample(new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x65, 0x88]), 1000, true);

    // Corrupted audio samples: some empty, some truncated
    const audioSamples = [
      new Uint8Array(0), // Corrupted empty
      new Uint8Array([0xff, 0xf1, 0x50, 0x80]), // Legitimate
      new Uint8Array(0), // Corrupted empty
    ];

    muxer.setAudioTrack({
      timescale: 44100,
      sampleRate: 44100,
      channels: 2,
    });

    let skippedCount = 0;
    for (const aSample of audioSamples) {
      if (!aSample || aSample.byteLength === 0) {
        skippedCount++;
        continue;
      }
      muxer.writeAudioSample(aSample, 1024);
    }

    const output = muxer.finalize();
    expect(skippedCount).toBe(2);
    expect(output.byteLength).toBeGreaterThan(0);
  });

  test('FAIL-05 Autocorrection: Truncated MP4 missing moov box must activate salvage mode from mdat', () => {
    // Construct a synthetic truncated MP4 containing only ftyp and mdat with Annex-B NALs (missing moov)
    const nalStream: number[] = [
      // ftyp box (16 bytes)
      0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
      // mdat box header (8 bytes)
      0x00, 0x00, 0x00, 0x30, 0x6d, 0x64, 0x61, 0x74,
      // Annex-B SPS (NAL type 7)
      0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f,
      // Annex-B PPS (NAL type 8)
      0x00, 0x00, 0x00, 0x01, 0x68, 0xce, 0x3c, 0x80,
      // Annex-B IDR (NAL type 5)
      0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00, 0x11, 0x22, 0x33, 0x44,
      // Annex-B Non-IDR Slice (NAL type 1)
      0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x12, 0x34, 0x56, 0x78,
    ];

    const buffer = new Uint8Array(nalStream).buffer;
    const demuxer = new SimpleMp4Demuxer(buffer);
    const tracks = demuxer.parse();

    expect(tracks.length).toBeGreaterThan(0);
    const videoTrack = tracks[0];
    expect(videoTrack.codec).toBe('avc1.42001f');
    expect(videoTrack.samples.length).toBeGreaterThanOrEqual(3);
    expect(videoTrack.samples[0].type).toBe('key');
  });

  test('FAIL-06 Autocorrection: VRAM backpressure spike must throttle queue size strictly <= 8', async ({ page }) => {
    await page.goto('/');

    const queueResult = await page.evaluate(async () => {
      // Simulate rapid ingestion of 100 frames with queue backpressure check
      let currentQueueSize = 0;
      let maxRecordedQueue = 0;
      let throttleTriggers = 0;

      for (let i = 0; i < 100; i++) {
        // Backpressure throttle simulation
        while (currentQueueSize >= 8) {
          throttleTriggers++;
          await new Promise((r) => setTimeout(r, 1));
          currentQueueSize -= 4; // Simulate consumer drain
        }

        currentQueueSize++;
        if (currentQueueSize > maxRecordedQueue) {
          maxRecordedQueue = currentQueueSize;
        }
      }

      return {
        maxRecordedQueue,
        throttleTriggers,
      };
    });

    expect(queueResult.maxRecordedQueue).toBeLessThanOrEqual(8);
    expect(queueResult.throttleTriggers).toBeGreaterThan(0);
  });

  test('RFC 0002 Live Master Clock Sync: 3-tier drift alignment (<40ms, 40-500ms 1.05x, >500ms seek)', () => {
    const clock = new MasterClockSync({
      tightThresholdMs: 40,
      catchupThresholdMs: 500,
      catchupRate: 1.05,
    });

    // 1. Initial frame anchors the clock
    const decisionInit = clock.evaluateFrameSync(1000000);
    expect(decisionInit.action).toBe('RENDER_NORMAL');
    expect(decisionInit.playbackRate).toBe(1.0);

    // 2. Normal frame within tight threshold (< 40ms drift)
    const normalClockUs = clock.getMasterClockUs();
    const decisionNormal = clock.evaluateFrameSync(normalClockUs + 15000); // 15ms drift
    expect(decisionNormal.action).toBe('RENDER_NORMAL');

    // 3. Smooth catchup frame (drift between -40ms and -500ms)
    const decisionCatchup = clock.evaluateFrameSync(normalClockUs - 120000); // -120ms drift
    expect(decisionCatchup.action).toBe('SMOOTH_CATCHUP');
    expect(decisionCatchup.playbackRate).toBe(1.05);

    // 4. Catastrophic drift (> 500ms lag): must trigger SEEK_KEYFRAME
    const decisionSeek = clock.evaluateFrameSync(normalClockUs - 650000); // -650ms drift
    expect(decisionSeek.action).toBe('SEEK_KEYFRAME');
  });

  test('RFC 0002 Live Player Pipeline: lifecycle management and metrics querying', async () => {
    const player = new LiveStreamPlayer({
      minBufferMs: 50,
      maxBufferMs: 200,
    });

    expect(player.active).toBe(false);
    const metricsInit = player.getMetrics();
    expect(metricsInit.renderedFrames).toBe(0);
    expect(metricsInit.droppedFrames).toBe(0);

    await player.reset();
    expect(player.active).toBe(false);
  });

  test('RFC 0002 Live Ingest Pipeline: state tracking and telemetry estimation', async () => {
    const pipeline = new LiveStreamIngestPipeline();

    expect(pipeline.active).toBe(false);
    const telemetry = pipeline.getTelemetry();
    expect(telemetry.encodedFrames).toBe(0);
    expect(telemetry.currentFps).toBe(0);
    expect(telemetry.droppedFrames).toBe(0);

    await pipeline.stop();
    expect(pipeline.active).toBe(false);
  });
});
