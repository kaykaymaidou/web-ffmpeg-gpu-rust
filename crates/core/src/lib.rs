pub mod packet;
pub mod frame;
pub mod timeline;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

/// Initialize panic hook and logging for debugging in browser console.
#[wasm_bindgen]
pub fn init_core() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
    log("🚀 [Web-FFmpeg-Core] Rust WASM Media Engine initialized successfully.");
}

/// Inspect capabilities and print version.
#[wasm_bindgen]
pub fn get_engine_version() -> String {
    "0.1.0-alpha (Web-FFmpeg-GPU)".to_string()
}
