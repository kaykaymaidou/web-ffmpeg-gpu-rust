/* tslint:disable */
/* eslint-disable */

/**
 * Color space metadata (critical to prevent washed-out colors).
 */
export enum ColorSpace {
    Bt709 = 0,
    Bt601 = 1,
    Bt2020 = 2,
    Srgb = 3,
}

/**
 * Parsed FLV Header metadata.
 */
export class FlvHeader {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly has_audio: boolean;
    readonly has_video: boolean;
}

/**
 * Extracted Video Tag information.
 */
export class FlvVideoTagInfo {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly codec_id: number;
    readonly dts_ms: number;
    readonly is_keyframe: boolean;
    readonly is_sequence_header: boolean;
    readonly pts_ms: number;
}

/**
 * Decoded video frame metadata (analogous to FFmpeg's `AVFrame`).
 */
export class FrameMetadata {
    free(): void;
    [Symbol.dispose](): void;
    constructor(width: number, height: number, pts: bigint, format: PixelFormat, color_space: ColorSpace, is_key: boolean);
    color_space: ColorSpace;
    format: PixelFormat;
    height: number;
    is_key: boolean;
    pts: bigint;
    width: number;
}

/**
 * Industrial Adaptive Jitter Buffer for WebRTC and Live Video (RFC 0002).
 * Implements RFC 3550 statistical inter-arrival jitter estimation,
 * B-frame / out-of-order packet reordering, and monotonic timestamp defense.
 */
export class JitterBuffer {
    free(): void;
    [Symbol.dispose](): void;
    clear(): void;
    constructor(config: JitterBufferConfig);
    /**
     * Pop the next packet ready for playback, guaranteeing strictly monotonic non-negative PTS.
     */
    pop_ready_frame(current_playback_clock_us: bigint): Packet | undefined;
    /**
     * Push an arriving packet with its local arrival timestamp in microseconds.
     */
    push_packet(packet: Packet, arrival_time_us: bigint): void;
    /**
     * Number of frames currently buffered in jitter queue.
     */
    readonly buffered_frames: number;
    /**
     * Estimated jitter in milliseconds.
     */
    readonly estimated_jitter_ms: number;
    readonly packets_dropped: bigint;
    readonly packets_received: bigint;
    /**
     * Adaptive target playout delay in microseconds based on dynamic network jitter.
     */
    readonly target_delay_us: bigint;
}

/**
 * JitterBuffer configuration options.
 */
export class JitterBufferConfig {
    free(): void;
    [Symbol.dispose](): void;
    constructor(min_delay_ms: number, max_delay_ms: number, max_queue_frames: number);
    max_delay_ms: number;
    max_queue_frames: number;
    min_delay_ms: number;
}

/**
 * Media packet representing a compressed frame/chunk of data (analogous to FFmpeg's `AVPacket`).
 */
export class Packet {
    free(): void;
    [Symbol.dispose](): void;
    constructor(pts: bigint, dts: bigint, duration: bigint, is_keyframe: boolean, stream_index: number, data: Uint8Array);
    readonly data: Uint8Array;
    dts: bigint;
    duration: bigint;
    readonly is_keyframe: boolean;
    pts: bigint;
    readonly size: number;
    readonly stream_index: number;
}

/**
 * Pixel format enumeration (analogous to FFmpeg's `AVPixelFormat`).
 */
export enum PixelFormat {
    Rgba8 = 0,
    Bgra8 = 1,
    Yuv420p = 2,
    Nv12 = 3,
    /**
     * Hardware texture reference managed by WebGPU / WebCodecs VideoFrame
     */
    WebGpuTexture = 4,
}

/**
 * Pure Rust Audio DSP & Resampling Engine WASM Bridge.
 */
export class RustAudioDsp {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Downmix 5.1 Surround f32 PCM audio to Stereo [L, R] using ITU-R BS.775.
     */
    static downmix_51_to_stereo(input: Float32Array, include_lfe: boolean): Float32Array;
    /**
     * Downmix Stereo [L, R] to Mono [M].
     */
    static downmix_stereo_to_mono(input: Float32Array): Float32Array;
    /**
     * Resample interleaved f32 PCM audio between sample rates.
     */
    static resample(input: Float32Array, from_rate: number, to_rate: number, channels: number): Float32Array;
    /**
     * Upmix Mono to Stereo [L, R].
     */
    static upmix_mono_to_stereo(input: Float32Array): Float32Array;
}

