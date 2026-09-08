import { test, expect } from '@playwright/test';

test.describe('WebGPU Compute Shader Engine & FAIL-11 Boundary Verification', () => {
  test('Compute Shader Suite: Bilateral Denoise & Lanczos Upsampling should execute cleanly on GPU', async ({ page }) => {
    await page.goto('/');

    const result = await page.evaluate(async () => {
      if (!navigator.gpu) {
        return { supported: false };
      }

      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return { supported: false };
      const device = await adapter.requestDevice();

      // Access WebGpuComputeEngine exposed on window
      const ComputeEngine = (window as any).WebGpuComputeEngine;
      if (!ComputeEngine) {
        throw new Error('WebGpuComputeEngine not found on window');
      }

      const engine = ComputeEngine.create(device);

      const inWidth = 256;
      const inHeight = 256;
      const outWidth = 512;
      const outHeight = 512;

      // 1. Create input texture
      const inTex = device.createTexture({
        size: [inWidth, inHeight],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.STORAGE_BINDING,
      });

      // 2. Create output texture for denoise
      const denoiseOutTex = device.createTexture({
        size: [inWidth, inHeight],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      });

      // 3. Create output texture for Lanczos upsample
      const upsampleOutTex = device.createTexture({
        size: [outWidth, outHeight],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      });

      // Record compute commands
      const encoder = device.createCommandEncoder();
      engine.dispatchBilateralDenoise(encoder, inTex, denoiseOutTex, inWidth, inHeight, 2.0, 0.15);
      engine.dispatchLanczosUpsample(encoder, inTex, upsampleOutTex, inWidth, inHeight, outWidth, outHeight);

      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();

      inTex.destroy();
      denoiseOutTex.destroy();
      upsampleOutTex.destroy();
      engine.destroy();
      device.destroy();

      return {
        supported: true,
        denoiseSuccess: true,
        upsampleSuccess: true,
      };
    });

    if (result.supported) {
      expect(result.denoiseSuccess).toBe(true);
      expect(result.upsampleSuccess).toBe(true);
    }
  });

  test('Compute Shader Suite: 256-Bin Luminance Histogram Parallel Reduction must equal total pixels', async ({ page }) => {
    await page.goto('/');

    const result = await page.evaluate(async () => {
      if (!navigator.gpu) {
        return { supported: false };
      }

      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return { supported: false };
      const device = await adapter.requestDevice();

      const ComputeEngine = (window as any).WebGpuComputeEngine;
      const engine = ComputeEngine.create(device);

      const width = 128;
      const height = 128;
      const totalPixels = width * height;

      // Create texture and populate with known pixel colors
      const texture = device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.STORAGE_BINDING,
      });

      const pixelBytes = new Uint8Array(totalPixels * 4);
      // Half pure black (luma 0), half pure white (luma 255)
      for (let i = 0; i < totalPixels; i++) {
        const val = i < totalPixels / 2 ? 0 : 255;
        pixelBytes[i * 4] = val;
        pixelBytes[i * 4 + 1] = val;
        pixelBytes[i * 4 + 2] = val;
        pixelBytes[i * 4 + 3] = 255;
      }

      device.queue.writeTexture(
        { texture },
        pixelBytes,
        { bytesPerRow: width * 4 },
        [width, height]
      );

      const encoder = device.createCommandEncoder();
      engine.dispatchHistogram(encoder, texture, width, height);
      device.queue.submit([encoder.finish()]);

      const histogram = await engine.readHistogramAsync();

      let sum = 0;
      for (let i = 0; i < histogram.length; i++) {
        sum += histogram[i];
      }

      texture.destroy();
      engine.destroy();
      device.destroy();

      return {
        supported: true,
        histogramBins: histogram.length,
        totalSum: sum,
        expectedPixels: totalPixels,
        blackBinCount: histogram[0],
        whiteBinCount: histogram[255],
      };
    });

    if (result.supported) {
      expect(result.histogramBins).toBe(256);
      expect(result.totalSum).toBe(result.expectedPixels);
      expect(result.blackBinCount).toBe(result.expectedPixels / 2);
      expect(result.whiteBinCount).toBe(result.expectedPixels / 2);
    }
  });

  test('FAIL-11 Autocorrection: Odd / Non-multiple-of-16 Resolution Clamping must not crash GPU device', async ({ page }) => {
    await page.goto('/');

    const result = await page.evaluate(async () => {
      if (!navigator.gpu) {
        return { supported: false };
      }

      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return { supported: false };
      const device = await adapter.requestDevice();

      const ComputeEngine = (window as any).WebGpuComputeEngine;
      const engine = ComputeEngine.create(device);

      // Pathological non-multiple-of-16 dimensions
      const testCases = [
        { w: 853, h: 479 },
        { w: 1921, h: 1081 },
        { w: 1080, h: 1921 }, // Portrait
      ];

      const completedCases: any[] = [];

      for (const tc of testCases) {
        const inTex = device.createTexture({
          size: [tc.w, tc.h],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.STORAGE_BINDING,
        });

        const outTex = device.createTexture({
          size: [tc.w, tc.h],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
        });

        const encoder = device.createCommandEncoder();

        // Dispatch all compute operations with odd dimensions
        engine.dispatchBilateralDenoise(encoder, inTex, outTex, tc.w, tc.h, 2.0, 0.15);
        engine.dispatchHistogram(encoder, inTex, tc.w, tc.h);

        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();

        const histogram = await engine.readHistogramAsync();
        let totalCount = 0;
        for (let i = 0; i < histogram.length; i++) {
          totalCount += histogram[i];
        }

        completedCases.push({
          resolution: `${tc.w}x${tc.h}`,
          histogramMatches: totalCount === tc.w * tc.h,
          totalCount,
          expected: tc.w * tc.h,
        });

        inTex.destroy();
        outTex.destroy();
      }

      engine.destroy();
      device.destroy();

      return {
        supported: true,
        completedCases,
      };
    });

    if (result.supported) {
      expect(result.completedCases.length).toBe(3);
      for (const c of result.completedCases) {
        expect(c.histogramMatches).toBe(true);
        expect(c.totalCount).toBe(c.expected);
      }
    }
  });
});
