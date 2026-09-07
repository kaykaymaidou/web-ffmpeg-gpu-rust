use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use crate::packet::Packet;

/// FLV Tag Type
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlvTagType {
    Audio = 8,
    Video = 9,
    ScriptData = 18,
}

/// Parsed FLV Header metadata.
#[wasm_bindgen]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlvHeader {
    has_audio: bool,
    has_video: bool,
    data_offset: u32,
}

#[wasm_bindgen]
impl FlvHeader {
    #[wasm_bindgen(getter)]
    pub fn has_audio(&self) -> bool {
        self.has_audio
    }

    #[wasm_bindgen(getter)]
    pub fn has_video(&self) -> bool {
        self.has_video
    }
}

/// Extracted Video Tag information.
#[wasm_bindgen]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlvVideoTagInfo {
    is_keyframe: bool,
    is_sequence_header: bool,
    dts_ms: u32,
    pts_ms: u32,
    codec_id: u8,
}

#[wasm_bindgen]
impl FlvVideoTagInfo {
    #[wasm_bindgen(getter)]
    pub fn is_keyframe(&self) -> bool {
        self.is_keyframe
    }

    #[wasm_bindgen(getter)]
    pub fn is_sequence_header(&self) -> bool {
        self.is_sequence_header
    }

    #[wasm_bindgen(getter)]
    pub fn dts_ms(&self) -> u32 {
        self.dts_ms
    }

    #[wasm_bindgen(getter)]
    pub fn pts_ms(&self) -> u32 {
        self.pts_ms
    }

    #[wasm_bindgen(getter)]
    pub fn codec_id(&self) -> u8 {
        self.codec_id
    }
}

/// Pure Rust Stream-Oriented FLV Demuxer (RFC 0002).
/// Efficiently processes chunked WebSocket-FLV / HTTP-FLV streams without MSE memory leaks.
#[wasm_bindgen]
pub struct RustFlvDemuxer {
    buffer: Vec<u8>,
    header_parsed: bool,
    has_audio: bool,
    has_video: bool,
    offset: usize,
}