/**
 * Pure Rust CPU image processing filters.
 * Designed with chunked iterators to allow LLVM to auto-vectorize with WASM SIMD128.
 */
export class RustCpuFilter {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Apply brightness & contrast adjustment in-place using Rust CPU.
     */
    static adjust_brightness_contrast(data: Uint8Array, brightness: number, contrast: number): void;
    /**
     * Apply grayscale filter on RGBA8 buffer in-place using Rust CPU SIMD.
     */
    static grayscale_rgba(data: Uint8Array): void;
    /**
     * Apply color inversion on RGBA8 buffer in-place using Rust CPU SIMD.
     */
    static invert_rgba(data: Uint8Array): void;
}

/**
 * Rust-native high-performance WASM Demuxer.
 */
export class RustDemuxer {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Extract a specific sample's raw compressed bitstream payload.
     */
    get_sample_data(index: number): Uint8Array | undefined;
    /**
     * Sample duration in microseconds.
     */
    get_sample_duration(index: number): bigint;
    /**
     * Sample presentation timestamp in microseconds.
     */
    get_sample_pts(index: number): bigint;
    /**
     * Check if primary video track is HEVC / H.265.
     */
    is_hevc(): boolean;
    /**
     * Check if sample at index is a keyframe.
     */
    is_sample_keyframe(index: number): boolean;
    constructor(data: Uint8Array);
    /**
     * Total sample count in the primary video track.
     */
    sample_count(): number;
    /**
     * Number of tracks found in container.
     */
    track_count(): number;
    /**
     * Primary video track codec string (e.g. "avc1.640028" or "hvc1.1.6.L93.B0").
     */
    video_codec(): string | undefined;
    /**
     * Extradata description box (e.g. avcC or hvcC).
     */
    video_description(): Uint8Array | undefined;
    video_height(): number;
    video_timescale(): number;
    video_width(): number;
}

/**
 * Pure Rust Stream-Oriented FLV Demuxer (RFC 0002).
 * Efficiently processes chunked WebSocket-FLV / HTTP-FLV streams without MSE memory leaks.
 */
export class RustFlvDemuxer {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Append incoming chunk of live stream bytes.
     */
    append_bytes(chunk: Uint8Array): void;
    /**
     * Compact internal buffer to free consumed memory.
     */
    compact(): void;
    /**
     * Demux next available packet from the internal buffer.
     * Returns None when more bytes are needed or EOF.
     */
    demux_next_packet(): Packet | undefined;
    constructor();
    /**
     * Check and parse FLV header if enough bytes are present.
     */
    parse_header(): FlvHeader | undefined;
}

/**
 * Pure Rust Matroska (MKV) & WebM Demuxer WASM Bridge.
 */
export class RustMkvDemuxer {
    free(): void;
    [Symbol.dispose](): void;
    frame_count(): number;
    get_frame_data(index: number): Uint8Array | undefined;
    get_frame_pts_us(index: number): number | undefined;
    get_track_codec(index: number): string | undefined;
    get_track_type(index: number): number | undefined;
    get_video_dimensions(index: number): Uint32Array | undefined;
    is_frame_keyframe(index: number): boolean;
    constructor(data: Uint8Array);
    track_count(): number;
}

/**
 * Rust-native stream feeder with in-band parameter set extraction (H.264 avcC & H.265 hvcC + HDR10).
 */
