//! WebRTC & Live Stream RTP Packetization & Depacketization (RFC 3550, RFC 6184, RFC 7798).
//!
//! Provides industrial-grade handling of:
//! - RFC 3550 standard RTP 12-byte headers and extension headers.
//! - RFC 3550 Appendix A.1 modular 16-bit sequence number unrolling ($65535 \to 0$).
//! - RFC 6184 H.264: Single NAL, STAP-A aggregation, and FU-A fragmentation.
//! - RFC 7798 H.265 / HEVC: Single NAL (0..47), AP aggregation (48), and FU fragmentation (49).
//! - FAIL-09 Self-Correction: Dropped fragment detection and corrupt NAL purge without WebCodecs crash.
//! - FAIL-10 Self-Correction: Seamless sequence wrap-around without packet loss.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RtpHeader {
    pub version: u8,
    pub padding: bool,
    pub extension: bool,
    pub csrc_count: u8,
    pub marker: bool,
    pub payload_type: u8,
    pub sequence_number: u16,
    pub timestamp: u32,
    pub ssrc: u32,
    pub header_len: usize,
}

impl RtpHeader {
    /// Parse RFC 3550 RTP fixed header and optional extensions.
    pub fn parse(data: &[u8]) -> Result<(Self, &[u8]), &'static str> {
        if data.len() < 12 {
            return Err("RTP packet too small (<12 bytes)");
        }

        let b0 = data[0];
        let version = (b0 >> 6) & 0x03;
        if version != 2 {
            return Err("Unsupported RTP version (must be 2)");
        }

        let padding = ((b0 >> 5) & 0x01) == 1;
        let extension = ((b0 >> 4) & 0x01) == 1;
        let csrc_count = b0 & 0x0F;

        let b1 = data[1];
        let marker = ((b1 >> 7) & 0x01) == 1;
        let payload_type = b1 & 0x7F;

        let sequence_number = u16::from_be_bytes([data[2], data[3]]);
        let timestamp = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
        let ssrc = u32::from_be_bytes([data[8], data[9], data[10], data[11]]);

        let mut header_len = 12 + (csrc_count as usize) * 4;
        if data.len() < header_len {
            return Err("RTP packet truncated within CSRC list");
        }

        if extension {
            if data.len() < header_len + 4 {
                return Err("RTP packet truncated within extension header");
            }
            // Skip 2-byte defined-by-profile and read 2-byte length (count of 32-bit words)
            let ext_words = u16::from_be_bytes([data[header_len + 2], data[header_len + 3]]) as usize;
            header_len += 4 + ext_words * 4;
            if data.len() < header_len {
                return Err("RTP packet truncated within extension body");
            }
        }

        let mut payload_len = data.len() - header_len;
        if padding {
            if payload_len == 0 {
                return Err("RTP packet has padding flag but empty payload");
            }
            let pad_len = data[data.len() - 1] as usize;
            if pad_len > payload_len {
                return Err("Invalid RTP padding length exceeds payload");
            }
            payload_len -= pad_len;
        }

        let payload = &data[header_len..header_len + payload_len];

        Ok((
            RtpHeader {
                version,
                padding,
                extension,
                csrc_count,
                marker,
                payload_type,
                sequence_number,
                timestamp,
                ssrc,
                header_len,
            },
            payload,
        ))
    }
}

/// Continuous 16-bit to 64-bit sequence number unroller based on RFC 3550 Appendix A.1.
#[derive(Debug, Clone)]
pub struct RtpSequenceUnroller {
    max_seq: u16,
    cycles: u64,
    initialized: bool,
}

impl RtpSequenceUnroller {
    pub fn new() -> Self {
        Self {
            max_seq: 0,
            cycles: 0,
            initialized: false,
        }
    }

