import { test, expect } from '@playwright/test';
import { FastStartMp4Muxer, SimpleMp4Demuxer } from '@web-ffmpeg-gpu/core';

test.describe('GPU Hardware Transcoding & FastStart MP4 Pipeline', () => {
  test('should verify Hardware VideoEncoder support in browser environment', async ({ page }) => {
    await page.goto('/');

    const support = await page.evaluate(async () => {
      if (typeof VideoEncoder === 'undefined') {
        return { hasWebCodecs: false, supported: false };
      }
      try {
        const res = await VideoEncoder.isConfigSupported({
          codec: 'avc1.42001f', // Baseline profile
          width: 1280,
          height: 720,
          bitrate: 2_500_000,
          framerate: 30,
          hardwareAcceleration: 'prefer-hardware',
        });
        return { hasWebCodecs: true, supported: !!res.supported };
      } catch (err: any) {
        return { hasWebCodecs: true, supported: false, error: err.message };
      }
    });

    expect(support.hasWebCodecs).toBe(true);
    expect(support.supported).toBe(true);
  });

  test('should generate valid FastStart MP4 with moov placed before mdat', async () => {
    const muxer = new FastStartMp4Muxer();

    const sps = new Uint8Array([0x67, 0x42, 0xc0, 0x1e, 0xd9, 0x00, 0xa0, 0x7b, 0x40]);
    const pps = new Uint8Array([0x68, 0xce, 0x38, 0x80]);

    muxer.setVideoTrack({
      width: 1920,
      height: 1080,
      timescale: 30000,
      sps,
      pps,
    });

    muxer.setAudioTrack({
      timescale: 44100,
      sampleRate: 44100,
      channels: 2,
    });

    // Write 5 video frames
    for (let i = 0; i < 5; i++) {
      const isKey = i === 0;
      const data = new Uint8Array([0, 0, 0, 4, isKey ? 0x65 : 0x41, i, i + 1, i + 2]);
      muxer.writeVideoSample(data, 1000, isKey);
    }

    // Write 5 audio packets
    for (let i = 0; i < 5; i++) {
      const audioData = new Uint8Array([0xff, 0xf1, 0x50, 0x80, i, i + 1]);
      muxer.writeAudioSample(audioData, 1024);
    }

    const mp4Bytes = muxer.finalize();
    expect(mp4Bytes.byteLength).toBeGreaterThan(100);

    // Verify FastStart: find moov and mdat
    const view = new DataView(mp4Bytes.buffer, mp4Bytes.byteOffset, mp4Bytes.byteLength);
    let offset = 0;
    let moovOffset = -1;
    let mdatOffset = -1;

    while (offset < mp4Bytes.byteLength - 8) {
      const size = view.getUint32(offset);
      const tag = String.fromCharCode(
        mp4Bytes[offset + 4],
        mp4Bytes[offset + 5],
        mp4Bytes[offset + 6],
        mp4Bytes[offset + 7]
      );

      if (tag === 'moov') {
        moovOffset = offset;
      } else if (tag === 'mdat') {
        mdatOffset = offset;
      }

      if (size === 0) break;
      offset += size;
    }

    expect(moovOffset).toBeGreaterThan(0);
    expect(mdatOffset).toBeGreaterThan(0);
    // Crucial FastStart invariant: moov MUST come before mdat!
    expect(moovOffset).toBeLessThan(mdatOffset);

    // Verify Demuxer can read back the muxed file
    const demuxer = new SimpleMp4Demuxer(mp4Bytes.buffer.slice(mp4Bytes.byteOffset, mp4Bytes.byteOffset + mp4Bytes.byteLength));
    const tracks = demuxer.parse();
    expect(tracks.length).toBeGreaterThanOrEqual(1);

    const vTrack = tracks.find((t) => t.codec.startsWith('avc1'));
    expect(vTrack).toBeDefined();
    expect(vTrack?.width).toBe(1920);
    expect(vTrack?.height).toBe(1080);
    expect(vTrack?.samples.length).toBe(5);
    expect(vTrack?.samples[0].type).toBe('key');
    expect(vTrack?.samples[1].type).toBe('delta');
  });

  test('should verify UI transcoding controls exist and function in playground', async ({ page }) => {
    await page.goto('/');

    const btnStart = page.locator('#btn-start-transcode');
    const selectPreset = page.locator('#select-preset');
    const checkMute = page.locator('#check-mute');
    const boxTree = page.locator('#box-tree-content');

    await expect(btnStart).toBeVisible();
    await expect(selectPreset).toBeVisible();
    await expect(checkMute).toBeVisible();
    await expect(boxTree).toBeVisible();

    // Check presets options
    const options = await selectPreset.locator('option').allTextContents();
    expect(options.some((o) => o.includes('720p'))).toBe(true);
    expect(options.some((o) => o.includes('1080p'))).toBe(true);
    expect(options.some((o) => o.includes('原画瘦身'))).toBe(true);
  });
});
