use std::collections::HashSet;
use serde::{Deserialize, Serialize};
use crate::bitstream::h264::{build_avcc, parse_sps, NalUnitType};
use crate::bitstream::h265::{build_hvcc, parse_hevc_sps, HevcNalUnitType};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RustDemuxedSample {
    pub is_key: bool,
    pub timestamp_us: i64,
    pub duration_us: u64,
    pub offset: usize,
    pub size: usize,
}

fn default_track_kind() -> String {
    "video".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RustDemuxedTrack {
    pub id: u32,
    #[serde(default = "default_track_kind")]
    pub kind: String,
    pub codec: String,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub channels: Option<u32>,
    #[serde(default)]
    pub sample_rate: Option<u32>,
    pub timescale: u32,
    pub description: Option<Vec<u8>>,
    pub samples: Vec<RustDemuxedSample>,
}

fn read_descr_len(data: &[u8], mut pos: usize) -> (usize, usize) {
    let mut len = 0usize;
    let mut count = 0;
    while pos < data.len() && count < 4 {
        let b = data[pos];
        pos += 1;
        count += 1;
        len = (len << 7) | ((b & 0x7F) as usize);
        if (b & 0x80) == 0 {
            break;
        }
    }
    (len, pos)
}

fn parse_decoder_config(data: &[u8]) -> Option<Vec<u8>> {
    if data.is_empty() || data[0] != 0x04 {
        return None;
    }
    let mut pos = 1;
    let (_len, next_pos) = read_descr_len(data, pos);
    pos = next_pos;
    if pos + 13 > data.len() {
        return None;
    }
    pos += 13; // objectTypeIndication(1) + streamType(1) + bufferSizeDB(3) + maxBitrate(4) + avgBitrate(4)
    if pos >= data.len() || data[pos] != 0x05 {
        return None;
    }
    pos += 1;
    let (config_len, next_pos) = read_descr_len(data, pos);
    pos = next_pos;
    if pos + config_len <= data.len() {
        Some(data[pos..pos + config_len].to_vec())
    } else {
        None
    }
}

fn parse_esds_audio_config(data: &[u8]) -> Option<Vec<u8>> {
    if data.len() < 4 {
        return None;
    }
    let mut pos = 4; // skip 4 bytes version/flags
    if pos >= data.len() {
        return None;
    }
    if data[pos] == 0x04 {
        return parse_decoder_config(&data[pos..]);
    }
    if data[pos] != 0x03 {
        return None;
    }
    pos += 1;
    let (_len, next_pos) = read_descr_len(data, pos);
    pos = next_pos;
    if pos + 3 > data.len() {
        return None;
    }
    pos += 2; // skip ES_ID
    let flags = data[pos];
    pos += 1;
    if (flags & 0x80) != 0 {
        pos += 2;
    }
    if (flags & 0x40) != 0 {
        if pos >= data.len() {
            return None;
        }
        let url_len = data[pos] as usize;
        pos += 1 + url_len;
    }
    if (flags & 0x20) != 0 {
        pos += 2;
    }
    if pos < data.len() {
        parse_decoder_config(&data[pos..])
    } else {
        None
    }
}

pub struct Mp4Demuxer<'a> {
    data: &'a [u8],
}

