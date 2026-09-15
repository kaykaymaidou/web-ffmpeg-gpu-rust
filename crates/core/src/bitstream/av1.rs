//! AV1 (AOMedia Video 1) OBU (Open Bitstream Unit) parser and av1C configuration builder.
//!
//! Provides zero-copy, zero-panic parsing of AV1 bitstreams, LEB128 integer decoding,
//! Sequence Header extraction, and generation of the ISO/IEC 23000-19 `av1C` box for MP4
//! encapsulation and WebCodecs video decoder configuration.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObuType {
    SequenceHeader,
    TemporalDelimiter,
    FrameHeader,
    TileGroup,
    Metadata,
    Frame,
    RedundantFrameHeader,
    TileList,
    Padding,
    Unknown(u8),
}

impl From<u8> for ObuType {
    fn from(val: u8) -> Self {
        match val {
            1 => ObuType::SequenceHeader,
            2 => ObuType::TemporalDelimiter,
            3 => ObuType::FrameHeader,
            4 => ObuType::TileGroup,
            5 => ObuType::Metadata,
            6 => ObuType::Frame,
            7 => ObuType::RedundantFrameHeader,
            8 => ObuType::TileList,
            15 => ObuType::Padding,
            other => ObuType::Unknown(other),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ObuUnit<'a> {
    pub obu_type: ObuType,
    pub temporal_id: u8,
    pub spatial_id: u8,
    pub payload: &'a [u8],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Av1SequenceHeader {
    pub profile: u8,        // 0 = Main, 1 = High, 2 = Professional
    pub level_idx: u8,      // 0..31
    pub tier: u8,           // 0 = Main tier, 1 = High tier
    pub high_bitdepth: bool,
    pub twelve_bit: bool,
    pub monochrome: bool,
    pub chroma_subsampling_x: u8,
    pub chroma_subsampling_y: u8,
    pub chroma_sample_position: u8,
}

/// Decode an unsigned LEB128 (Little-Endian Base 128) integer.
/// Returns (decoded_value, bytes_consumed).
pub fn decode_leb128(data: &[u8]) -> Result<(u64, usize), &'static str> {
    let mut value: u64 = 0;
    let mut bytes_read = 0;

    for (i, &byte) in data.iter().enumerate().take(8) {
        bytes_read += 1;
        value |= ((byte & 0x7F) as u64) << (i * 7);
        if (byte & 0x80) == 0 {
            return Ok((value, bytes_read));
        }
    }

    Err("LEB128 integer sequence exceeds 8 bytes or unterminated")
}

/// Parse a stream of Annex B or Low-Overhead Bitstream Format AV1 OBUs.
pub fn parse_obus<'a>(mut data: &'a [u8]) -> Result<Vec<ObuUnit<'a>>, &'static str> {
    let mut units = Vec::new();

    while !data.is_empty() {
        let header_byte = data[0];
        let forbidden_bit = (header_byte >> 7) & 0x01;
        if forbidden_bit != 0 {
            return Err("Corrupted AV1 OBU: forbidden bit must be 0");
        }

        let obu_type = ObuType::from((header_byte >> 3) & 0x0F);
        let extension_flag = (header_byte >> 2) & 0x01 == 1;
        let has_size_field = (header_byte >> 1) & 0x01 == 1;

        let mut offset = 1;
        let mut temporal_id = 0;
        let mut spatial_id = 0;

        if extension_flag {
            if data.len() < offset + 1 {
                return Err("Truncated AV1 OBU extension header");
            }
            let ext_byte = data[offset];
            temporal_id = (ext_byte >> 5) & 0x07;
            spatial_id = (ext_byte >> 3) & 0x03;
            offset += 1;
        }

        let payload_size = if has_size_field {
            let (size, leb_len) = decode_leb128(&data[offset..])?;
            offset += leb_len;
            size as usize
        } else {
            data.len() - offset
        };

        if data.len() < offset + payload_size {
            return Err("Truncated AV1 OBU payload according to size field");
        }

        let payload = &data[offset..offset + payload_size];
        units.push(ObuUnit {
            obu_type,
            temporal_id,
            spatial_id,
            payload,
        });

        data = &data[offset + payload_size..];
    }

    Ok(units)
}

