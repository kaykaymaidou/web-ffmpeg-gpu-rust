use std::collections::HashSet;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RustDemuxedSample {
    pub is_key: bool,
    pub timestamp_us: i64,
    pub duration_us: u64,
    pub offset: usize,
    pub size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RustDemuxedTrack {
    pub id: u32,
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub timescale: u32,
    pub description: Option<Vec<u8>>,
    pub samples: Vec<RustDemuxedSample>,
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
        let mut codec = "avc1.640028".to_string();
        let mut width = 1920;
        let mut height = 1080;
        let mut timescale = 30000;
        let mut description = None;
        let mut sample_sizes = Vec::new();
        let mut chunk_offsets = Vec::new();
        let mut keyframe_indices = HashSet::new();
        let mut sample_deltas = Vec::new();

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

                    if m_tag == "mdhd" && mdia_offset + 28 <= self.data.len() {
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
                                    &mut codec,
                                    &mut width,
                                    &mut height,
                                    &mut description,
                                    &mut sample_sizes,
                                    &mut chunk_offsets,
                                    &mut keyframe_indices,
                                    &mut sample_deltas,
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

        let mut samples = Vec::with_capacity(sample_sizes.len());
        let mut current_offset = chunk_offsets[0];
        let mut current_ts_us: i64 = 0;

        for (i, &size) in sample_sizes.iter().enumerate() {
            let delta = sample_deltas.get(i).copied().unwrap_or(1000);
            let duration_us = ((delta as f64 / timescale as f64) * 1_000_000.0).round() as u64;
            let is_key = keyframe_indices.is_empty() || keyframe_indices.contains(&i);

            samples.push(RustDemuxedSample {
                is_key,
                timestamp_us: current_ts_us,
                duration_us,
                offset: current_offset,
                size,
            });

            current_ts_us += duration_us as i64;
            current_offset += size;
        }

        Some(RustDemuxedTrack {
            id: track_id,
            codec,
            width,
            height,
            timescale,
            description,
            samples,
        })
    }

    fn parse_stbl(
        &self,
        start: usize,
        end: usize,
        codec: &mut String,
        width: &mut u32,
        height: &mut u32,
        description: &mut Option<Vec<u8>>,
        sample_sizes: &mut Vec<usize>,
        chunk_offsets: &mut Vec<usize>,
        keyframe_indices: &mut HashSet<usize>,
        sample_deltas: &mut Vec<u32>,
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
                _ => {}
            }

            offset += size;
        }
    }

    fn read_u16(&self, offset: usize) -> u16 {
        u16::from_be_bytes([self.data[offset], self.data[offset + 1]])
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
}
