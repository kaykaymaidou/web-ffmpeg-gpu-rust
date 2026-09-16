import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadRustCore } from '@web-ffmpeg-gpu/core';

export interface ServiceConfig {
  watchDir: string;
  outputDir: string;
  pollIntervalMs: number;
}

export class WindowsTranscodeDaemon {
  private isRunning: boolean = false;
  private timer: NodeJS.Timeout | null = null;
  private processingSet: Set<string> = new Set();

  constructor(private config: ServiceConfig) {}

  async start(): Promise<void> {
    console.log('[INFO] [daemon] Starting background transcode daemon...');
    const rustCore = await loadRustCore();
    console.log(`[INFO] [daemon] Rust core linked: ${rustCore.get_engine_version()}`);

    if (!fs.existsSync(this.config.watchDir)) {
      fs.mkdirSync(this.config.watchDir, { recursive: true });
    }
    if (!fs.existsSync(this.config.outputDir)) {
      fs.mkdirSync(this.config.outputDir, { recursive: true });
    }

    this.isRunning = true;
    this.scheduleNextPoll();
    console.log(`[INFO] [daemon] Watching directory: ${path.resolve(this.config.watchDir)}`);
  }

  stop(): void {
    console.log('[INFO] [daemon] Stopping transcode daemon...');
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNextPoll(): void {
    if (!this.isRunning) return;
    this.timer = setTimeout(async () => {
      try {
        await this.pollOnce();
      } catch (err) {
        console.error('[ERROR] [daemon] Poll error:', err);
      }
      this.scheduleNextPoll();
    }, this.config.pollIntervalMs);
  }

  async pollOnce(): Promise<void> {
    if (!fs.existsSync(this.config.watchDir)) return;
    const files = fs.readdirSync(this.config.watchDir);

    for (const file of files) {
      if (file.endsWith('.tmp') || file.startsWith('.')) continue;
      const fullPath = path.join(this.config.watchDir, file);
      if (this.processingSet.has(fullPath)) continue;

      const stat = fs.statSync(fullPath);
      if (stat.isFile() && stat.size > 0) {
        this.processingSet.add(fullPath);
        console.log(`[INFO] [daemon] Discovered incoming media: ${file} (${(stat.size / 1024).toFixed(1)} KB)`);
        // Dispatch processing
        this.processFile(fullPath, file);
      }
    }
  }

  private async processFile(filePath: string, fileName: string): Promise<void> {
    try {
      const buffer = fs.readFileSync(filePath);
      const mod = await loadRustCore();

      // Quick probe using Rust demuxer
      const demuxer = new mod.RustDemuxer(buffer);
      console.log(`[INFO] [daemon] Probed ${fileName}: tracks=${demuxer.track_count()}, codec=${demuxer.video_codec()}`);

      // In real daemon: transcode or repackage into outputDir
      const destPath = path.join(this.config.outputDir, `${path.parse(fileName).name}_processed.mp4`);
      fs.writeFileSync(destPath, buffer);
      console.log(`[INFO] [daemon] Processed: ${destPath}`);
    } catch (err) {
      console.error(`[ERROR] [daemon] Error processing ${fileName}:`, err);
    } finally {
      this.processingSet.delete(filePath);
    }
  }
}

// Default CLI / Service entry point
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  const daemon = new WindowsTranscodeDaemon({
    watchDir: path.resolve('./incoming'),
    outputDir: path.resolve('./processed'),
    pollIntervalMs: 5000,
  });

  daemon.start().catch(console.error);

  process.on('SIGINT', () => {
    daemon.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    daemon.stop();
    process.exit(0);
  });
}
