/**
 * Copy @ffmpeg/core ESM assets into the playground public dir so Playwright
 * can load ffmpeg.wasm from the same origin (COOP/COEP).
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = join(root, 'node_modules/@ffmpeg/core/dist/esm');
const destDir = join(root, 'apps/playground/public/ffmpeg-wasm');

mkdirSync(destDir, { recursive: true });
for (const name of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  const src = join(coreDir, name);
  if (!existsSync(src)) {
    throw new Error(`missing ${src} — npm install @ffmpeg/core`);
  }
  copyFileSync(src, join(destDir, name));
  console.log(`copied ${name}`);
}
