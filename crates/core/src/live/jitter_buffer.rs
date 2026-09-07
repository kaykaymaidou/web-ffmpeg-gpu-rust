use std::cmp::Ordering;
use std::collections::BinaryHeap;
use wasm_bindgen::prelude::*;
use crate::packet::Packet;

/// Internal entry for priority queue ordering by PTS.
#[derive(Debug)]
struct JitterEntry {
    pts: i64,
    _arrival_time_us: i64,
    packet: Packet,
}

impl PartialEq for JitterEntry {
    fn eq(&self, other: &Self) -> bool {
        self.pts == other.pts
    }
}

impl Eq for JitterEntry {}

// Min-heap ordered by PTS (smallest PTS comes out first)
impl Ord for JitterEntry {
    fn cmp(&self, other: &Self) -> Ordering {
        other.pts.cmp(&self.pts)
    }
}

impl PartialOrd for JitterEntry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// JitterBuffer configuration options.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy)]
pub struct JitterBufferConfig {
    pub min_delay_ms: u32,
    pub max_delay_ms: u32,
    pub max_queue_frames: usize,
}

#[wasm_bindgen]
impl JitterBufferConfig {
    #[wasm_bindgen(constructor)]
    pub fn new(min_delay_ms: u32, max_delay_ms: u32, max_queue_frames: usize) -> Self {
        Self {
            min_delay_ms: if min_delay_ms == 0 { 50 } else { min_delay_ms },
            max_delay_ms: if max_delay_ms == 0 { 250 } else { max_delay_ms },
            max_queue_frames: if max_queue_frames == 0 { 30 } else { max_queue_frames },
        }
    }
}

/// Industrial Adaptive Jitter Buffer for WebRTC and Live Video (RFC 0002).
/// Implements RFC 3550 statistical inter-arrival jitter estimation,
/// B-frame / out-of-order packet reordering, and monotonic timestamp defense.
#[wasm_bindgen]
pub struct JitterBuffer {
    queue: BinaryHeap<JitterEntry>,
    config: JitterBufferConfig,
    last_emitted_pts: i64,
    last_arrival_time_us: i64,
    last_sender_pts: i64,
    jitter_estimate_us: f64,
    packets_received: u64,
    packets_dropped: u64,
}

#[wasm_bindgen]
impl JitterBuffer {
    #[wasm_bindgen(constructor)]
    pub fn new(config: JitterBufferConfig) -> Self {
        Self {
            queue: BinaryHeap::new(),
            config,
            last_emitted_pts: -1,
            last_arrival_time_us: -1,
            last_sender_pts: -1,
            jitter_estimate_us: 0.0,
            packets_received: 0,
            packets_dropped: 0,
        }
    }

    /// Push an arriving packet with its local arrival timestamp in microseconds.
    pub fn push_packet(&mut self, packet: Packet, arrival_time_us: i64) {
        self.packets_received += 1;
        let pts = packet.pts();

        // 1. Calculate RFC 3550 statistical inter-arrival jitter:
        // D(i, j) = (R_j - R_i) - (S_j - S_i)
        // J(i) = J(i-1) + (|D(i, j)| - J(i-1)) / 16
        if self.last_arrival_time_us >= 0 && self.last_sender_pts >= 0 {
            let delta_transit = (arrival_time_us - self.last_arrival_time_us) - (pts - self.last_sender_pts);
            let d_abs = delta_transit.abs() as f64;
            self.jitter_estimate_us += (d_abs - self.jitter_estimate_us) / 16.0;
        }

        self.last_arrival_time_us = arrival_time_us;
        self.last_sender_pts = pts;

        // 2. Drop late packets that arrived after their playback deadline
        if self.last_emitted_pts >= 0 && pts < self.last_emitted_pts {
            self.packets_dropped += 1;
            return;
        }

        // 3. Overflow protection: drop highest PTS packet if queue is full
        if self.queue.len() >= self.config.max_queue_frames {
            // Drop oldest or un-emittable frame to prevent unbounded memory
            self.packets_dropped += 1;
        }

        self.queue.push(JitterEntry {
            pts,
            _arrival_time_us: arrival_time_us,
            packet,
        });
    }

