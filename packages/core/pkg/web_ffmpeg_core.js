/* @ts-self-types="./web_ffmpeg_core.d.ts" */

/**
 * Color space metadata (critical to prevent washed-out colors).
 * @enum {0 | 1 | 2 | 3}
 */
export const ColorSpace = Object.freeze({
    Bt709: 0, "0": "Bt709",
    Bt601: 1, "1": "Bt601",
    Bt2020: 2, "2": "Bt2020",
    Srgb: 3, "3": "Srgb",
});

/**
 * Parsed FLV Header metadata.
 */
export class FlvHeader {
    static __wrap(ptr) {
        const obj = Object.create(FlvHeader.prototype);
        obj.__wbg_ptr = ptr;
        FlvHeaderFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FlvHeaderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_flvheader_free(ptr, 0);
    }
    /**
     * @returns {boolean}
     */
    get has_audio() {
        const ret = wasm.flvheader_has_audio(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {boolean}
     */
    get has_video() {
        const ret = wasm.flvheader_has_video(this.__wbg_ptr);
        return ret !== 0;
    }
}
if (Symbol.dispose) FlvHeader.prototype[Symbol.dispose] = FlvHeader.prototype.free;

/**
 * Extracted Video Tag information.
 */
export class FlvVideoTagInfo {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FlvVideoTagInfoFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_flvvideotaginfo_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get codec_id() {
        const ret = wasm.flvvideotaginfo_codec_id(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get dts_ms() {
        const ret = wasm.flvvideotaginfo_dts_ms(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {boolean}
     */
    get is_keyframe() {
        const ret = wasm.flvvideotaginfo_is_keyframe(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {boolean}
     */
    get is_sequence_header() {
        const ret = wasm.flvvideotaginfo_is_sequence_header(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    get pts_ms() {
        const ret = wasm.flvvideotaginfo_pts_ms(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) FlvVideoTagInfo.prototype[Symbol.dispose] = FlvVideoTagInfo.prototype.free;

/**
 * Decoded video frame metadata (analogous to FFmpeg's `AVFrame`).
 */
export class FrameMetadata {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FrameMetadataFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_framemetadata_free(ptr, 0);
    }
    /**
     * @param {number} width
     * @param {number} height
     * @param {bigint} pts
     * @param {PixelFormat} format
     * @param {ColorSpace} color_space
     * @param {boolean} is_key
     */
    constructor(width, height, pts, format, color_space, is_key) {
        const ret = wasm.framemetadata_new(width, height, pts, format, color_space, is_key);
        this.__wbg_ptr = ret;
        FrameMetadataFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {ColorSpace}
     */
    get color_space() {
        const ret = wasm.__wbg_get_framemetadata_color_space(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {PixelFormat}
     */
    get format() {
        const ret = wasm.__wbg_get_framemetadata_format(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get height() {
        const ret = wasm.__wbg_get_framemetadata_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {boolean}
     */
    get is_key() {
        const ret = wasm.__wbg_get_framemetadata_is_key(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {bigint}
     */
    get pts() {
        const ret = wasm.__wbg_get_framemetadata_pts(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get width() {
        const ret = wasm.__wbg_get_framemetadata_width(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {ColorSpace} arg0
     */
    set color_space(arg0) {
        wasm.__wbg_set_framemetadata_color_space(this.__wbg_ptr, arg0);
    }
    /**
     * @param {PixelFormat} arg0
     */
    set format(arg0) {
        wasm.__wbg_set_framemetadata_format(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set height(arg0) {
        wasm.__wbg_set_framemetadata_height(this.__wbg_ptr, arg0);
    }
    /**
     * @param {boolean} arg0
     */
    set is_key(arg0) {
        wasm.__wbg_set_framemetadata_is_key(this.__wbg_ptr, arg0);
    }
    /**
     * @param {bigint} arg0
     */
    set pts(arg0) {
        wasm.__wbg_set_framemetadata_pts(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set width(arg0) {
        wasm.__wbg_set_framemetadata_width(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) FrameMetadata.prototype[Symbol.dispose] = FrameMetadata.prototype.free;

/**
 * Industrial Adaptive Jitter Buffer for WebRTC and Live Video (RFC 0002).
 * Implements RFC 3550 statistical inter-arrival jitter estimation,
 * B-frame / out-of-order packet reordering, and monotonic timestamp defense.
 */
export class JitterBuffer {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JitterBufferFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jitterbuffer_free(ptr, 0);
    }
    /**
     * Number of frames currently buffered in jitter queue.
     * @returns {number}
     */
    get buffered_frames() {
        const ret = wasm.jitterbuffer_buffered_frames(this.__wbg_ptr);
        return ret >>> 0;
    }
    clear() {
        wasm.jitterbuffer_clear(this.__wbg_ptr);
    }
    /**
     * Estimated jitter in milliseconds.
     * @returns {number}
     */
    get estimated_jitter_ms() {
        const ret = wasm.jitterbuffer_estimated_jitter_ms(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {JitterBufferConfig} config
     */
    constructor(config) {
        _assertClass(config, JitterBufferConfig);
        var ptr0 = config.__destroy_into_raw();
        const ret = wasm.jitterbuffer_new(ptr0);
        this.__wbg_ptr = ret;
        JitterBufferFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {bigint}
     */
    get packets_dropped() {
        const ret = wasm.jitterbuffer_packets_dropped(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {bigint}
     */
    get packets_received() {
        const ret = wasm.jitterbuffer_packets_received(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Pop the next packet ready for playback, guaranteeing strictly monotonic non-negative PTS.
     * @param {bigint} current_playback_clock_us
     * @returns {Packet | undefined}
     */
    pop_ready_frame(current_playback_clock_us) {
        const ret = wasm.jitterbuffer_pop_ready_frame(this.__wbg_ptr, current_playback_clock_us);
        return ret === 0 ? undefined : Packet.__wrap(ret);
    }
    /**
     * Push an arriving packet with its local arrival timestamp in microseconds.
     * @param {Packet} packet
     * @param {bigint} arrival_time_us
     */
    push_packet(packet, arrival_time_us) {
        _assertClass(packet, Packet);
        var ptr0 = packet.__destroy_into_raw();
        wasm.jitterbuffer_push_packet(this.__wbg_ptr, ptr0, arrival_time_us);
    }
    /**
     * Adaptive target playout delay in microseconds based on dynamic network jitter.
     * @returns {bigint}
     */
    get target_delay_us() {
        const ret = wasm.jitterbuffer_target_delay_us(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) JitterBuffer.prototype[Symbol.dispose] = JitterBuffer.prototype.free;

/**
 * JitterBuffer configuration options.
 */
export class JitterBufferConfig {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        JitterBufferConfigFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_jitterbufferconfig_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get max_delay_ms() {
        const ret = wasm.__wbg_get_jitterbufferconfig_max_delay_ms(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get max_queue_frames() {
        const ret = wasm.__wbg_get_jitterbufferconfig_max_queue_frames(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get min_delay_ms() {
        const ret = wasm.__wbg_get_jitterbufferconfig_min_delay_ms(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} min_delay_ms
     * @param {number} max_delay_ms
     * @param {number} max_queue_frames
     */
    constructor(min_delay_ms, max_delay_ms, max_queue_frames) {
        const ret = wasm.jitterbufferconfig_new(min_delay_ms, max_delay_ms, max_queue_frames);
        this.__wbg_ptr = ret;
        JitterBufferConfigFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {number} arg0
     */
    set max_delay_ms(arg0) {
        wasm.__wbg_set_jitterbufferconfig_max_delay_ms(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set max_queue_frames(arg0) {
        wasm.__wbg_set_jitterbufferconfig_max_queue_frames(this.__wbg_ptr, arg0);
    }
    /**
     * @param {number} arg0
     */
    set min_delay_ms(arg0) {
        wasm.__wbg_set_jitterbufferconfig_min_delay_ms(this.__wbg_ptr, arg0);
    }
}
if (Symbol.dispose) JitterBufferConfig.prototype[Symbol.dispose] = JitterBufferConfig.prototype.free;

/**
 * Media packet representing a compressed frame/chunk of data (analogous to FFmpeg's `AVPacket`).
 */
export class Packet {
    static __wrap(ptr) {
        const obj = Object.create(Packet.prototype);
        obj.__wbg_ptr = ptr;
        PacketFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PacketFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_packet_free(ptr, 0);
    }
    /**
     * @returns {Uint8Array}
     */
    get data() {
        const ret = wasm.packet_data(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {bigint}
     */
    get dts() {
        const ret = wasm.packet_dts(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {bigint}
     */
    get duration() {
        const ret = wasm.packet_duration(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {boolean}
     */
    get is_keyframe() {
        const ret = wasm.packet_is_keyframe(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {bigint} pts
     * @param {bigint} dts
     * @param {bigint} duration
     * @param {boolean} is_keyframe
     * @param {number} stream_index
     * @param {Uint8Array} data
     */
    constructor(pts, dts, duration, is_keyframe, stream_index, data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.packet_new(pts, dts, duration, is_keyframe, stream_index, ptr0, len0);
        this.__wbg_ptr = ret;
        PacketFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {bigint}
     */
    get pts() {
        const ret = wasm.packet_pts(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {bigint} dts
     */
    set dts(dts) {
        wasm.packet_set_dts(this.__wbg_ptr, dts);
    }
    /**
     * @param {bigint} duration
     */
    set duration(duration) {
        wasm.packet_set_duration(this.__wbg_ptr, duration);
    }
    /**
     * @param {bigint} pts
     */
    set pts(pts) {
        wasm.packet_set_pts(this.__wbg_ptr, pts);
    }
    /**
     * @returns {number}
     */
    get size() {
        const ret = wasm.packet_size(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get stream_index() {
        const ret = wasm.packet_stream_index(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) Packet.prototype[Symbol.dispose] = Packet.prototype.free;

/**
 * Pixel format enumeration (analogous to FFmpeg's `AVPixelFormat`).
 * @enum {0 | 1 | 2 | 3 | 4}
 */
export const PixelFormat = Object.freeze({
    Rgba8: 0, "0": "Rgba8",
    Bgra8: 1, "1": "Bgra8",
    Yuv420p: 2, "2": "Yuv420p",
    Nv12: 3, "3": "Nv12",
    /**
     * Hardware texture reference managed by WebGPU / WebCodecs VideoFrame
     */
    WebGpuTexture: 4, "4": "WebGpuTexture",
});

/**
 * Pure Rust Audio DSP & Resampling Engine WASM Bridge.
 */
export class RustAudioDsp {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RustAudioDspFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rustaudiodsp_free(ptr, 0);
    }
    /**
     * Downmix 5.1 Surround f32 PCM audio to Stereo [L, R] using ITU-R BS.775.
     * @param {Float32Array} input
     * @param {boolean} include_lfe
     * @returns {Float32Array}
     */
    static downmix_51_to_stereo(input, include_lfe) {
        const ptr0 = passArrayF32ToWasm0(input, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustaudiodsp_downmix_51_to_stereo(ptr0, len0, include_lfe);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v2;
    }
    /**
     * Downmix Stereo [L, R] to Mono [M].
     * @param {Float32Array} input
     * @returns {Float32Array}
     */
    static downmix_stereo_to_mono(input) {
        const ptr0 = passArrayF32ToWasm0(input, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustaudiodsp_downmix_stereo_to_mono(ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v2;
    }
    /**
     * Resample interleaved f32 PCM audio between sample rates.
     * @param {Float32Array} input
     * @param {number} from_rate
     * @param {number} to_rate
     * @param {number} channels
     * @returns {Float32Array}
     */
    static resample(input, from_rate, to_rate, channels) {
        const ptr0 = passArrayF32ToWasm0(input, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustaudiodsp_resample(ptr0, len0, from_rate, to_rate, channels);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v2;
    }
    /**
     * Upmix Mono to Stereo [L, R].
     * @param {Float32Array} input
     * @returns {Float32Array}
     */
    static upmix_mono_to_stereo(input) {
        const ptr0 = passArrayF32ToWasm0(input, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustaudiodsp_upmix_mono_to_stereo(ptr0, len0);
        var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v2;
    }
}
if (Symbol.dispose) RustAudioDsp.prototype[Symbol.dispose] = RustAudioDsp.prototype.free;

/**
 * Pure Rust CPU image processing filters.
 * Designed with chunked iterators to allow LLVM to auto-vectorize with WASM SIMD128.
 */
export class RustCpuFilter {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RustCpuFilterFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rustcpufilter_free(ptr, 0);
    }
    /**
     * Apply brightness & contrast adjustment in-place using Rust CPU.
     * @param {Uint8Array} data
     * @param {number} brightness
     * @param {number} contrast
     */
    static adjust_brightness_contrast(data, brightness, contrast) {
        var ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        var len0 = WASM_VECTOR_LEN;
        wasm.rustcpufilter_adjust_brightness_contrast(ptr0, len0, data, brightness, contrast);
    }
    /**
     * Apply grayscale filter on RGBA8 buffer in-place using Rust CPU SIMD.
     * @param {Uint8Array} data
     */
    static grayscale_rgba(data) {
        var ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        var len0 = WASM_VECTOR_LEN;
        wasm.rustcpufilter_grayscale_rgba(ptr0, len0, data);
    }
    /**
     * Apply color inversion on RGBA8 buffer in-place using Rust CPU SIMD.
     * @param {Uint8Array} data
     */
    static invert_rgba(data) {
        var ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        var len0 = WASM_VECTOR_LEN;
        wasm.rustcpufilter_invert_rgba(ptr0, len0, data);
    }
}
if (Symbol.dispose) RustCpuFilter.prototype[Symbol.dispose] = RustCpuFilter.prototype.free;

/**
 * Rust-native high-performance WASM Demuxer.
 */
export class RustDemuxer {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RustDemuxerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rustdemuxer_free(ptr, 0);
    }
    /**
     * Extract a specific sample's raw compressed bitstream payload.
     * @param {number} index
     * @returns {Uint8Array | undefined}
     */
    get_sample_data(index) {
        const ret = wasm.rustdemuxer_get_sample_data(this.__wbg_ptr, index);
        let v1;
        if (ret[0] !== 0) {
            v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Sample duration in microseconds.
     * @param {number} index
     * @returns {bigint}
     */
    get_sample_duration(index) {
        const ret = wasm.rustdemuxer_get_sample_duration(this.__wbg_ptr, index);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Sample presentation timestamp in microseconds.
     * @param {number} index
     * @returns {bigint}
     */
    get_sample_pts(index) {
        const ret = wasm.rustdemuxer_get_sample_pts(this.__wbg_ptr, index);
        return ret;
    }
    /**
     * Check if primary video track is HEVC / H.265.
     * @returns {boolean}
     */
    is_hevc() {
        const ret = wasm.rustdemuxer_is_hevc(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if sample at index is a keyframe.
     * @param {number} index
     * @returns {boolean}
     */
    is_sample_keyframe(index) {
        const ret = wasm.rustdemuxer_is_sample_keyframe(this.__wbg_ptr, index);
        return ret !== 0;
    }
    /**
     * @param {Uint8Array} data
     */
    constructor(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustdemuxer_new(ptr0, len0);
        this.__wbg_ptr = ret;
        RustDemuxerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Total sample count in the primary video track.
     * @returns {number}
     */
    sample_count() {
        const ret = wasm.rustdemuxer_sample_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Number of tracks found in container.
     * @returns {number}
     */
    track_count() {
        const ret = wasm.rustdemuxer_track_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Primary video track codec string (e.g. "avc1.640028" or "hvc1.1.6.L93.B0").
     * @returns {string | undefined}
     */
    video_codec() {
        const ret = wasm.rustdemuxer_video_codec(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Extradata description box (e.g. avcC or hvcC).
     * @returns {Uint8Array | undefined}
     */
    video_description() {
        const ret = wasm.rustdemuxer_video_description(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * @returns {number}
     */
    video_height() {
        const ret = wasm.rustdemuxer_video_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    video_timescale() {
        const ret = wasm.rustdemuxer_video_timescale(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    video_width() {
        const ret = wasm.rustdemuxer_video_width(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) RustDemuxer.prototype[Symbol.dispose] = RustDemuxer.prototype.free;

/**
 * Pure Rust Stream-Oriented FLV Demuxer (RFC 0002).
 * Efficiently processes chunked WebSocket-FLV / HTTP-FLV streams without MSE memory leaks.
 */
export class RustFlvDemuxer {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RustFlvDemuxerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rustflvdemuxer_free(ptr, 0);
    }
    /**
     * Append incoming chunk of live stream bytes.
     * @param {Uint8Array} chunk
     */
    append_bytes(chunk) {
        const ptr0 = passArray8ToWasm0(chunk, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.rustflvdemuxer_append_bytes(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Compact internal buffer to free consumed memory.
     */
    compact() {
        wasm.rustflvdemuxer_compact(this.__wbg_ptr);
    }
    /**
     * Demux next available packet from the internal buffer.
     * Returns None when more bytes are needed or EOF.
     * @returns {Packet | undefined}
     */
    demux_next_packet() {
        const ret = wasm.rustflvdemuxer_demux_next_packet(this.__wbg_ptr);
        return ret === 0 ? undefined : Packet.__wrap(ret);
    }
    constructor() {
        const ret = wasm.rustflvdemuxer_new();
        this.__wbg_ptr = ret;
        RustFlvDemuxerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Check and parse FLV header if enough bytes are present.
     * @returns {FlvHeader | undefined}
     */
    parse_header() {
        const ret = wasm.rustflvdemuxer_parse_header(this.__wbg_ptr);
        return ret === 0 ? undefined : FlvHeader.__wrap(ret);
    }
}
if (Symbol.dispose) RustFlvDemuxer.prototype[Symbol.dispose] = RustFlvDemuxer.prototype.free;

/**
 * Pure Rust Matroska (MKV) & WebM Demuxer WASM Bridge.
 */
export class RustMkvDemuxer {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RustMkvDemuxerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rustmkvdemuxer_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    frame_count() {
        const ret = wasm.rustmkvdemuxer_frame_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} index
     * @returns {Uint8Array | undefined}
     */
    get_frame_data(index) {
        const ret = wasm.rustmkvdemuxer_get_frame_data(this.__wbg_ptr, index);
        let v1;
        if (ret[0] !== 0) {
            v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * @param {number} index
     * @returns {number | undefined}
     */
    get_frame_pts_us(index) {
        const ret = wasm.rustmkvdemuxer_get_frame_pts_us(this.__wbg_ptr, index);
        return ret[0] === 0 ? undefined : ret[1];
    }
    /**
     * @param {number} index
     * @returns {string | undefined}
     */
    get_track_codec(index) {
        const ret = wasm.rustmkvdemuxer_get_track_codec(this.__wbg_ptr, index);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * @param {number} index
     * @returns {number | undefined}
     */
    get_track_type(index) {
        const ret = wasm.rustmkvdemuxer_get_track_type(this.__wbg_ptr, index);
        return ret === 0xFFFFFF ? undefined : ret;
    }
    /**
     * @param {number} index
     * @returns {Uint32Array | undefined}
     */
    get_video_dimensions(index) {
        const ret = wasm.rustmkvdemuxer_get_video_dimensions(this.__wbg_ptr, index);
        return ret;
    }
    /**
     * @param {number} index
     * @returns {boolean}
     */
    is_frame_keyframe(index) {
        const ret = wasm.rustmkvdemuxer_is_frame_keyframe(this.__wbg_ptr, index);
        return ret !== 0;
    }
    /**
     * @param {Uint8Array} data
     */
    constructor(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustmkvdemuxer_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        RustMkvDemuxerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    track_count() {
        const ret = wasm.rustmkvdemuxer_track_count(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) RustMkvDemuxer.prototype[Symbol.dispose] = RustMkvDemuxer.prototype.free;

/**
 * Rust-native stream feeder with in-band parameter set extraction (H.264 avcC & H.265 hvcC + HDR10).
 */
export class RustStreamAnalyzer {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RustStreamAnalyzerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ruststreamanalyzer_free(ptr, 0);
    }
    /**
     * Analyze a streaming packet chunk.
     * Returns codec string if SPS was detected/updated.
     * @param {Uint8Array} data
     * @returns {string | undefined}
     */
    analyze_packet(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ruststreamanalyzer_analyze_packet(this.__wbg_ptr, ptr0, len0);
        let v2;
        if (ret[0] !== 0) {
            v2 = getStringFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v2;
    }
    /**
     * Build AVCC extradata configuration from stored SPS and PPS.
     * @returns {Uint8Array | undefined}
     */
    get_avcc_description() {
        const ret = wasm.ruststreamanalyzer_get_avcc_description(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Build configuration description box: `hvcC` for HEVC or `avcC` for H.264.
     * @returns {Uint8Array | undefined}
     */
    get_description() {
        const ret = wasm.ruststreamanalyzer_get_description(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Check if analyzed stream has HDR10 colorimetry (BT.2020 / PQ / HLG).
     * @returns {boolean}
     */
    is_hdr() {
        const ret = wasm.ruststreamanalyzer_is_hdr(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if analyzed stream is H.265 / HEVC.
     * @returns {boolean}
     */
    is_hevc() {
        const ret = wasm.ruststreamanalyzer_is_hevc(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Check if packet contains an IDR / IRAP keyframe slice.
     * @param {Uint8Array} data
     * @returns {boolean}
     */
    is_keyframe(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ruststreamanalyzer_is_keyframe(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    constructor() {
        const ret = wasm.ruststreamanalyzer_new();
        this.__wbg_ptr = ret;
        RustStreamAnalyzerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) RustStreamAnalyzer.prototype[Symbol.dispose] = RustStreamAnalyzer.prototype.free;

/**
 * FFmpeg-style Filtergraph Parser WASM Bridge.
 */
export class RustWasmFilterGraph {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RustWasmFilterGraphFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rustwasmfiltergraph_free(ptr, 0);
    }
    /**
     * @param {number} index
     * @returns {string | undefined}
     */
    get_node_name(index) {
        const ret = wasm.rustwasmfiltergraph_get_node_name(this.__wbg_ptr, index);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * @param {number} index
     * @returns {string | undefined}
     */
    get_node_target(index) {
        const ret = wasm.rustwasmfiltergraph_get_node_target(this.__wbg_ptr, index);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * @param {string} filter_str
     */
    constructor(filter_str) {
        const ptr0 = passStringToWasm0(filter_str, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustwasmfiltergraph_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        RustWasmFilterGraphFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {number}
     */
    node_count() {
        const ret = wasm.rustwasmfiltergraph_node_count(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) RustWasmFilterGraph.prototype[Symbol.dispose] = RustWasmFilterGraph.prototype.free;

/**
 * WASM-exported MP4 Muxer with FastStart streaming support.
 */
export class RustWasmMp4Muxer {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RustWasmMp4MuxerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rustwasmmp4muxer_free(ptr, 0);
    }
    /**
     * @returns {Uint8Array}
     */
    finalize() {
        const ret = wasm.rustwasmmp4muxer_finalize(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    constructor() {
        const ret = wasm.rustwasmmp4muxer_new();
        this.__wbg_ptr = ret;
        RustWasmMp4MuxerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {number} timescale
     * @param {number} sample_rate
     * @param {number} channels
     * @param {Uint8Array | null} [config]
     */
    set_audio_track(timescale, sample_rate, channels, config) {
        var ptr0 = isLikeNone(config) ? 0 : passArray8ToWasm0(config, wasm.__wbindgen_malloc);
        var len0 = WASM_VECTOR_LEN;
        wasm.rustwasmmp4muxer_set_audio_track(this.__wbg_ptr, timescale, sample_rate, channels, ptr0, len0);
    }
    /**
     * @param {number} width
     * @param {number} height
     * @param {number} timescale
     * @param {Uint8Array} vps
     * @param {Uint8Array} sps
     * @param {Uint8Array} pps
     */
    set_hevc_video_track(width, height, timescale, vps, sps, pps) {
        const ptr0 = passArray8ToWasm0(vps, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(sps, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(pps, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        wasm.rustwasmmp4muxer_set_hevc_video_track(this.__wbg_ptr, width, height, timescale, ptr0, len0, ptr1, len1, ptr2, len2);
    }
    /**
     * @param {number} width
     * @param {number} height
     * @param {number} timescale
     * @param {Uint8Array} sps
     * @param {Uint8Array} pps
     */
    set_video_track(width, height, timescale, sps, pps) {
        const ptr0 = passArray8ToWasm0(sps, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(pps, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.rustwasmmp4muxer_set_video_track(this.__wbg_ptr, width, height, timescale, ptr0, len0, ptr1, len1);
    }
    /**
     * @param {Uint8Array} data
     * @param {number} duration_ticks
     */
    write_audio_sample(data, duration_ticks) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.rustwasmmp4muxer_write_audio_sample(this.__wbg_ptr, ptr0, len0, duration_ticks);
    }
    /**
     * @param {Uint8Array} data
     * @param {number} duration_ticks
     * @param {boolean} is_key
     */
    write_video_sample(data, duration_ticks, is_key) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.rustwasmmp4muxer_write_video_sample(this.__wbg_ptr, ptr0, len0, duration_ticks, is_key);
    }
}
if (Symbol.dispose) RustWasmMp4Muxer.prototype[Symbol.dispose] = RustWasmMp4Muxer.prototype.free;

/**
 * WebRTC RTP Depacketizer WASM Bridge (H.264 RFC 6184 / H.265 RFC 7798).
 */
export class RustWasmRtpDepacketizer {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RustWasmRtpDepacketizerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rustwasmrtpdepacketizer_free(ptr, 0);
    }
    /**
     * @returns {bigint}
     */
    frames_assembled() {
        const ret = wasm.rustwasmrtpdepacketizer_frames_assembled(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @param {boolean} is_hevc
     */
    constructor(is_hevc) {
        const ret = wasm.rustwasmrtpdepacketizer_new(is_hevc);
        this.__wbg_ptr = ret;
        RustWasmRtpDepacketizerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {bigint}
     */
    packets_dropped() {
        const ret = wasm.rustwasmrtpdepacketizer_packets_dropped(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @returns {bigint}
     */
    packets_received() {
        const ret = wasm.rustwasmrtpdepacketizer_packets_received(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @param {Uint8Array} packet_bytes
     * @returns {RustWasmRtpFrame | undefined}
     */
    push_packet(packet_bytes) {
        const ptr0 = passArray8ToWasm0(packet_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustwasmrtpdepacketizer_push_packet(this.__wbg_ptr, ptr0, len0);
        return ret === 0 ? undefined : RustWasmRtpFrame.__wrap(ret);
    }
}
if (Symbol.dispose) RustWasmRtpDepacketizer.prototype[Symbol.dispose] = RustWasmRtpDepacketizer.prototype.free;

/**
 * Reconstructed RTP video frame exposed to WASM.
 */
export class RustWasmRtpFrame {
    static __wrap(ptr) {
        const obj = Object.create(RustWasmRtpFrame.prototype);
        obj.__wbg_ptr = ptr;
        RustWasmRtpFrameFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RustWasmRtpFrameFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rustwasmrtpframe_free(ptr, 0);
    }
    /**
     * @param {number} index
     * @returns {Uint8Array | undefined}
     */
    get_nal(index) {
        const ret = wasm.rustwasmrtpframe_get_nal(this.__wbg_ptr, index);
        let v1;
        if (ret[0] !== 0) {
            v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * @returns {boolean}
     */
    is_keyframe() {
        const ret = wasm.rustwasmrtpframe_is_keyframe(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    nal_count() {
        const ret = wasm.rustwasmrtpframe_nal_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {bigint}
     */
    pts_us() {
        const ret = wasm.rustwasmrtpframe_pts_us(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    ssrc() {
        const ret = wasm.rustwasmrtpframe_ssrc(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {Uint8Array}
     */
    to_annex_b() {
        const ret = wasm.rustwasmrtpframe_to_annex_b(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {Uint8Array}
     */
    to_avcc() {
        const ret = wasm.rustwasmrtpframe_to_avcc(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) RustWasmRtpFrame.prototype[Symbol.dispose] = RustWasmRtpFrame.prototype.free;

/**
 * WebRTC RTP Packetizer WASM Bridge (H.264 RFC 6184).
 */
export class RustWasmRtpPacketizer {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RustWasmRtpPacketizerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rustwasmrtppacketizer_free(ptr, 0);
    }
    /**
     * @param {number} mtu
     * @param {number} payload_type
     * @param {number} ssrc
     */
    constructor(mtu, payload_type, ssrc) {
        const ret = wasm.rustwasmrtppacketizer_new(mtu, payload_type, ssrc);
        this.__wbg_ptr = ret;
        RustWasmRtpPacketizerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {Uint8Array} nal
     * @param {bigint} pts_us
     * @param {boolean} is_last_nal
     * @returns {Array<any>}
     */
    packetize_nal(nal, pts_us, is_last_nal) {
        const ptr0 = passArray8ToWasm0(nal, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustwasmrtppacketizer_packetize_nal(this.__wbg_ptr, ptr0, len0, pts_us, is_last_nal);
        return ret;
    }
}
if (Symbol.dispose) RustWasmRtpPacketizer.prototype[Symbol.dispose] = RustWasmRtpPacketizer.prototype.free;

/**
 * Timeline and B-frame reordering scheduler.
 * Solves the out-of-order timestamp bug common in naive hardware decoder implementations.
 */
export class TimelineQueue {
    static __wrap(ptr) {
        const obj = Object.create(TimelineQueue.prototype);
        obj.__wbg_ptr = ptr;
        TimelineQueueFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        TimelineQueueFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_timelinequeue_free(ptr, 0);
    }
    /**
     * Check if a packet is ready to be consumed in strict PTS order.
     * @returns {boolean}
     */
    can_pop() {
        const ret = wasm.timelinequeue_can_pop(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Clear all queues (e.g. on seek).
     */
    clear() {
        wasm.timelinequeue_clear(this.__wbg_ptr);
    }
    /**
     * Flush remaining packets when stream ends (e.g. EOF).
     * @returns {Packet | undefined}
     */
    flush_next() {
        const ret = wasm.timelinequeue_flush_next(this.__wbg_ptr);
        return ret === 0 ? undefined : Packet.__wrap(ret);
    }
    /**
     * @returns {boolean}
     */
    is_empty() {
        const ret = wasm.timelinequeue_is_empty(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Current buffered queue size.
     * @returns {number}
     */
    len() {
        const ret = wasm.timelinequeue_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} max_delay_frames
     */
    constructor(max_delay_frames) {
        const ret = wasm.timelinequeue_new(max_delay_frames);
        this.__wbg_ptr = ret;
        TimelineQueueFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Pop the next packet with the lowest PTS, guaranteed to be monotonically increasing.
     * @returns {Packet | undefined}
     */
    pop() {
        const ret = wasm.timelinequeue_pop(this.__wbg_ptr);
        return ret === 0 ? undefined : Packet.__wrap(ret);
    }
    /**
     * Push an input packet into the reordering queue.
     * @param {Packet} packet
     */
    push(packet) {
        _assertClass(packet, Packet);
        var ptr0 = packet.__destroy_into_raw();
        wasm.timelinequeue_push(this.__wbg_ptr, ptr0);
    }
}
if (Symbol.dispose) TimelineQueue.prototype[Symbol.dispose] = TimelineQueue.prototype.free;

/**
 * Create a packet instance in Rust.
 * @param {bigint} pts
 * @param {bigint} dts
 * @param {bigint} duration
 * @param {boolean} is_keyframe
 * @param {number} stream_index
 * @param {Uint8Array} data
 * @returns {Packet}
 */
export function create_rust_packet(pts, dts, duration, is_keyframe, stream_index, data) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.create_rust_packet(pts, dts, duration, is_keyframe, stream_index, ptr0, len0);
    return Packet.__wrap(ret);
}

/**
 * Helper to create and initialize a Rust Timeline queue.
 * @param {number} max_delay_frames
 * @returns {TimelineQueue}
 */
export function create_rust_timeline(max_delay_frames) {
    const ret = wasm.create_rust_timeline(max_delay_frames);
    return TimelineQueue.__wrap(ret);
}

/**
 * Inspect capabilities and print version.
 * @returns {string}
 */
export function get_engine_version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.get_engine_version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Initialize panic hook and logging for debugging in browser console.
 */
export function init_core() {
    wasm.init_core();
}

/**
 * Standalone WASM converter: Annex-B to AVCC.
 * @param {Uint8Array} annex_b
 * @returns {Uint8Array}
 */
export function rust_annex_b_to_avcc(annex_b) {
    const ptr0 = passArray8ToWasm0(annex_b, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rust_annex_b_to_avcc(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Standalone WASM converter: AVCC to Annex-B.
 * @param {Uint8Array} avcc
 * @returns {Uint8Array}
 */
export function rust_avcc_to_annex_b(avcc) {
    const ptr0 = passArray8ToWasm0(avcc, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.rust_avcc_to_annex_b(ptr0, len0);
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Standalone WASM builder: build ISO 14496-15 avcC box.
 * @param {Uint8Array} sps
 * @param {Uint8Array} pps
 * @returns {Uint8Array}
 */
export function rust_build_avcc(sps, pps) {
    const ptr0 = passArray8ToWasm0(sps, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(pps, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.rust_build_avcc(ptr0, len0, ptr1, len1);
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
}

/**
 * Standalone WASM builder: build ISO 14496-15 hvcC box.
 * @param {Uint8Array} vps
 * @param {Uint8Array} sps
 * @param {Uint8Array} pps
 * @returns {Uint8Array}
 */
export function rust_build_hvcc(vps, sps, pps) {
    const ptr0 = passArray8ToWasm0(vps, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(sps, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray8ToWasm0(pps, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.rust_build_hvcc(ptr0, len0, ptr1, len1, ptr2, len2);
    var v4 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v4;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_copy_to_typed_array_cccd104be8cf0b8d: function(arg0, arg1, arg2) {
            new Uint8Array(arg2.buffer, arg2.byteOffset, arg2.byteLength).set(getArrayU8FromWasm0(arg0, arg1));
        },
        __wbg___wbindgen_throw_5d9e815e6fdf150f: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_log_16ef9d45fd8dfc37: function(arg0, arg1) {
            console.log(getStringFromWasm0(arg0, arg1));
        },
        __wbg_new_ffa92086ea89f79c: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_from_slice_4ee02165f9de919e: function(arg0, arg1) {
            const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_with_length_867011e49634d0b3: function(arg0) {
            const ret = new Uint32Array(arg0 >>> 0);
            return ret;
        },
        __wbg_push_bfdf956ba476f65b: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_set_index_c45581b254bc5f37: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2 >>> 0;
        },
        __wbindgen_generic_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./web_ffmpeg_core_bg.js": import0,
    };
}

const FlvHeaderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_flvheader_free(ptr, 1));
const FlvVideoTagInfoFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_flvvideotaginfo_free(ptr, 1));
const FrameMetadataFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_framemetadata_free(ptr, 1));
const JitterBufferFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jitterbuffer_free(ptr, 1));
const JitterBufferConfigFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_jitterbufferconfig_free(ptr, 1));
const PacketFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_packet_free(ptr, 1));
const RustAudioDspFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rustaudiodsp_free(ptr, 1));
const RustCpuFilterFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rustcpufilter_free(ptr, 1));
const RustDemuxerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rustdemuxer_free(ptr, 1));
const RustFlvDemuxerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rustflvdemuxer_free(ptr, 1));
const RustMkvDemuxerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rustmkvdemuxer_free(ptr, 1));
const RustStreamAnalyzerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ruststreamanalyzer_free(ptr, 1));
const RustWasmFilterGraphFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rustwasmfiltergraph_free(ptr, 1));
const RustWasmMp4MuxerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rustwasmmp4muxer_free(ptr, 1));
const RustWasmRtpDepacketizerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rustwasmrtpdepacketizer_free(ptr, 1));
const RustWasmRtpFrameFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rustwasmrtpframe_free(ptr, 1));
const RustWasmRtpPacketizerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rustwasmrtppacketizer_free(ptr, 1));
const TimelineQueueFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_timelinequeue_free(ptr, 1));

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('web_ffmpeg_core_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
