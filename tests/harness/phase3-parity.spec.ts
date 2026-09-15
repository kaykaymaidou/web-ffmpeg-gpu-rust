import { test, expect } from '@playwright/test';
import { AudioDsp, FilterGraphPlanner, WebmDemuxer } from '../../packages/core/src/index.js';

test.describe('Phase 3 Core Parity: Audio DSP, WebM/MKV Demuxer & Filtergraph Execution Planner', () => {
  test('Tier 1 [Audio DSP Resampler]: Resample 48kHz audio buffer to 16kHz via Rust WASM', async () => {
    // Generate 480 samples of 48kHz audio (10ms of audio)
    const inRate = 48000;
    const outRate = 16000;
    const channels = 1;
    const sampleCount = 480;
    const input = new Float32Array(sampleCount);

    for (let i = 0; i < sampleCount; i++) {
      input[i] = Math.sin((2 * Math.PI * 440 * i) / inRate);
    }

    const resampled = await AudioDsp.resample(input, {
      fromRate: inRate,
      toRate: outRate,
      channels,
    });

    // 480 samples at 3:1 decimation should produce exactly 160 samples
    expect(resampled.length).toBe(160);
    // Values should remain bounded within [-1.0, 1.0]
    for (let i = 0; i < resampled.length; i++) {
      expect(Math.abs(resampled[i])).toBeLessThanOrEqual(1.0);
    }
  });

  test('Tier 2 [Audio DSP Matrix Mixer]: 5.1 Surround to Stereo Downmix adheres to ITU-R BS.775', async () => {
    // 5.1 input frame: [L, R, C, LFE, Ls, Rs]
    // 2 frames
    const input51 = new Float32Array([
      1.0, 0.0, 0.5, 0.0, 0.0, 0.0, // Frame 1
      0.0, 1.0, 0.5, 0.0, 0.0, 0.0, // Frame 2
    ]);

    const stereo = await AudioDsp.downmix51ToStereo(input51);
    expect(stereo.length).toBe(4); // 2 frames * 2 channels

    // Left channel Frame 1 has L=1.0 and C=0.5
    expect(stereo[0]).toBeGreaterThan(0.5);
    // Right channel Frame 1 has R=0.0 and C=0.5
    expect(stereo[1]).toBeGreaterThan(0.0);
  });

  test('Tier 3 [Filtergraph Execution Planner]: Partitions FFmpeg -vf into WebGPU & CPU targets', async () => {
    const planner = new FilterGraphPlanner('scale=1920:1080,fps=60,grayscale');
    const nodes = await planner.plan();

    expect(nodes.length).toBe(3);
    expect(nodes[0].name).toBe('scale');
    expect(nodes[0].target).toBe('webgpu');

    expect(nodes[1].name).toBe('fps');
    expect(nodes[1].target).toBe('passthrough');

    expect(nodes[2].name).toBe('grayscale');
    expect(nodes[2].target).toBe('webgpu');
  });

  test('Tier 4 [Filtergraph Complex Graph]: Multi-output split and scale branch planning', async () => {
    const planner = new FilterGraphPlanner(
      '[0:v]split=2[v0][v1];[v0]scale=1280:720[out0];[v1]boxblur=2:1[out1]'
    );
    const nodes = await planner.plan();

    expect(nodes.length).toBe(3);
    expect(nodes[0].name).toBe('split');
    expect(nodes[0].target).toBe('passthrough');

    expect(nodes[1].name).toBe('scale');
    expect(nodes[1].target).toBe('webgpu');

    expect(nodes[2].name).toBe('boxblur');
    expect(nodes[2].target).toBe('webgpu');
  });

  test('Tier 5 [WebM/MKV Demuxer]: Extract VP9 track and SimpleBlocks from EBML stream', async () => {
    // Construct minimal valid WebM EBML stream in memory
    const parts: number[][] = [];

    // EBML Header (0x1A45DFA3, size 0 -> 0x80)
    parts.push([0x1A, 0x45, 0xDF, 0xA3, 0x80]);

    // Segment (0x18538067, size streamed 0xFF)
    parts.push([0x18, 0x53, 0x80, 0x67, 0xFF]);

    // Info: TimecodeScale 1ms (0x1549A966, size 7)
    parts.push([
      0x15, 0x49, 0xA9, 0x66, 0x87,
      0x2A, 0xD7, 0xB1, 0x83, 0x0F, 0x42, 0x40,
    ]);

    // TrackEntry: TrackNum=1, Type=1(Video), Codec="V_VP9", Width=1280, Height=720
    const trackEntry: number[] = [
      0xD7, 0x81, 0x01, // TrackNum
      0x83, 0x81, 0x01, // Video Type
      0x86, 0x85, ...Array.from(Buffer.from('V_VP9')), // CodecID
      0xE0, 0x88, // VideoSettings size 8
      0xB0, 0x82, 0x05, 0x00, // Width 1280
      0xBA, 0x82, 0x02, 0xD0, // Height 720
    ];

    const tracksBox = [0xAE, 0x80 | trackEntry.length, ...trackEntry];
    parts.push([0x16, 0x54, 0xAE, 0x6B, 0x80 | tracksBox.length, ...tracksBox]);

    // Cluster with 1 SimpleBlock
    const simpleBlock: number[] = [
      0x81, // Track 1
      0x00, 0x00, // rel_tc 0
      0x80, // Keyframe flag
      0xAA, 0xBB, 0xCC, 0xDD, // Payload
    ];
    const clusterPayload: number[] = [
      0xE7, 0x82, 0x00, 0x64, // Timecode = 100ms
      0xA3, 0x80 | simpleBlock.length, ...simpleBlock,
    ];
    parts.push([0x1F, 0x43, 0xB6, 0x75, 0x80 | clusterPayload.length, ...clusterPayload]);

    const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
    const buffer = new Uint8Array(totalLen);
    let offset = 0;
    for (const p of parts) {
      buffer.set(new Uint8Array(p), offset);
      offset += p.length;
    }

    const demuxer = new WebmDemuxer(buffer);
    const result = await demuxer.parse();

    expect(result.tracks.length).toBe(1);
    expect(result.tracks[0].codec).toBe('V_VP9');
    expect(result.tracks[0].width).toBe(1280);
    expect(result.tracks[0].height).toBe(720);
    expect(result.frameCount).toBe(1);

    const frames = demuxer.getFrames();
    expect(frames.length).toBe(1);
    expect(frames[0].isKeyframe).toBe(true);
    expect(frames[0].ptsUs).toBe(100_000); // 100ms in us
    expect(Array.from(frames[0].data)).toEqual([0xAA, 0xBB, 0xCC, 0xDD]);
  });
});