export class RustStreamAnalyzer {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Analyze a streaming packet chunk.
     * Returns codec string if SPS was detected/updated.
     */
    analyze_packet(data: Uint8Array): string | undefined;
    /**
     * Build AVCC extradata configuration from stored SPS and PPS.
     */
    get_avcc_description(): Uint8Array | undefined;
    /**
     * Build configuration description box: `hvcC` for HEVC or `avcC` for H.264.
     */
    get_description(): Uint8Array | undefined;
    /**
     * Check if analyzed stream has HDR10 colorimetry (BT.2020 / PQ / HLG).
     */
    is_hdr(): boolean;
    /**
     * Check if analyzed stream is H.265 / HEVC.
     */
    is_hevc(): boolean;
    /**
     * Check if packet contains an IDR / IRAP keyframe slice.
     */
    is_keyframe(data: Uint8Array): boolean;
    constructor();
}

/**
 * FFmpeg-style Filtergraph Parser WASM Bridge.
 */
export class RustWasmFilterGraph {
    free(): void;
    [Symbol.dispose](): void;
    get_node_name(index: number): string | undefined;
    get_node_target(index: number): string | undefined;
    constructor(filter_str: string);
    node_count(): number;
}

/**
 * WASM-exported MP4 Muxer with FastStart streaming support.
 */
export class RustWasmMp4Muxer {
    free(): void;
    [Symbol.dispose](): void;
    finalize(): Uint8Array;
    constructor();
    set_audio_track(timescale: number, sample_rate: number, channels: number, config?: Uint8Array | null): void;
    set_hevc_video_track(width: number, height: number, timescale: number, vps: Uint8Array, sps: Uint8Array, pps: Uint8Array): void;
    set_video_track(width: number, height: number, timescale: number, sps: Uint8Array, pps: Uint8Array): void;
    write_audio_sample(data: Uint8Array, duration_ticks: number): void;
    write_video_sample(data: Uint8Array, duration_ticks: number, is_key: boolean): void;
}

/**
 * WebRTC RTP Depacketizer WASM Bridge (H.264 RFC 6184 / H.265 RFC 7798).
 */
export class RustWasmRtpDepacketizer {
    free(): void;
    [Symbol.dispose](): void;
    frames_assembled(): bigint;
    constructor(is_hevc: boolean);
    packets_dropped(): bigint;
    packets_received(): bigint;
    push_packet(packet_bytes: Uint8Array): RustWasmRtpFrame | undefined;
}

/**
 * Reconstructed RTP video frame exposed to WASM.
 */
export class RustWasmRtpFrame {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    get_nal(index: number): Uint8Array | undefined;
    is_keyframe(): boolean;
    nal_count(): number;
    pts_us(): bigint;
    ssrc(): number;
    to_annex_b(): Uint8Array;
    to_avcc(): Uint8Array;
}

/**
 * WebRTC RTP Packetizer WASM Bridge (H.264 RFC 6184).
 */
export class RustWasmRtpPacketizer {
    free(): void;
    [Symbol.dispose](): void;
    constructor(mtu: number, payload_type: number, ssrc: number);
    packetize_nal(nal: Uint8Array, pts_us: bigint, is_last_nal: boolean): Array<any>;
}

/**
 * Timeline and B-frame reordering scheduler.
 * Solves the out-of-order timestamp bug common in naive hardware decoder implementations.
 */
export class TimelineQueue {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Check if a packet is ready to be consumed in strict PTS order.
     */
    can_pop(): boolean;
    /**
     * Clear all queues (e.g. on seek).
     */
    clear(): void;
    /**
     * Flush remaining packets when stream ends (e.g. EOF).
     */
    flush_next(): Packet | undefined;
    is_empty(): boolean;
    /**
     * Current buffered queue size.
     */
    len(): number;
    constructor(max_delay_frames: number);
    /**
     * Pop the next packet with the lowest PTS, guaranteed to be monotonically increasing.
     */
    pop(): Packet | undefined;
    /**
     * Push an input packet into the reordering queue.
     */
    push(packet: Packet): void;
}

/**
 * Create a packet instance in Rust.
 */
export function create_rust_packet(pts: bigint, dts: bigint, duration: bigint, is_keyframe: boolean, stream_index: number, data: Uint8Array): Packet;

/**
 * Helper to create and initialize a Rust Timeline queue.
 */
export function create_rust_timeline(max_delay_frames: number): TimelineQueue;

/**
 * Inspect capabilities and print version.
 */
export function get_engine_version(): string;

/**
 * Initialize panic hook and logging for debugging in browser console.
 */