    /// Unroll 16-bit sequence number to a continuous 64-bit monotonic sequence.
    /// Handles wrap-around from 65535 to 0 seamlessly (FAIL-10).
    pub fn unroll(&mut self, seq: u16) -> u64 {
        if !self.initialized {
            self.max_seq = seq;
            self.cycles = 0;
            self.initialized = true;
            return seq as u64;
        }

        let delta = seq.wrapping_sub(self.max_seq) as i16;
        if delta > 0 {
            if seq < self.max_seq {
                // Wrap-around occurred: e.g. max_seq = 65535, seq = 0, delta = 1 > 0
                self.cycles += 1;
            }
            self.max_seq = seq;
        }

        (self.cycles << 16) + (seq as u64)
    }

    pub fn reset(&mut self) {
        self.initialized = false;
        self.max_seq = 0;
        self.cycles = 0;
    }
}

/// Continuous 32-bit to 64-bit RTP timestamp unroller & 90kHz microsecond converter.
#[derive(Debug, Clone)]
pub struct RtpTimestampUnroller {
    max_ts: u32,
    cycles: u64,
    initialized: bool,
    clock_rate: u32,
}

impl RtpTimestampUnroller {
    pub fn new(clock_rate: u32) -> Self {
        Self {
            max_ts: 0,
            cycles: 0,
            initialized: false,
            clock_rate: if clock_rate == 0 { 90000 } else { clock_rate },
        }
    }

    pub fn unroll(&mut self, ts: u32) -> u64 {
        if !self.initialized {
            self.max_ts = ts;
            self.cycles = 0;
            self.initialized = true;
            return ts as u64;
        }

        let delta = ts.wrapping_sub(self.max_ts) as i32;
        if delta > 0 {
            if ts < self.max_ts {
                self.cycles += 1;
            }
            self.max_ts = ts;
        }

        (self.cycles << 32) + (ts as u64)
    }

    /// Convert raw RTP timestamp to absolute microseconds.
    pub fn to_pts_us(&mut self, ts: u32) -> i64 {
        let unrolled = self.unroll(ts);
        ((unrolled as u128 * 1_000_000) / (self.clock_rate as u128)) as i64
    }
}

/// Reconstructed video frame containing one or more NAL units.
#[derive(Debug, Clone)]
pub struct RtpFrame {
    pub nals: Vec<Vec<u8>>,
    pub pts_us: i64,
    pub is_keyframe: bool,
    pub ssrc: u32,
    pub marker: bool,
}

impl RtpFrame {
    /// Convert all assembled NAL units into Annex-B format (prefixed with 0x00000001).
    pub fn to_annex_b(&self) -> Vec<u8> {
        let mut total_size = 0;
        for nal in &self.nals {
            total_size += 4 + nal.len();
        }
        let mut out = Vec::with_capacity(total_size);
        for nal in &self.nals {
            out.extend_from_slice(&[0, 0, 0, 1]);
            out.extend_from_slice(nal);
        }
        out
    }

    /// Convert all assembled NAL units into AVCC format (prefixed with 4-byte big-endian length).
    pub fn to_avcc(&self) -> Vec<u8> {
        let mut total_size = 0;
        for nal in &self.nals {
            total_size += 4 + nal.len();
        }
        let mut out = Vec::with_capacity(total_size);
        for nal in &self.nals {
            out.extend_from_slice(&(nal.len() as u32).to_be_bytes());
            out.extend_from_slice(nal);
        }
        out
    }
}

/// Industrial RFC 6184 H.264 Depacketizer with FAIL-09 fragment loss self-healing.
pub struct RtpDepacketizerH264 {
    seq_unroller: RtpSequenceUnroller,
    ts_unroller: RtpTimestampUnroller,
    current_nals: Vec<Vec<u8>>,
    fu_buffer: Vec<u8>,
    fu_expected_seq: u16,
    fu_in_progress: bool,
    fu_has_gap: bool,
    has_keyframe: bool,
    pub packets_received: u64,
    pub packets_dropped: u64,
    pub frames_assembled: u64,
}

impl RtpDepacketizerH264 {
    pub fn new() -> Self {
        Self {
            seq_unroller: RtpSequenceUnroller::new(),
            ts_unroller: RtpTimestampUnroller::new(90000),
            current_nals: Vec::new(),
            fu_buffer: Vec::new(),
            fu_expected_seq: 0,
            fu_in_progress: false,
            fu_has_gap: false,
            has_keyframe: false,
            packets_received: 0,
            packets_dropped: 0,
            frames_assembled: 0,
        }
    }

