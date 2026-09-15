use serde::{Deserialize, Serialize};

/// Error types for EBML / Matroska demuxing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MkvDemuxError {
    UnexpectedEof,
    InvalidEbmlHeader,
    InvalidVint,
    MalformedCluster,
    UnsupportedLacing,
    BufferTooSmall,
}

impl core::fmt::Display for MkvDemuxError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::UnexpectedEof => write!(f, "Unexpected end of EBML buffer"),
            Self::InvalidEbmlHeader => write!(f, "Invalid or missing EBML header"),
            Self::InvalidVint => write!(f, "Malformed EBML variable integer (VINT)"),
            Self::MalformedCluster => write!(f, "Malformed Matroska cluster or block"),
            Self::UnsupportedLacing => write!(f, "Unsupported block lacing format"),
            Self::BufferTooSmall => write!(f, "Buffer is too small to contain a valid EBML element"),
        }
    }
}

/// Discovered track information in MKV / WebM container.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MkvTrack {
    pub track_number: u64,
    pub track_type: u8, // 1 = Video, 2 = Audio
    pub codec_id: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub sample_rate: Option<f64>,
    pub channels: Option<u32>,
    pub codec_private: Option<Vec<u8>>,
}

/// Extracted media frame/sample from a Matroska SimpleBlock or Block.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MkvFrame {
    pub track_number: u64,
    pub pts_us: i64,
    pub is_keyframe: bool,
    pub data: Vec<u8>,
}

/// Summary result of demuxing a WebM / MKV file or stream.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MkvDemuxResult {
    pub timecode_scale_ns: u64,
    pub tracks: Vec<MkvTrack>,
    pub frames: Vec<MkvFrame>,
}

/// Read an EBML Variable Size Integer (VINT) without masking the length descriptor bit (for Element IDs).
pub fn read_vint_id(buf: &[u8], offset: &mut usize) -> Result<u32, MkvDemuxError> {
    if *offset >= buf.len() {
        return Err(MkvDemuxError::UnexpectedEof);
    }

    let first = buf[*offset];
    let len = if first & 0x80 != 0 {
        1
    } else if first & 0x40 != 0 {
        2
    } else if first & 0x20 != 0 {
        3
    } else if first & 0x10 != 0 {
        4
    } else {
        return Err(MkvDemuxError::InvalidVint);
    };

    if *offset + len > buf.len() {
        return Err(MkvDemuxError::UnexpectedEof);
    }

    let mut id: u32 = 0;
    for i in 0..len {
        id = (id << 8) | (buf[*offset + i] as u32);
    }
    *offset += len;
    Ok(id)
}

/// Read an EBML Variable Size Integer (VINT) with the length bit masked out (for Element Data Sizes).
pub fn read_vint_size(buf: &[u8], offset: &mut usize) -> Result<Option<u64>, MkvDemuxError> {
    if *offset >= buf.len() {
        return Err(MkvDemuxError::UnexpectedEof);
    }

    let first = buf[*offset];
    let (len, mask) = if first & 0x80 != 0 {
        (1, 0x7F)
    } else if first & 0x40 != 0 {
        (2, 0x3F)
    } else if first & 0x20 != 0 {
        (3, 0x1F)
    } else if first & 0x10 != 0 {
        (4, 0x0F)
    } else if first & 0x08 != 0 {
        (5, 0x07)
    } else if first & 0x04 != 0 {
        (6, 0x03)
    } else if first & 0x02 != 0 {
        (7, 0x01)
    } else if first & 0x01 != 0 {
        (8, 0x00)
    } else {
        return Err(MkvDemuxError::InvalidVint);
    };

    if *offset + len > buf.len() {
        return Err(MkvDemuxError::UnexpectedEof);
    }

    let mut val = (first & mask) as u64;
    for i in 1..len {
        val = (val << 8) | (buf[*offset + i] as u64);
    }

    // Check for "unknown size" (all remaining bits are 1s)
    let unknown_marker = match len {
        1 => 0x7F,
        2 => 0x3FFF,
        3 => 0x1FFFFF,
        4 => 0x0FFFFFFF,
        5 => 0x07FFFFFFFF,
        6 => 0x03FFFFFFFFFF,
        7 => 0x01FFFFFFFFFFFF,
        8 => 0x00FFFFFFFFFFFFFF,
        _ => unreachable!(),
    };

    *offset += len;
    if val == unknown_marker {
        Ok(None)
    } else {
        Ok(Some(val))
    }
}

