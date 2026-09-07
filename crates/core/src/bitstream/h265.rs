use serde::{Deserialize, Serialize};
use crate::bitstream::h264::BitReader;

/// H.265 / HEVC NAL Unit types according to ITU-T H.265 / ISO/IEC 23008-2 specification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HevcNalUnitType {
    TrailN = 0,
    TrailR = 1,
    TsaN = 2,
    TsaR = 3,
    StsaN = 4,
    StsaR = 5,
    RadlN = 6,
    RadlR = 7,
    RaslN = 8,
    RaslR = 9,
    BlaWLp = 16,
    BlaWRadl = 17,
    BlaNLp = 18,
    IdrWRadl = 19,
    IdrNLp = 20,
    CraNut = 21,
    VpsNut = 32,
    SpsNut = 33,
    PpsNut = 34,
    AudNut = 35,
    EosNut = 36,
    EobNut = 37,
    FdNut = 38,
    PrefixSeiNut = 39,
    SuffixSeiNut = 40,
    Other = 99,
}

impl HevcNalUnitType {
    pub fn from_byte(b: u8) -> Self {
        let nal_type = (b >> 1) & 0x3f;
        match nal_type {
            0 => HevcNalUnitType::TrailN,
            1 => HevcNalUnitType::TrailR,
            2 => HevcNalUnitType::TsaN,
            3 => HevcNalUnitType::TsaR,
            4 => HevcNalUnitType::StsaN,
            5 => HevcNalUnitType::StsaR,
            6 => HevcNalUnitType::RadlN,
            7 => HevcNalUnitType::RadlR,
            8 => HevcNalUnitType::RaslN,
            9 => HevcNalUnitType::RaslR,
            16 => HevcNalUnitType::BlaWLp,
            17 => HevcNalUnitType::BlaWRadl,
            18 => HevcNalUnitType::BlaNLp,
            19 => HevcNalUnitType::IdrWRadl,
            20 => HevcNalUnitType::IdrNLp,
            21 => HevcNalUnitType::CraNut,
            32 => HevcNalUnitType::VpsNut,
            33 => HevcNalUnitType::SpsNut,
            34 => HevcNalUnitType::PpsNut,
            35 => HevcNalUnitType::AudNut,
            36 => HevcNalUnitType::EosNut,
            37 => HevcNalUnitType::EobNut,
            38 => HevcNalUnitType::FdNut,
            39 => HevcNalUnitType::PrefixSeiNut,
            40 => HevcNalUnitType::SuffixSeiNut,
            _ => HevcNalUnitType::Other,
        }
    }

    /// Check if this NAL unit corresponds to an IRAP keyframe (IDR, CRA, BLA).
    pub fn is_keyframe(&self) -> bool {
        matches!(
            self,
            HevcNalUnitType::BlaWLp
                | HevcNalUnitType::BlaWRadl
                | HevcNalUnitType::BlaNLp
                | HevcNalUnitType::IdrWRadl
                | HevcNalUnitType::IdrNLp
                | HevcNalUnitType::CraNut
        )
    }

    /// Check if this NAL unit is a parameter set (VPS, SPS, PPS).
    pub fn is_param_set(&self) -> bool {
        matches!(
            self,
            HevcNalUnitType::VpsNut | HevcNalUnitType::SpsNut | HevcNalUnitType::PpsNut
        )
    }
}

/// Extracted H.265 NAL unit reference.
#[derive(Debug, Clone)]
pub struct HevcNalUnit<'a> {
    pub unit_type: HevcNalUnitType,
    pub layer_id: u8,
    pub temporal_id: u8,
    pub data: &'a [u8],
}

/// H.265 Sequence Parameter Set (SPS) parsed metadata including HDR10 colorimetry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HevcSpsInfo {
    pub profile_space: u8,
    pub tier_flag: bool,
    pub profile_idc: u8,
    pub level_idc: u8,
    pub width: u32,
    pub height: u32,
    pub bit_depth_luma: u8,
    pub bit_depth_chroma: u8,
    pub chroma_format_idc: u8,
    pub colour_primaries: Option<u8>,
    pub transfer_characteristics: Option<u8>,
    pub matrix_coeffs: Option<u8>,
    pub is_hdr: bool,
    pub codec_string: String,
}

