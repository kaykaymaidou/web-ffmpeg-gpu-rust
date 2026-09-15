/**
 * Web-FFmpeg-Native: Desktop C-ABI Export Header
 * Compatible with C99, C++, C# (.NET P/Invoke), Python (ctypes/cffi), and Rust FFI.
 */

#ifndef WEB_FFMPEG_NATIVE_H
#define WEB_FFMPEG_NATIVE_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Status Codes */
#define WEB_FFMPEG_OK 0
#define WEB_FFMPEG_ERR_NULL_PTR -1
#define WEB_FFMPEG_ERR_INVALID_PARAM -2
#define WEB_FFMPEG_ERR_PROCESSING -3
#define WEB_FFMPEG_ERR_PANIC -99

/**
 * Return engine version string (e.g. "0.1.0-native-desktop").
 */
const char* web_ffmpeg_native_version(void);

/**
 * Resample interleaved float32 PCM audio data.
 * Caller MUST free *out_ptr by calling web_ffmpeg_native_free_audio.
 */
int32_t web_ffmpeg_native_resample_audio(
    const float* input,
    size_t in_len,
    uint32_t from_rate,
    uint32_t to_rate,
    uint32_t channels,
    float** out_ptr,
    size_t* out_len
);

/**
 * Free float32 audio memory previously allocated by the native library.
 */
void web_ffmpeg_native_free_audio(float* ptr, size_t len);

/**
 * Free byte buffers previously allocated by the native library.
 */
void web_ffmpeg_native_free_bytes(uint8_t* ptr, size_t len);

/**
 * Downmix 5.1 Surround audio to Stereo [L, R] using ITU-R BS.775.
 */
int32_t web_ffmpeg_native_mix_51_to_stereo(
    const float* input,
    size_t in_len,
    bool include_lfe,
    float** out_ptr,
    size_t* out_len
);

/**
 * Downmix Stereo [L, R] to Mono [M].
 */
int32_t web_ffmpeg_native_mix_stereo_to_mono(
    const float* input,
    size_t in_len,
    float** out_ptr,
    size_t* out_len
);

/**
 * Convert H.264 Annex B start codes (00 00 00 01) to AVCC length-prefixed format.
 */
int32_t web_ffmpeg_native_annex_b_to_avcc(
    const uint8_t* input,
    size_t in_len,
    uint8_t** out_ptr,
    size_t* out_len
);

/**
 * Convert H.264 AVCC length-prefixed stream to Annex B start codes.
 */
int32_t web_ffmpeg_native_avcc_to_annex_b(
    const uint8_t* input,
    size_t in_len,
    uint8_t** out_ptr,
    size_t* out_len
);

/**
 * Demux MKV / WebM container buffer and extract track/frame count and timescale.
 */
int32_t web_ffmpeg_native_demux_mkv_summary(
    const uint8_t* input,
    size_t in_len,
    size_t* out_tracks,
    size_t* out_frames,
    uint64_t* out_timescale_ns
);

/**
 * Demux MP4 / ISOBMFF container buffer and extract track and sample count.
 */
int32_t web_ffmpeg_native_demux_mp4_summary(
    const uint8_t* input,
    size_t in_len,
    size_t* out_tracks,
    size_t* out_samples
);

/**
 * Parse FFmpeg filtergraph string (e.g. "scale=1280:720,fps=30,grayscale")
 * and return the number of execution nodes planned.
 */
int32_t web_ffmpeg_native_parse_filtergraph_count(
    const char* filter_str,
    size_t* out_count
);

#ifdef __cplusplus
}
#endif

#endif /* WEB_FFMPEG_NATIVE_H */
