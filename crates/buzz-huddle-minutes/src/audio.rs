//! Small audio helpers: 16-bit PCM WAV in and out, resampling, mixing.

use sherpa_onnx::LinearResampler;

/// Why WAV bytes could not be read.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WavError {
    /// Not a RIFF/WAVE file or a chunk runs past the end.
    #[error("not a readable WAV file: {0}")]
    Malformed(&'static str),
    /// A layout other than 16-bit PCM mono.
    #[error("only 16-bit PCM mono WAV is supported (format {format}, {channels} ch, {bits} bit)")]
    Unsupported {
        /// `wFormatTag`.
        format: u16,
        /// Channel count.
        channels: u16,
        /// Bits per sample.
        bits: u16,
    },
}

/// Read a 16-bit PCM mono WAV. Returns the sample rate and samples in `[-1, 1)`.
pub fn read_wav_mono_i16(bytes: &[u8]) -> Result<(u32, Vec<f32>), WavError> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(WavError::Malformed("missing RIFF/WAVE header"));
    }
    let mut offset = 12;
    let mut format: Option<(u16, u16, u32, u16)> = None;
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes([
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ]) as usize;
        let body = bytes
            .get(offset + 8..offset + 8 + size)
            .ok_or(WavError::Malformed("chunk runs past the end"))?;
        match id {
            b"fmt " if size >= 16 => {
                format = Some((
                    u16::from_le_bytes([body[0], body[1]]),
                    u16::from_le_bytes([body[2], body[3]]),
                    u32::from_le_bytes([body[4], body[5], body[6], body[7]]),
                    u16::from_le_bytes([body[14], body[15]]),
                ));
            }
            b"data" => {
                let (tag, channels, rate, bits) =
                    format.ok_or(WavError::Malformed("data before fmt"))?;
                if tag != 1 || channels != 1 || bits != 16 {
                    return Err(WavError::Unsupported {
                        format: tag,
                        channels,
                        bits,
                    });
                }
                let samples = body
                    .chunks_exact(2)
                    .map(|pair| f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32_768.0)
                    .collect();
                return Ok((rate, samples));
            }
            _ => {}
        }
        // Chunks are padded to an even size.
        offset += 8 + size + (size & 1);
    }
    Err(WavError::Malformed("no data chunk"))
}

/// Write samples as a 16-bit PCM mono WAV. Values outside `[-1, 1]` are clipped.
pub fn write_wav_mono_i16(sample_rate: u32, samples: &[f32]) -> Vec<u8> {
    let data_len = u32::try_from(samples.len() * 2).unwrap_or(u32::MAX - 36);
    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for &sample in samples {
        out.extend_from_slice(&to_i16(sample).to_le_bytes());
    }
    out
}

fn to_i16(sample: f32) -> i16 {
    // Clamped into i16 range before the cast.
    (sample.clamp(-1.0, 1.0) * 32_767.0).round() as i16
}

/// Resample a whole signal (sherpa-onnx's windowed-sinc linear resampler).
pub fn resample(samples: &[f32], from_hz: u32, to_hz: u32) -> Vec<f32> {
    if from_hz == to_hz || samples.is_empty() {
        return samples.to_vec();
    }
    let rate = |hz: u32| i32::try_from(hz).unwrap_or(i32::MAX);
    match LinearResampler::create(rate(from_hz), rate(to_hz)) {
        Some(resampler) => resampler.resample(samples, true),
        None => Vec::new(),
    }
}

/// Sums people's tracks on one timeline.
#[derive(Debug, Clone)]
pub struct Mixer {
    sample_rate: u32,
    buf: Vec<f32>,
}

impl Mixer {
    /// Empty mix of `duration_ms` at `sample_rate`.
    pub fn new(sample_rate: u32, duration_ms: u64) -> Self {
        let len = duration_ms * u64::from(sample_rate) / 1_000;
        Self {
            sample_rate,
            buf: vec![0.0; usize::try_from(len).unwrap_or(0)],
        }
    }

    /// Add `samples` (already at the mix rate) starting at `start_ms`.
    /// Audio past the end grows the mix.
    pub fn add(&mut self, start_ms: u64, samples: &[f32]) {
        let start =
            usize::try_from(start_ms * u64::from(self.sample_rate) / 1_000).unwrap_or(usize::MAX);
        let end = start.saturating_add(samples.len());
        if self.buf.len() < end {
            self.buf.resize(end, 0.0);
        }
        for (out, &sample) in self.buf[start..end].iter_mut().zip(samples) {
            *out += sample;
        }
    }

    /// Mix rate.
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// The summed samples (may exceed `[-1, 1]` where people overlap).
    pub fn samples(&self) -> &[f32] {
        &self.buf
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_round_trips() {
        let samples = [0.0, 0.5, -0.5, 0.999, -1.0];
        let bytes = write_wav_mono_i16(16_000, &samples);
        assert_eq!(bytes.len(), 44 + samples.len() * 2);
        let (rate, back) = read_wav_mono_i16(&bytes).expect("read");
        assert_eq!(rate, 16_000);
        for (a, b) in samples.iter().zip(&back) {
            assert!((a - b).abs() < 1.0 / 16_000.0, "{a} vs {b}");
        }
    }

    #[test]
    fn wav_reader_refuses_other_layouts() {
        let mut bytes = write_wav_mono_i16(16_000, &[0.0; 4]);
        bytes[22] = 2; // stereo
        assert!(matches!(
            read_wav_mono_i16(&bytes),
            Err(WavError::Unsupported { channels: 2, .. })
        ));
        assert!(read_wav_mono_i16(b"not a wav").is_err());
    }

    #[test]
    fn mixer_sums_at_offsets_and_grows() {
        let mut mix = Mixer::new(1_000, 4);
        mix.add(1, &[0.5, 0.5]);
        mix.add(2, &[0.25, 0.25, 0.25, 0.25]);
        assert_eq!(mix.samples(), &[0.0, 0.5, 0.75, 0.25, 0.25, 0.25]);
    }

    #[test]
    fn resample_keeps_duration() {
        let tone: Vec<f32> = (0..48_000)
            .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * 0.5)
            .collect();
        let down = resample(&tone, 48_000, 16_000);
        assert!((down.len() as i64 - 16_000).abs() <= 16, "{}", down.len());
    }
}
