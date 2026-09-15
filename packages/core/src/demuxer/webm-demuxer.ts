import { loadRustCore } from '../wasm/rust-core.js';

export interface WebmTrackInfo {
  trackNumber: number;
  trackType: 'video' | 'audio' | 'unknown';
  codec: string;
  width?: number;
  height?: number;
}

export interface WebmSample {
  trackNumber: number;
  ptsUs: number;
  isKeyframe: boolean;
  data: Uint8Array;
}

/**
 * Pure Rust WASM Matroska / WebM Demuxer.
 *
 * Extracts EBML tracks and SimpleBlock / Block payloads with zero external C dependencies.
 */
export class WebmDemuxer {
  private wasmDemuxer: any = null;

  constructor(private buffer: Uint8Array) {}

  /**
   * Parse the MKV / WebM container.
   */
  async parse(): Promise<{ tracks: WebmTrackInfo[]; frameCount: number }> {
    const mod = await loadRustCore();
    // @ts-ignore - wasm-bindgen export
    if (!mod.RustMkvDemuxer) {
      throw new Error('RustMkvDemuxer not exported by WASM module');
    }

    // @ts-ignore
    this.wasmDemuxer = new mod.RustMkvDemuxer(this.buffer);

    const trackCount: number = this.wasmDemuxer.track_count();
    const tracks: WebmTrackInfo[] = [];

    for (let i = 0; i < trackCount; i++) {
      const codec = this.wasmDemuxer.get_track_codec(i) || 'unknown';
      const typeNum = this.wasmDemuxer.get_track_type(i);
      const dims = this.wasmDemuxer.get_video_dimensions(i);

      tracks.push({
        trackNumber: i + 1,
        trackType: typeNum === 1 ? 'video' : typeNum === 2 ? 'audio' : 'unknown',
        codec,
        width: dims ? dims[0] : undefined,
        height: dims ? dims[1] : undefined,
      });
    }

    return {
      tracks,
      frameCount: this.wasmDemuxer.frame_count(),
    };
  }

  /**
   * Get all demuxed media frames from the container.
   */
  getFrames(): WebmSample[] {
    if (!this.wasmDemuxer) {
      throw new Error('WebmDemuxer: must call parse() first');
    }

    const count: number = this.wasmDemuxer.frame_count();
    const frames: WebmSample[] = [];

    for (let i = 0; i < count; i++) {
      const data = this.wasmDemuxer.get_frame_data(i);
      if (!data) continue;

      frames.push({
        trackNumber: 1,
        ptsUs: this.wasmDemuxer.get_frame_pts_us(i) ?? 0,
        isKeyframe: this.wasmDemuxer.is_frame_keyframe(i),
        data: new Uint8Array(data),
      });
    }

    return frames;
  }
}
