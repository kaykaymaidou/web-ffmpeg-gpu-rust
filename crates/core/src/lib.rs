pub mod audio;
pub mod bitstream;
pub mod demuxer;
pub mod engine;
pub mod filter;
pub mod frame;
pub mod live;
pub mod muxer;
pub mod packet;
pub mod timeline;

pub use audio::{
    mix_51_to_stereo, mix_channels, mix_mono_to_stereo, mix_stereo_to_mono, resample_linear,
    soft_clip, AudioResampler, ChannelLayout, MixerError, ResampleError, ResamplerConfig,
};
pub use bitstream::{
    annex_b_to_avcc, avcc_to_annex_b, build_adts_header, build_audio_specific_config,
    build_av1c_config, build_avcc, build_hvcc, decode_leb128, parse_adts_header,
    parse_audio_specific_config, parse_av1_sequence_header, parse_hevc_sps, parse_obus, parse_sps,
    split_annex_b, split_hevc_annex_b, AdtsHeader, Av1SequenceHeader, HevcNalUnit,
    HevcNalUnitType, HevcSpsInfo, NalUnit, NalUnitType, ObuType, ObuUnit, SpsInfo,
};
pub use demuxer::{
    demux_mkv, MkvDemuxError, MkvDemuxResult, MkvFrame, MkvTrack, Mp4Demuxer, RustDemuxedSample,
    RustDemuxedTrack, TsDemuxedSample, TsDemuxer, TsElementaryStream, TsStreamKind,
};
pub use engine::{create_rust_packet, create_rust_timeline, RustDemuxer, RustStreamAnalyzer, RustWasmMp4Muxer};
pub use filter::{
    negotiate_filter_target, parse_filtergraph, FilterGraph, FilterNode, FilterParseError,
    FilterTarget, RustCpuFilter,
};
pub use frame::{ColorSpace, FrameMetadata, PixelFormat};
pub use live::{FlvHeader, FlvVideoTagInfo, JitterBuffer, JitterBufferConfig, RustFlvDemuxer};
pub use muxer::{AudioTrackConfig, RustMp4Muxer, VideoCodec, VideoTrackConfig};
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
