/**
 * Lazy loader for crates/core wasm-bindgen package (`packages/core/pkg`).
 * Build first: `npm run build:wasm`
 */
import init, {
  init_core,
  get_engine_version,
  RustDemuxer,
  RustWasmMp4Muxer,
  RustCpuFilter,
} from '../../pkg/web_ffmpeg_core.js';

export type RustCoreModule = {
  init_core: typeof init_core;
  get_engine_version: typeof get_engine_version;
  RustDemuxer: typeof RustDemuxer;
  RustWasmMp4Muxer: typeof RustWasmMp4Muxer;
  RustCpuFilter: typeof RustCpuFilter;
};

let initPromise: Promise<RustCoreModule> | null = null;

export async function loadRustCore(): Promise<RustCoreModule> {
  if (!initPromise) {
    initPromise = (async () => {
      const wasmUrl = new URL('../../pkg/web_ffmpeg_core_bg.wasm', import.meta.url).href;
      await init({ module_or_path: wasmUrl });
      init_core();
      return {
        init_core,
        get_engine_version,
        RustDemuxer,
        RustWasmMp4Muxer,
        RustCpuFilter,
      };
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

export async function getRustEngineVersion(): Promise<string> {
  const mod = await loadRustCore();
  return mod.get_engine_version();
}

export { RustDemuxer, RustWasmMp4Muxer, RustCpuFilter };
