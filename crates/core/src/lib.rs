pub mod bitstream;
pub mod demuxer;
pub mod engine;
pub mod filter;
pub mod frame;
pub mod muxer;
pub mod packet;
pub mod timeline;

pub use engine::{create_rust_packet, create_rust_timeline, RustDemuxer, RustStreamAnalyzer, RustWasmMp4Muxer};
pub use filter::RustCpuFilter;
pub use frame::{ColorSpace, FrameMetadata, PixelFormat};
pub use muxer::{RustMp4Muxer, VideoTrackConfig, AudioTrackConfig};
pub use packet::Packet;
pub use timeline::TimelineQueue;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

/// Initialize panic hook and logging for debugging in browser console.
#[wasm_bindgen]
pub fn init_core() {
    log("🚀 [Web-FFmpeg-Core] Rust Native WASM Media Engine initialized successfully.");
}

/// Inspect capabilities and print version.
#[wasm_bindgen]
pub fn get_engine_version() -> String {
    "0.1.0-alpha (Rust-Native Web-FFmpeg-GPU)".to_string()
}