    /// Ingest a raw RTP packet and assemble NAL units.
    /// When the frame is complete (Marker bit `M=1` or timestamp shift), returns `Some(RtpFrame)`.
    pub fn push_packet(&mut self, packet_bytes: &[u8]) -> Result<Option<RtpFrame>, &'static str> {
        self.packets_received += 1;
        let (header, payload) = RtpHeader::parse(packet_bytes)?;
        let _unrolled_seq = self.seq_unroller.unroll(header.sequence_number);
        let pts_us = self.ts_unroller.to_pts_us(header.timestamp);

        if payload.is_empty() {
            return Ok(None);
        }

        let nal_header = payload[0];
        let nal_type = nal_header & 0x1F;

        match nal_type {
            // Types 1..23: Single NAL Unit Packet
            1..=23 => {
                if nal_type == 5 || nal_type == 7 || nal_type == 8 {
                    self.has_keyframe = true;
                }
                self.current_nals.push(payload.to_vec());
            }

            // Type 24: STAP-A (Single-Time Aggregation Packet)
            24 => {
                let mut offset = 1;
                while offset + 2 <= payload.len() {
                    let nalu_size = u16::from_be_bytes([payload[offset], payload[offset + 1]]) as usize;
                    offset += 2;
                    if offset + nalu_size > payload.len() {
                        // Malformed STAP-A truncation defense
                        break;
                    }
                    let nalu = &payload[offset..offset + nalu_size];
                    if !nalu.is_empty() {
                        let inner_type = nalu[0] & 0x1F;
                        if inner_type == 5 || inner_type == 7 || inner_type == 8 {
                            self.has_keyframe = true;
                        }
                        self.current_nals.push(nalu.to_vec());
                    }
                    offset += nalu_size;
                }
            }

            // Type 28: FU-A (Fragmentation Unit Type A)
            28 => {
                if payload.len() < 2 {
                    return Err("Truncated FU-A packet");
                }
                let fu_indicator = payload[0];
                let fu_header = payload[1];
                let start_bit = (fu_header & 0x80) != 0;
                let end_bit = (fu_header & 0x40) != 0;
                let original_nal_type = fu_header & 0x1F;

                if start_bit {
                    // Reconstruct original NAL header: (fu_indicator & 0xE0) | (fu_header & 0x1F)
                    let reconstructed_header = (fu_indicator & 0xE0) | original_nal_type;
                    self.fu_buffer.clear();
                    self.fu_buffer.push(reconstructed_header);
                    self.fu_buffer.extend_from_slice(&payload[2..]);
                    self.fu_expected_seq = header.sequence_number.wrapping_add(1);
                    self.fu_in_progress = true;
                    self.fu_has_gap = false;

                    if original_nal_type == 5 {
                        self.has_keyframe = true;
                    }
                } else if self.fu_in_progress {
                    // FAIL-09 Defense: Check sequence continuity
                    if header.sequence_number != self.fu_expected_seq {
                        // Intermediate fragment lost! Drop corrupted buffer
                        self.fu_has_gap = true;
                        self.fu_in_progress = false;
                        self.fu_buffer.clear();
                        self.packets_dropped += 1;
                    } else if !self.fu_has_gap {
                        self.fu_buffer.extend_from_slice(&payload[2..]);
                        self.fu_expected_seq = header.sequence_number.wrapping_add(1);

                        if end_bit {
                            // Completed reassembly of fragmented NAL
                            let full_nal = std::mem::take(&mut self.fu_buffer);
                            self.current_nals.push(full_nal);
                            self.fu_in_progress = false;
                        }
                    }
                } else {
                    // Orphaned intermediate fragment without start bit: drop it
                    self.packets_dropped += 1;
                }
            }

            _ => {}
        }

