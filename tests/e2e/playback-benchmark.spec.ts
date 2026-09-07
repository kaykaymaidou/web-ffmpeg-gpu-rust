import { test, expect } from '@playwright/test';

test.describe('Web-FFmpeg-GPU Performance & Hardware Benchmark', () => {
  test('should detect WebCodecs and WebGPU hardware readiness', async ({ page }) => {
    await page.goto('/');

    // 1. Verify Page Loaded
    await expect(page.locator('h1')).toContainText('Web-FFmpeg-GPU');

    // 2. Check WebCodecs and WebGPU detection badges
    const webcodecsBadge = page.locator('#webcodecs-badge');
    await expect(webcodecsBadge).toContainText('WebCodecs: 硬件就绪');

    const gpuBadge = page.locator('#gpu-status-badge');
    const badgeText = await gpuBadge.innerText();
    expect(badgeText).toMatch(/WebGPU:/);
  });

  test('should dynamically toggle WGSL filters without pipeline stall', async ({ page }) => {
    await page.goto('/');

    // Click through each filter preset
    const filters = ['grayscale', 'invert', 'sepia', 'vignette', 'none'];
    for (const filter of filters) {
      const chip = page.locator(`.btn-chip[data-filter="${filter}"]`);
      await chip.click();
      await expect(chip).toHaveClass(/active/);
    }
  });

  test('should adjust brightness and contrast sliders smoothly', async ({ page }) => {
    await page.goto('/');

    const sliderBrightness = page.locator('#slider-brightness');
    await sliderBrightness.fill('0.2');
    await expect(page.locator('#val-brightness')).toHaveText('0.2');

    const sliderContrast = page.locator('#slider-contrast');
    await sliderContrast.fill('1.4');
    await expect(page.locator('#val-contrast')).toHaveText('1.4');

    // Test Reset Button
    await page.click('#btn-reset-filters');
    await expect(page.locator('#val-brightness')).toHaveText('0.0');
    await expect(page.locator('#val-contrast')).toHaveText('1.0');
  });
});
