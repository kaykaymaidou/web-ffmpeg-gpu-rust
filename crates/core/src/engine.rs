use wasm_bindgen::prelude::*;
use crate::demuxer::mp4::{Mp4Demuxer, RustDemuxedTrack};
use crate::bitstream::converter::{annex_b_to_avcc, avcc_to_annex_b};
use crate::bitstream::h264::{build_avcc, parse_sps, split_annex_b, NalUnitType};
use crate::bitstream::h265::{build_hvcc, parse_hevc_sps, split_hevc_annex_b, HevcNalUnitType};
use crate::muxer::mp4::{RustMp4Muxer, VideoTrackConfig, AudioTrackConfig};
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

    /// Primary video track codec string (e.g. "avc1.640028" or "hvc1.1.6.L93.B0").
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

    /// Check if primary video track is HEVC / H.265.
    pub fn is_hevc(&self) -> bool {
        self.tracks
            .first()
            .map(|t| t.codec.starts_with("hvc1") || t.codec.starts_with("hev1"))
            .unwrap_or(false)
    }

    /// Extradata description box (e.g. avcC or hvcC).
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

/// Rust-native stream feeder with in-band parameter set extraction (H.264 avcC & H.265 hvcC + HDR10).
#[wasm_bindgen]
pub struct RustStreamAnalyzer {
    current_sps: Option<Vec<u8>>,
    current_pps: Option<Vec<u8>>,
    current_hevc_vps: Option<Vec<u8>>,
    current_hevc_sps: Option<Vec<u8>>,
    current_hevc_pps: Option<Vec<u8>>,
    is_hevc: bool,
    is_hdr: bool,
}

#[wasm_bindgen]
impl RustStreamAnalyzer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            current_sps: None,
            current_pps: None,
            current_hevc_vps: None,
            current_hevc_sps: None,
            current_hevc_pps: None,
            is_hevc: false,
            is_hdr: false,
        }
    }

    /// Check if analyzed stream is H.265 / HEVC.
    pub fn is_hevc(&self) -> bool {
        self.is_hevc
    }

    /// Check if analyzed stream has HDR10 colorimetry (BT.2020 / PQ / HLG).
    pub fn is_hdr(&self) -> bool {
        self.is_hdr
    }

    /// Analyze a streaming packet chunk.
    /// Returns codec string if SPS was detected/updated.
    pub fn analyze_packet(&mut self, data: &[u8]) -> Option<String> {
        // 1. Try H.265 NAL parsing
        let hevc_nals = split_hevc_annex_b(data);
        let has_hevc_ps = hevc_nals.iter().any(|n| n.unit_type.is_param_set());

        if has_hevc_ps {
            self.is_hevc = true;
            let mut codec_str = None;

            for nal in hevc_nals {
                match nal.unit_type {
                    HevcNalUnitType::VpsNut => {
                        self.current_hevc_vps = Some(nal.data.to_vec());
                    }
                    HevcNalUnitType::SpsNut => {
                        self.current_hevc_sps = Some(nal.data.to_vec());
                        if let Some(info) = parse_hevc_sps(nal.data) {
                            self.is_hdr = info.is_hdr;
                            codec_str = Some(info.codec_string);
                        }
                    }
                    HevcNalUnitType::PpsNut => {
                        self.current_hevc_pps = Some(nal.data.to_vec());
                    }
                    _ => {}
                }
            }

            if codec_str.is_some() {
                return codec_str;
            }
        }

        // 2. Fallback to H.264 NAL parsing
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

    /// Build configuration description box: `hvcC` for HEVC or `avcC` for H.264.
    pub fn get_description(&self) -> Option<Vec<u8>> {
        if self.is_hevc {
            match (&self.current_hevc_vps, &self.current_hevc_sps, &self.current_hevc_pps) {
                (Some(vps), Some(sps), Some(pps)) => Some(build_hvcc(vps, sps, pps)),
                _ => None,
            }
        } else {
            self.get_avcc_description()
        }
    }

    /// Build AVCC extradata configuration from stored SPS and PPS.
    pub fn get_avcc_description(&self) -> Option<Vec<u8>> {
        match (&self.current_sps, &self.current_pps) {
            (Some(sps), Some(pps)) => Some(build_avcc(sps, pps)),
            _ => None,
        }
    }

    /// Check if packet contains an IDR / IRAP keyframe slice.
    pub fn is_keyframe(&self, data: &[u8]) -> bool {
        if self.is_hevc {
            let nals = split_hevc_annex_b(data);
            nals.iter().any(|n| n.unit_type.is_keyframe())
        } else {
            let nals = split_annex_b(data);
            nals.iter().any(|n| n.unit_type == NalUnitType::IdrSlice)
        }
    }
}

/// Standalone WASM converter: Annex-B to AVCC.
#[wasm_bindgen]
pub fn rust_annex_b_to_avcc(annex_b: &[u8]) -> Vec<u8> {
    annex_b_to_avcc(annex_b)
}

/// Standalone WASM converter: AVCC to Annex-B.
#[wasm_bindgen]
pub fn rust_avcc_to_annex_b(avcc: &[u8]) -> Vec<u8> {
    avcc_to_annex_b(avcc)
}

/// Standalone WASM builder: build ISO 14496-15 hvcC box.
#[wasm_bindgen]
pub fn rust_build_hvcc(vps: &[u8], sps: &[u8], pps: &[u8]) -> Vec<u8> {
    build_hvcc(vps, sps, pps)
}

/// Standalone WASM builder: build ISO 14496-15 avcC box.
#[wasm_bindgen]
pub fn rust_build_avcc(sps: &[u8], pps: &[u8]) -> Vec<u8> {
    build_avcc(sps, pps)
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

/// WASM-exported MP4 Muxer with FastStart streaming support.
#[wasm_bindgen]
pub struct RustWasmMp4Muxer {
    inner: RustMp4Muxer,
}

#[wasm_bindgen]
impl RustWasmMp4Muxer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: RustMp4Muxer::new(),
        }
    }

    pub fn set_video_track(&mut self, width: u32, height: u32, timescale: u32, sps: Vec<u8>, pps: Vec<u8>) {
        self.inner.set_video_track(VideoTrackConfig::new_h264(
            width,
            height,
            timescale,
            sps,
            pps,
        ));
    }

    pub fn set_hevc_video_track(&mut self, width: u32, height: u32, timescale: u32, vps: Vec<u8>, sps: Vec<u8>, pps: Vec<u8>) {
        self.inner.set_video_track(VideoTrackConfig::new_h265(
            width,
            height,
            timescale,
            vps,
            sps,
            pps,
        ));
    }

    pub fn set_audio_track(&mut self, timescale: u32, sample_rate: u32, channels: u16, config: Option<Vec<u8>>) {
        self.inner.set_audio_track(AudioTrackConfig {
            timescale,
            sample_rate,
            channels,
            config,
        });
    }

    pub fn write_video_sample(&mut self, data: &[u8], duration_ticks: u32, is_key: bool) {
        self.inner.write_video_sample(data, duration_ticks, is_key);
    }

    pub fn write_audio_sample(&mut self, data: &[u8], duration_ticks: u32) {
        self.inner.write_audio_sample(data, duration_ticks);
    }

    pub fn finalize(&self) -> Vec<u8> {
        self.inner.finalize()
    }
}