/// Split H.265 Annex-B bitstream (`00 00 00 01` or `00 00 01`) into separate NAL units.
pub fn split_hevc_annex_b<'a>(data: &'a [u8]) -> Vec<HevcNalUnit<'a>> {
    let mut nals = Vec::new();
    let len = data.len();
    let mut start_indices = Vec::new();

    let mut i = 0;
    while i + 2 < len {
        if data[i] == 0 && data[i + 1] == 0 {
            if data[i + 2] == 1 {
                start_indices.push((i, 3));
                i += 3;
                continue;
            } else if i + 3 < len && data[i + 2] == 0 && data[i + 3] == 1 {
                start_indices.push((i, 4));
                i += 4;
                continue;
            }
        }
        i += 1;
    }

    for idx in 0..start_indices.len() {
        let (pos, prefix_len) = start_indices[idx];
        let nal_start = pos + prefix_len;
        let nal_end = if idx + 1 < start_indices.len() {
            start_indices[idx + 1].0
        } else {
            len
        };

        if nal_start + 2 <= nal_end {
            let nal_bytes = &data[nal_start..nal_end];
            let header0 = nal_bytes[0];
            let header1 = nal_bytes[1];

            let unit_type = HevcNalUnitType::from_byte(header0);
            let layer_id = ((header0 & 0x01) << 5) | (header1 >> 3);
            let temporal_id = (header1 & 0x07).saturating_sub(1);

            nals.push(HevcNalUnit {
                unit_type,
                layer_id,
                temporal_id,
                data: nal_bytes,
            });
        }
    }

    nals
}

/// Strip emulation prevention three-byte sequences (0x00 0x00 0x03 -> 0x00 0x00).
pub fn strip_emulation_prevention(data: &[u8]) -> Vec<u8> {
    let mut clean = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        if i + 2 < data.len() && data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 3 {
            clean.push(0);
            clean.push(0);
            i += 3;
        } else {
            clean.push(data[i]);
            i += 1;
        }
    }
    clean
}