impl<'a> Mp4Demuxer<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data }
    }

    pub fn parse(&self) -> Vec<RustDemuxedTrack> {
        let mut tracks = Vec::new();
        let mut offset = 0;

        while offset + 8 <= self.data.len() {
            let size = self.read_u32(offset) as usize;
            let tag = self.read_tag(offset + 4);

            if size == 0 {
                break;
            }
            let box_size = if size == 1 && offset + 16 <= self.data.len() {
                self.read_u64(offset + 8) as usize
            } else {
                size
            };

            if tag == "moov" {
                tracks.extend(self.parse_moov(offset + 8, offset + box_size));
            }

            offset += box_size;
        }

        if tracks.is_empty() {
            if let Some(salvaged) = self.salvage_truncated_mdat() {
                tracks.push(salvaged);
            }
        }

        tracks
    }

    fn parse_moov(&self, start: usize, end: usize) -> Vec<RustDemuxedTrack> {
        let mut tracks = Vec::new();
        let mut offset = start;

        while offset + 8 <= end && offset + 8 <= self.data.len() {
            let size = self.read_u32(offset) as usize;
            let tag = self.read_tag(offset + 4);
            if size == 0 {
                break;
            }

            if tag == "trak" {
                if let Some(track) = self.parse_trak(offset + 8, offset + size) {
                    tracks.push(track);
                }
            }
            offset += size;
        }

        tracks
    }

    fn parse_trak(&self, start: usize, end: usize) -> Option<RustDemuxedTrack> {
        let mut offset = start;
        let mut track_id = 1;
        let mut track_kind = "video".to_string();
        let mut codec = "avc1.640028".to_string();
        let mut width = 0u32;
        let mut height = 0u32;
        let mut channels = None;
        let mut sample_rate = None;
        let mut timescale = 30000;
        let mut description = None;
        let mut sample_sizes = Vec::new();
        let mut chunk_offsets = Vec::new();
        let mut keyframe_indices = HashSet::new();
        let mut sample_deltas = Vec::new();
        let mut stsc_entries: Vec<(u32, u32)> = Vec::new();
        let mut ctts_offsets: Vec<i32> = Vec::new();

        while offset + 8 <= end && offset + 8 <= self.data.len() {
            let size = self.read_u32(offset) as usize;
            let tag = self.read_tag(offset + 4);
            if size == 0 {
                break;
            }

            if tag == "mdia" {
                let mut mdia_offset = offset + 8;
                let mdia_end = offset + size;

                while mdia_offset + 8 <= mdia_end && mdia_offset + 8 <= self.data.len() {
                    let m_size = self.read_u32(mdia_offset) as usize;
                    let m_tag = self.read_tag(mdia_offset + 4);

                    if m_tag == "hdlr" && mdia_offset + 20 <= self.data.len() {
                        let handler_type = self.read_tag(mdia_offset + 16);
                        if handler_type == "soun" {
                            track_kind = "audio".to_string();
                        } else if handler_type == "vide" {
                            track_kind = "video".to_string();
                        }
                    } else if m_tag == "mdhd" && mdia_offset + 28 <= self.data.len() {
                        let version = self.data[mdia_offset + 8];
                        timescale = if version == 1 && mdia_offset + 32 <= self.data.len() {
                            self.read_u32(mdia_offset + 28)
                        } else {
                            self.read_u32(mdia_offset + 20)
                        };
                    } else if m_tag == "minf" {
                        let mut minf_offset = mdia_offset + 8;
                        let minf_end = mdia_offset + m_size;

                        while minf_offset + 8 <= minf_end && minf_offset + 8 <= self.data.len() {
                            let inf_size = self.read_u32(minf_offset) as usize;
                            let inf_tag = self.read_tag(minf_offset + 4);

                            if inf_tag == "stbl" {
                                self.parse_stbl(
                                    minf_offset + 8,
                                    minf_offset + inf_size,
                                    &mut track_kind,
                                    &mut codec,
                                    &mut width,
                                    &mut height,
                                    &mut channels,
                                    &mut sample_rate,
                                    &mut description,
                                    &mut sample_sizes,
                                    &mut chunk_offsets,
                                    &mut keyframe_indices,
                                    &mut sample_deltas,
                                    &mut stsc_entries,
                                    &mut ctts_offsets,
                                );
                            }
                            minf_offset += inf_size;
                        }
                    }
                    mdia_offset += m_size;
                }
            } else if tag == "tkhd" && offset + 24 <= self.data.len() {
                track_id = self.read_u32(offset + 20);
            }

            offset += size;
        }

        if sample_sizes.is_empty() || chunk_offsets.is_empty() {
            return None;
        }

        let samples_per_chunk_at = |chunk_index_1based: usize| -> usize {
            if stsc_entries.is_empty() {
                if chunk_offsets.len() <= 1 {
                    return sample_sizes.len();
                }
                return 1;
            }
            let mut spc = stsc_entries[0].1 as usize;
            for &(first_chunk, samples_per_chunk) in &stsc_entries {
                if first_chunk as usize <= chunk_index_1based {
                    spc = samples_per_chunk as usize;
                }
            }
            spc
        };

        let mut samples = Vec::with_capacity(sample_sizes.len());
        let mut sample_index = 0usize;
        let mut decode_ticks: i64 = 0;

        for (chunk, &chunk_start) in chunk_offsets.iter().enumerate() {
            if sample_index >= sample_sizes.len() {
                break;
            }
            let mut byte_offset = chunk_start;
            let count = samples_per_chunk_at(chunk + 1);
            for _ in 0..count {
                if sample_index >= sample_sizes.len() {
                    break;
                }
                let size = sample_sizes[sample_index];
                let delta = sample_deltas.get(sample_index).copied().unwrap_or(1000);
                let composition = i64::from(ctts_offsets.get(sample_index).copied().unwrap_or(0));
                let duration_us = ((delta as f64 / timescale as f64) * 1_000_000.0).round() as u64;
                let pts_ticks = decode_ticks + composition;
                let timestamp_us =
                    ((pts_ticks as f64 / timescale as f64) * 1_000_000.0).round() as i64;
                let is_key = keyframe_indices.is_empty() || keyframe_indices.contains(&sample_index);

                samples.push(RustDemuxedSample {
                    is_key,
                    timestamp_us: timestamp_us.max(0),
                    duration_us,
                    offset: byte_offset,
                    size,
                });

                byte_offset += size;
                decode_ticks += i64::from(delta);
                sample_index += 1;
            }
        }

        Some(RustDemuxedTrack {
            id: track_id,
            kind: track_kind,
            codec,
            width,
            height,
            channels,
            sample_rate,
            timescale,
            description,
            samples,
        })
    }

    fn parse_stbl(
        &self,
        start: usize,
        end: usize,
        track_kind: &mut String,
        codec: &mut String,
        width: &mut u32,
        height: &mut u32,
        channels: &mut Option<u32>,
        sample_rate: &mut Option<u32>,
        description: &mut Option<Vec<u8>>,
        sample_sizes: &mut Vec<usize>,
        chunk_offsets: &mut Vec<usize>,
        keyframe_indices: &mut HashSet<usize>,
        sample_deltas: &mut Vec<u32>,
        stsc_entries: &mut Vec<(u32, u32)>,
        ctts_offsets: &mut Vec<i32>,
    ) {
        let mut offset = start;

        while offset + 8 <= end && offset + 8 <= self.data.len() {
            let size = self.read_u32(offset) as usize;
            let tag = self.read_tag(offset + 4);
            if size == 0 {
                break;
            }

            match tag.as_str() {
                "stsd" if offset + 16 <= self.data.len() => {
                    let entry_count = self.read_u32(offset + 12);
                    let mut entry_offset = offset + 16;
                    for _ in 0..entry_count {
                        if entry_offset + 8 > self.data.len() {
                            break;
                        }
                        let entry_size = self.read_u32(entry_offset) as usize;
                        let fmt = self.read_tag(entry_offset + 4);

                        if (fmt == "avc1" || fmt == "hvc1" || fmt == "vp09" || fmt == "av01")
                            && entry_offset + 36 <= self.data.len()
                        {
                            *track_kind = "video".to_string();
                            *width = self.read_u16(entry_offset + 32) as u32;
                            *height = self.read_u16(entry_offset + 34) as u32;

                            // Scan child boxes for avcC / hvcC
                            let mut sub_offset = entry_offset + 86;
                            let sub_end = entry_offset + entry_size;
                            while sub_offset + 8 <= sub_end && sub_offset + 8 <= self.data.len() {
                                let sub_size = self.read_u32(sub_offset) as usize;
                                let sub_tag = self.read_tag(sub_offset + 4);
                                if sub_tag == "avcC" && sub_offset + sub_size <= self.data.len() {
                                    let desc = self.data[sub_offset + 8..sub_offset + sub_size].to_vec();
                                    if desc.len() >= 4 {
                                        *codec = format!(
                                            "avc1.{:02x}{:02x}{:02x}",
                                            desc[1], desc[2], desc[3]
                                        );
                                    }
                                    *description = Some(desc);
                                } else if sub_tag == "hvcC" && sub_offset + sub_size <= self.data.len() {
                                    *codec = "hvc1.1.6.L93.B0".to_string();
                                    *description = Some(
                                        self.data[sub_offset + 8..sub_offset + sub_size].to_vec(),
                                    );
                                }
                                sub_offset += sub_size;
                            }
                        } else if fmt == "mp4a" && entry_offset + 36 <= self.data.len() {
                            *track_kind = "audio".to_string();
                            *width = 0;
                            *height = 0;
                            let ch = self.read_u16(entry_offset + 24) as u32;
                            *channels = Some(ch);
                            let sr = self.read_u32(entry_offset + 32) >> 16;
                            *sample_rate = Some(sr);
                            *codec = "mp4a.40.2".to_string();

                            // Scan child boxes for esds
                            let mut sub_offset = entry_offset + 36;
                            let sub_end = entry_offset + entry_size;
                            while sub_offset + 8 <= sub_end && sub_offset + 8 <= self.data.len() {
                                let sub_size = self.read_u32(sub_offset) as usize;
                                let sub_tag = self.read_tag(sub_offset + 4);
                                if sub_tag == "esds" && sub_offset + sub_size <= self.data.len() {
                                    if let Some(asc) = parse_esds_audio_config(&self.data[sub_offset + 8..sub_offset + sub_size]) {
                                        if asc.len() >= 2 {
                                            let audio_object_type = (asc[0] >> 3) & 0x1F;
                                            if audio_object_type > 0 {
                                                *codec = format!("mp4a.40.{}", audio_object_type);
                                            }
                                        }
                                        *description = Some(asc);
                                    }
                                }
                                sub_offset += sub_size;
                            }
                        } else if fmt == "Opus" && entry_offset + 36 <= self.data.len() {
                            *track_kind = "audio".to_string();
                            *width = 0;
                            *height = 0;
                            *codec = "opus".to_string();
                            *channels = Some(self.read_u16(entry_offset + 24) as u32);
                            *sample_rate = Some(48000);
                        }
                        entry_offset += entry_size;
                    }
                }
                "stsz" if offset + 20 <= self.data.len() => {
                    let sample_size = self.read_u32(offset + 12) as usize;
                    let count = self.read_u32(offset + 16) as usize;
                    if sample_size == 0 {
                        for i in 0..count {
                            let pos = offset + 20 + i * 4;
                            if pos + 4 <= self.data.len() {
                                sample_sizes.push(self.read_u32(pos) as usize);
                            }
                        }
                    } else {
                        sample_sizes.resize(count, sample_size);
                    }
                }
                "stco" if offset + 16 <= self.data.len() => {
                    let count = self.read_u32(offset + 12) as usize;
                    for i in 0..count {
                        let pos = offset + 16 + i * 4;
                        if pos + 4 <= self.data.len() {
                            chunk_offsets.push(self.read_u32(pos) as usize);
                        }
                    }
                }
                "co64" if offset + 16 <= self.data.len() => {
                    let count = self.read_u32(offset + 12) as usize;
                    for i in 0..count {
                        let pos = offset + 16 + i * 8;
                        if pos + 8 <= self.data.len() {
                            chunk_offsets.push(self.read_u64(pos) as usize);
                        }
                    }
                }
                "stss" if offset + 16 <= self.data.len() => {
                    let count = self.read_u32(offset + 12) as usize;
                    for i in 0..count {
                        let pos = offset + 16 + i * 4;
                        if pos + 4 <= self.data.len() {
                            let index = self.read_u32(pos) as usize;
                            if index > 0 {
                                keyframe_indices.insert(index - 1);
                            }
                        }
                    }
                }
                "stts" if offset + 16 <= self.data.len() => {
                    let count = self.read_u32(offset + 12) as usize;
                    for i in 0..count {
                        let pos = offset + 16 + i * 8;
                        if pos + 8 <= self.data.len() {
                            let sample_count = self.read_u32(pos) as usize;
                            let delta = self.read_u32(pos + 4);
                            for _ in 0..sample_count {
                                sample_deltas.push(delta);
                            }
                        }
                    }
                }
                "stsc" if offset + 16 <= self.data.len() => {
                    let count = self.read_u32(offset + 12) as usize;
                    for i in 0..count {
                        let pos = offset + 16 + i * 12;
                        if pos + 12 <= self.data.len() {
                            stsc_entries.push((self.read_u32(pos), self.read_u32(pos + 4)));
                        }
                    }
                }
                "ctts" if offset + 16 <= self.data.len() => {
                    let count = self.read_u32(offset + 12) as usize;
                    for i in 0..count {
                        let pos = offset + 16 + i * 8;
                        if pos + 8 <= self.data.len() {
                            let sample_count = self.read_u32(pos) as usize;
                            let composition = self.read_i32(pos + 4);
                            for _ in 0..sample_count {
                                ctts_offsets.push(composition);
                            }
                        }
                    }
                }
                _ => {}
            }

            offset += size;
        }
    }

    fn read_u16(&self, offset: usize) -> u16 {
        u16::from_be_bytes([self.data[offset], self.data[offset + 1]])
    }

    fn read_i32(&self, offset: usize) -> i32 {
        i32::from_be_bytes([
            self.data[offset],
            self.data[offset + 1],
            self.data[offset + 2],
            self.data[offset + 3],
        ])
    }

    fn read_u32(&self, offset: usize) -> u32 {
        u32::from_be_bytes([
            self.data[offset],
            self.data[offset + 1],
            self.data[offset + 2],
            self.data[offset + 3],
        ])
    }

    fn read_u64(&self, offset: usize) -> u64 {
        u64::from_be_bytes([
            self.data[offset],
            self.data[offset + 1],
            self.data[offset + 2],
            self.data[offset + 3],
            self.data[offset + 4],
            self.data[offset + 5],
            self.data[offset + 6],
            self.data[offset + 7],
        ])
    }

    fn read_tag(&self, offset: usize) -> String {
        String::from_utf8_lossy(&self.data[offset..offset + 4]).to_string()
    }

    /// Port of FAIL-05 salvage scanner down to pure Rust native core.
    /// Rescues orphaned video frames from truncated/incomplete MP4 files
    /// when the container ends prematurely without a finalized `moov` box.
    pub fn salvage_truncated_mdat(&self) -> Option<RustDemuxedTrack> {
        if self.data.is_empty() {
            return None;
        }

        // 1. Locate mdat payload offset
        let mut mdat_start = 0;
        let mut mdat_end = self.data.len();

        let mut offset = 0;
        while offset + 8 <= self.data.len() {
            let size = self.read_u32(offset) as usize;
            let tag = self.read_tag(offset + 4);

            if tag == "mdat" {
                mdat_start = if size == 1 && offset + 16 <= self.data.len() {
                    offset + 16
                } else {
                    offset + 8
                };
                if size > 1 && offset + size <= self.data.len() {
                    mdat_end = offset + size;
                }
                break;
            }

            if size == 0 {
                break;
            }
            offset += size;
        }

        if mdat_start >= mdat_end || mdat_start >= self.data.len() {
            // Fallback: scan whole buffer if mdat tag not found or at boundary
            mdat_start = 0;
            mdat_end = self.data.len();
        }

        let mdat_data = &self.data[mdat_start..mdat_end];
        if mdat_data.len() < 4 {
            return None;
        }

        // 2. Scan for Annex-B start codes (00 00 01 or 00 00 00 01)
        let mut start_indices = Vec::new();
        let mut i = 0;
        let len = mdat_data.len();
        while i + 2 < len {
            if mdat_data[i] == 0 && mdat_data[i + 1] == 0 {
                if mdat_data[i + 2] == 1 {
                    start_indices.push((i, 3));
                    i += 3;
                    continue;
                } else if i + 3 < len && mdat_data[i + 2] == 0 && mdat_data[i + 3] == 1 {
                    start_indices.push((i, 4));
                    i += 4;
                    continue;
                }
            }
            i += 1;
        }

        if start_indices.is_empty() {
            return None;
        }

        let mut sps_bytes: Option<Vec<u8>> = None;
        let mut pps_bytes: Option<Vec<u8>> = None;
        let mut vps_bytes: Option<Vec<u8>> = None;

        let mut width = 1920;
        let mut height = 1080;
        let mut codec = "avc1.640028".to_string();

        // 3. Inspect NAL units to detect codec (H.264 vs H.265)
        let mut is_hevc = false;
        for idx in 0..start_indices.len() {
            let (pos, prefix_len) = start_indices[idx];
            let nal_start = pos + prefix_len;
            if nal_start < len {
                let b0 = mdat_data[nal_start];
                if NalUnitType::from_byte(b0) == NalUnitType::Sps {
                    is_hevc = false;
                    break;
                }
                let hevc_t = HevcNalUnitType::from_byte(b0);
                if (b0 & 0x80 == 0) && (hevc_t == HevcNalUnitType::VpsNut || hevc_t == HevcNalUnitType::SpsNut) {
                    is_hevc = true;
                    break;
                }
            }
        }

        // 4. Extract parameter sets according to detected codec
        for idx in 0..start_indices.len() {
            let (pos, prefix_len) = start_indices[idx];
            let nal_start = pos + prefix_len;
            let nal_end = if idx + 1 < start_indices.len() {
                start_indices[idx + 1].0
            } else {
                len
            };

            if nal_start < nal_end {
                let nal = &mdat_data[nal_start..nal_end];
                let b0 = nal[0];

                if is_hevc {
                    let hevc_type = HevcNalUnitType::from_byte(b0);
                    if hevc_type == HevcNalUnitType::VpsNut && vps_bytes.is_none() {
                        vps_bytes = Some(nal.to_vec());
                    } else if hevc_type == HevcNalUnitType::SpsNut && sps_bytes.is_none() {
                        sps_bytes = Some(nal.to_vec());
                        if let Some(sps_info) = parse_hevc_sps(nal) {
                            width = sps_info.width;
                            height = sps_info.height;
                            codec = sps_info.codec_string;
                        }
                    } else if hevc_type == HevcNalUnitType::PpsNut && pps_bytes.is_none() {
                        pps_bytes = Some(nal.to_vec());
                    }
                } else {
                    let h264_type = NalUnitType::from_byte(b0);
                    if h264_type == NalUnitType::Sps && sps_bytes.is_none() {
                        sps_bytes = Some(nal.to_vec());
                        if let Some(sps_info) = parse_sps(nal) {
                            width = sps_info.width;
                            height = sps_info.height;
                            codec = sps_info.codec_string;
                        }
                    } else if h264_type == NalUnitType::Pps && pps_bytes.is_none() {
                        pps_bytes = Some(nal.to_vec());
                    }
                }
            }
        }

        // 4. Build description
        let description = if is_hevc {
            if let (Some(vps), Some(sps), Some(pps)) = (&vps_bytes, &sps_bytes, &pps_bytes) {
                Some(build_hvcc(vps, sps, pps))
            } else {
                None
            }
        } else {
            if let (Some(sps), Some(pps)) = (&sps_bytes, &pps_bytes) {
                Some(build_avcc(sps, pps))
            } else {
                None
            }
        };

        // 5. Group NALs into samples (slices / frames)
        let mut samples = Vec::new();
        let frame_duration_us: u64 = 33333; // ~30 fps default
        let mut current_ts: i64 = 0;

        for idx in 0..start_indices.len() {
            let (pos, prefix_len) = start_indices[idx];
            let nal_end = if idx + 1 < start_indices.len() {
                start_indices[idx + 1].0
            } else {
                len
            };

            let sample_offset = mdat_start + pos;
            let sample_size = nal_end - pos;

            if sample_size == 0 {
                continue;
            }

            let nal_first_byte = mdat_data[pos + prefix_len];
            let is_key = if is_hevc {
                HevcNalUnitType::from_byte(nal_first_byte).is_keyframe()
            } else {
                NalUnitType::from_byte(nal_first_byte).is_keyframe()
            };

            // Only consider VCL frames as video samples (exclude standalone SPS/PPS)
            let is_vcl = if is_hevc {
                let t = HevcNalUnitType::from_byte(nal_first_byte);
                !t.is_param_set() && t != HevcNalUnitType::AudNut && t != HevcNalUnitType::PrefixSeiNut
            } else {
                let t = NalUnitType::from_byte(nal_first_byte);
                t == NalUnitType::IdrSlice || t == NalUnitType::NonIdrSlice
            };

            if is_vcl {
                samples.push(RustDemuxedSample {
                    is_key,
                    timestamp_us: current_ts,
                    duration_us: frame_duration_us,
                    offset: sample_offset,
                    size: sample_size,
                });
                current_ts += frame_duration_us as i64;
            }
        }

        if samples.is_empty() {
            // If strict VCL check had 0, treat any NAL unit as sample
            for idx in 0..start_indices.len() {
                let (pos, _) = start_indices[idx];
                let nal_end = if idx + 1 < start_indices.len() {
                    start_indices[idx + 1].0
                } else {
                    len
                };
                let sample_size = nal_end - pos;
                if sample_size > 0 {
                    samples.push(RustDemuxedSample {
                        is_key: idx == 0,
                        timestamp_us: current_ts,
                        duration_us: frame_duration_us,
                        offset: mdat_start + pos,
                        size: sample_size,
                    });
                    current_ts += frame_duration_us as i64;
                }
            }
        }

        if samples.is_empty() {
            return None;
        }

        Some(RustDemuxedTrack {
            id: 1,
            kind: "video".to_string(),
            codec,
            width,
            height,
            channels: None,
            sample_rate: None,
            timescale: 1_000_000,
            description,
            samples,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_salvage_truncated_headless_mp4() {
        // Construct truncated MP4 data: ftyp box followed by unclosed mdat with Annex-B H.264 frames
        let mut data = Vec::new();

        // 1. ftyp box (32 bytes)
        data.extend_from_slice(&32u32.to_be_bytes());
        data.extend_from_slice(b"ftyp");
        data.extend_from_slice(b"isom\0\0\x02\0isommp41mp42avc1");

        // 2. mdat box with size = 0 (extends to EOF) or truncated size
        let mdat_pos = data.len();
        data.extend_from_slice(&0u32.to_be_bytes()); // size = 0 means to EOF
        data.extend_from_slice(b"mdat");

        // SPS (type 7)
        data.extend_from_slice(&[0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f]);
        // PPS (type 8)
        data.extend_from_slice(&[0x00, 0x00, 0x00, 0x01, 0x68, 0xce, 0x3c, 0x80]);
        // IDR slice (type 5)
        data.extend_from_slice(&[0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00, 0x11, 0x22]);
        // Non-IDR slice (type 1)
        data.extend_from_slice(&[0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x01, 0x33, 0x44]);

        let demuxer = Mp4Demuxer::new(&data);
        let tracks = demuxer.parse();

        // Must successfully recover 1 track via salvage scanner
        assert_eq!(tracks.len(), 1);
        let track = &tracks[0];
        assert_eq!(track.id, 1);
        assert!(track.description.is_some());
        // At least 2 VCL samples (IDR + Non-IDR) salvaged
        assert_eq!(track.samples.len(), 2);
        assert!(track.samples[0].is_key);
        assert!(!track.samples[1].is_key);
        assert_eq!(track.samples[0].timestamp_us, 0);
        assert_eq!(track.samples[1].timestamp_us, 33333);
        assert!(track.samples[0].offset >= mdat_pos + 8);
    }
}

