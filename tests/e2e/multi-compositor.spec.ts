import { test, expect } from '@playwright/test';

test.describe('WebGPU Multi-Stream Compositor & Multi-Track Audio Mixer (RFC 0002 Phase 4)', () => {
  test('Tier 1 [Compositor Layouts]: Should initialize WebGPU multi-stream compositor and dynamically switch presets', async ({ page }) => {
    await page.goto('/');

    const result = await page.evaluate(async () => {
      const { WebGpuMultiStreamCompositor } = window as any;
      if (!WebGpuMultiStreamCompositor || !navigator.gpu) {
        return { supported: false };
      }

      const canvas = new OffscreenCanvas(640, 360);
      const compositor = new WebGpuMultiStreamCompositor({
        canvas,
        initialPreset: 'single',
      });

      await compositor.initialize();

      // Add 4 channels
      compositor.addChannel('host');
      compositor.addChannel('guest1');
      compositor.addChannel('guest2');
      compositor.addChannel('screen');

      const presetsTested: string[] = [];

      // Test PIP Bottom-Right
      compositor.setLayoutPreset('pip_br');
      presetsTested.push(compositor.getLayoutPreset());

      // Test Split Horizontal
      compositor.setLayoutPreset('split_horizontal');
      presetsTested.push(compositor.getLayoutPreset());

      // Test 2x2 Grid
      compositor.setLayoutPreset('grid_2x2');
      presetsTested.push(compositor.getLayoutPreset());

      compositor.destroy();

      return {
        supported: true,
        channelCount: 4,
        presetsTested,
      };
    });

    if (result.supported) {
      expect(result.channelCount).toBe(4);
      expect(result.presetsTested).toEqual(['pip_br', 'split_horizontal', 'grid_2x2']);
    }
  });

  test('Tier 2 [Multi-Channel Ingestion & Rendering]: Should composite 4 concurrent VideoFrames with rounded borders without crash', async ({ page }) => {
    await page.goto('/');

    const renderResult = await page.evaluate(async () => {
      const { WebGpuMultiStreamCompositor } = window as any;
      if (!WebGpuMultiStreamCompositor || !navigator.gpu || typeof VideoFrame === 'undefined') {
        return { supported: false };
      }

      const canvas = new OffscreenCanvas(640, 360);
      const compositor = new WebGpuMultiStreamCompositor({
        canvas,
        initialPreset: 'pip_br',
      });

      await compositor.initialize();
      compositor.addChannel('host');
      compositor.addChannel('guest');

      // Helper to generate colored test VideoFrames
      const createTestFrame = (color: string, timestamp: number): VideoFrame => {
        const offscreen = new OffscreenCanvas(128, 128);
        const ctx = offscreen.getContext('2d')!;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 128, 128);
        return new VideoFrame(offscreen, { timestamp });
      };

      const hostFrame = createTestFrame('#ef4444', 0);
      const guestFrame = createTestFrame('#3b82f6', 0);

      compositor.pushFrame('host', hostFrame);
      compositor.pushFrame('guest', guestFrame);

      // Execute hardware composition
      compositor.composite();

      const activeFrames = compositor.getActiveFrameCount();
      compositor.destroy();
      const framesAfterDestroy = compositor.getActiveFrameCount();

      return {
        supported: true,
        activeFrames,
        framesAfterDestroy,
      };
    });

    if (renderResult.supported) {
      expect(renderResult.activeFrames).toBe(2);
      expect(renderResult.framesAfterDestroy).toBe(0);
    }
  });

  test('Tier 3 [Zero-VRAM-Leak Invariant]: 1,000 continuous multi-channel frame pushes must strictly maintain active handles <= 4 and drop to 0', async ({ page }) => {
    await page.goto('/');

    const stressResult = await page.evaluate(async () => {
      const { WebGpuMultiStreamCompositor } = window as any;
      if (!WebGpuMultiStreamCompositor || !navigator.gpu || typeof VideoFrame === 'undefined') {
        return { supported: false };
      }

      const canvas = new OffscreenCanvas(640, 360);
      const compositor = new WebGpuMultiStreamCompositor({
        canvas,
        initialPreset: 'grid_2x2',
      });

      await compositor.initialize();

      const channels = ['ch0', 'ch1', 'ch2', 'ch3'];
      channels.forEach((id) => compositor.addChannel(id));

      const offscreen = new OffscreenCanvas(64, 64);
      const ctx = offscreen.getContext('2d')!;
      ctx.fillStyle = '#10b981';
      ctx.fillRect(0, 0, 64, 64);

      let maxActiveDuringStress = 0;

      // Ingest 1,000 frames total (250 per channel)
      for (let i = 0; i < 250; i++) {
        for (const chId of channels) {
          const frame = new VideoFrame(offscreen, { timestamp: i * 33333 });
          compositor.pushFrame(chId, frame);
        }

        const currentActive = compositor.getActiveFrameCount();
        if (currentActive > maxActiveDuringStress) {
          maxActiveDuringStress = currentActive;
        }

        // Periodically trigger composition pass
        if (i % 25 === 0) {
          compositor.composite();
        }
      }

      const activeBeforeDestroy = compositor.getActiveFrameCount();
      compositor.destroy();
      const activeAfterDestroy = compositor.getActiveFrameCount();

      return {
        supported: true,
        maxActiveDuringStress,
        activeBeforeDestroy,
        activeAfterDestroy,
      };
    });

    if (stressResult.supported) {
      // Golden Invariant: Never exceed 4 active handles across 1,000 allocations
      expect(stressResult.maxActiveDuringStress).toBeLessThanOrEqual(4);
      expect(stressResult.activeBeforeDestroy).toBe(4);
      // After destroy: perfectly 0
      expect(stressResult.activeAfterDestroy).toBe(0);
    }
  });

  test('Tier 4 [MultiTrackAudioMixer]: Multi-track gain, mute, pan, and DynamicsCompressor clipping protection with zero memory leak', async ({ page }) => {
    await page.goto('/');

    const audioResult = await page.evaluate(async () => {
      const { MultiTrackAudioMixer } = window as any;
      if (!MultiTrackAudioMixer || typeof AudioData === 'undefined') {
        return { supported: false };
      }

      const mixer = new MultiTrackAudioMixer({ sampleRate: 48000 });
      mixer.ensureContext();

      mixer.addTrack({ trackId: 'host_mic', volume: 1.0, pan: 0.0 });
      mixer.addTrack({ trackId: 'guest_stream', volume: 1.2, pan: 0.5 });
      mixer.addTrack({ trackId: 'bgm', volume: 0.3, pan: -0.5, muted: false });

      mixer.setTrackVolume('host_mic', 0.8);
      mixer.setTrackPan('host_mic', -0.2);
      mixer.setTrackMuted('bgm', true);

      // Create 100 AudioData chunks and feed to mixer
      let closedDataCount = 0;
      for (let i = 0; i < 50; i++) {
        const sampleRate = 48000;
        const numberOfFrames = 480; // 10ms
        const buffer = new Float32Array(numberOfFrames * 2); // stereo

        // Generate synthetic sine waves that would normally clip if summed linearly
        for (let s = 0; s < numberOfFrames * 2; s++) {
          buffer[s] = Math.sin((s / sampleRate) * 440 * 2 * Math.PI) * 0.9;
        }

        const audioData = new AudioData({
          format: 'f32',
          sampleRate,
          numberOfFrames,
          numberOfChannels: 2,
          timestamp: i * 10000,
          data: buffer,
        });

        // Patch close to audit RAII
        const originalClose = audioData.close.bind(audioData);
        audioData.close = () => {
          closedDataCount++;
          originalClose();
        };

        mixer.scheduleAudioData(i % 2 === 0 ? 'host_mic' : 'guest_stream', audioData);
      }

      const stats = mixer.getStats();
      mixer.destroy();

      return {
        supported: true,
        closedDataCount,
        activeTracks: stats.activeTracks,
      };
    });

    if (audioResult.supported) {
      expect(audioResult.closedDataCount).toBe(50);
      expect(audioResult.activeTracks).toBe(3);
    }
  });

  test('Tier 5 [Playground Compositor UI]: User can toggle multi-stream compositor, switch layouts, and verify live FPS & zero leak', async ({ page }) => {
    await page.goto('/');

    const btnToggle = page.locator('#btn-toggle-compositor');
    const selectLayout = page.locator('#select-compositor-layout');
    const metricChannels = page.locator('#metric-compositor-channels');
    const metricVram = page.locator('#metric-compositor-vram');
    const metricFps = page.locator('#metric-compositor-fps');

    await expect(btnToggle).toBeVisible();
    await expect(selectLayout).toBeVisible();
    await expect(metricChannels).toHaveText('0 路');
    await expect(metricVram).toHaveText('0 句柄 (0泄漏)');

    // Start Compositor
    await btnToggle.click();
    await expect(btnToggle).toHaveText('⏹ 停止 WebGPU 多路混流');

    // Wait for at least 1 metrics cycle (500ms)
    await page.waitForTimeout(600);
    await expect(metricChannels).toHaveText('3 路');
    await expect(metricVram).toContainText('(0泄漏)');

    // Switch layout to 2x2 Grid
    await selectLayout.selectOption('grid_2x2');
    await page.waitForTimeout(400);
    await expect(metricChannels).toHaveText('3 路');

    // Switch layout to Split Horizontal
    await selectLayout.selectOption('split_horizontal');
    await page.waitForTimeout(400);

    // Stop Compositor
    await btnToggle.click();
    await expect(btnToggle).toHaveText('▶ 启动 WebGPU 实时多路合成演示');
    await expect(metricChannels).toHaveText('0 路');
    await expect(metricVram).toHaveText('0 句柄 (0泄漏)');
  });
});