        if header.marker && !self.current_nals.is_empty() {
            let nals = std::mem::take(&mut self.current_nals);
            let frame = RtpFrame {
                nals,
                pts_us,
                is_keyframe: self.has_keyframe,
                ssrc: header.ssrc,
                marker: true,
            };
            self.has_keyframe = false;
            self.frames_assembled += 1;
            Ok(Some(frame))
        } else {
            Ok(None)
        }
    }
}

/// RFC 6184 H.264 RTP Packetizer: splits raw NAL units into MTU-safe RTP packets.
pub struct RtpPacketizerH264 {
    mtu: usize,
    payload_type: u8,
    sequence_number: u16,
    ssrc: u32,
    clock_rate: u32,
}

impl RtpPacketizerH264 {
    pub fn new(mtu: usize, payload_type: u8, ssrc: u32) -> Self {
        Self {
            mtu: if mtu < 128 { 1400 } else { mtu },
            payload_type,
            sequence_number: 1,
            ssrc,
            clock_rate: 90000,
        }
    }

    /// Packetize a single H.264 NAL unit into one or more RTP packets.
    /// If `is_last_nal_of_frame` is true, the marker bit is set on the final RTP packet.
    pub fn packetize_nal(
        &mut self,
        nal: &[u8],
        pts_us: i64,
        is_last_nal_of_frame: bool,
    ) -> Vec<Vec<u8>> {
        if nal.is_empty() {
            return Vec::new();
        }

        let ts = ((pts_us as u128 * self.clock_rate as u128) / 1_000_000) as u32;
        let mut packets = Vec::new();

        // 12 bytes RTP header
        let max_payload = self.mtu.saturating_sub(12);

        if nal.len() <= max_payload {
            // Single NAL unit packet
            let mut packet = Vec::with_capacity(12 + nal.len());
            self.write_header(&mut packet, is_last_nal_of_frame, ts);
            packet.extend_from_slice(nal);
            packets.push(packet);
        } else {
            // FU-A fragmentation
            let nal_header = nal[0];
            let nri = nal_header & 0x60;
            let nal_type = nal_header & 0x1F;
            let fu_indicator = nri | 28;

            let raw_data = &nal[1..];
            let chunk_size = max_payload.saturating_sub(2); // 2 bytes for FU indicator + FU header
            let mut offset = 0;

            while offset < raw_data.len() {
                let end = (offset + chunk_size).min(raw_data.len());
                let is_first = offset == 0;
                let is_last = end == raw_data.len();

                let mut fu_header = nal_type;
                if is_first {
                    fu_header |= 0x80; // Start bit
                }
                if is_last {
                    fu_header |= 0x40; // End bit
                }

                let marker = is_last && is_last_nal_of_frame;
                let mut packet = Vec::with_capacity(12 + 2 + (end - offset));
                self.write_header(&mut packet, marker, ts);
                packet.push(fu_indicator);
                packet.push(fu_header);
                packet.extend_from_slice(&raw_data[offset..end]);

                packets.push(packet);
                offset = end;
            }
        }

        packets
    }

    fn write_header(&mut self, out: &mut Vec<u8>, marker: bool, timestamp: u32) {
        out.push(0x80); // V=2, P=0, X=0, CC=0
        let b1 = if marker { 0x80 | self.payload_type } else { self.payload_type };
        out.push(b1);
        out.extend_from_slice(&self.sequence_number.to_be_bytes());
        out.extend_from_slice(&timestamp.to_be_bytes());
        out.extend_from_slice(&self.ssrc.to_be_bytes());

        self.sequence_number = self.sequence_number.wrapping_add(1);
    }
}

/// RFC 7798 H.265 / HEVC Depacketizer.
pub struct RtpDepacketizerH265 {
    seq_unroller: RtpSequenceUnroller,
    ts_unroller: RtpTimestampUnroller,
    current_nals: Vec<Vec<u8>>,
    fu_buffer: Vec<u8>,
    fu_expected_seq: u16,
    fu_in_progress: bool,
    fu_has_gap: bool,
    has_keyframe: bool,
    pub packets_received: u64,
    pub packets_dropped: u64,
    pub frames_assembled: u64,
}