// Well-known EBML IDs
const ID_EBML_HEADER: u32 = 0x1A45DFA3;
const ID_SEGMENT: u32 = 0x18538067;
const ID_INFO: u32 = 0x1549A966;
const ID_TIMECODE_SCALE: u32 = 0x2AD7B1;
const ID_TRACKS: u32 = 0x1654AE6B;
const ID_TRACK_ENTRY: u32 = 0xAE;
const ID_TRACK_NUMBER: u32 = 0xD7;
const ID_TRACK_TYPE: u32 = 0x83;
const ID_CODEC_ID: u32 = 0x86;
const ID_CODEC_PRIVATE: u32 = 0x63A2;
const ID_VIDEO_SETTINGS: u32 = 0xE0;
const ID_PIXEL_WIDTH: u32 = 0xB0;
const ID_PIXEL_HEIGHT: u32 = 0xBA;
const ID_AUDIO_SETTINGS: u32 = 0xE1;
const ID_SAMPLING_FREQ: u32 = 0xB5;
const ID_CHANNELS: u32 = 0x9F;
const ID_CLUSTER: u32 = 0x1F43B675;
const ID_CLUSTER_TIMECODE: u32 = 0xE7;
const ID_SIMPLE_BLOCK: u32 = 0xA3;
const ID_BLOCK_GROUP: u32 = 0xA0;
const ID_BLOCK: u32 = 0xA1;

/// Demux an MKV or WebM byte buffer into structured tracks and media frames.
pub fn demux_mkv(data: &[u8]) -> Result<MkvDemuxResult, MkvDemuxError> {
    if data.len() < 4 {
        return Err(MkvDemuxError::BufferTooSmall);
    }

    let mut offset = 0;
    let mut timecode_scale_ns: u64 = 1_000_000; // Default 1ms (1,000,000 ns) per Matroska spec
    let mut tracks: Vec<MkvTrack> = Vec::new();
    let mut frames: Vec<MkvFrame> = Vec::new();

    // Verify EBML Header
    let first_id = read_vint_id(data, &mut offset)?;
    if first_id != ID_EBML_HEADER {
        return Err(MkvDemuxError::InvalidEbmlHeader);
    }
    let header_size = read_vint_size(data, &mut offset)?
        .ok_or(MkvDemuxError::InvalidEbmlHeader)? as usize;
    if offset + header_size > data.len() {
        return Err(MkvDemuxError::UnexpectedEof);
    }
    offset += header_size; // Skip header content

    // Locate and process Segment
    while offset < data.len() {
        let element_id = match read_vint_id(data, &mut offset) {
            Ok(id) => id,
            Err(_) => break,
        };

        let element_size = match read_vint_size(data, &mut offset)? {
            Some(sz) => sz as usize,
            None => data.len().saturating_sub(offset), // Stream until EOF if undefined size
        };

        let element_end = (offset + element_size).min(data.len());

        if element_id == ID_SEGMENT {
            // Recurse into Segment children
            parse_segment_children(
                &data[offset..element_end],
                &mut timecode_scale_ns,
                &mut tracks,
                &mut frames,
            )?;
            break;
        } else {
            offset = element_end;
        }
    }

    Ok(MkvDemuxResult {
        timecode_scale_ns,
        tracks,
        frames,
    })
}

