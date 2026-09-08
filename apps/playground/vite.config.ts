import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  server: {
    port: 3000,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  resolve: {
    alias: {
      '@web-ffmpeg-gpu/core': resolve(__dirname, '../../packages/core/src/index.ts'),
      '@web-ffmpeg-gpu/mcp-server': resolve(__dirname, '../../packages/mcp-server/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist',
  },
});
