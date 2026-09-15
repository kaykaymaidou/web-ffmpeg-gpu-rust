//! Web-FFmpeg-Native: Desktop SDK and C-ABI export layer.
//! Provides stable FFI bindings for C/C++, C# (.NET), Python, and Electron native addons.

use std::os::raw::{c_char, c_int};
use web_ffmpeg_core::{mix_51_to_stereo, resample_linear};

/// Static version string.
static VERSION_CSTR: &[u8] = b"0.1.0-native-desktop\0";

/// Return engine version string as a null-terminated C string.
#[no_mangle]
pub extern "C" fn web_ffmpeg_native_version() -> *const c_char {
    VERSION_CSTR.as_ptr() as *const c_char
}

/// Status codes for C-ABI calls.
pub const STATUS_OK: c_int = 0;
pub const STATUS_ERR_NULL_PTR: c_int = -1;
pub const STATUS_ERR_INVALID_PARAM: c_int = -2;
pub const STATUS_ERR_PROCESSING: c_int = -3;
pub const STATUS_ERR_PANIC: c_int = -99;

/// Resample interleaved PCM float audio data across C-ABI boundary.
///
/// Returns 0 on success. The caller MUST free `*out_ptr` by calling `web_ffmpeg_native_free_audio`.
#[no_mangle]
pub unsafe extern "C" fn web_ffmpeg_native_resample_audio(
    input: *const f32,
    in_len: usize,
    from_rate: u32,
    to_rate: u32,
    channels: u32,
    out_ptr: *mut *mut f32,
    out_len: *mut usize,
) -> c_int {
    if input.is_null() || out_ptr.is_null() || out_len.is_null() {
        return STATUS_ERR_NULL_PTR;
    }
    if from_rate == 0 || to_rate == 0 || channels == 0 || in_len == 0 {
        return STATUS_ERR_INVALID_PARAM;
    }

    let result = std::panic::catch_unwind(|| {
        let in_slice = std::slice::from_raw_parts(input, in_len);
        match resample_linear(in_slice, from_rate, to_rate, channels) {
            Ok(mut resampled) => {
                resampled.shrink_to_fit();
                *out_len = resampled.len();
                let ptr = resampled.as_mut_ptr();
                std::mem::forget(resampled);
                *out_ptr = ptr;
                STATUS_OK
            }
            Err(_) => STATUS_ERR_PROCESSING,
        }
    });

    result.unwrap_or(STATUS_ERR_PANIC)
}

/// Free audio memory previously allocated by `web_ffmpeg_native_resample_audio` or `web_ffmpeg_native_mix_51_to_stereo`.
#[no_mangle]
pub unsafe extern "C" fn web_ffmpeg_native_free_audio(ptr: *mut f32, len: usize) {
    if !ptr.is_null() && len > 0 {
        let _ = Vec::from_raw_parts(ptr, len, len);
    }
}

/// Free byte buffers previously allocated across the C-ABI boundary.
#[no_mangle]
pub unsafe extern "C" fn web_ffmpeg_native_free_bytes(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        let _ = Vec::from_raw_parts(ptr, len, len);
    }
}

/// Downmix 5.1 Surround audio to Stereo [L, R] using ITU-R BS.775 power normalization.
#[no_mangle]
pub unsafe extern "C" fn web_ffmpeg_native_mix_51_to_stereo(
    input: *const f32,
    in_len: usize,
    include_lfe: bool,
    out_ptr: *mut *mut f32,
    out_len: *mut usize,
) -> c_int {
    if input.is_null() || out_ptr.is_null() || out_len.is_null() {
        return STATUS_ERR_NULL_PTR;
    }
    if in_len == 0 || in_len % 6 != 0 {
        return STATUS_ERR_INVALID_PARAM;
    }

    let result = std::panic::catch_unwind(|| {
        let in_slice = std::slice::from_raw_parts(input, in_len);
        match mix_51_to_stereo(in_slice, include_lfe) {
            Ok(mut stereo) => {
                stereo.shrink_to_fit();
                *out_len = stereo.len();
                let ptr = stereo.as_mut_ptr();
                std::mem::forget(stereo);
                *out_ptr = ptr;
                STATUS_OK
            }
            Err(_) => STATUS_ERR_PROCESSING,
        }
    });

    result.unwrap_or(STATUS_ERR_PANIC)
}

