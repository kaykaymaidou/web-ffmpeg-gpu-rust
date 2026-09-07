use serde::{Deserialize, Serialize};

/// H.264 NAL Unit types according to ITU-T H.264 specification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NalUnitType {
    Unspecified = 0,
    NonIdrSlice = 1,
    SlicePartitionA = 2,
    SlicePartitionB = 3,
    SlicePartitionC = 4,
    IdrSlice = 5,
    Sei = 6,
    Sps = 7,
    Pps = 8,
    Aud = 9,
    EndOfSequence = 10,
    EndOfStream = 11,
    FillerData = 12,
    Other = 99,
}

impl NalUnitType {
    pub fn from_byte(b: u8) -> Self {
        match b & 0x1f {
            0 => NalUnitType::Unspecified,
            1 => NalUnitType::NonIdrSlice,
            2 => NalUnitType::SlicePartitionA,
            3 => NalUnitType::SlicePartitionB,
            4 => NalUnitType::SlicePartitionC,
            5 => NalUnitType::IdrSlice,
            6 => NalUnitType::Sei,
            7 => NalUnitType::Sps,
            8 => NalUnitType::Pps,
            9 => NalUnitType::Aud,
            10 => NalUnitType::EndOfSequence,
            11 => NalUnitType::EndOfStream,
            12 => NalUnitType::FillerData,
            _ => NalUnitType::Other,
        }
    }

    pub fn is_keyframe(&self) -> bool {
        matches!(self, NalUnitType::IdrSlice)
    }
}

/// Extracted NAL unit reference.
#[derive(Debug, Clone)]
pub struct NalUnit<'a> {
    pub unit_type: NalUnitType,
    pub data: &'a [u8],
}

/// H.264 Sequence Parameter Set (SPS) parsed metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpsInfo {
    pub profile_idc: u8,
    pub profile_compatibility: u8,
    pub level_idc: u8,
    pub width: u32,
    pub height: u32,
    pub codec_string: String,
}

/// Bit-level stream reader for parsing H.264 Exp-Golomb coded headers.
pub struct BitReader<'a> {
    data: &'a [u8],
    byte_offset: usize,
    bit_offset: u8,
}

impl<'a> BitReader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            byte_offset: 0,
            bit_offset: 0,
        }
    }

    pub fn read_bit(&mut self) -> Option<u32> {
        if self.byte_offset >= self.data.len() {
            return None;
        }

        let bit = ((self.data[self.byte_offset] >> (7 - self.bit_offset)) & 1) as u32;
        self.bit_offset += 1;
        if self.bit_offset == 8 {
            self.bit_offset = 0;
            self.byte_offset += 1;
        }
        Some(bit)
    }

    pub fn read_bits(&mut self, n: u8) -> Option<u32> {
        let mut val = 0u32;
        for _ in 0..n {
            val = (val << 1) | self.read_bit()?;
        }
        Some(val)
    }

    /// Read an unsigned exponential-Golomb coded integer ue(v).
    pub fn read_ue(&mut self) -> Option<u32> {
        let mut leading_zeros = 0;
        while self.read_bit()? == 0 {
            leading_zeros += 1;
            // Strictly guard against >= 32 to prevent 1 << 32 bit-shift overflow panic
            if leading_zeros >= 32 {
                return None;
            }
        }
        if leading_zeros == 0 {
            return Some(0);
        }
        let suffix = self.read_bits(leading_zeros)?;
        let base = (1u32.checked_shl(leading_zeros as u32)?) - 1;
        base.checked_add(suffix)
    }

    /// Read a signed exponential-Golomb coded integer se(v).
    pub fn read_se(&mut self) -> Option<i32> {
        let code_num = self.read_ue()?;
        if code_num == 0 {
            Some(0)
        } else {
            let sign = if (code_num & 1) == 0 { -1 } else { 1 };
            let val = ((code_num + 1) / 2) as i32 * sign;
            Some(val)
        }
    }

    /// Skip n bits in the bitstream.
    pub fn skip_bits(&mut self, n: usize) -> Option<()> {
        for _ in 0..n {
            self.read_bit()?;
        }
        Some(())
    }
}

/// Split Annex-B bitstream (`00 00 00 01` or `00 00 01`) into separate NAL units.
pub fn split_annex_b<'a>(data: &'a [u8]) -> Vec<NalUnit<'a>> {
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

        if nal_start < nal_end {
            let nal_bytes = &data[nal_start..nal_end];
            let unit_type = NalUnitType::from_byte(nal_bytes[0]);
            nals.push(NalUnit {
                unit_type,
                data: nal_bytes,
            });
        }
    }

    nals
}

