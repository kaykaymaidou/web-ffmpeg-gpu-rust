//! AAC (Advanced Audio Coding) ADTS and AudioSpecificConfig bitstream parser and packer.
//!
//! Provides zero-copy, zero-panic parsing of ADTS (Audio Data Transport Stream) headers,
//! extraction of raw AAC frames, creation of ADTS headers, and generation of ISO/IEC 14496-3
//! AudioSpecificConfig (2-byte ESDS config) for WebCodecs and MP4 audio tracks.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdtsHeader {
    pub id: u8,                          // 0 = MPEG-4, 1 = MPEG-2
    pub layer: u8,                       // always 0
    pub protection_absent: bool,          // 1 = no CRC (7-byte header), 0 = CRC present (9-byte header)
    pub profile: u8,                      // 0 = Main, 1 = LC, 2 = SSR, 3 = LTP (in MPEG-4, profile = audio_object_type - 1)
    pub sample_rate: u32,                // e.g. 44100, 48000
    pub sample_rate_index: u8,           // 0..15
    pub channels: u8,                    // channel configuration 1..7
    pub frame_length: usize,             // total frame length including ADTS header
    pub header_size: usize,              // 7 or 9 bytes
    pub buffer_fullness: u16,            // 0x7FF = VBR
    pub number_of_raw_data_blocks_in_frame: u8,
}

const SAMPLE_RATES: [u32; 16] = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350, 0,
    0, 0,
];

/// Find sample rate index from Hz value.
pub fn get_sample_rate_index(sample_rate: u32) -> Option<u8> {
    for (idx, &rate) in SAMPLE_RATES.iter().enumerate() {
        if rate == sample_rate {
            return Some(idx as u8);
        }
    }
    None
}

/// Parse an ADTS header from a byte slice.
/// Returns Ok(Some(AdtsHeader)) if a valid header is found,
/// Ok(None) if buffer is too short, or Err(&str) if corrupted.
pub fn parse_adts_header(data: &[u8]) -> Result<Option<AdtsHeader>, &'static str> {
    if data.len() < 7 {
        return Ok(None);
    }

    // Syncword check: 12 bits of all 1s: 0xFFF
    if data[0] != 0xFF || (data[1] & 0xF0) != 0xF0 {
        return Err("Invalid ADTS syncword (expected 0xFFF)");
    }

    let id = (data[1] >> 3) & 0x01;
    let layer = (data[1] >> 1) & 0x03;
    if layer != 0 {
        return Err("Invalid ADTS layer (must be 0 for AAC)");
    }
    let protection_absent = (data[1] & 0x01) == 1;

    let profile = (data[2] >> 6) & 0x03;
    let sample_rate_index = (data[2] >> 2) & 0x0F;
    if sample_rate_index >= 13 {
        return Err("Reserved or invalid sample rate index in ADTS header");
    }
    let sample_rate = SAMPLE_RATES[sample_rate_index as usize];

    let channels = ((data[2] & 0x01) << 2) | ((data[3] >> 6) & 0x03);
    if channels == 0 || channels > 7 {
        return Err("Invalid channel configuration in ADTS header");
    }

    let frame_length = (((data[3] & 0x03) as usize) << 11)
        | ((data[4] as usize) << 3)
        | (((data[5] >> 5) & 0x07) as usize);

    let buffer_fullness = (((data[5] & 0x1F) as u16) << 6) | (((data[6] >> 2) & 0x3F) as u16);
    let number_of_raw_data_blocks = data[6] & 0x03;

    let header_size = if protection_absent { 7 } else { 9 };

    if data.len() < header_size {
        return Ok(None);
    }

    Ok(Some(AdtsHeader {
        id,
        layer,
        protection_absent,
        profile,
        sample_rate,
        sample_rate_index,
        channels,
        frame_length,
        header_size,
        buffer_fullness,
        number_of_raw_data_blocks_in_frame: number_of_raw_data_blocks,
    }))
}