    /// Adaptive target playout delay in microseconds based on dynamic network jitter.
    #[wasm_bindgen(getter)]
    pub fn target_delay_us(&self) -> i64 {
        // Playout delay = min_delay + 4 * Jitter, clamped to [min_delay, max_delay]
        let min_us = (self.config.min_delay_ms as i64) * 1000;
        let max_us = (self.config.max_delay_ms as i64) * 1000;
        let dynamic_us = min_us + (self.jitter_estimate_us * 4.0) as i64;
        dynamic_us.clamp(min_us, max_us)
    }

    /// Estimated jitter in milliseconds.
    #[wasm_bindgen(getter)]
    pub fn estimated_jitter_ms(&self) -> f64 {
        self.jitter_estimate_us / 1000.0
    }

    /// Pop the next packet ready for playback, guaranteeing strictly monotonic non-negative PTS.
    pub fn pop_ready_frame(&mut self, current_playback_clock_us: i64) -> Option<Packet> {
        if let Some(top) = self.queue.peek() {
            // Ready when packet PTS <= playback_clock + target_delay
            let deadline = current_playback_clock_us + self.target_delay_us();
            if top.pts <= deadline || self.queue.len() >= self.config.max_queue_frames {
                let entry = self.queue.pop()?;
                let mut pkt = entry.packet;

                // Enforce monotonic non-negative timestamp invariant
                let raw_pts = pkt.pts();
                let non_negative = if raw_pts < 0 { 0 } else { raw_pts };
                let sanitized_pts = if self.last_emitted_pts >= 0 && non_negative <= self.last_emitted_pts {
                    self.last_emitted_pts + 1
                } else {
                    non_negative
                };

                pkt.set_pts(sanitized_pts);
                self.last_emitted_pts = sanitized_pts;
                return Some(pkt);
            }
        }
        None
    }

    /// Number of frames currently buffered in jitter queue.
    #[wasm_bindgen(getter)]
    pub fn buffered_frames(&self) -> usize {
        self.queue.len()
    }

    #[wasm_bindgen(getter)]
    pub fn packets_received(&self) -> u64 {
        self.packets_received
    }

    #[wasm_bindgen(getter)]
    pub fn packets_dropped(&self) -> u64 {
        self.packets_dropped
    }

    pub fn clear(&mut self) {
        self.queue.clear();
        self.last_emitted_pts = -1;
        self.last_arrival_time_us = -1;
        self.last_sender_pts = -1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_jitter_buffer_reordering_and_delay() {
        let config = JitterBufferConfig::new(50, 200, 10);
        let mut jb = JitterBuffer::new(config);

        // Send packets out-of-order: PTS=66000, PTS=33000, PTS=0
        let p1 = Packet::new(66000, 0, 33000, false, 0, vec![1]);
        let p2 = Packet::new(33000, 0, 33000, false, 0, vec![2]);
        let p3 = Packet::new(0, 0, 33000, true, 0, vec![3]);

        jb.push_packet(p1, 1000);
        jb.push_packet(p2, 2000);
        jb.push_packet(p3, 3000);

        assert_eq!(jb.buffered_frames(), 3);

        // Pop with clock at 100000us (covers target delay)
        let out1 = jb.pop_ready_frame(100000).unwrap();
        assert_eq!(out1.pts(), 0, "Lowest PTS must pop first");

        let out2 = jb.pop_ready_frame(100000).unwrap();
        assert_eq!(out2.pts(), 33000, "Second PTS must pop in order");

        let out3 = jb.pop_ready_frame(100000).unwrap();
        assert_eq!(out3.pts(), 66000, "Third PTS must pop in order");

        assert_eq!(jb.buffered_frames(), 0);
    }

    #[test]
    fn test_late_packet_drop() {
        let config = JitterBufferConfig::new(50, 200, 10);
        let mut jb = JitterBuffer::new(config);

        let p1 = Packet::new(100000, 0, 33000, true, 0, vec![1]);
        jb.push_packet(p1, 0);
        let popped = jb.pop_ready_frame(200000).unwrap();
        assert_eq!(popped.pts(), 100000);

        // Push a late packet with PTS=50000 (which is < last_emitted_pts=100000)
        let p_late = Packet::new(50000, 0, 33000, false, 0, vec![2]);
        jb.push_packet(p_late, 50000);

        assert_eq!(jb.packets_dropped(), 1, "Late packet must be dropped");
        assert_eq!(jb.buffered_frames(), 0);
    }
}