/// Downmix Stereo [L, R] to Mono [M].
#[no_mangle]
pub unsafe extern "C" fn web_ffmpeg_native_mix_stereo_to_mono(
    input: *const f32,
    in_len: usize,
    out_ptr: *mut *mut f32,
    out_len: *mut usize,
) -> c_int {
    if input.is_null() || out_ptr.is_null() || out_len.is_null() {
        return STATUS_ERR_NULL_PTR;
    }
    if in_len == 0 || in_len % 2 != 0 {
        return STATUS_ERR_INVALID_PARAM;
    }

    let result = std::panic::catch_unwind(|| {
        let in_slice = std::slice::from_raw_parts(input, in_len);
        match web_ffmpeg_core::mix_stereo_to_mono(in_slice) {
            Ok(mut mono) => {
                mono.shrink_to_fit();
                *out_len = mono.len();
                let ptr = mono.as_mut_ptr();
                std::mem::forget(mono);
                *out_ptr = ptr;
                STATUS_OK
            }
            Err(_) => STATUS_ERR_PROCESSING,
        }
    });

    result.unwrap_or(STATUS_ERR_PANIC)
}

/// Convert H.264 Annex B start-code stream to AVCC length-prefixed format across C-ABI.
#[no_mangle]
pub unsafe extern "C" fn web_ffmpeg_native_annex_b_to_avcc(
    input: *const u8,
    in_len: usize,
    out_ptr: *mut *mut u8,
    out_len: *mut usize,
) -> c_int {
    if input.is_null() || out_ptr.is_null() || out_len.is_null() {
        return STATUS_ERR_NULL_PTR;
    }
    if in_len == 0 {
        return STATUS_ERR_INVALID_PARAM;
    }

    let result = std::panic::catch_unwind(|| {
        let in_slice = std::slice::from_raw_parts(input, in_len);
        let mut avcc = web_ffmpeg_core::annex_b_to_avcc(in_slice);
        avcc.shrink_to_fit();
        *out_len = avcc.len();
        let ptr = avcc.as_mut_ptr();
        std::mem::forget(avcc);
        *out_ptr = ptr;
        STATUS_OK
    });

    result.unwrap_or(STATUS_ERR_PANIC)
}

/// Convert H.264 AVCC length-prefixed stream to Annex B start codes across C-ABI.
#[no_mangle]
pub unsafe extern "C" fn web_ffmpeg_native_avcc_to_annex_b(
    input: *const u8,
    in_len: usize,
    out_ptr: *mut *mut u8,
    out_len: *mut usize,
) -> c_int {
    if input.is_null() || out_ptr.is_null() || out_len.is_null() {
        return STATUS_ERR_NULL_PTR;
    }
    if in_len == 0 {
        return STATUS_ERR_INVALID_PARAM;
    }

    let result = std::panic::catch_unwind(|| {
        let in_slice = std::slice::from_raw_parts(input, in_len);
        let mut annex_b = web_ffmpeg_core::avcc_to_annex_b(in_slice);
        annex_b.shrink_to_fit();
        *out_len = annex_b.len();
        let ptr = annex_b.as_mut_ptr();
        std::mem::forget(annex_b);
        *out_ptr = ptr;
        STATUS_OK
    });

    result.unwrap_or(STATUS_ERR_PANIC)
}

/// Demux an MKV / WebM container buffer and return summary metadata.
#[no_mangle]
pub unsafe extern "C" fn web_ffmpeg_native_demux_mkv_summary(
    input: *const u8,
    in_len: usize,
    out_tracks: *mut usize,
    out_frames: *mut usize,
    out_timescale_ns: *mut u64,
) -> c_int {
    if input.is_null() || out_tracks.is_null() || out_frames.is_null() || out_timescale_ns.is_null() {
        return STATUS_ERR_NULL_PTR;
    }
    if in_len < 4 {
        return STATUS_ERR_INVALID_PARAM;
    }

    let result = std::panic::catch_unwind(|| {
        let in_slice = std::slice::from_raw_parts(input, in_len);
        match web_ffmpeg_core::demux_mkv(in_slice) {
            Ok(res) => {
                *out_tracks = res.tracks.len();
                *out_frames = res.frames.len();
                *out_timescale_ns = res.timecode_scale_ns;
                STATUS_OK
            }
            Err(_) => STATUS_ERR_PROCESSING,
        }
    });

    result.unwrap_or(STATUS_ERR_PANIC)
}

/// Demux an MP4 / ISOBMFF container buffer and return summary metadata.
#[no_mangle]
pub unsafe extern "C" fn web_ffmpeg_native_demux_mp4_summary(
    input: *const u8,
    in_len: usize,
    out_tracks: *mut usize,
    out_samples: *mut usize,
) -> c_int {
    if input.is_null() || out_tracks.is_null() || out_samples.is_null() {
        return STATUS_ERR_NULL_PTR;
    }
    if in_len < 8 {
        return STATUS_ERR_INVALID_PARAM;
    }

    let result = std::panic::catch_unwind(|| {
        let in_slice = std::slice::from_raw_parts(input, in_len);
        let demuxer = web_ffmpeg_core::Mp4Demuxer::new(in_slice);
        let tracks = demuxer.parse();
        *out_tracks = tracks.len();
        *out_samples = tracks.iter().map(|t| t.samples.len()).sum();
        STATUS_OK
    });

    result.unwrap_or(STATUS_ERR_PANIC)
}

