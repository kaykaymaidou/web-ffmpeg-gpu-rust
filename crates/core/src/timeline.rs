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

    /// Pop the next packet with the lowest PTS.
    pub fn pop(&mut self) -> Option<Packet> {
        if let Some(entry) = self.queue.pop() {
            self.last_emitted_pts = entry.pts;
            Some(entry.packet)
        } else {
            None
        }
    }

    /// Flush remaining packets when stream ends (e.g. EOF).
    pub fn flush_next(&mut self) -> Option<Packet> {
        self.queue.pop().map(|e| {
            self.last_emitted_pts = e.pts;
            e.packet
        })
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