export function init_core(): void;

/**
 * Standalone WASM converter: Annex-B to AVCC.
 */
export function rust_annex_b_to_avcc(annex_b: Uint8Array): Uint8Array;

/**
 * Standalone WASM converter: AVCC to Annex-B.
 */
export function rust_avcc_to_annex_b(avcc: Uint8Array): Uint8Array;

/**
 * Standalone WASM builder: build ISO 14496-15 avcC box.
 */
export function rust_build_avcc(sps: Uint8Array, pps: Uint8Array): Uint8Array;

/**
 * Standalone WASM builder: build ISO 14496-15 hvcC box.
 */
export function rust_build_hvcc(vps: Uint8Array, sps: Uint8Array, pps: Uint8Array): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_flvheader_free: (a: number, b: number) => void;
    readonly __wbg_flvvideotaginfo_free: (a: number, b: number) => void;
    readonly __wbg_framemetadata_free: (a: number, b: number) => void;
    readonly __wbg_get_framemetadata_color_space: (a: number) => number;
    readonly __wbg_get_framemetadata_format: (a: number) => number;
    readonly __wbg_get_framemetadata_height: (a: number) => number;
    readonly __wbg_get_framemetadata_is_key: (a: number) => number;
    readonly __wbg_get_framemetadata_pts: (a: number) => bigint;
    readonly __wbg_get_framemetadata_width: (a: number) => number;
    readonly __wbg_get_jitterbufferconfig_max_delay_ms: (a: number) => number;
    readonly __wbg_get_jitterbufferconfig_max_queue_frames: (a: number) => number;
    readonly __wbg_get_jitterbufferconfig_min_delay_ms: (a: number) => number;
    readonly __wbg_jitterbuffer_free: (a: number, b: number) => void;
    readonly __wbg_jitterbufferconfig_free: (a: number, b: number) => void;
    readonly __wbg_packet_free: (a: number, b: number) => void;
    readonly __wbg_rustaudiodsp_free: (a: number, b: number) => void;
    readonly __wbg_rustcpufilter_free: (a: number, b: number) => void;
    readonly __wbg_rustdemuxer_free: (a: number, b: number) => void;
    readonly __wbg_rustflvdemuxer_free: (a: number, b: number) => void;
    readonly __wbg_rustmkvdemuxer_free: (a: number, b: number) => void;
    readonly __wbg_ruststreamanalyzer_free: (a: number, b: number) => void;
    readonly __wbg_rustwasmfiltergraph_free: (a: number, b: number) => void;
    readonly __wbg_rustwasmmp4muxer_free: (a: number, b: number) => void;
    readonly __wbg_rustwasmrtpdepacketizer_free: (a: number, b: number) => void;
    readonly __wbg_rustwasmrtpframe_free: (a: number, b: number) => void;
    readonly __wbg_rustwasmrtppacketizer_free: (a: number, b: number) => void;
    readonly __wbg_set_framemetadata_color_space: (a: number, b: number) => void;
    readonly __wbg_set_framemetadata_format: (a: number, b: number) => void;
    readonly __wbg_set_framemetadata_height: (a: number, b: number) => void;
    readonly __wbg_set_framemetadata_is_key: (a: number, b: number) => void;
    readonly __wbg_set_framemetadata_pts: (a: number, b: bigint) => void;
    readonly __wbg_set_framemetadata_width: (a: number, b: number) => void;
    readonly __wbg_set_jitterbufferconfig_max_delay_ms: (a: number, b: number) => void;
    readonly __wbg_set_jitterbufferconfig_max_queue_frames: (a: number, b: number) => void;
    readonly __wbg_set_jitterbufferconfig_min_delay_ms: (a: number, b: number) => void;
    readonly __wbg_timelinequeue_free: (a: number, b: number) => void;
    readonly create_rust_packet: (a: bigint, b: bigint, c: bigint, d: number, e: number, f: number, g: number) => number;
    readonly create_rust_timeline: (a: number) => number;
    readonly flvheader_has_audio: (a: number) => number;
    readonly flvheader_has_video: (a: number) => number;
    readonly flvvideotaginfo_codec_id: (a: number) => number;
    readonly flvvideotaginfo_dts_ms: (a: number) => number;
    readonly flvvideotaginfo_is_keyframe: (a: number) => number;
    readonly flvvideotaginfo_is_sequence_header: (a: number) => number;
    readonly flvvideotaginfo_pts_ms: (a: number) => number;
    readonly framemetadata_new: (a: number, b: number, c: bigint, d: number, e: number, f: number) => number;
    readonly get_engine_version: () => [number, number];
    readonly init_core: () => void;
    readonly jitterbuffer_buffered_frames: (a: number) => number;
    readonly jitterbuffer_clear: (a: number) => void;
    readonly jitterbuffer_estimated_jitter_ms: (a: number) => number;
    readonly jitterbuffer_new: (a: number) => number;
    readonly jitterbuffer_packets_dropped: (a: number) => bigint;
    readonly jitterbuffer_packets_received: (a: number) => bigint;
    readonly jitterbuffer_pop_ready_frame: (a: number, b: bigint) => number;
    readonly jitterbuffer_push_packet: (a: number, b: number, c: bigint) => void;
    readonly jitterbuffer_target_delay_us: (a: number) => bigint;
    readonly jitterbufferconfig_new: (a: number, b: number, c: number) => number;
    readonly packet_data: (a: number) => [number, number];
    readonly packet_dts: (a: number) => bigint;
    readonly packet_duration: (a: number) => bigint;
    readonly packet_is_keyframe: (a: number) => number;
    readonly packet_new: (a: bigint, b: bigint, c: bigint, d: number, e: number, f: number, g: number) => number;
    readonly packet_pts: (a: number) => bigint;
    readonly packet_set_dts: (a: number, b: bigint) => void;
    readonly packet_set_duration: (a: number, b: bigint) => void;
    readonly packet_set_pts: (a: number, b: bigint) => void;
    readonly packet_size: (a: number) => number;
    readonly packet_stream_index: (a: number) => number;
    readonly rust_annex_b_to_avcc: (a: number, b: number) => [number, number];
    readonly rust_avcc_to_annex_b: (a: number, b: number) => [number, number];
    readonly rust_build_avcc: (a: number, b: number, c: number, d: number) => [number, number];
    readonly rust_build_hvcc: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly rustaudiodsp_downmix_51_to_stereo: (a: number, b: number, c: number) => [number, number, number, number];
    readonly rustaudiodsp_downmix_stereo_to_mono: (a: number, b: number) => [number, number, number, number];
    readonly rustaudiodsp_resample: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly rustaudiodsp_upmix_mono_to_stereo: (a: number, b: number) => [number, number];
    readonly rustcpufilter_adjust_brightness_contrast: (a: number, b: number, c: any, d: number, e: number) => void;
    readonly rustcpufilter_grayscale_rgba: (a: number, b: number, c: any) => void;
    readonly rustcpufilter_invert_rgba: (a: number, b: number, c: any) => void;
    readonly rustdemuxer_get_sample_data: (a: number, b: number) => [number, number];
    readonly rustdemuxer_get_sample_duration: (a: number, b: number) => bigint;
    readonly rustdemuxer_get_sample_pts: (a: number, b: number) => bigint;
    readonly rustdemuxer_is_hevc: (a: number) => number;
    readonly rustdemuxer_is_sample_keyframe: (a: number, b: number) => number;
    readonly rustdemuxer_new: (a: number, b: number) => number;
    readonly rustdemuxer_sample_count: (a: number) => number;
    readonly rustdemuxer_track_count: (a: number) => number;
    readonly rustdemuxer_video_codec: (a: number) => [number, number];
    readonly rustdemuxer_video_description: (a: number) => [number, number];
    readonly rustdemuxer_video_height: (a: number) => number;
    readonly rustdemuxer_video_timescale: (a: number) => number;
    readonly rustdemuxer_video_width: (a: number) => number;
    readonly rustflvdemuxer_append_bytes: (a: number, b: number, c: number) => void;
    readonly rustflvdemuxer_compact: (a: number) => void;
    readonly rustflvdemuxer_demux_next_packet: (a: number) => number;
    readonly rustflvdemuxer_new: () => number;
    readonly rustflvdemuxer_parse_header: (a: number) => number;
    readonly rustmkvdemuxer_frame_count: (a: number) => number;
    readonly rustmkvdemuxer_get_frame_data: (a: number, b: number) => [number, number];
    readonly rustmkvdemuxer_get_frame_pts_us: (a: number, b: number) => [number, number];
    readonly rustmkvdemuxer_get_track_codec: (a: number, b: number) => [number, number];
    readonly rustmkvdemuxer_get_track_type: (a: number, b: number) => number;
    readonly rustmkvdemuxer_get_video_dimensions: (a: number, b: number) => any;
    readonly rustmkvdemuxer_is_frame_keyframe: (a: number, b: number) => number;
    readonly rustmkvdemuxer_new: (a: number, b: number) => [number, number, number];
    readonly rustmkvdemuxer_track_count: (a: number) => number;
    readonly ruststreamanalyzer_analyze_packet: (a: number, b: number, c: number) => [number, number];
    readonly ruststreamanalyzer_get_avcc_description: (a: number) => [number, number];
    readonly ruststreamanalyzer_get_description: (a: number) => [number, number];
    readonly ruststreamanalyzer_is_hdr: (a: number) => number;
    readonly ruststreamanalyzer_is_hevc: (a: number) => number;
    readonly ruststreamanalyzer_is_keyframe: (a: number, b: number, c: number) => number;
    readonly ruststreamanalyzer_new: () => number;
    readonly rustwasmfiltergraph_get_node_name: (a: number, b: number) => [number, number];
    readonly rustwasmfiltergraph_get_node_target: (a: number, b: number) => [number, number];
    readonly rustwasmfiltergraph_new: (a: number, b: number) => [number, number, number];
    readonly rustwasmfiltergraph_node_count: (a: number) => number;
    readonly rustwasmmp4muxer_finalize: (a: number) => [number, number];
    readonly rustwasmmp4muxer_new: () => number;
    readonly rustwasmmp4muxer_set_audio_track: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly rustwasmmp4muxer_set_hevc_video_track: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => void;
    readonly rustwasmmp4muxer_set_video_track: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly rustwasmmp4muxer_write_audio_sample: (a: number, b: number, c: number, d: number) => void;
    readonly rustwasmmp4muxer_write_video_sample: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly rustwasmrtpdepacketizer_frames_assembled: (a: number) => bigint;
    readonly rustwasmrtpdepacketizer_new: (a: number) => number;
    readonly rustwasmrtpdepacketizer_packets_dropped: (a: number) => bigint;
    readonly rustwasmrtpdepacketizer_packets_received: (a: number) => bigint;
    readonly rustwasmrtpdepacketizer_push_packet: (a: number, b: number, c: number) => number;
    readonly rustwasmrtpframe_get_nal: (a: number, b: number) => [number, number];
    readonly rustwasmrtpframe_is_keyframe: (a: number) => number;
    readonly rustwasmrtpframe_nal_count: (a: number) => number;
    readonly rustwasmrtpframe_pts_us: (a: number) => bigint;
    readonly rustwasmrtpframe_ssrc: (a: number) => number;
    readonly rustwasmrtpframe_to_annex_b: (a: number) => [number, number];
    readonly rustwasmrtpframe_to_avcc: (a: number) => [number, number];
    readonly rustwasmrtppacketizer_new: (a: number, b: number, c: number) => number;
    readonly rustwasmrtppacketizer_packetize_nal: (a: number, b: number, c: number, d: bigint, e: number) => any;
    readonly timelinequeue_can_pop: (a: number) => number;
    readonly timelinequeue_clear: (a: number) => void;
    readonly timelinequeue_flush_next: (a: number) => number;
    readonly timelinequeue_is_empty: (a: number) => number;
    readonly timelinequeue_len: (a: number) => number;
    readonly timelinequeue_new: (a: number) => number;
    readonly timelinequeue_pop: (a: number) => number;
    readonly timelinequeue_push: (a: number, b: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