fn parse_segment_children(
    segment_data: &[u8],
    timecode_scale_ns: &mut u64,
    tracks: &mut Vec<MkvTrack>,
    frames: &mut Vec<MkvFrame>,
) -> Result<(), MkvDemuxError> {
    let mut offset = 0;

    while offset < segment_data.len() {
        let element_id = match read_vint_id(segment_data, &mut offset) {
            Ok(id) => id,
            Err(_) => break,
        };

        let element_size = match read_vint_size(segment_data, &mut offset)? {
            Some(sz) => sz as usize,
            None => segment_data.len().saturating_sub(offset),
        };

        let element_end = (offset + element_size).min(segment_data.len());
        let payload = &segment_data[offset..element_end];

        match element_id {
            ID_INFO => {
                parse_info(payload, timecode_scale_ns);
            }
            ID_TRACKS => {
                parse_tracks(payload, tracks);
            }
            ID_CLUSTER => {
                parse_cluster(payload, *timecode_scale_ns, frames);
            }
            _ => {
                // Skip unhandled segment level elements (SeekHead, Cues, Tags, etc.)
            }
        }

        offset = element_end;
    }

    Ok(())
}

fn parse_info(info_data: &[u8], timecode_scale_ns: &mut u64) {
    let mut offset = 0;
    while offset < info_data.len() {
        let id = match read_vint_id(info_data, &mut offset) {
            Ok(id) => id,
            Err(_) => break,
        };
        let size = match read_vint_size(info_data, &mut offset) {
            Ok(Some(sz)) => sz as usize,
            _ => break,
        };
        let end = (offset + size).min(info_data.len());
        let payload = &info_data[offset..end];

        if id == ID_TIMECODE_SCALE {
            let mut scale: u64 = 0;
            for &b in payload {
                scale = (scale << 8) | (b as u64);
            }
            if scale > 0 {
                *timecode_scale_ns = scale;
            }
        }
        offset = end;
    }
}

fn parse_tracks(tracks_data: &[u8], tracks: &mut Vec<MkvTrack>) {
    let mut offset = 0;
    while offset < tracks_data.len() {
        let id = match read_vint_id(tracks_data, &mut offset) {
            Ok(id) => id,
            Err(_) => break,
        };
        let size = match read_vint_size(tracks_data, &mut offset) {
            Ok(Some(sz)) => sz as usize,
            _ => break,
        };
        let end = (offset + size).min(tracks_data.len());
        let payload = &tracks_data[offset..end];

        if id == ID_TRACK_ENTRY {
            if let Some(track) = parse_track_entry(payload) {
                tracks.push(track);
            }
        }
        offset = end;
    }
}

fn parse_track_entry(entry_data: &[u8]) -> Option<MkvTrack> {
    let mut offset = 0;
    let mut track_number = 1u64;
    let mut track_type = 1u8; // default 1 = video
    let mut codec_id = String::new();
    let mut codec_private = None;
    let mut width = None;
    let mut height = None;
    let mut sample_rate = None;
    let mut channels = None;

    while offset < entry_data.len() {
        let id = match read_vint_id(entry_data, &mut offset) {
            Ok(id) => id,
            Err(_) => break,
        };
        let size = match read_vint_size(entry_data, &mut offset) {
            Ok(Some(sz)) => sz as usize,
            _ => break,
        };
        let end = (offset + size).min(entry_data.len());
        let payload = &entry_data[offset..end];

        match id {
            ID_TRACK_NUMBER => {
                let mut num = 0u64;
                for &b in payload {
                    num = (num << 8) | (b as u64);
                }
                track_number = num;
            }
            ID_TRACK_TYPE => {
                if !payload.is_empty() {
                    track_type = payload[0];
                }
            }
            ID_CODEC_ID => {
                if let Ok(s) = core::str::from_utf8(payload) {
                    codec_id = s.trim_matches('\0').to_string();
                }
            }
            ID_CODEC_PRIVATE => {
                codec_private = Some(payload.to_vec());
            }
            ID_VIDEO_SETTINGS => {
                parse_video_settings(payload, &mut width, &mut height);
            }
            ID_AUDIO_SETTINGS => {
                parse_audio_settings(payload, &mut sample_rate, &mut channels);
            }
            _ => {}
        }
        offset = end;
    }

    if !codec_id.is_empty() {
        Some(MkvTrack {
            track_number,
            track_type,
            codec_id,
            width,
            height,
            sample_rate,
            channels,
            codec_private,
        })
    } else {
        None
    }
}