impl RtpDepacketizerH265 {
    pub fn new() -> Self {
        Self {
            seq_unroller: RtpSequenceUnroller::new(),
            ts_unroller: RtpTimestampUnroller::new(90000),
            current_nals: Vec::new(),
            fu_buffer: Vec::new(),
            fu_expected_seq: 0,
            fu_in_progress: false,
            fu_has_gap: false,
            has_keyframe: false,
            packets_received: 0,
            packets_dropped: 0,
            frames_assembled: 0,
        }
    }

    pub fn push_packet(&mut self, packet_bytes: &[u8]) -> Result<Option<RtpFrame>, &'static str> {
        self.packets_received += 1;
        let (header, payload) = RtpHeader::parse(packet_bytes)?;
        let _unrolled_seq = self.seq_unroller.unroll(header.sequence_number);
        let pts_us = self.ts_unroller.to_pts_us(header.timestamp);

        if payload.len() < 2 {
            return Ok(None);
        }

        // H.265 2-byte payload header
        let nal_type = (payload[0] >> 1) & 0x3F;

        match nal_type {
            // Types 0..47: Single NAL Unit Packet
            0..=47 => {
                if (19..=21).contains(&nal_type) || (32..=34).contains(&nal_type) {
                    self.has_keyframe = true;
                }
                self.current_nals.push(payload.to_vec());
            }

            // Type 48: AP (Aggregation Packet)
            48 => {
                let mut offset = 2; // Skip 2-byte AP header
                while offset + 2 <= payload.len() {
                    let nalu_size = u16::from_be_bytes([payload[offset], payload[offset + 1]]) as usize;
                    offset += 2;
                    if offset + nalu_size > payload.len() {
                        break;
                    }
                    let nalu = &payload[offset..offset + nalu_size];
                    if nalu.len() >= 2 {
                        let inner_type = (nalu[0] >> 1) & 0x3F;
                        if (19..=21).contains(&inner_type) || (32..=34).contains(&inner_type) {
                            self.has_keyframe = true;
                        }
                        self.current_nals.push(nalu.to_vec());
                    }
                    offset += nalu_size;
                }
            }

            // Type 49: FU (Fragmentation Unit)
            49 => {
                if payload.len() < 3 {
                    return Err("Truncated H.265 FU packet");
                }
                let fu_header = payload[2];
                let start_bit = (fu_header & 0x80) != 0;
                let end_bit = (fu_header & 0x40) != 0;
                let original_nal_type = fu_header & 0x3F;

                if start_bit {
                    // Reconstruct 2-byte NAL header:
                    // Byte 0: (payload[0] & 0x81) | (original_nal_type << 1)
                    // Byte 1: payload[1]
                    let byte0 = (payload[0] & 0x81) | (original_nal_type << 1);
                    let byte1 = payload[1];
                    self.fu_buffer.clear();
                    self.fu_buffer.push(byte0);
                    self.fu_buffer.push(byte1);
                    self.fu_buffer.extend_from_slice(&payload[3..]);
                    self.fu_expected_seq = header.sequence_number.wrapping_add(1);
                    self.fu_in_progress = true;
                    self.fu_has_gap = false;

                    if (19..=21).contains(&original_nal_type) {
                        self.has_keyframe = true;
                    }
                } else if self.fu_in_progress {
                    if header.sequence_number != self.fu_expected_seq {
                        self.fu_has_gap = true;
                        self.fu_in_progress = false;
                        self.fu_buffer.clear();
                        self.packets_dropped += 1;
                    } else if !self.fu_has_gap {
                        self.fu_buffer.extend_from_slice(&payload[3..]);
                        self.fu_expected_seq = header.sequence_number.wrapping_add(1);

                        if end_bit {
                            let full_nal = std::mem::take(&mut self.fu_buffer);
                            self.current_nals.push(full_nal);
                            self.fu_in_progress = false;
                        }
                    }
                } else {
                    self.packets_dropped += 1;
                }
            }

            _ => {}
        }

