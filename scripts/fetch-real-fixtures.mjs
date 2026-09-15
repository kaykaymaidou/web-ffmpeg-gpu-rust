import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const incomingDir = path.resolve(__dirname, '../tests/fixtures/incoming');

if (!fs.existsSync(incomingDir)) {
  fs.mkdirSync(incomingDir, { recursive: true });
}

const SOURCES = [
  {
    name: 'big-buck-bunny-trailer.mp4',
    url: 'https://www.w3schools.com/html/mov_bbb.mp4',
    description: 'Blender Big Buck Bunny (Standard Web Reference Clip, H.264/AAC)',
  },
  {
    name: 'intel-bottle-detection.mp4',
    url: 'https://raw.githubusercontent.com/intel-iot-devkit/sample-videos/master/bottle-detection.mp4',
    description: 'Intel IoT Sample Benchmark Video (H.264, Real Camera Stream)',
  },
];

async function downloadFile(url, dest) {
  console.log(`⏳ Fetching real-world test clip from: ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(arrayBuffer));
  console.log(`✅ Saved: ${dest} (${(arrayBuffer.byteLength / 1024).toFixed(1)} KB)`);
}

async function main() {
  console.log('🎬 [Fixture Downloader] Acquiring real-world media test clips...');
  for (const item of SOURCES) {
    const dest = path.join(incomingDir, item.name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      console.log(`ℹ️ [Already Exists] ${item.name} (${item.description})`);
    } else {
      await downloadFile(item.url, dest);
    }
  }
  console.log('🎉 All real-world fixtures ready in tests/fixtures/incoming/!');
}

main().catch(console.error);