/// Parse an H.264 SPS NAL unit to extract codec string, width, and height.
pub fn parse_sps(sps_data: &[u8]) -> Option<SpsInfo> {
    if sps_data.len() < 4 {
        return None;
    }

    let profile_idc = sps_data[1];
    let profile_compatibility = sps_data[2];
    let level_idc = sps_data[3];

    let codec_string = format!(
        "avc1.{:02x}{:02x}{:02x}",
        profile_idc, profile_compatibility, level_idc
    );

    // Strip emulation prevention bytes (0x00 0x00 0x03 -> 0x00 0x00)
    let mut clean_data = Vec::with_capacity(sps_data.len());
    let mut i = 0;
    while i < sps_data.len() {
        if i + 2 < sps_data.len() && sps_data[i] == 0 && sps_data[i + 1] == 0 && sps_data[i + 2] == 3 {
            clean_data.push(0);
            clean_data.push(0);
            i += 3;
        } else {
            clean_data.push(sps_data[i]);
            i += 1;
        }
    }

    if clean_data.len() < 4 {
        return None;
    }

    let mut reader = BitReader::new(&clean_data[4..]); // Skip NAL header + 3 bytes profile/level

    let _sps_id = reader.read_ue()?;

    if [100, 110, 122, 244, 44, 83, 86, 118, 128].contains(&profile_idc) {
        let chroma_format_idc = reader.read_ue()?;
        if chroma_format_idc == 3 {
            let _separate_colour_plane_flag = reader.read_bit()?;
        }
        let _bit_depth_luma_minus8 = reader.read_ue()?;
        let _bit_depth_chroma_minus8 = reader.read_ue()?;
        let _qpprime_y_zero_transform_bypass_flag = reader.read_bit()?;
        let seq_scaling_matrix_present_flag = reader.read_bit()?;
        if seq_scaling_matrix_present_flag == 1 {
            let count = if chroma_format_idc != 3 { 8 } else { 12 };
            for _ in 0..count {
                let seq_scaling_list_present = reader.read_bit()?;
                if seq_scaling_list_present == 1 {
                    // Skip scaling list
                    let mut last_scale = 8;
                    let mut next_scale = 8;
                    for _ in 0..16 {
                        if next_scale != 0 {
                            let delta_scale = reader.read_ue()? as i32; // Approx
                            next_scale = (last_scale + delta_scale + 256) % 256;
                        }
                        last_scale = if next_scale == 0 { last_scale } else { next_scale };
                    }
                }
            }
        }
    }

    let _log2_max_frame_num_minus4 = reader.read_ue()?;
    let pic_order_cnt_type = reader.read_ue()?;
    if pic_order_cnt_type == 0 {
        let _log2_max_pic_order_cnt_lsb_minus4 = reader.read_ue()?;
    } else if pic_order_cnt_type == 1 {
        let _delta_pic_order_always_zero_flag = reader.read_bit()?;
        let _offset_for_non_ref_pic = reader.read_ue()?;
        let _offset_for_top_to_bottom_field = reader.read_ue()?;
        let num_ref_frames_in_pic_order_cnt_cycle = reader.read_ue()?;
        if num_ref_frames_in_pic_order_cnt_cycle > 255 {
            return None; // Guard against DoS loop
        }
        for _ in 0..num_ref_frames_in_pic_order_cnt_cycle {
            let _ = reader.read_ue()?;
        }
    }

    let _max_num_ref_frames = reader.read_ue()?;
    let _gaps_in_frame_num_value_allowed_flag = reader.read_bit()?;
    let pic_width_in_mbs_minus1 = reader.read_ue()?;
    let pic_height_in_map_units_minus1 = reader.read_ue()?;
    let frame_mbs_only_flag = reader.read_bit()?;
    if frame_mbs_only_flag == 0 {
        let _mb_adaptive_frame_field_flag = reader.read_bit()?;
    }
    let _direct_8x8_inference_flag = reader.read_bit()?;
    let frame_cropping_flag = reader.read_bit()?;

    let mut crop_left = 0;
    let mut crop_right = 0;
    let mut crop_top = 0;
    let mut crop_bottom = 0;

    if frame_cropping_flag == 1 {
        crop_left = reader.read_ue().unwrap_or(0);
        crop_right = reader.read_ue().unwrap_or(0);
        crop_top = reader.read_ue().unwrap_or(0);
        crop_bottom = reader.read_ue().unwrap_or(0);
    }

    // Safe arithmetic preventing addition overflow and subtraction underflow
    let raw_width = pic_width_in_mbs_minus1.checked_add(1)?.checked_mul(16)?;
    let crop_w = (crop_left.checked_add(crop_right)?).checked_mul(2)?;
    let width = raw_width.checked_sub(crop_w)?;

    let raw_height = (2 - frame_mbs_only_flag)
        .checked_mul(pic_height_in_map_units_minus1.checked_add(1)?)?
        .checked_mul(16)?;
    let crop_h = (crop_top.checked_add(crop_bottom)?).checked_mul(2)?;
    let height = raw_height.checked_sub(crop_h)?;

    Some(SpsInfo {
        profile_idc,
        profile_compatibility,
        level_idc,
        width,
        height,
        codec_string,
    })
}

