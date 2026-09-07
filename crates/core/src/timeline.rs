use std::collections::BinaryHeap;
use std::cmp::Ordering;
use wasm_bindgen::prelude::*;
use crate::packet::Packet;

/// Internal entry for priority queue ordering by PTS.
#[derive(Debug)]
struct ReorderEntry {
    pts: i64,
    packet: Packet,
}

impl PartialEq for ReorderEntry {
    fn eq(&self, other: &Self) -> bool {
        self.pts == other.pts
    }
}

impl Eq for ReorderEntry {}

// Min-heap ordered by PTS (smallest PTS comes out first)
impl Ord for ReorderEntry {
    fn cmp(&self, other: &Self) -> Ordering {
        other.pts.cmp(&self.pts)
    }
}

impl PartialOrd for ReorderEntry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Timeline and B-frame reordering scheduler.
/// Solves the out-of-order timestamp bug common in naive hardware decoder implementations.
#[wasm_bindgen]
pub struct TimelineQueue {
    queue: BinaryHeap<ReorderEntry>,
    max_delay_frames: usize,
    last_emitted_pts: i64,
}

#[wasm_bindgen]
impl TimelineQueue {
    #[wasm_bindgen(constructor)]
    pub fn new(max_delay_frames: usize) -> Self {
        Self {
            queue: BinaryHeap::new(),
            max_delay_frames: if max_delay_frames == 0 { 4 } else { max_delay_frames },
            last_emitted_pts: -1,
        }
    }

    /// Push an input packet into the reordering queue.
    pub fn push(&mut self, packet: Packet) {
        self.queue.push(ReorderEntry {
            pts: packet.pts(),
            packet,
        });
    }

    /// Check if a packet is ready to be consumed in strict PTS order.
    pub fn can_pop(&self) -> bool {
        self.queue.len() >= self.max_delay_frames
    }

    fn sanitize_packet(&mut self, mut packet: Packet) -> Packet {
        let raw_pts = packet.pts();
        let non_negative = if raw_pts < 0 { 0 } else { raw_pts };
        let sanitized_pts = if self.last_emitted_pts >= 0 && non_negative <= self.last_emitted_pts {
            self.last_emitted_pts + 1
        } else {
            non_negative
        };
        packet.set_pts(sanitized_pts);
        self.last_emitted_pts = sanitized_pts;
        packet
    }

    /// Pop the next packet with the lowest PTS, guaranteed to be monotonically increasing.
    pub fn pop(&mut self) -> Option<Packet> {
        self.queue.pop().map(|e| self.sanitize_packet(e.packet))
    }

    /// Flush remaining packets when stream ends (e.g. EOF).
    pub fn flush_next(&mut self) -> Option<Packet> {
        self.queue.pop().map(|e| self.sanitize_packet(e.packet))
    }

    /// Current buffered queue size.
    pub fn len(&self) -> usize {
        self.queue.len()
    }

    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    /// Clear all queues (e.g. on seek).
    pub fn clear(&mut self) {
        self.queue.clear();
        self.last_emitted_pts = -1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_b_frame_reordering() {
        let mut scheduler = TimelineQueue::new(3);

        // Simulated out-of-order decode packets: DTS=0 (PTS=2000), DTS=1 (PTS=1000), DTS=2 (PTS=3000)
        let p1 = Packet::new(2000, 0, 1000, false, 0, vec![1]);
        let p2 = Packet::new(1000, 1, 1000, false, 0, vec![2]);
        let p3 = Packet::new(3000, 2, 1000, false, 0, vec![3]);

        scheduler.push(p1);
        scheduler.push(p2);
        scheduler.push(p3);

        assert!(scheduler.can_pop());

        // Min-heap must emit PTS=1000 first, then PTS=2000, then PTS=3000
        let out1 = scheduler.pop().unwrap();
        assert_eq!(out1.pts(), 1000);

        let out2 = scheduler.pop().unwrap();
        assert_eq!(out2.pts(), 2000);

        let out3 = scheduler.pop().unwrap();
        assert_eq!(out3.pts(), 3000);

        assert!(scheduler.is_empty());
    }

    #[test]
    fn test_negative_and_retrograde_pts_autocorrection() {
        let mut scheduler = TimelineQueue::new(1);

        // Negative PTS and retrograde PTS packets
        let p_neg = Packet::new(-5000, 0, 1000, true, 0, vec![1]);
        let p_same = Packet::new(0, 1, 1000, false, 0, vec![2]);
        let p_regress = Packet::new(-100, 2, 1000, false, 0, vec![3]);

        scheduler.push(p_neg);
        let out1 = scheduler.pop().unwrap();
        assert_eq!(out1.pts(), 0, "Negative PTS must be clamped to 0");

        scheduler.push(p_same);
        let out2 = scheduler.pop().unwrap();
        assert!(out2.pts() > out1.pts(), "Identical or retrograde PTS must be clamped monotonically");

        scheduler.push(p_regress);
        let out3 = scheduler.pop().unwrap();
        assert!(out3.pts() > out2.pts(), "Retrograde timestamp must be clamped monotonically");
    }
}

