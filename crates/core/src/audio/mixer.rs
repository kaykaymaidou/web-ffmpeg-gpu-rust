use serde::{Deserialize, Serialize};

/// Error types for channel mixing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MixerError {
    InvalidInputLength,
    UnsupportedChannelConfiguration,
}

impl core::fmt::Display for MixerError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::InvalidInputLength => write!(f, "Input buffer length does not match expected channels"),
            Self::UnsupportedChannelConfiguration => write!(f, "Unsupported input/output channel mapping"),
        }
    }
}

/// Standard channel layout identifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChannelLayout {
    Mono,       // 1 channel
    Stereo,     // 2 channels: [L, R]
    Surround51, // 6 channels: [L, R, C, LFE, Ls, Rs]
}

impl ChannelLayout {
    pub fn channels(&self) -> usize {
        match self {
            Self::Mono => 1,
            Self::Stereo => 2,
            Self::Surround51 => 6,
        }
    }
}

/// Apply a smooth, tape-style soft-clipping saturation curve.
///
/// Prevents harsh digital wraps or brittle square-wave clipping when mixing multi-channel sums.
/// Linear in `[-0.75, +0.75]`, asymptotically approaches +/- 1.0 above 0.75.
#[inline(always)]
pub fn soft_clip(x: f32) -> f32 {
    if x.abs() <= 0.75 {
        x
    } else {
        let sign = if x > 0.0 { 1.0 } else { -1.0 };
        let excess = x.abs() - 0.75;
        // Pade approximation of tanh(excess * 2.0)
        let tanh_approx = (excess * 2.0) / (1.0 + (excess * 2.0).abs());
        sign * (0.75 + 0.25 * tanh_approx)
    }
}

/// Downmix 5.1 Surround audio to Stereo according to ITU-R BS.775.
///
/// $L' = \frac{1}{\sqrt{2}} (L + 0.7071 \cdot C + 0.7071 \cdot Ls)$
/// $R' = \frac{1}{\sqrt{2}} (R + 0.7071 \cdot C + 0.7071 \cdot Rs)$
/// (LFE is attenuated by default to prevent bass blooming).
pub fn mix_51_to_stereo(input: &[f32], include_lfe: bool) -> Result<Vec<f32>, MixerError> {
    if input.len() % 6 != 0 {
        return Err(MixerError::InvalidInputLength);
    }

    let frames = input.len() / 6;
    let mut output = Vec::with_capacity(frames * 2);

    let inv_sqrt2 = 0.70710678_f32;
    let norm_factor = 0.70710678_f32;

    for i in 0..frames {
        let offset = i * 6;
        let l = input[offset];
        let r = input[offset + 1];
        let c = input[offset + 2];
        let lfe = input[offset + 3];
        let ls = input[offset + 4];
        let rs = input[offset + 5];

        let lfe_contrib = if include_lfe { lfe * 0.5 } else { 0.0 };

        let sum_l = (l + c * inv_sqrt2 + ls * inv_sqrt2 + lfe_contrib) * norm_factor;
        let sum_r = (r + c * inv_sqrt2 + rs * inv_sqrt2 + lfe_contrib) * norm_factor;

        output.push(soft_clip(sum_l));
        output.push(soft_clip(sum_r));
    }

    Ok(output)
}

/// Downmix Stereo [L, R] to Mono [M].
///
/// $M = 0.5 \cdot L + 0.5 \cdot R$
pub fn mix_stereo_to_mono(input: &[f32]) -> Result<Vec<f32>, MixerError> {
    if input.len() % 2 != 0 {
        return Err(MixerError::InvalidInputLength);
    }

    let frames = input.len() / 2;
    let mut output = Vec::with_capacity(frames);

    for i in 0..frames {
        let l = input[i * 2];
        let r = input[i * 2 + 1];
        output.push(soft_clip(0.5 * (l + r)));
    }

    Ok(output)
}

/// Upmix Mono [M] to dual-channel Stereo [L, R].
///
/// $L = M, R = M$
pub fn mix_mono_to_stereo(input: &[f32]) -> Vec<f32> {
    let mut output = Vec::with_capacity(input.len() * 2);
    for &m in input {
        output.push(m);
        output.push(m);
    }
    output
}

/// General matrix channel mixer with gain scaling.
pub fn mix_channels(
    input: &[f32],
    src_layout: ChannelLayout,
    dst_layout: ChannelLayout,
    gain: f32,
) -> Result<Vec<f32>, MixerError> {
    let mut mixed = match (src_layout, dst_layout) {
        (a, b) if a == b => input.to_vec(),
        (ChannelLayout::Surround51, ChannelLayout::Stereo) => mix_51_to_stereo(input, false)?,
        (ChannelLayout::Surround51, ChannelLayout::Mono) => {
            let st = mix_51_to_stereo(input, false)?;
            mix_stereo_to_mono(&st)?
        }
        (ChannelLayout::Stereo, ChannelLayout::Mono) => mix_stereo_to_mono(input)?,
        (ChannelLayout::Mono, ChannelLayout::Stereo) => mix_mono_to_stereo(input),
        _ => return Err(MixerError::UnsupportedChannelConfiguration),
    };

    if (gain - 1.0).abs() > 1e-5 {
        for s in mixed.iter_mut() {
            *s = soft_clip(*s * gain);
        }
    }

    Ok(mixed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_soft_clip_linear_region() {
        assert_eq!(soft_clip(0.0), 0.0);
        assert_eq!(soft_clip(0.5), 0.5);
        assert_eq!(soft_clip(-0.5), -0.5);
    }

    #[test]
    fn test_soft_clip_saturation_asymptote() {
        let huge = soft_clip(100.0);
        assert!(huge <= 1.0 && huge > 0.99);

        let huge_neg = soft_clip(-100.0);
        assert!(huge_neg >= -1.0 && huge_neg < -0.99);
    }

    #[test]
    fn test_stereo_to_mono_mix() {
        let stereo = vec![1.0, 0.0, 0.5, 0.5];
        let mono = mix_stereo_to_mono(&stereo).unwrap();
        assert_eq!(mono.len(), 2);
        assert_eq!(mono[0], 0.5);
        assert_eq!(mono[1], 0.5);
    }

    #[test]
    fn test_mono_to_stereo_mix() {
        let mono = vec![0.8, -0.4];
        let stereo = mix_mono_to_stereo(&mono);
        assert_eq!(stereo, vec![0.8, 0.8, -0.4, -0.4]);
    }

    #[test]
    fn test_51_to_stereo_itu_r_bs775() {
        // [L, R, C, LFE, Ls, Rs]
        let frame = vec![1.0, 1.0, 0.0, 0.0, 0.0, 0.0];
        let st = mix_51_to_stereo(&frame, false).unwrap();
        assert_eq!(st.len(), 2);
        // L and R scaled by 0.7071
        assert!((st[0] - 0.70710678).abs() < 1e-4);
        assert!((st[1] - 0.70710678).abs() < 1e-4);
    }
}