/// Construct an ISO 14496-15 AVCC (avcC) configuration record from SPS and PPS.
pub fn build_avcc(sps: &[u8], pps: &[u8]) -> Vec<u8> {
    let mut avcc = Vec::with_capacity(11 + sps.len() + pps.len());
    avcc.push(1); // configurationVersion = 1
    avcc.push(sps.get(1).copied().unwrap_or(0x64)); // AVCProfileIndication
    avcc.push(sps.get(2).copied().unwrap_or(0x00)); // profile_compatibility
    avcc.push(sps.get(3).copied().unwrap_or(0x1f)); // AVCLevelIndication
    avcc.push(0xff); // 6 bits reserved (111111b) + 2 bits lengthSizeMinusOne (3 = 4 bytes length)
    avcc.push(0xe1); // 3 bits reserved (111b) + 5 bits numOfSequenceParameterSets (1)

    // SPS length (16-bit big endian) + SPS bytes
    let sps_len = sps.len() as u16;
    avcc.push((sps_len >> 8) as u8);
    avcc.push((sps_len & 0xff) as u8);
    avcc.extend_from_slice(sps);

    // numOfPictureParameterSets = 1
    avcc.push(1);
    let pps_len = pps.len() as u16;
    avcc.push((pps_len >> 8) as u8);
    avcc.push((pps_len & 0xff) as u8);
    avcc.extend_from_slice(pps);

    avcc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_exp_golomb_reader() {
        // ue(0) -> '1' = 0
        // ue(1) -> '010' = 1
        // ue(2) -> '011' = 2
        // byte: 1 010 011 0 = 0b10100110 = 0xa6
        let data = [0xa6];
        let mut reader = BitReader::new(&data);
        assert_eq!(reader.read_ue(), Some(0));
        assert_eq!(reader.read_ue(), Some(1));
        assert_eq!(reader.read_ue(), Some(2));
    }

    #[test]
    fn test_annex_b_splitter() {
        let stream = vec![
            0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f, // SPS (NAL type 7)
            0x00, 0x00, 0x00, 0x01, 0x68, 0xce, 0x3c, 0x80, // PPS (NAL type 8)
            0x00, 0x00, 0x01, 0x65, 0x88, 0x84,             // IDR (NAL type 5)
        ];

        let nals = split_annex_b(&stream);
        assert_eq!(nals.len(), 3);
        assert_eq!(nals[0].unit_type, NalUnitType::Sps);
        assert_eq!(nals[1].unit_type, NalUnitType::Pps);
        assert_eq!(nals[2].unit_type, NalUnitType::IdrSlice);
    }

    #[test]
    fn test_build_avcc() {
        let sps = vec![0x67, 0x64, 0x00, 0x28];
        let pps = vec![0x68, 0xce, 0x3c];
        let avcc = build_avcc(&sps, &pps);

        assert_eq!(avcc[0], 1); // version
        assert_eq!(avcc[1], 0x64); // profile
        assert_eq!(avcc[3], 0x28); // level
        assert_eq!(avcc[5] & 0x1f, 1); // 1 SPS
    }

    #[test]
    fn test_exp_golomb_32_zero_shift_overflow() {
        // 32 zero bits followed by 1 bit and 32 suffix bits
        let mut data = vec![0u8; 4]; // 32 zero bits
        data.push(0x80); // 1-bit set at bit 33
        data.extend_from_slice(&[0xff; 4]); // suffix

        let mut reader = BitReader::new(&data);
        // Must return None rather than panicking with 'attempt to shift left with overflow'
        assert_eq!(reader.read_ue(), None);
    }

    #[test]
    fn test_malformed_sps_underflow_resilience() {
        // Truncated data after stripping
        let malformed = vec![0x67, 0x00, 0x00, 0x03];
        assert_eq!(parse_sps(&malformed), None);
    }
}

