import { loadRustCore } from '../wasm/rust-core.js';

export interface AudioResampleOptions {
  fromRate: number;
  toRate: number;
  channels: number;
}

/**
 * Pure Rust Audio DSP Engine for Web Audio / WebCodecs.
 *
 * Provides high-speed sample-rate conversion, ITU-R BS.775 5.1-to-stereo downmixing,
 * and soft-clipping saturation.
 */
export class AudioDsp {
  /**
   * Resample interleaved Float32Array PCM audio.
   */
  static async resample(
    input: Float32Array,
    options: AudioResampleOptions
  ): Promise<Float32Array> {
    if (options.fromRate === options.toRate) {
      return input.slice();
    }
    const mod = await loadRustCore();
    // @ts-ignore
    const result = mod.RustAudioDsp.resample(
      input,
      options.fromRate,
      options.toRate,
      options.channels
    );
    return new Float32Array(result);
  }

  /**
   * Downmix 5.1 Surround audio to Stereo using ITU-R BS.775 power normalization.
   */
  static async downmix51ToStereo(
    input: Float32Array,
    includeLfe: boolean = false
  ): Promise<Float32Array> {
    const mod = await loadRustCore();
    // @ts-ignore
    const result = mod.RustAudioDsp.downmix_51_to_stereo(input, includeLfe);
    return new Float32Array(result);
  }

  /**
   * Downmix Stereo to Mono (0.5 * L + 0.5 * R).
   */
  static async downmixStereoToMono(input: Float32Array): Promise<Float32Array> {
    const mod = await loadRustCore();
    // @ts-ignore
    const result = mod.RustAudioDsp.downmix_stereo_to_mono(input);
    return new Float32Array(result);
  }

  /**
   * Upmix Mono to dual-channel Stereo (L = M, R = M).
   */
  static async upmixMonoToStereo(input: Float32Array): Promise<Float32Array> {
    const mod = await loadRustCore();
    // @ts-ignore
    const result = mod.RustAudioDsp.upmix_mono_to_stereo(input);
    return new Float32Array(result);
  }
}
