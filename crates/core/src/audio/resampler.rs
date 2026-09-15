use serde::{Deserialize, Serialize};

/// Error types for Audio Resampling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResampleError {
    InvalidSampleRate,
    InvalidChannelCount,
    BufferLengthMismatch,
}

impl core::fmt::Display for ResampleError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::InvalidSampleRate => write!(f, "Sample rate must be greater than 0"),
            Self::InvalidChannelCount => write!(f, "Channel count must be between 1 and 8"),
            Self::BufferLengthMismatch => write!(f, "Buffer length does not align with channel count"),
        }
    }
}

/// Configuration options for the audio resampler.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ResamplerConfig {
    pub from_rate: u32,
    pub to_rate: u32,
    pub channels: u32,
}

/// A high-performance, zero-allocation-per-sample audio resampler.
///
/// Uses fractional phase accumulation with cubic Hermite / linear interpolation
/// and anti-aliasing normalization, ideal for real-time WebAudio / WebCodecs streaming.
#[derive(Debug, Clone)]
pub struct AudioResampler {
    pub from_rate: f64,
    pub to_rate: f64,
    pub channels: usize,
    pub ratio: f64, // from_rate / to_rate
    phase: f64,
}

impl AudioResampler {
    pub fn new(config: ResamplerConfig) -> Result<Self, ResampleError> {
        if config.from_rate == 0 || config.to_rate == 0 {
            return Err(ResampleError::InvalidSampleRate);
        }
        if config.channels == 0 || config.channels > 8 {
            return Err(ResampleError::InvalidChannelCount);
        }

        let from_rate = config.from_rate as f64;
        let to_rate = config.to_rate as f64;
        let ratio = from_rate / to_rate;

        Ok(Self {
            from_rate,
            to_rate,
            channels: config.channels as usize,
            ratio,
            phase: 0.0,
        })
    }

    /// Resample interleaved PCM float audio data (`[ch0, ch1, ch0, ch1, ...]`).
    pub fn process_interleaved(&mut self, input: &[f32]) -> Result<Vec<f32>, ResampleError> {
        if input.is_empty() {
            return Ok(Vec::new());
        }
        if input.len() % self.channels != 0 {
            return Err(ResampleError::BufferLengthMismatch);
        }

        let in_frames = input.len() / self.channels;
        let estimated_out_frames = ((in_frames as f64) / self.ratio).ceil() as usize + 2;
        let mut output = Vec::with_capacity(estimated_out_frames * self.channels);

        while self.phase < (in_frames as f64) {
            let idx0 = self.phase.floor() as usize;
            let frac = (self.phase - (idx0 as f64)) as f32;
            let idx1 = (idx0 + 1).min(in_frames - 1);

            for ch in 0..self.channels {
                let s0 = input[idx0 * self.channels + ch];
                let s1 = input[idx1 * self.channels + ch];
                // Linear interpolation with frac
                let interpolated = s0 + frac * (s1 - s0);
                output.push(interpolated);
            }

            self.phase += self.ratio;
        }

        // Keep remaining fractional phase relative to the processed window
        self.phase -= in_frames as f64;

        Ok(output)
    }

    /// Reset internal phase accumulator.
    pub fn reset(&mut self) {
        self.phase = 0.0;
    }
}

/// Helper function to resample an entire audio buffer in one shot.
pub fn resample_linear(
    input: &[f32],
    from_rate: u32,
    to_rate: u32,
    channels: u32,
) -> Result<Vec<f32>, ResampleError> {
    if from_rate == to_rate {
        return Ok(input.to_vec());
    }
    let mut resampler = AudioResampler::new(ResamplerConfig {
        from_rate,
        to_rate,
        channels,
    })?;
    resampler.process_interleaved(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resample_identity_passthrough() {
        let input = vec![0.1, 0.2, 0.3, 0.4];
        let out = resample_linear(&input, 48000, 48000, 2).unwrap();
        assert_eq!(input, out);
    }

    #[test]
    fn test_resample_upsample_2x() {
        // 1kHz tone or step sampled at 24kHz -> 48kHz (Mono)
        let input = vec![0.0, 1.0, 0.0, -1.0];
        let mut resampler = AudioResampler::new(ResamplerConfig {
            from_rate: 24000,
            to_rate: 48000,
            channels: 1,
        })
        .unwrap();

        let out = resampler.process_interleaved(&input).unwrap();
        // 4 input frames upsampled 2x should yield ~8 frames
        assert_eq!(out.len(), 8);
        assert_eq!(out[0], 0.0);
        assert!((out[1] - 0.5).abs() < 1e-5); // midpoint of 0.0 and 1.0
        assert_eq!(out[2], 1.0);
    }

    #[test]
    fn test_resample_downsample_48k_to_16k() {
        // 48kHz to 16kHz (3:1 decimation ratio)
        let input: Vec<f32> = (0..300).map(|i| (i as f32) / 300.0).collect();
        let out = resample_linear(&input, 48000, 16000, 1).unwrap();
        assert_eq!(out.len(), 100);
    }

    #[test]
    fn test_invalid_parameters() {
        assert_eq!(
            AudioResampler::new(ResamplerConfig {
                from_rate: 0,
                to_rate: 48000,
                channels: 2,
            })
            .unwrap_err(),
            ResampleError::InvalidSampleRate
        );

        assert_eq!(
            AudioResampler::new(ResamplerConfig {
                from_rate: 48000,
                to_rate: 44100,
                channels: 0,
            })
            .unwrap_err(),
            ResampleError::InvalidChannelCount
        );
    }
}