/// Create a standard 7-byte ADTS header for a raw AAC frame.
pub fn build_adts_header(
    raw_payload_len: usize,
    sample_rate: u32,
    channels: u8,
    profile: u8, // typically 1 for AAC-LC (Audio Object Type 2)
) -> Result<[u8; 7], &'static str> {
    let sample_rate_idx = get_sample_rate_index(sample_rate)
        .ok_or("Unsupported sample rate for ADTS encapsulation")?;

    if channels == 0 || channels > 7 {
        return Err("Invalid channel count (must be between 1 and 7)");
    }

    let frame_len = raw_payload_len + 7;
    if frame_len > 0x1FFF {
        return Err("AAC frame length exceeds 13-bit maximum (8192 bytes)");
    }

    let mut header = [0u8; 7];

    // Byte 0: Syncword 0xFF
    header[0] = 0xFF;

    // Byte 1: Syncword 0xF (4 bits), ID 0 (MPEG-4, 1 bit), Layer 00 (2 bits), Protection absent 1 (1 bit)
    header[1] = 0xF1;

    // Byte 2: Profile (2 bits), Sample rate index (4 bits), Private bit 0 (1 bit), Channel config high bit (1 bit)
    header[2] = ((profile & 0x03) << 6) | ((sample_rate_idx & 0x0F) << 2) | ((channels >> 2) & 0x01);

    // Byte 3: Channel config low 2 bits (2 bits), Original/Copy 0, Home 0, Copyright 0, Frame length high 2 bits (2 bits)
    header[3] = ((channels & 0x03) << 6) | (((frame_len >> 11) & 0x03) as u8);

    // Byte 4: Frame length middle 8 bits
    header[4] = ((frame_len >> 3) & 0xFF) as u8;

    // Byte 5: Frame length low 3 bits (3 bits), Buffer fullness high 5 bits (5 bits, 0x1F for VBR)
    header[5] = (((frame_len & 0x07) as u8) << 5) | 0x1F;

    // Byte 6: Buffer fullness low 6 bits (0x3F for VBR), raw data blocks count (2 bits = 0)
    header[6] = 0xFC;

    Ok(header)
}

/// Generate a 2-byte ISO/IEC 14496-3 AudioSpecificConfig (ASC).
/// Format:
/// - 5 bits: Audio Object Type (e.g. 2 for AAC-LC)
/// - 4 bits: Sampling Frequency Index (0..12)
/// - 4 bits: Channel Configuration (1..7)
/// - 3 bits: padding/zeroes
pub fn build_audio_specific_config(
    sample_rate: u32,
    channels: u8,
    audio_object_type: u8, // default 2 = AAC-LC
) -> Result<[u8; 2], &'static str> {
    let s_idx = get_sample_rate_index(sample_rate)
        .ok_or("Unsupported sample rate for AudioSpecificConfig")?;

    if channels == 0 || channels > 7 {
        return Err("Invalid channel count for AudioSpecificConfig");
    }

    let aot = audio_object_type & 0x1F; // 5 bits
    let s_idx = s_idx & 0x0F;          // 4 bits
    let ch = channels & 0x0F;          // 4 bits

    let byte0 = (aot << 3) | (s_idx >> 1);
    let byte1 = ((s_idx & 0x01) << 7) | (ch << 3);

    Ok([byte0, byte1])
}

/// Parse a 2-byte AudioSpecificConfig and return (audio_object_type, sample_rate, channels).
pub fn parse_audio_specific_config(data: &[u8]) -> Result<(u8, u32, u8), &'static str> {
    if data.len() < 2 {
        return Err("AudioSpecificConfig must be at least 2 bytes");
    }

    let aot = (data[0] >> 3) & 0x1F;
    let s_idx = ((data[0] & 0x07) << 1) | ((data[1] >> 7) & 0x01);
    let ch = (data[1] >> 3) & 0x0F;

    if (s_idx as usize) >= SAMPLE_RATES.len() {
        return Err("Invalid sampling frequency index in AudioSpecificConfig");
    }
    let sample_rate = SAMPLE_RATES[s_idx as usize];

    Ok((aot, sample_rate, ch))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_adts_header_build_and_parse_roundtrip() {
        let payload_len = 350;
        let sample_rate = 48000;
        let channels = 2;
        let profile = 1; // AAC-LC

        let header_bytes = build_adts_header(payload_len, sample_rate, channels, profile).unwrap();
        assert_eq!(header_bytes.len(), 7);

        let parsed = parse_adts_header(&header_bytes).unwrap().unwrap();
        assert_eq!(parsed.sample_rate, 48000);
        assert_eq!(parsed.channels, 2);
        assert_eq!(parsed.profile, 1);
        assert_eq!(parsed.frame_length, payload_len + 7);
        assert_eq!(parsed.header_size, 7);
    }

    #[test]
    fn test_audio_specific_config_roundtrip() {
        let asc = build_audio_specific_config(44100, 2, 2).unwrap();
        let (aot, sr, ch) = parse_audio_specific_config(&asc).unwrap();
        assert_eq!(aot, 2);
        assert_eq!(sr, 44100);
        assert_eq!(ch, 2);
    }

    #[test]
    fn test_corrupted_adts_syncword_fails_safely() {
        let corrupted = [0xFE, 0xF1, 0x50, 0x80, 0x0A, 0xDF, 0xFC];
        let result = parse_adts_header(&corrupted);
        assert!(result.is_err());
    }
}