fn parse_video_settings(data: &[u8], width: &mut Option<u32>, height: &mut Option<u32>) {
    let mut offset = 0;
    while offset < data.len() {
        let id = match read_vint_id(data, &mut offset) {
            Ok(id) => id,
            Err(_) => break,
        };
        let size = match read_vint_size(data, &mut offset) {
            Ok(Some(sz)) => sz as usize,
            _ => break,
        };
        let end = (offset + size).min(data.len());
        let payload = &data[offset..end];

        match id {
            ID_PIXEL_WIDTH => {
                let mut w = 0u32;
                for &b in payload {
                    w = (w << 8) | (b as u32);
                }
                *width = Some(w);
            }
            ID_PIXEL_HEIGHT => {
                let mut h = 0u32;
                for &b in payload {
                    h = (h << 8) | (b as u32);
                }
                *height = Some(h);
            }
            _ => {}
        }
        offset = end;
    }
}

fn parse_audio_settings(data: &[u8], sample_rate: &mut Option<f64>, channels: &mut Option<u32>) {
    let mut offset = 0;
    while offset < data.len() {
        let id = match read_vint_id(data, &mut offset) {
            Ok(id) => id,
            Err(_) => break,
        };
        let size = match read_vint_size(data, &mut offset) {
            Ok(Some(sz)) => sz as usize,
            _ => break,
        };
        let end = (offset + size).min(data.len());
        let payload = &data[offset..end];

        match id {
            ID_SAMPLING_FREQ => {
                if payload.len() == 4 {
                    let mut b = [0u8; 4];
                    b.copy_from_slice(payload);
                    *sample_rate = Some(f32::from_be_bytes(b) as f64);
                } else if payload.len() == 8 {
                    let mut b = [0u8; 8];
                    b.copy_from_slice(payload);
                    *sample_rate = Some(f64::from_be_bytes(b));
                }
            }
            ID_CHANNELS => {
                let mut ch = 0u32;
                for &b in payload {
                    ch = (ch << 8) | (b as u32);
                }
                *channels = Some(ch);
            }
            _ => {}
        }
        offset = end;
    }
}

fn parse_cluster(cluster_data: &[u8], timecode_scale_ns: u64, frames: &mut Vec<MkvFrame>) {
    let mut offset = 0;
    let mut cluster_timecode_units = 0u64;

    while offset < cluster_data.len() {
        let id = match read_vint_id(cluster_data, &mut offset) {
            Ok(id) => id,
            Err(_) => break,
        };
        let size = match read_vint_size(cluster_data, &mut offset) {
            Ok(Some(sz)) => sz as usize,
            _ => break,
        };
        let end = (offset + size).min(cluster_data.len());
        let payload = &cluster_data[offset..end];

        match id {
            ID_CLUSTER_TIMECODE => {
                let mut tc = 0u64;
                for &b in payload {
                    tc = (tc << 8) | (b as u64);
                }
                cluster_timecode_units = tc;
            }
            ID_SIMPLE_BLOCK => {
                if let Some(frame) = parse_simple_block(payload, cluster_timecode_units, timecode_scale_ns) {
                    frames.push(frame);
                }
            }
            ID_BLOCK_GROUP => {
                if let Some(frame) = parse_block_group(payload, cluster_timecode_units, timecode_scale_ns) {
                    frames.push(frame);
                }
            }
            _ => {}
        }
        offset = end;
    }
}

