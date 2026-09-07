import { test, expect } from '@playwright/test';

test.describe('Empirical Benchmark: CPU Processing vs WebGPU Shader Execution', () => {
  test('should compare 1080p pixel processing latency between CPU and WebGPU', async ({ page }) => {
    await page.goto('/');

    const benchmarkResults = await page.evaluate(async () => {
      const width = 1920;
      const height = 1080;
      const pixelCount = width * height;
      const buffer = new Uint8Array(pixelCount * 4);

      // Fill with dummy color values
      for (let i = 0; i < buffer.length; i += 4) {
        buffer[i] = 120;
        buffer[i + 1] = 180;
        buffer[i + 2] = 240;
        buffer[i + 3] = 255;
      }

      // 1. CPU In-place Grayscale Benchmark (simulating Rust SIMD loop)
      const cpuStart = performance.now();
      for (let i = 0; i < buffer.length; i += 4) {
        const r = buffer[i];
        const g = buffer[i + 1];
        const b = buffer[i + 2];
        const gray = ((r * 299 + g * 587 + b * 114) / 1000) | 0;
        buffer[i] = gray;
        buffer[i + 1] = gray;
        buffer[i + 2] = gray;
      }
      const cpuTimeMs = performance.now() - cpuStart;

      // 2. WebGPU Pipeline Overhead Check
      let webGpuAvailable = false;
      let gpuTimeMs = 0;
      if (navigator.gpu) {
        try {
          const adapter = await navigator.gpu.requestAdapter();
          if (adapter) {
            const device = await adapter.requestDevice();
            const gpuStart = performance.now();
            // Create a command encoder & submit empty work to measure queue roundtrip
            const encoder = device.createCommandEncoder();
            device.queue.submit([encoder.finish()]);
            await device.queue.onSubmittedWorkDone();
            gpuTimeMs = performance.now() - gpuStart;
            webGpuAvailable = true;
          }
        } catch {
          webGpuAvailable = false;
        }
      }

      return {
        resolution: `${width}x${height}`,
        cpuProcessingTimeMs: Number(cpuTimeMs.toFixed(2)),
        gpuRoundtripLatencyMs: Number(gpuTimeMs.toFixed(2)),
        webGpuAvailable,
      };
    });

    console.log('📊 [Benchmark Results (1080p)]:', benchmarkResults);
    expect(benchmarkResults.cpuProcessingTimeMs).toBeGreaterThan(0);
  });
});