#[wasm_bindgen]
impl RustFlvDemuxer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            buffer: Vec::with_capacity(65536),
            header_parsed: false,
            has_audio: false,
            has_video: false,
            offset: 0,
        }
    }

    /// Append incoming chunk of live stream bytes.
    pub fn append_bytes(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
    }

    /// Check and parse FLV header if enough bytes are present.
    pub fn parse_header(&mut self) -> Option<FlvHeader> {
        if self.header_parsed {
            return Some(FlvHeader {
                has_audio: self.has_audio,
                has_video: self.has_video,
                data_offset: 9,
            });
        }

        if self.buffer.len() < 9 + 4 {
            return None;
        }

        // FLV header must start with 'FLV' (0x46 0x4C 0x56 0x01)
        if &self.buffer[0..3] != b"FLV" || self.buffer[3] != 0x01 {
            return None;
        }

        let flags = self.buffer[4];
        self.has_audio = (flags & 0x04) != 0;
        self.has_video = (flags & 0x01) != 0;

        let data_offset = u32::from_be_bytes([
            self.buffer[5],
            self.buffer[6],
            self.buffer[7],
            self.buffer[8],
        ]);

        self.header_parsed = true;
        self.offset = (data_offset as usize) + 4; // Skip PreviousTagSize0 (4 bytes)

        Some(FlvHeader {
            has_audio: self.has_audio,
            has_video: self.has_video,
            data_offset,
        })
    }

    /// Demux next available packet from the internal buffer.
    /// Returns None when more bytes are needed or EOF.
    pub fn demux_next_packet(&mut self) -> Option<Packet> {
        if !self.header_parsed && self.parse_header().is_none() {
            return None;
        }

        while self.offset + 11 <= self.buffer.len() {
            let tag_type_byte = self.buffer[self.offset];
            let data_size = ((self.buffer[self.offset + 1] as usize) << 16)
                | ((self.buffer[self.offset + 2] as usize) << 8)
                | (self.buffer[self.offset + 3] as usize);

            let timestamp_lower = ((self.buffer[self.offset + 4] as u32) << 16)
                | ((self.buffer[self.offset + 5] as u32) << 8)
                | (self.buffer[self.offset + 6] as u32);
            let timestamp_extended = self.buffer[self.offset + 7] as u32;
            let dts_ms = (timestamp_extended << 24) | timestamp_lower;

            let total_tag_size = 11 + data_size + 4; // Header(11) + Payload + PrevTagSize(4)
            if self.offset + total_tag_size > self.buffer.len() {
                // Incomplete tag, wait for more network chunks
                return None;
            }

            let payload_start = self.offset + 11;
            let payload_end = payload_start + data_size;
            let payload = &self.buffer[payload_start..payload_end];

            let mut packet: Option<Packet> = None;

            if tag_type_byte == 9 && data_size >= 5 {
                // Video Tag
                let is_extended_header = (payload[0] & 0x80) != 0;

                if is_extended_header {
                    // Enhanced FLV v2 Video Header
                    let frame_type = (payload[0] >> 4) & 0x07;
                    let packet_type = payload[0] & 0x0f;
                    let is_keyframe = frame_type == 1;
                    let fourcc = &payload[1..5];

                    if packet_type == 1 {
                        // Coded frames
                        if (fourcc == b"hvc1" || fourcc == b"hev1") && data_size >= 8 {
                            let cts_ms = ((payload[5] as i32) << 16)
                                | ((payload[6] as i32) << 8)
                                | (payload[7] as i32);
                            let pts_ms = (dts_ms as i64) + (cts_ms as i64);
                            let nalu_data = payload[8..].to_vec();
                            let pts_us = pts_ms * 1000;
                            let dts_us = (dts_ms as i64) * 1000;

                            packet = Some(Packet::new(
                                pts_us,
                                dts_us,
                                33333,
                                is_keyframe,
                                0, // Video stream index
                                nalu_data,
                            ));
                        } else if fourcc == b"av01" && data_size >= 5 {
                            let obus_data = payload[5..].to_vec();
                            let pts_us = (dts_ms as i64) * 1000;

                            packet = Some(Packet::new(
                                pts_us,
                                pts_us,
                                33333,
                                is_keyframe,
                                0,
                                obus_data,
                            ));
                        }
                    }
                } else {
                    // Standard / Legacy FLV Video Tag (AVC / H.264)
                    let frame_type = (payload[0] >> 4) & 0x0f;
                    let codec_id = payload[0] & 0x0f;
                    let is_keyframe = frame_type == 1;

                    if codec_id == 7 {
                        let avc_packet_type = payload[1];
                        let cts_ms = ((payload[2] as i32) << 16)
                            | ((payload[3] as i32) << 8)
                            | (payload[4] as i32);
                        let pts_ms = (dts_ms as i64) + (cts_ms as i64);

                        if avc_packet_type == 1 {
                            let nalu_data = payload[5..].to_vec();
                            let pts_us = pts_ms * 1000;
                            let dts_us = (dts_ms as i64) * 1000;

                            packet = Some(Packet::new(
                                pts_us,
                                dts_us,
                                33333,
                                is_keyframe,
                                0, // Video stream index
                                nalu_data,
                            ));
                        }
                    }
                }
            } else if tag_type_byte == 8 && data_size >= 2 {
                // Audio Tag
                let sound_format = (payload[0] >> 4) & 0x0f;

                if sound_format == 14 && data_size >= 5 {
                    // Enhanced Audio (ExAudio)
                    let packet_type = payload[0] & 0x0f;
                    let fourcc = &payload[1..5];

                    if fourcc == b"Opus" && packet_type == 1 {
                        let opus_data = payload[5..].to_vec();
                        let pts_us = (dts_ms as i64) * 1000;
                        packet = Some(Packet::new(
                            pts_us,
                            pts_us,
                            20000, // 20ms typical Opus frame
                            true,
                            1, // Audio stream index
                            opus_data,
                        ));
                    }
                } else if sound_format == 10 {
                    // Standard AAC
                    let aac_packet_type = payload[1];
                    if aac_packet_type == 1 {
                        let aac_data = payload[2..].to_vec();
                        let pts_us = (dts_ms as i64) * 1000;
                        packet = Some(Packet::new(
                            pts_us,
                            pts_us,
                            23219, // ~1024 samples @ 44.1kHz
                            true,
                            1, // Audio stream index
                            aac_data,
                        ));
                    }
                }
            }

            self.offset += total_tag_size;

            if let Some(pkt) = packet {
                // Compact buffer if consumed more than 32KB
                if self.offset > 32768 {
                    self.buffer.drain(0..self.offset);
                    self.offset = 0;
                }
                return Some(pkt);
            }
        }

        None
    }

    /// Compact internal buffer to free consumed memory.
    pub fn compact(&mut self) {
        if self.offset > 0 {
            self.buffer.drain(0..self.offset);
            self.offset = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_flv_demux_roundtrip() {
        let mut demuxer = RustFlvDemuxer::new();

        // Construct a synthetic FLV stream with Header + Video Tag
        let mut flv_stream = Vec::new();
        // 1. FLV Header (9 bytes)
        flv_stream.extend_from_slice(b"FLV\x01\x05\x00\x00\x00\x09");
        // PrevTagSize0 (4 bytes)
        flv_stream.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);

        // 2. Video Tag (TagType=9, DataSize=7, Timestamp=100ms)
        flv_stream.push(9); // TagType: Video
        flv_stream.extend_from_slice(&[0x00, 0x00, 0x07]); // DataSize: 7 bytes
        flv_stream.extend_from_slice(&[0x00, 0x00, 0x64]); // Timestamp: 100ms
        flv_stream.push(0x00); // TimestampExtended
        flv_stream.extend_from_slice(&[0x00, 0x00, 0x00]); // StreamID: 0

        // Video Payload: Keyframe(0x1) + AVC(0x7) = 0x17
        flv_stream.push(0x17);
        flv_stream.push(1); // AVC NALU
        flv_stream.extend_from_slice(&[0x00, 0x00, 0x00]); // CTS = 0
        flv_stream.extend_from_slice(&[0xaa, 0xbb]); // 2 bytes NAL data

        // PrevTagSize1 (4 bytes: 11 + 7 = 18 = 0x12)
        flv_stream.extend_from_slice(&[0x00, 0x00, 0x00, 0x12]);

        demuxer.append_bytes(&flv_stream);
        let header = demuxer.parse_header().expect("FLV header must parse");
        assert!(header.has_video);
        assert!(header.has_audio);

        let packet = demuxer.demux_next_packet().expect("Video packet must be demuxed");
        assert!(packet.is_keyframe());
        assert_eq!(packet.pts(), 100_000); // 100ms in us
        assert_eq!(packet.stream_index(), 0);
        assert_eq!(packet.data(), vec![0xaa, 0xbb]);
    }

    #[test]
    fn test_enhanced_flv_hevc_demux() {
        let mut demuxer = RustFlvDemuxer::new();
        let mut stream = Vec::new();

        // 1. FLV Header
        stream.extend_from_slice(b"FLV\x01\x05\x00\x00\x00\x09");
        stream.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);

        // 2. Enhanced Video Tag: TagType=9, DataSize=12, Timestamp=200ms
        // Header(11) + Payload(12) + PrevTagSize(4)
        stream.push(9);
        stream.extend_from_slice(&[0x00, 0x00, 0x0c]); // 12 bytes payload
        stream.extend_from_slice(&[0x00, 0x00, 0xc8]); // 200ms DTS
        stream.push(0x00);
        stream.extend_from_slice(&[0x00, 0x00, 0x00]);

        // Enhanced Video Payload:
        // ExHeader(0x80) | Keyframe(0x10) | CodedFrames(0x01) = 0x91
        stream.push(0x91);
        stream.extend_from_slice(b"hvc1"); // FourCC
        stream.extend_from_slice(&[0x00, 0x00, 0x14]); // CTS = 20ms
        stream.extend_from_slice(&[0x26, 0x01, 0x11, 0x22]); // HEVC IDR NAL

        // PrevTagSize (11 + 12 = 23 = 0x17)
        stream.extend_from_slice(&[0x00, 0x00, 0x00, 0x17]);

        demuxer.append_bytes(&stream);
        let pkt = demuxer.demux_next_packet().expect("Enhanced HEVC packet must demux");
        assert!(pkt.is_keyframe());
        assert_eq!(pkt.stream_index(), 0);
        // DTS = 200ms, CTS = 20ms -> PTS = 220ms (220_000 us)
        assert_eq!(pkt.pts(), 220_000);
        assert_eq!(pkt.dts(), 200_000);
        assert_eq!(pkt.data(), vec![0x26, 0x01, 0x11, 0x22]);
    }

    #[test]
    fn test_enhanced_flv_opus_demux() {
        let mut demuxer = RustFlvDemuxer::new();
        let mut stream = Vec::new();

        // 1. FLV Header
        stream.extend_from_slice(b"FLV\x01\x05\x00\x00\x00\x09");
        stream.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);

        // 2. Enhanced Audio Tag: TagType=8, DataSize=8, Timestamp=50ms
        stream.push(8);
        stream.extend_from_slice(&[0x00, 0x00, 0x08]); // 8 bytes payload
        stream.extend_from_slice(&[0x00, 0x00, 0x32]); // 50ms DTS
        stream.push(0x00);
        stream.extend_from_slice(&[0x00, 0x00, 0x00]);

        // Enhanced Audio Payload:
        // ExAudio(0xe0) | CodedFrames(0x01) = 0xe1
        stream.push(0xe1);
        stream.extend_from_slice(b"Opus"); // FourCC
        stream.extend_from_slice(&[0xfc, 0xaa, 0xbb]); // Opus payload

        // PrevTagSize (11 + 8 = 19 = 0x13)
        stream.extend_from_slice(&[0x00, 0x00, 0x00, 0x13]);

        demuxer.append_bytes(&stream);
        let pkt = demuxer.demux_next_packet().expect("Enhanced Opus packet must demux");
        assert_eq!(pkt.stream_index(), 1); // Audio
        assert_eq!(pkt.pts(), 50_000);
        assert_eq!(pkt.data(), vec![0xfc, 0xaa, 0xbb]);
    }
}
