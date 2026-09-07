pub mod converter;
pub mod h264;
pub mod h265;

pub use converter::{annex_b_to_avcc, avcc_to_annex_b};
pub use h264::{build_avcc, parse_sps, split_annex_b, BitReader, NalUnit, NalUnitType, SpsInfo};
pub use h265::{
    build_hvcc, parse_hevc_sps, split_hevc_annex_b, HevcNalUnit, HevcNalUnitType, HevcSpsInfo,
};