/// Parse FFmpeg filtergraph string and return the total number of planned nodes.
#[no_mangle]
pub unsafe extern "C" fn web_ffmpeg_native_parse_filtergraph_count(
    filter_str: *const c_char,
    out_count: *mut usize,
) -> c_int {
    if filter_str.is_null() || out_count.is_null() {
        return STATUS_ERR_NULL_PTR;
    }

    let result = std::panic::catch_unwind(|| {
        let c_str = std::ffi::CStr::from_ptr(filter_str);
        match c_str.to_str() {
            Ok(s) => match web_ffmpeg_core::parse_filtergraph(s) {
                Ok(graph) => {
                    *out_count = graph.nodes.len();
                    STATUS_OK
                }
                Err(_) => STATUS_ERR_PROCESSING,
            },
            Err(_) => STATUS_ERR_INVALID_PARAM,
        }
    });

    result.unwrap_or(STATUS_ERR_PANIC)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CStr;

    #[test]
    fn test_c_abi_version_string() {
        let ptr = web_ffmpeg_native_version();
        assert!(!ptr.is_null());
        let cstr = unsafe { CStr::from_ptr(ptr) };
        assert_eq!(cstr.to_str().unwrap(), "0.1.0-native-desktop");
    }

    #[test]
    fn test_c_abi_resample_audio_roundtrip() {
        let input: Vec<f32> = vec![0.0, 0.5, 1.0, 0.5, 0.0, -0.5]; // 6 samples, 48kHz mono
        let mut out_ptr: *mut f32 = std::ptr::null_mut();
        let mut out_len: usize = 0;

        let status = unsafe {
            web_ffmpeg_native_resample_audio(
                input.as_ptr(),
                input.len(),
                48000,
                24000, // 2:1 downsampling
                1,
                &mut out_ptr,
                &mut out_len,
            )
        };

        assert_eq!(status, STATUS_OK);
        assert_eq!(out_len, 3);
        assert!(!out_ptr.is_null());

        let resampled_slice = unsafe { std::slice::from_raw_parts(out_ptr, out_len) };
        assert_eq!(resampled_slice.len(), 3);

        // Clean up allocated buffer
        unsafe {
            web_ffmpeg_native_free_audio(out_ptr, out_len);
        }
    }

    #[test]
    fn test_c_abi_null_pointer_safety() {
        let status = unsafe {
            web_ffmpeg_native_resample_audio(
                std::ptr::null(),
                100,
                48000,
                24000,
                1,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        assert_eq!(status, STATUS_ERR_NULL_PTR);
    }

    #[test]
    fn test_c_abi_stereo_to_mono_mix() {
        let stereo = vec![1.0f32, 0.0f32, 0.5f32, 0.5f32];
        let mut out_ptr: *mut f32 = std::ptr::null_mut();
        let mut out_len: usize = 0;

        let status = unsafe {
            web_ffmpeg_native_mix_stereo_to_mono(
                stereo.as_ptr(),
                stereo.len(),
                &mut out_ptr,
                &mut out_len,
            )
        };

        assert_eq!(status, STATUS_OK);
        assert_eq!(out_len, 2);
        assert!(!out_ptr.is_null());

        let mono = unsafe { std::slice::from_raw_parts(out_ptr, out_len) };
        assert_eq!(mono[0], 0.5);
        assert_eq!(mono[1], 0.5);

        unsafe {
            web_ffmpeg_native_free_audio(out_ptr, out_len);
        }
    }

    #[test]
    fn test_c_abi_annex_b_to_avcc_roundtrip() {
        // [00 00 00 01, NAL...]
        let annex_b = vec![0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x0A];
        let mut out_ptr: *mut u8 = std::ptr::null_mut();
        let mut out_len: usize = 0;

        let status = unsafe {
            web_ffmpeg_native_annex_b_to_avcc(
                annex_b.as_ptr(),
                annex_b.len(),
                &mut out_ptr,
                &mut out_len,
            )
        };

        assert_eq!(status, STATUS_OK);
        assert_eq!(out_len, 8); // 4 bytes length prefix + 4 bytes NAL
        let avcc = unsafe { std::slice::from_raw_parts(out_ptr, out_len) };
        assert_eq!(avcc[0..4], [0x00, 0x00, 0x00, 0x04]);

        unsafe {
            web_ffmpeg_native_free_bytes(out_ptr, out_len);
        }
    }

    #[test]
    fn test_c_abi_filtergraph_parsing() {
        let filter_str = std::ffi::CString::new("scale=1280:720,fps=30,grayscale").unwrap();
        let mut count: usize = 0;

        let status = unsafe {
            web_ffmpeg_native_parse_filtergraph_count(filter_str.as_ptr(), &mut count)
        };

        assert_eq!(status, STATUS_OK);
        assert_eq!(count, 3);
    }
}