fn parse_simple_block(
    payload: &[u8],
    cluster_timecode_units: u64,
    timecode_scale_ns: u64,
) -> Option<MkvFrame> {
    if payload.len() < 4 {
        return None;
    }
    let mut offset = 0;
    let track_num = read_vint_size(payload, &mut offset).ok()??;
    if offset + 3 > payload.len() {
        return None;
    }

    // Relative timecode: signed 16-bit big endian
    let rel_tc = i16::from_be_bytes([payload[offset], payload[offset + 1]]) as i64;
    offset += 2;

    let flags = payload[offset];
    offset += 1;

    let is_keyframe = (flags & 0x80) != 0;
    let lacing = (flags >> 1) & 0x03;

    // We support non-laced frames directly (00)
    let frame_data = if lacing == 0 {
        payload[offset..].to_vec()
    } else {
        // Fallback or copy for laced
        payload[offset..].to_vec()
    };

    // Calculate PTS in microseconds
    let total_time_units = (cluster_timecode_units as i64).saturating_add(rel_tc);
    let pts_us = (total_time_units as i128 * timecode_scale_ns as i128 / 1000) as i64;

    Some(MkvFrame {
        track_number: track_num,
        pts_us,
        is_keyframe,
        data: frame_data,
    })
}

fn parse_block_group(
    payload: &[u8],
    cluster_timecode_units: u64,
    timecode_scale_ns: u64,
) -> Option<MkvFrame> {
    let mut offset = 0;
    let mut block_data: Option<&[u8]> = None;
    let mut is_keyframe = true;

    while offset < payload.len() {
        let id = read_vint_id(payload, &mut offset).ok()?;
        let size = read_vint_size(payload, &mut offset).ok()?? as usize;
        let end = (offset + size).min(payload.len());
        let element_payload = &payload[offset..end];

        if id == ID_BLOCK {
            block_data = Some(element_payload);
        } else if id == 0xFB {
            // ReferenceBlock: presence indicates inter-frame (non-keyframe)
            is_keyframe = false;
        }
        offset = end;
    }

    let blk = block_data?;
    if blk.len() < 3 {
        return None;
    }

    let mut blk_offset = 0;
    let track_num = read_vint_size(blk, &mut blk_offset).ok()??;
    if blk_offset + 3 > blk.len() {
        return None;
    }

    let rel_tc = i16::from_be_bytes([blk[blk_offset], blk[blk_offset + 1]]) as i64;
    blk_offset += 2;
    // Skip flags
    blk_offset += 1;

    let total_time_units = (cluster_timecode_units as i64).saturating_add(rel_tc);
    let pts_us = (total_time_units as i128 * timecode_scale_ns as i128 / 1000) as i64;

    Some(MkvFrame {
        track_number: track_num,
        pts_us,
        is_keyframe,
        data: blk[blk_offset..].to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vint_id_and_size_parsing() {
        let buf1 = [0x81];
        let mut offset = 0;
        let id = read_vint_id(&buf1, &mut offset).unwrap();
        assert_eq!(id, 0x81);
        assert_eq!(offset, 1);

        let buf4 = [0x1A, 0x45, 0xDF, 0xA3];
        offset = 0;
        let id4 = read_vint_id(&buf4, &mut offset).unwrap();
        assert_eq!(id4, 0x1A45DFA3);
        assert_eq!(offset, 4);

        let size_buf = [0x40, 0x05];
        offset = 0;
        let sz = read_vint_size(&size_buf, &mut offset).unwrap();
        assert_eq!(sz, Some(5));
        assert_eq!(offset, 2);
    }

    #[test]
    fn test_corrupted_ebml_header_safely_rejected() {
        let garbage = [0xFF, 0xFE, 0x00, 0x00];
        let res = demux_mkv(&garbage);
        assert_eq!(res.unwrap_err(), MkvDemuxError::InvalidEbmlHeader);
    }

    #[test]
    fn test_synthetic_webm_demux_roundtrip() {
        let mut buf = Vec::new();

        // 1. EBML Header (ID: 0x1A45DFA3, Size: 0 -> len 1, size 0x80)
        buf.extend_from_slice(&[0x1A, 0x45, 0xDF, 0xA3, 0x80]);

        // 2. Segment (ID: 0x18538067, Size: unknown/streamed 0xFF)
        buf.extend_from_slice(&[0x18, 0x53, 0x80, 0x67, 0xFF]);

        // 2.1 Info: TimecodeScale = 1,000,000 ns (1ms)
        buf.extend_from_slice(&[
            0x15, 0x49, 0xA9, 0x66, 0x87,
            0x2A, 0xD7, 0xB1, 0x83, 0x0F, 0x42, 0x40,
        ]);

        // 2.2 Tracks: TrackEntry (TrackNum=1, TrackType=1, CodecID="V_VP9", Width=1280, Height=720)
        let mut track_entry = Vec::new();
        track_entry.extend_from_slice(&[0xD7, 0x81, 0x01]);
        track_entry.extend_from_slice(&[0x83, 0x81, 0x01]);
        track_entry.extend_from_slice(&[0x86, 0x85, b'V', b'_', b'V', b'P', b'9']);
        let mut video_settings = Vec::new();
        video_settings.extend_from_slice(&[0xB0, 0x82, 0x05, 0x00]);
        video_settings.extend_from_slice(&[0xBA, 0x82, 0x02, 0xD0]);

        track_entry.extend_from_slice(&[0xE0, (0x80 | video_settings.len() as u8)]);
        track_entry.extend_from_slice(&video_settings);

        let mut tracks_box = Vec::new();
        tracks_box.extend_from_slice(&[0xAE, (0x80 | track_entry.len() as u8)]);
        tracks_box.extend_from_slice(&track_entry);

        buf.extend_from_slice(&[0x16, 0x54, 0xAE, 0x6B, (0x80 | tracks_box.len() as u8)]);
        buf.extend_from_slice(&tracks_box);

        // 2.3 Cluster: Timecode=1000ms (0x03E8), SimpleBlock: Track 1, rel_tc=0, Keyframe, payload=[0xDE, 0xAD]
        let mut cluster_box = Vec::new();
        cluster_box.extend_from_slice(&[0xE7, 0x82, 0x03, 0xE8]);

        let mut simple_block = Vec::new();
        simple_block.push(0x81);
        simple_block.extend_from_slice(&[0x00, 0x00]);
        simple_block.push(0x80);
        simple_block.extend_from_slice(&[0xDE, 0xAD, 0xBE, 0xEF]);

        cluster_box.extend_from_slice(&[0xA3, (0x80 | simple_block.len() as u8)]);
        cluster_box.extend_from_slice(&simple_block);

        buf.extend_from_slice(&[0x1F, 0x43, 0xB6, 0x75, (0x80 | cluster_box.len() as u8)]);
        buf.extend_from_slice(&cluster_box);

        let result = demux_mkv(&buf).expect("Demux should succeed");
        assert_eq!(result.timecode_scale_ns, 1_000_000);
        assert_eq!(result.tracks.len(), 1);
        assert_eq!(result.tracks[0].codec_id, "V_VP9");
        assert_eq!(result.tracks[0].width, Some(1280));
        assert_eq!(result.tracks[0].height, Some(720));

        assert_eq!(result.frames.len(), 1);
        assert_eq!(result.frames[0].track_number, 1);
        assert_eq!(result.frames[0].is_keyframe, true);
        assert_eq!(result.frames[0].pts_us, 1_000_000);
        assert_eq!(result.frames[0].data, vec![0xDE, 0xAD, 0xBE, 0xEF]);
    }
}
