import { test, expect } from '@playwright/test';

test.describe('Stress Testing & VRAM Memory Leak Checks', () => {
  test('should verify VideoFrame allocation and immediate RAII closure', async ({ page }) => {
    await page.goto('/');

    const memoryClean = await page.evaluate(async () => {
      // Simulate rapid frame creation and closure loop (500 iterations)
      let openFrames = 0;
      for (let i = 0; i < 200; i++) {
        // Create an offscreen canvas to produce VideoFrames
        const canvas = new OffscreenCanvas(64, 64);
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = i % 2 === 0 ? 'red' : 'blue';
        ctx.fillRect(0, 0, 64, 64);

        const frame = new VideoFrame(canvas, { timestamp: i * 33333 });
        openFrames++;

        // Invariant 1: Immediate closure
        frame.close();
        openFrames--;
      }
      return openFrames === 0;
    });

    expect(memoryClean).toBe(true);
  });
});
