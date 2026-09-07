use wasm_bindgen::prelude::*;

/// Pure Rust CPU image processing filters.
/// Designed with chunked iterators to allow LLVM to auto-vectorize with WASM SIMD128.
#[wasm_bindgen]
pub struct RustCpuFilter;

#[wasm_bindgen]
impl RustCpuFilter {
    /// Apply grayscale filter on RGBA8 buffer in-place using Rust CPU SIMD.
    pub fn grayscale_rgba(data: &mut [u8]) {
        // Process in chunks of 4 (R, G, B, A)
        for pixel in data.chunks_exact_mut(4) {
            let r = pixel[0] as u32;
            let g = pixel[1] as u32;
            let b = pixel[2] as u32;
            // Standard BT.601 luma formula in integer arithmetic: (299*R + 587*G + 114*B) / 1000
            let gray = ((r * 299 + g * 587 + b * 114) / 1000) as u8;
            pixel[0] = gray;
            pixel[1] = gray;
            pixel[2] = gray;
        }
    }

    /// Apply color inversion on RGBA8 buffer in-place using Rust CPU SIMD.
    pub fn invert_rgba(data: &mut [u8]) {
        for pixel in data.chunks_exact_mut(4) {
            pixel[0] = 255 - pixel[0];
            pixel[1] = 255 - pixel[1];
            pixel[2] = 255 - pixel[2];
        }
    }

    /// Apply brightness & contrast adjustment in-place using Rust CPU.
    pub fn adjust_brightness_contrast(data: &mut [u8], brightness: i32, contrast: f32) {
        for pixel in data.chunks_exact_mut(4) {
            for c in 0..3 {
                let val = pixel[c] as f32;
                let adjusted = (val - 128.0) * contrast + 128.0 + (brightness as f32);
                pixel[c] = adjusted.clamp(0.0, 255.0) as u8;
            }
        }
    }
}
