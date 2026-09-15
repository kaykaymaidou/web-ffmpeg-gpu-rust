import { defineConfig } from 'vite';
import * as path from 'node:path';

export default defineConfig({
  build: {
    target: 'node18',
    ssr: true,
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      external: [
        'node:fs',
        'node:path',
        'node:crypto',
        'node:os',
        'node:child_process',
        'node:process',
        'node:events',
        'node:url',
        'node:util',
        'node:buffer',
      ],
    },
  },
});
