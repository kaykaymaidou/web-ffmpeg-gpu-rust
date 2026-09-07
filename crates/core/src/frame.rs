use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// Pixel format enumeration (analogous to FFmpeg's `AVPixelFormat`).
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PixelFormat {
    Rgba8 = 0,
    Bgra8 = 1,
    Yuv420p = 2,
    Nv12 = 3,
    /// Hardware texture reference managed by WebGPU / WebCodecs VideoFrame
    WebGpuTexture = 4,
}

/// Color space metadata (critical to prevent washed-out colors).
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ColorSpace {
    Bt709 = 0,
    Bt601 = 1,
    Bt2020 = 2,
    Srgb = 3,
}

/// Decoded video frame metadata (analogous to FFmpeg's `AVFrame`).
#[wasm_bindgen]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameMetadata {
    pub width: u32,
    pub height: u32,
    pub pts: i64,
    pub format: PixelFormat,
    pub color_space: ColorSpace,
    pub is_key: bool,
}

#[wasm_bindgen]
impl FrameMetadata {
    #[wasm_bindgen(constructor)]
    pub fn new(
        width: u32,
        height: u32,
        pts: i64,
        format: PixelFormat,
        color_space: ColorSpace,
        is_key: bool,
    ) -> Self {
        Self {
            width,
            height,
            pts,
            format,
            color_space,
            is_key,
        }
    }
}