/// Parse an H.265 / HEVC Sequence Parameter Set (SPS) NAL unit.
pub fn parse_hevc_sps(sps_data: &[u8]) -> Option<HevcSpsInfo> {
    if sps_data.len() < 4 {
        return None;
    }

    // Check NAL type: must be SPS (33)
    let nal_type = (sps_data[0] >> 1) & 0x3f;
    if nal_type != 33 {
        return None;
    }

    let clean_data = strip_emulation_prevention(sps_data);
    if clean_data.len() < 15 {
        return None;
    }

    // Skip 2-byte NAL unit header
    let mut reader = BitReader::new(&clean_data[2..]);

    let _sps_video_parameter_set_id = reader.read_bits(4)?;
    let sps_max_sub_layers_minus1 = reader.read_bits(3)?;
    let _sps_temporal_id_nesting_flag = reader.read_bit()?;

    // profile_tier_level(1, sps_max_sub_layers_minus1)
    let profile_space = reader.read_bits(2)? as u8;
    let tier_flag = reader.read_bit()? == 1;
    let profile_idc = reader.read_bits(5)? as u8;

    let _general_profile_compatibility_flags = (reader.read_bits(16)? << 16) | reader.read_bits(16)?;

    // progressive_source, interlaced_source, non_packed_constraint, frame_only_constraint
    let _ = reader.read_bits(4)?;
    // general_reserved_zero_44bits
    reader.skip_bits(44)?;

    let level_idc = reader.read_bits(8)? as u8;

    let mut sub_layer_profile_present_flag = Vec::with_capacity(sps_max_sub_layers_minus1 as usize);
    let mut sub_layer_level_present_flag = Vec::with_capacity(sps_max_sub_layers_minus1 as usize);

    for _ in 0..sps_max_sub_layers_minus1 {
        sub_layer_profile_present_flag.push(reader.read_bit()? == 1);
        sub_layer_level_present_flag.push(reader.read_bit()? == 1);
    }

    if sps_max_sub_layers_minus1 > 0 {
        for _ in sps_max_sub_layers_minus1..8 {
            let _ = reader.read_bits(2)?;
        }
    }

    for i in 0..sps_max_sub_layers_minus1 as usize {
        if sub_layer_profile_present_flag.get(i).copied().unwrap_or(false) {
            reader.skip_bits(88)?;
        }
        if sub_layer_level_present_flag.get(i).copied().unwrap_or(false) {
            reader.skip_bits(8)?;
        }
    }

    // SPS parameters
    let _sps_seq_parameter_set_id = reader.read_ue()?;
    let chroma_format_idc = reader.read_ue().unwrap_or(1) as u8;

    if chroma_format_idc == 3 {
        let _separate_colour_plane_flag = reader.read_bit()?;
    }

    let pic_width_in_luma_samples = reader.read_ue()?;
    let pic_height_in_luma_samples = reader.read_ue()?;

    let conformance_window_flag = reader.read_bit()?;
    let mut conf_win_left_offset = 0u32;
    let mut conf_win_right_offset = 0u32;
    let mut conf_win_top_offset = 0u32;
    let mut conf_win_bottom_offset = 0u32;

    if conformance_window_flag == 1 {
        conf_win_left_offset = reader.read_ue().unwrap_or(0);
        conf_win_right_offset = reader.read_ue().unwrap_or(0);
        conf_win_top_offset = reader.read_ue().unwrap_or(0);
        conf_win_bottom_offset = reader.read_ue().unwrap_or(0);
    }

    let bit_depth_luma_minus8 = reader.read_ue().unwrap_or(0);
    let bit_depth_chroma_minus8 = reader.read_ue().unwrap_or(0);

    let bit_depth_luma = (bit_depth_luma_minus8 as u8).saturating_add(8);
    let bit_depth_chroma = (bit_depth_chroma_minus8 as u8).saturating_add(8);

    // Compute cropped width and height
    let sub_width_c = if chroma_format_idc == 1 || chroma_format_idc == 2 { 2 } else { 1 };
    let sub_height_c = if chroma_format_idc == 1 { 2 } else { 1 };

    let crop_w = (conf_win_left_offset.saturating_add(conf_win_right_offset)).saturating_mul(sub_width_c);
    let crop_h = (conf_win_top_offset.saturating_add(conf_win_bottom_offset)).saturating_mul(sub_height_c);

    let width = pic_width_in_luma_samples.saturating_sub(crop_w);
    let height = pic_height_in_luma_samples.saturating_sub(crop_h);

    // Attempt to parse VUI parameters for HDR10 colorimetry
    let mut colour_primaries: Option<u8> = None;
    let mut transfer_characteristics: Option<u8> = None;
    let mut matrix_coeffs: Option<u8> = None;

    let vui_result = (|| -> Option<()> {
        let _log2_max_pic_order_cnt_lsb_minus4 = reader.read_ue()?;
        let sps_sub_layer_ordering_info_present_flag = reader.read_bit()?;
        let start_layer = if sps_sub_layer_ordering_info_present_flag == 1 { 0 } else { sps_max_sub_layers_minus1 };
        for _ in start_layer..=sps_max_sub_layers_minus1 {
            let _ = reader.read_ue()?;
            let _ = reader.read_ue()?;
            let _ = reader.read_ue()?;
        }
        let _log2_min_luma_coding_block_size_minus3 = reader.read_ue()?;
        let _log2_diff_max_min_luma_coding_block_size = reader.read_ue()?;
        let _log2_min_luma_transform_block_size_minus2 = reader.read_ue()?;
        let _log2_diff_max_min_luma_transform_block_size = reader.read_ue()?;
        let _max_transform_hierarchy_depth_inter = reader.read_ue()?;
        let _max_transform_hierarchy_depth_intra = reader.read_ue()?;

        let scaling_list_enabled_flag = reader.read_bit()?;
        if scaling_list_enabled_flag == 1 {
            let sps_scaling_list_data_present_flag = reader.read_bit()?;
            if sps_scaling_list_data_present_flag == 1 {
                for size_id in 0..4 {
                    let matrix_count = if size_id == 3 { 2 } else { 6 };
                    for _ in 0..matrix_count {
                        let pred_mode = reader.read_bit()?;
                        if pred_mode == 0 {
                            let _ = reader.read_ue()?;
                        } else {
                            let coef_num = std::cmp::min(64, 1 << (4 + (size_id << 1)));
                            if size_id > 1 {
                                let _ = reader.read_se()?;
                            }
                            for _ in 0..coef_num {
                                let _ = reader.read_se()?;
                            }
                        }
                    }
                }
            }
        }

        let _amp_enabled_flag = reader.read_bit()?;
        let _sample_adaptive_offset_enabled_flag = reader.read_bit()?;
        let pcm_enabled_flag = reader.read_bit()?;
        if pcm_enabled_flag == 1 {
            reader.skip_bits(8)?;
            let _ = reader.read_ue()?;
            let _ = reader.read_ue()?;
            let _ = reader.read_bit()?;
        }

        let num_short_term_ref_pic_sets = reader.read_ue()?;
        if num_short_term_ref_pic_sets > 64 {
            return None;
        }

        for st_idx in 0..num_short_term_ref_pic_sets {
            let inter_ref = if st_idx != 0 { reader.read_bit()? == 1 } else { false };
            if inter_ref {
                if st_idx == num_short_term_ref_pic_sets {
                    let _ = reader.read_ue()?;
                }
                let _ = reader.read_bit()?;
                let _ = reader.read_ue()?;
                // Skip delta poc flags
            } else {
                let num_neg = reader.read_ue()?;
                let num_pos = reader.read_ue()?;
                for _ in 0..num_neg {
                    let _ = reader.read_ue()?;
                    let _ = reader.read_bit()?;
                }
                for _ in 0..num_pos {
                    let _ = reader.read_ue()?;
                    let _ = reader.read_bit()?;
                }
            }
        }

        let long_term_ref_pics_present_flag = reader.read_bit()?;
        if long_term_ref_pics_present_flag == 1 {
            let num_lt = reader.read_ue()?;
            for _ in 0..num_lt {
                let _ = reader.read_ue()?;
                let _ = reader.read_bit()?;
            }
        }

        let _sps_temporal_mvp_enabled_flag = reader.read_bit()?;
        let _strong_intra_smoothing_enabled_flag = reader.read_bit()?;

        let vui_parameters_present_flag = reader.read_bit()?;
        if vui_parameters_present_flag == 1 {
            let aspect_ratio_info_present_flag = reader.read_bit()?;
            if aspect_ratio_info_present_flag == 1 {
                let aspect_ratio_idc = reader.read_bits(8)?;
                if aspect_ratio_idc == 255 {
                    reader.skip_bits(32)?;
                }
            }
            let overscan_info_present_flag = reader.read_bit()?;
            if overscan_info_present_flag == 1 {
                let _ = reader.read_bit()?;
            }
            let video_signal_type_present_flag = reader.read_bit()?;
            if video_signal_type_present_flag == 1 {
                let _video_format = reader.read_bits(3)?;
                let _video_full_range_flag = reader.read_bit()?;
                let colour_description_present_flag = reader.read_bit()?;
                if colour_description_present_flag == 1 {
                    colour_primaries = Some(reader.read_bits(8)? as u8);
                    transfer_characteristics = Some(reader.read_bits(8)? as u8);
                    matrix_coeffs = Some(reader.read_bits(8)? as u8);
                }
            }
        }

        Some(())
    })();

    let _ = vui_result;

    let is_hdr = transfer_characteristics == Some(16)
        || transfer_characteristics == Some(18)
        || (bit_depth_luma >= 10 && colour_primaries == Some(9));

    let tier_str = if tier_flag { "H" } else { "L" };
    let codec_string = format!("hvc1.{}.6.{}{}.B0", profile_idc, tier_str, level_idc);

    Some(HevcSpsInfo {
        profile_space,
        tier_flag,
        profile_idc,
        level_idc,
        width,
        height,
        bit_depth_luma,
        bit_depth_chroma,
        chroma_format_idc,
        colour_primaries,
        transfer_characteristics,
        matrix_coeffs,
        is_hdr,
        codec_string,
    })
}

