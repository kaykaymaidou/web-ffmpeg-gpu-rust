use wasm_bindgen::prelude::*;
use crate::demuxer::mp4::{Mp4Demuxer, RustDemuxedTrack};
use crate::bitstream::h264::{build_avcc, parse_sps, split_annex_b, NalUnitType};
use crate::timeline::TimelineQueue;
use crate::packet::Packet;

/// Rust-native high-performance WASM Demuxer.
#[wasm_bindgen]
pub struct RustDemuxer {
    data: Vec<u8>,
    tracks: Vec<RustDemuxedTrack>,
}

#[wasm_bindgen]
impl RustDemuxer {
    #[wasm_bindgen(constructor)]
    pub fn new(data: Vec<u8>) -> Self {
        let demuxer = Mp4Demuxer::new(&data);
        let tracks = demuxer.parse();
        Self { data, tracks }
    }

    /// Number of tracks found in container.
    pub fn track_count(&self) -> usize {
        self.tracks.len()
    }

    /// Primary video track codec string (e.g. "avc1.640028").
    pub fn video_codec(&self) -> Option<String> {
        self.tracks.first().map(|t| t.codec.clone())
    }

    pub fn video_width(&self) -> u32 {
        self.tracks.first().map(|t| t.width).unwrap_or(0)
    }

    pub fn video_height(&self) -> u32 {
        self.tracks.first().map(|t| t.height).unwrap_or(0)
    }

    pub fn video_timescale(&self) -> u32 {
        self.tracks.first().map(|t| t.timescale).unwrap_or(30000)
    }

    /// Extradata description box (e.g. avcC).
    pub fn video_description(&self) -> Option<Vec<u8>> {
        self.tracks.first().and_then(|t| t.description.clone())
    }

    /// Total sample count in the primary video track.
    pub fn sample_count(&self) -> usize {
        self.tracks.first().map(|t| t.samples.len()).unwrap_or(0)
    }

    /// Extract a specific sample's raw compressed bitstream payload.
    pub fn get_sample_data(&self, index: usize) -> Option<Vec<u8>> {
        let sample = self.tracks.first()?.samples.get(index)?;
        if sample.offset + sample.size <= self.data.len() {
            Some(self.data[sample.offset..sample.offset + sample.size].to_vec())
        } else {
            None
        }
    }

    /// Check if sample at index is a keyframe.
    pub fn is_sample_keyframe(&self, index: usize) -> bool {
        self.tracks
            .first()
            .and_then(|t| t.samples.get(index))
            .map(|s| s.is_key)
            .unwrap_or(false)
    }

    /// Sample presentation timestamp in microseconds.
    pub fn get_sample_pts(&self, index: usize) -> i64 {
        self.tracks
            .first()
            .and_then(|t| t.samples.get(index))
            .map(|s| s.timestamp_us)
            .unwrap_or(0)
    }

    /// Sample duration in microseconds.
    pub fn get_sample_duration(&self, index: usize) -> u64 {
        self.tracks
            .first()
            .and_then(|t| t.samples.get(index))
            .map(|s| s.duration_us)
            .unwrap_or(0)
    }
}

/// Rust-native stream feeder with in-band SPS/PPS parameter set extraction.
#[wasm_bindgen]
pub struct RustStreamAnalyzer {
    current_sps: Option<Vec<u8>>,
    current_pps: Option<Vec<u8>>,
}

#[wasm_bindgen]
impl RustStreamAnalyzer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            current_sps: None,
            current_pps: None,
        }
    }

    /// Analyze a streaming packet chunk.
    /// Returns codec string if SPS was detected/updated.
    pub fn analyze_packet(&mut self, data: &[u8]) -> Option<String> {
        let nals = split_annex_b(data);
        let mut updated_codec = None;

        for nal in nals {
            match nal.unit_type {
                NalUnitType::Sps => {
                    self.current_sps = Some(nal.data.to_vec());
                    if let Some(info) = parse_sps(nal.data) {
                        updated_codec = Some(info.codec_string);
                    }
                }
                NalUnitType::Pps => {
                    self.current_pps = Some(nal.data.to_vec());
                }
                _ => {}
            }
        }

        updated_codec
    }

    /// Build AVCC extradata configuration from stored SPS and PPS.
    pub fn get_avcc_description(&self) -> Option<Vec<u8>> {
        match (&self.current_sps, &self.current_pps) {
            (Some(sps), Some(pps)) => Some(build_avcc(sps, pps)),
            _ => None,
        }
    }

    /// Check if packet contains an IDR keyframe slice.
    pub fn is_keyframe(&self, data: &[u8]) -> bool {
        let nals = split_annex_b(data);
        nals.iter().any(|n| n.unit_type == NalUnitType::IdrSlice)
    }
}

/// Helper to create and initialize a Rust Timeline queue.
#[wasm_bindgen]
pub fn create_rust_timeline(max_delay_frames: usize) -> TimelineQueue {
    TimelineQueue::new(max_delay_frames)
}

/// Create a packet instance in Rust.
#[wasm_bindgen]
pub fn create_rust_packet(
    pts: i64,
    dts: i64,
    duration: u64,
    is_keyframe: bool,
    stream_index: u32,
    data: Vec<u8>,
) -> Packet {
    Packet::new(pts, dts, duration, is_keyframe, stream_index, data)
}