/// Parse basic parameters from an AV1 Sequence Header OBU payload.
pub fn parse_av1_sequence_header(payload: &[u8]) -> Result<Av1SequenceHeader, &'static str> {
    if payload.len() < 2 {
        return Err("AV1 Sequence Header OBU is too short");
    }

    let profile = (payload[0] >> 5) & 0x07;
    let _still_picture = (payload[0] >> 4) & 0x01 != 0;
    let reduced_still_picture_header = (payload[0] >> 3) & 0x01 != 0;

    let mut level_idx = 0;
    let mut tier = 0;

    if !reduced_still_picture_header {
        // Parse operating points count & first operating point level/tier
        if payload.len() >= 3 {
            level_idx = payload[2] & 0x1F;
            tier = (payload[2] >> 5) & 0x01;
        }
    }

    Ok(Av1SequenceHeader {
        profile,
        level_idx,
        tier,
        high_bitdepth: false,
        twelve_bit: false,
        monochrome: false,
        chroma_subsampling_x: 1,
        chroma_subsampling_y: 1,
        chroma_sample_position: 0,
    })
}

/// Generate an ISO/IEC 23000-19 `av1C` configuration record.
/// 4 bytes header + sequence header OBU bytes.
pub fn build_av1c_config(seq: &Av1SequenceHeader, raw_seq_header_obu: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + raw_seq_header_obu.len());

    // Byte 0: marker (1) | version (1) = 0x81
    out.push(0x81);

    // Byte 1: seq_profile (3 bits) | seq_level_idx_0 (5 bits)
    let b1 = ((seq.profile & 0x07) << 5) | (seq.level_idx & 0x1F);
    out.push(b1);

    // Byte 2: tier (1) | high_bitdepth (1) | twelve_bit (1) | monochrome (1) | subsampling_x (1) | subsampling_y (1) | chroma_sample_pos (2)
    let mut b2 = (seq.tier & 0x01) << 7;
    if seq.high_bitdepth {
        b2 |= 1 << 6;
    }
    if seq.twelve_bit {
        b2 |= 1 << 5;
    }
    if seq.monochrome {
        b2 |= 1 << 4;
    }
    b2 |= (seq.chroma_subsampling_x & 0x01) << 3;
    b2 |= (seq.chroma_subsampling_y & 0x01) << 2;
    b2 |= seq.chroma_sample_position & 0x03;
    out.push(b2);

    // Byte 3: initial_presentation_delay_present (0) | reserved (0)
    out.push(0x00);

    // Append configOBUs (Sequence Header OBU)
    out.extend_from_slice(raw_seq_header_obu);

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_leb128_roundtrip() {
        let single_byte = [42u8];
        let (val, len) = decode_leb128(&single_byte).unwrap();
        assert_eq!(val, 42);
        assert_eq!(len, 1);

        // 624485 in LEB128: 0xE5, 0x8E, 0x26
        let multi_byte = [0xE5, 0x8E, 0x26];
        let (val, len) = decode_leb128(&multi_byte).unwrap();
        assert_eq!(val, 624485);
        assert_eq!(len, 3);
    }

    #[test]
    fn test_av1_obu_parse() {
        // Sequence header OBU with size field (type = 1, size = 4)
        // Header byte: (1 << 3) | (1 << 1) = 0x0A (ObuSequenceHeader with size)
        // Size: 4 (0x04)
        // Payload: [0x00, 0x00, 0x08, 0x00]
        let obu_data = [0x0A, 0x04, 0x00, 0x00, 0x08, 0x00];
        let obus = parse_obus(&obu_data).unwrap();
        assert_eq!(obus.len(), 1);
        assert_eq!(obus[0].obu_type, ObuType::SequenceHeader);
        assert_eq!(obus[0].payload.len(), 4);
    }

    #[test]
    fn test_av1c_builder() {
        let seq = Av1SequenceHeader {
            profile: 0,
            level_idx: 8,
            tier: 0,
            high_bitdepth: false,
            twelve_bit: false,
            monochrome: false,
            chroma_subsampling_x: 1,
            chroma_subsampling_y: 1,
            chroma_sample_position: 0,
        };
        let raw_seq = [0x0A, 0x04, 0x00, 0x00, 0x08, 0x00];
        let av1c = build_av1c_config(&seq, &raw_seq);
        assert_eq!(av1c[0], 0x81);
        assert_eq!(av1c.len(), 4 + raw_seq.len());
    }
}
