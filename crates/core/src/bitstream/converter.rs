/// Bidirectional high-throughput converter between Annex-B (start-code delimited)
/// and AVCC / ISO BMFF (length-prefixed) bitstreams.
///
/// Ensures zero panic on malformed streams and minimal memory allocation.

/// Convert an Annex-B bitstream (start codes `00 00 00 01` or `00 00 01`)
/// to AVCC format (4-byte big-endian length prefix per NAL unit).
pub fn annex_b_to_avcc(annex_b: &[u8]) -> Vec<u8> {
    if annex_b.is_empty() {
        return Vec::new();
    }

    let len = annex_b.len();
    let mut start_indices: Vec<(usize, usize)> = Vec::new(); // (start_idx, prefix_len)

    let mut i = 0;
    while i + 2 < len {
        if annex_b[i] == 0 && annex_b[i + 1] == 0 {
            if annex_b[i + 2] == 1 {
                start_indices.push((i, 3));
                i += 3;
                continue;
            } else if i + 3 < len && annex_b[i + 2] == 0 && annex_b[i + 3] == 1 {
                start_indices.push((i, 4));
                i += 4;
                continue;
            }
        }
        i += 1;
    }

    if start_indices.is_empty() {
        // No start code found: treat whole buffer as single NAL if non-empty
        let mut avcc = Vec::with_capacity(4 + len);
        avcc.extend_from_slice(&(len as u32).to_be_bytes());
        avcc.extend_from_slice(annex_b);
        return avcc;
    }

    let mut avcc = Vec::with_capacity(annex_b.len());

    for idx in 0..start_indices.len() {
        let (pos, prefix_len) = start_indices[idx];
        let nal_start = pos + prefix_len;
        let nal_end = if idx + 1 < start_indices.len() {
            start_indices[idx + 1].0
        } else {
            len
        };

        if nal_start < nal_end {
            let nal_bytes = &annex_b[nal_start..nal_end];
            let nal_len = nal_bytes.len() as u32;
            avcc.extend_from_slice(&nal_len.to_be_bytes());
            avcc.extend_from_slice(nal_bytes);
        }
    }

    avcc
}

/// Convert an AVCC format bitstream (4-byte big-endian length prefix)
/// to Annex-B format (prefixed with `00 00 00 01`).
pub fn avcc_to_annex_b(avcc: &[u8]) -> Vec<u8> {
    if avcc.len() < 4 {
        return Vec::new();
    }

    let mut annex_b = Vec::with_capacity(avcc.len() + 16);
    let mut offset = 0;

    while offset + 4 <= avcc.len() {
        let nal_len = u32::from_be_bytes([
            avcc[offset],
            avcc[offset + 1],
            avcc[offset + 2],
            avcc[offset + 3],
        ]) as usize;

        offset += 4;

        if offset + nal_len > avcc.len() {
            // Truncated packet: salvage available bytes
            let available = &avcc[offset..];
            if !available.is_empty() {
                annex_b.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
                annex_b.extend_from_slice(available);
            }
            break;
        }

        annex_b.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);
        annex_b.extend_from_slice(&avcc[offset..offset + nal_len]);
        offset += nal_len;
    }

    annex_b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_annex_b_to_avcc_and_roundtrip() {
        let raw_annex_b = vec![
            0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f, // 4-byte prefix SPS (4 bytes)
            0x00, 0x00, 0x01, 0x68, 0xce, 0x3c,             // 3-byte prefix PPS (3 bytes)
            0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00, // 4-byte prefix IDR (4 bytes)
        ];

        let avcc = annex_b_to_avcc(&raw_annex_b);
        assert_eq!(avcc.len(), (4 + 4) + (4 + 3) + (4 + 4));

        // Verify AVCC length prefixes
        let sps_len = u32::from_be_bytes([avcc[0], avcc[1], avcc[2], avcc[3]]);
        assert_eq!(sps_len, 4);
        assert_eq!(&avcc[4..8], &[0x67, 0x42, 0x00, 0x1f]);

        let pps_len = u32::from_be_bytes([avcc[8], avcc[9], avcc[10], avcc[11]]);
        assert_eq!(pps_len, 3);
        assert_eq!(&avcc[12..15], &[0x68, 0xce, 0x3c]);

        // Convert back to Annex-B
        let roundtrip_annex_b = avcc_to_annex_b(&avcc);
        assert_eq!(
            roundtrip_annex_b,
            vec![
                0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f,
                0x00, 0x00, 0x00, 0x01, 0x68, 0xce, 0x3c,
                0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00,
            ]
        );
    }

    #[test]
    fn test_truncated_avcc_safety() {
        // Declared length is 100, but only 3 bytes follow
        let mut malformed = vec![0x00, 0x00, 0x00, 100];
        malformed.extend_from_slice(&[0xaa, 0xbb, 0xcc]);

        let annex_b = avcc_to_annex_b(&malformed);
        assert_eq!(annex_b.len(), 4 + 3);
        assert_eq!(&annex_b[0..4], &[0x00, 0x00, 0x00, 0x01]);
        assert_eq!(&annex_b[4..], &[0xaa, 0xbb, 0xcc]);
    }
}
