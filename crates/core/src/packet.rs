use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// Media packet representing a compressed frame/chunk of data (analogous to FFmpeg's `AVPacket`).
#[wasm_bindgen]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Packet {
    /// Presentation timestamp (in microseconds)
    pts: i64,
    /// Decompression timestamp (in microseconds)
    dts: i64,
    /// Duration of this packet (in microseconds)
    duration: u64,
    /// True if this is an IDR/Key frame
    is_keyframe: bool,
    /// Stream index (e.g., 0 for video, 1 for audio)
    stream_index: u32,
    /// Raw compressed bitstream payload (e.g., Annex-B NAL units)
    data: Vec<u8>,
}

#[wasm_bindgen]
impl Packet {
    #[wasm_bindgen(constructor)]
    pub fn new(
        pts: i64,
        dts: i64,
        duration: u64,
        is_keyframe: bool,
        stream_index: u32,
        data: Vec<u8>,
    ) -> Self {
        Self {
            pts,
            dts,
            duration,
            is_keyframe,
            stream_index,
            data,
        }
    }

    #[wasm_bindgen(getter)]
    pub fn pts(&self) -> i64 {
        self.pts
    }

    #[wasm_bindgen(getter)]
    pub fn dts(&self) -> i64 {
        self.dts
    }

    #[wasm_bindgen(getter)]
    pub fn duration(&self) -> u64 {
        self.duration
    }

    #[wasm_bindgen(getter)]
    pub fn is_keyframe(&self) -> bool {
        self.is_keyframe
    }

    #[wasm_bindgen(getter)]
    pub fn stream_index(&self) -> u32 {
        self.stream_index
    }

    #[wasm_bindgen(getter)]
    pub fn data(&self) -> Vec<u8> {
        self.data.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn size(&self) -> usize {
        self.data.len()
    }
}
