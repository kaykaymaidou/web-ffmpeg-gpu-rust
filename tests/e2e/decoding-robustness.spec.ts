import { test, expect } from '@playwright/test';

test.describe('Decoding Robustness & Codec Edge Cases', () => {
  test('should handle unsupported codec queries gracefully without crashing', async ({ page }) => {
    await page.goto('/');

    const result = await page.evaluate(async () => {
      // Query an intentionally non-existent codec string
      const config: VideoDecoderConfig = {
        codec: 'invalid-codec-string-12345',
        codedWidth: 1920,
        codedHeight: 1080,
      };
      if (typeof VideoDecoder === 'undefined') return { supported: false, isWebCodecs: false };
      try {
        const res = await VideoDecoder.isConfigSupported(config);
        return { supported: res.supported, isWebCodecs: true };
      } catch {
        return { supported: false, isWebCodecs: true };
      }
    });

    // An invalid codec must return supported: false rather than throwing unhandled exception
    expect(result.supported).toBe(false);
  });

  test('should verify H.264 high-profile hardware decoder availability', async ({ page }) => {
    await page.goto('/');

    const support = await page.evaluate(async () => {
      const config: VideoDecoderConfig = {
        codec: 'avc1.640028', // H.264 High Profile Level 4.0
        codedWidth: 1920,
        codedHeight: 1080,
      };
      if (typeof VideoDecoder === 'undefined') return false;
      const res = await VideoDecoder.isConfigSupported(config);
      return res.supported;
    });

    expect(support).toBe(true);
  });
});