        if header.marker && !self.current_nals.is_empty() {
            let nals = std::mem::take(&mut self.current_nals);
            let frame = RtpFrame {
                nals,
                pts_us,
                is_keyframe: self.has_keyframe,
                ssrc: header.ssrc,
                marker: true,
            };
            self.has_keyframe = false;
            self.frames_assembled += 1;
            Ok(Some(frame))
        } else {
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rtp_header_parse_and_unroller() {
        let mut raw = vec![0x80, 0x60, 0x00, 0x01, 0x00, 0x01, 0x5F, 0x90, 0x12, 0x34, 0x56, 0x78];
        raw.extend_from_slice(&[0x67, 0x42, 0x00, 0x1f]); // SPS dummy

        let (header, payload) = RtpHeader::parse(&raw).unwrap();
        assert_eq!(header.version, 2);
        assert_eq!(header.sequence_number, 1);
        assert_eq!(header.timestamp, 90000);
        assert_eq!(header.payload_type, 96);
        assert_eq!(payload, &[0x67, 0x42, 0x00, 0x1f]);

        let mut unroller = RtpSequenceUnroller::new();
        assert_eq!(unroller.unroll(65535), 65535);
        // FAIL-10: Sequence wrap-around
        assert_eq!(unroller.unroll(0), 65536);
        assert_eq!(unroller.unroll(1), 65537);
    }

    #[test]
    fn test_h264_rtp_roundtrip_fu_a() {
        // Create a large 3000-byte synthetic IDR slice
        let mut large_nal = vec![0x65]; // IDR slice (type 5, NRI=3)
        large_nal.resize(3000, 0xAB);

        let mut packetizer = RtpPacketizerH264::new(1400, 96, 0x11223344);
        let packets = packetizer.packetize_nal(&large_nal, 33333, true);
        assert_eq!(packets.len(), 3); // 3000 bytes split across ~1400 MTU

        let mut depacketizer = RtpDepacketizerH264::new();
        let mut completed_frame = None;

        for packet in &packets {
            if let Some(frame) = depacketizer.push_packet(packet).unwrap() {
                completed_frame = Some(frame);
            }
        }

        let frame = completed_frame.expect("Frame should be completed on last packet");
        assert!(frame.is_keyframe);
        assert!((frame.pts_us - 33333).abs() <= 20);
        assert_eq!(frame.nals.len(), 1);
        assert_eq!(frame.nals[0], large_nal);
    }

    #[test]
    fn test_fail09_dropped_fragment_protection() {
        // Create a 3-part FU-A sequence
        let mut large_nal = vec![0x65];
        large_nal.resize(3000, 0xCC);

        let mut packetizer = RtpPacketizerH264::new(1400, 96, 0x11223344);
        let packets = packetizer.packetize_nal(&large_nal, 66666, true);
        assert_eq!(packets.len(), 3);

        let mut depacketizer = RtpDepacketizerH264::new();

        // Feed packet 0 (Start fragment)
        assert!(depacketizer.push_packet(&packets[0]).unwrap().is_none());

        // DROP packet 1 (Middle fragment lost in weak network!)
        // Directly feed packet 2 (End fragment with marker)
        let result = depacketizer.push_packet(&packets[2]).unwrap();

        // FAIL-09 defense: Must NOT emit corrupted partial frame!
        assert!(result.is_none(), "Must reject corrupted frame with missing fragment");
        assert_eq!(depacketizer.packets_dropped, 1, "Must record dropped packet/fragment");
    }

    #[test]
    fn test_h264_stap_a_aggregation() {
        let sps = vec![0x67, 0x42, 0x00, 0x1F];
        let pps = vec![0x68, 0xCE, 0x3C, 0x80];

        // Build STAP-A RTP packet manually:
        // Header (12 bytes) + STAP-A indicator (0x78 = 24) + [len][sps] + [len][pps]
        let mut raw = vec![0x80, 0xE0, 0x00, 0x0A, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]; // Marker=1
        raw.push(24); // STAP-A
        raw.extend_from_slice(&(sps.len() as u16).to_be_bytes());
        raw.extend_from_slice(&sps);
        raw.extend_from_slice(&(pps.len() as u16).to_be_bytes());
        raw.extend_from_slice(&pps);

        let mut depacketizer = RtpDepacketizerH264::new();
        let frame = depacketizer.push_packet(&raw).unwrap().expect("STAP-A frame");

        assert!(frame.is_keyframe);
        assert_eq!(frame.nals.len(), 2);
        assert_eq!(frame.nals[0], sps);
        assert_eq!(frame.nals[1], pps);
    }

    #[test]
    fn test_h265_rtp_depacketizer() {
        // H.265 IDR slice (type 19 -> 0x26, 0x01)
        let mut raw = vec![0x80, 0xE0, 0x00, 0x10, 0x00, 0x01, 0x5F, 0x90, 0x00, 0x00, 0x00, 0x02];
        let h265_header = [19 << 1, 0x01]; // Type 19, TID 1
        raw.extend_from_slice(&h265_header);
        raw.extend_from_slice(&[0x11, 0x22, 0x33, 0x44]);

        let mut depacketizer = RtpDepacketizerH265::new();
        let frame = depacketizer.push_packet(&raw).unwrap().expect("H.265 frame");
        assert!(frame.is_keyframe);
        assert_eq!(frame.nals.len(), 1);
        assert_eq!(frame.nals[0][0..2], h265_header);
    }

    #[test]
    fn test_fail10_sequence_wraparound_continuity() {
        let mut depacketizer = RtpDepacketizerH264::new();

        // Feed packet at seq 65534
        let p1 = vec![0x80, 0x60, 0xFF, 0xFE, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x67, 0x42];
        depacketizer.push_packet(&p1).unwrap();

        // Feed packet at seq 65535
        let p2 = vec![0x80, 0x60, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x68, 0xCE];
        depacketizer.push_packet(&p2).unwrap();

        // FAIL-10: Wrap-around across 65535 to 0 with Marker bit
        let p3 = vec![0x80, 0xE0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x65, 0x88];
        let frame = depacketizer.push_packet(&p3).unwrap().expect("Frame after wrap-around");
        assert_eq!(frame.nals.len(), 3);
        assert_eq!(depacketizer.packets_dropped, 0, "No packets should be dropped across 65535 wrap");
    }

    #[test]
    fn test_h265_fu_fragmentation_reassembly() {
        let mut depacketizer = RtpDepacketizerH265::new();

        // H.265 FU fragment 1 (Start bit S=1, FuType=19 IDR):
        // Header: 12 bytes
        // Payload: [PayloadHdr0, PayloadHdr1, FuHdr]
        // PayloadHdr0 = (49 << 1) = 98 (0x62), PayloadHdr1 = 1 (TID=1)
        // FuHdr: S=1 (0x80) | 19 = 0x93
        let p1 = vec![
            0x80, 0x60, 0x00, 0x01, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x02,
            0x62, 0x01, 0x93, 0xAA, 0xBB,
        ];
        assert!(depacketizer.push_packet(&p1).unwrap().is_none());

        // H.265 FU fragment 2 (End bit E=1, Marker=1, FuType=19):
        // FuHdr: E=1 (0x40) | 19 = 0x53
        let p2 = vec![
            0x80, 0xE0, 0x00, 0x02, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x02,
            0x62, 0x01, 0x53, 0xCC, 0xDD,
        ];
        let frame = depacketizer.push_packet(&p2).unwrap().expect("Reassembled H.265 FU frame");
        assert!(frame.is_keyframe);
        assert_eq!(frame.nals.len(), 1);
        // Check reconstructed NAL header: (0x62 & 0x81) | (19 << 1) = 0 | 38 = 0x26, byte 1 = 1
        assert_eq!(frame.nals[0][0], (19 << 1));
        assert_eq!(frame.nals[0][1], 0x01);
        assert_eq!(&frame.nals[0][2..], &[0xAA, 0xBB, 0xCC, 0xDD]);
    }
}