/// Construct an ISO/IEC 14496-15 `hvcC` configuration record from VPS, SPS, and PPS.
pub fn build_hvcc(vps: &[u8], sps: &[u8], pps: &[u8]) -> Vec<u8> {
    let mut hvcc = Vec::with_capacity(23 + 3 * 5 + vps.len() + sps.len() + pps.len());

    // Extract basic profile/tier/level from SPS if available
    let (profile_space, tier_flag, profile_idc, level_idc, bit_depth_luma_minus8, bit_depth_chroma_minus8) =
        if let Some(sps_info) = parse_hevc_sps(sps) {
            (
                sps_info.profile_space,
                sps_info.tier_flag,
                sps_info.profile_idc,
                sps_info.level_idc,
                sps_info.bit_depth_luma.saturating_sub(8),
                sps_info.bit_depth_chroma.saturating_sub(8),
            )
        } else {
            (0, false, 1, 93, 0, 0)
        };

    // 1. configurationVersion = 1
    hvcc.push(1);

    // 2. profile_space(2) + tier_flag(1) + profile_idc(5)
    let p_byte = (profile_space << 6) | ((tier_flag as u8) << 5) | (profile_idc & 0x1f);
    hvcc.push(p_byte);

    // 3..6. profile_compatibility_flags (4 bytes)
    hvcc.extend_from_slice(&[0x60, 0x00, 0x00, 0x00]);

    // 7..12. constraint_indicator_flags (6 bytes)
    hvcc.extend_from_slice(&[0xb0, 0x00, 0x00, 0x00, 0x00, 0x00]);

    // 13. level_idc
    hvcc.push(level_idc);

    // 14..15. min_spatial_segmentation_idc (12 bits with 4 bits reserved 1111b)
    hvcc.extend_from_slice(&[0xf0, 0x00]);

    // 16. parallelismType (2 bits with 6 bits reserved 111111b)
    hvcc.push(0xfc);

    // 17. chroma_format_idc (2 bits with 6 bits reserved 111111b)
    hvcc.push(0xfc | 0x01); // 4:2:0

    // 18. bit_depth_luma_minus8 (3 bits with 5 bits reserved 11111b)
    hvcc.push(0xf8 | (bit_depth_luma_minus8 & 0x07));

    // 19. bit_depth_chroma_minus8 (3 bits with 5 bits reserved 11111b)
    hvcc.push(0xf8 | (bit_depth_chroma_minus8 & 0x07));

    // 20..21. avgFrameRate (16 bits)
    hvcc.extend_from_slice(&[0x00, 0x00]);

    // 22. constantFrameRate(2) + numTemporalLayers(3) + temporalIdNested(1) + lengthSizeMinusOne(2)
    // lengthSizeMinusOne = 3 (4-byte NAL unit length prefix)
    hvcc.push(0x03);

    // 23. numOfArrays (3 arrays: VPS, SPS, PPS)
    hvcc.push(3);

    // Array 1: VPS (NAL type 32)
    hvcc.push(0x80 | 32); // array_completeness(1) + NAL_unit_type(6)
    hvcc.extend_from_slice(&1u16.to_be_bytes()); // numNalus = 1
    hvcc.extend_from_slice(&(vps.len() as u16).to_be_bytes());
    hvcc.extend_from_slice(vps);

    // Array 2: SPS (NAL type 33)
    hvcc.push(0x80 | 33);
    hvcc.extend_from_slice(&1u16.to_be_bytes());
    hvcc.extend_from_slice(&(sps.len() as u16).to_be_bytes());
    hvcc.extend_from_slice(sps);

    // Array 3: PPS (NAL type 34)
    hvcc.push(0x80 | 34);
    hvcc.extend_from_slice(&1u16.to_be_bytes());
    hvcc.extend_from_slice(&(pps.len() as u16).to_be_bytes());
    hvcc.extend_from_slice(pps);

    hvcc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hevc_annex_b_splitter() {
        // VPS: NAL type 32 (header: 0x40 0x01)
        // SPS: NAL type 33 (header: 0x42 0x01)
        // IDR: NAL type 19 (header: 0x26 0x01)
        let stream = vec![
            0x00, 0x00, 0x00, 0x01, 0x40, 0x01, 0x0c, 0x01, // VPS
            0x00, 0x00, 0x00, 0x01, 0x42, 0x01, 0x01, 0x01, // SPS
            0x00, 0x00, 0x01, 0x26, 0x01, 0xaf,             // IDR
        ];

        let nals = split_hevc_annex_b(&stream);
        assert_eq!(nals.len(), 3);
        assert_eq!(nals[0].unit_type, HevcNalUnitType::VpsNut);
        assert_eq!(nals[1].unit_type, HevcNalUnitType::SpsNut);
        assert_eq!(nals[2].unit_type, HevcNalUnitType::IdrWRadl);
        assert!(nals[2].unit_type.is_keyframe());
        assert!(!nals[0].unit_type.is_keyframe());
        assert!(nals[0].unit_type.is_param_set());
    }

    #[test]
    fn test_build_hvcc() {
        let vps = vec![0x40, 0x01, 0x0c, 0x01];
        let sps = vec![0x42, 0x01, 0x01, 0x01];
        let pps = vec![0x44, 0x01, 0xc0];

        let hvcc = build_hvcc(&vps, &sps, &pps);
        assert_eq!(hvcc[0], 1); // configurationVersion = 1
        assert_eq!(hvcc[21], 0x03); // lengthSizeMinusOne = 3
        assert_eq!(hvcc[22], 3); // 3 parameter arrays
        assert!(hvcc.len() > 23);
    }

    #[test]
    fn test_malformed_hevc_sps() {
        // Too short
        assert_eq!(parse_hevc_sps(&[0x42, 0x01]), None);

        // Wrong NAL type (e.g. IDR type 19 = 0x26)
        assert_eq!(parse_hevc_sps(&[0x26, 0x01, 0x00, 0x00, 0x00]), None);

        // Truncated after NAL header
        let truncated = vec![0x42, 0x01, 0x01, 0x02, 0x03];
        assert_eq!(parse_hevc_sps(&truncated), None);
    }
}
