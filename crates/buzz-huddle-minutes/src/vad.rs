//! Find speech in one person's audio (step 3).
//!
//! A [`SpeechDetector`] marks natural speech units; [`plan_segments`] turns
//! them into the pieces sent to the transcriber, one request each
//! (`docs/huddle-minutes-worker.md` step 4):
//!
//! - a unit is sent as it is — units are never joined across a pause
//!   (Chirp 3 dropped the later speech of joined pieces);
//! - a unit longer than the limit is cut at its longest inner pause;
//! - the audio sent gets a little padding on each side, while the script
//!   keeps the unpadded speech times.

use std::path::Path;

use sherpa_onnx::{SileroVadModelConfig, VadModelConfig, VoiceActivityDetector};

/// Rate every detector and transcriber in this crate works at.
pub const VAD_SAMPLE_RATE: u32 = 16_000;
/// Silero works on 512-sample windows at 16 kHz.
const SILERO_WINDOW: usize = 512;

/// Half-open sample range `[start, end)` at [`VAD_SAMPLE_RATE`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpeechSpan {
    /// First sample.
    pub start: usize,
    /// One past the last sample.
    pub end: usize,
}

impl SpeechSpan {
    /// Length in samples.
    pub fn len(&self) -> usize {
        self.end - self.start
    }

    /// True for an empty span.
    pub fn is_empty(&self) -> bool {
        self.end <= self.start
    }
}

/// Why speech detection failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VadError {
    /// The model file is missing.
    #[error("VAD model not found at {0}")]
    MissingModel(String),
    /// sherpa-onnx refused the configuration.
    #[error("sherpa-onnx could not create the VAD")]
    CreateFailed,
}

/// Something that marks speech in 16 kHz mono audio.
pub trait SpeechDetector {
    /// Natural speech units in `pcm_16k`, in order, not overlapping.
    fn detect(&mut self, pcm_16k: &[f32]) -> Result<Vec<SpeechSpan>, VadError>;

    /// Finer spans inside one over-long unit, split at shorter pauses, used
    /// only to find where to cut it. Defaults to [`Self::detect`].
    fn detect_pauses(&mut self, pcm_16k: &[f32]) -> Result<Vec<SpeechSpan>, VadError> {
        self.detect(pcm_16k)
    }
}

/// Silero settings (seconds and probabilities, as sherpa-onnx takes them).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SileroSettings {
    /// Speech probability threshold.
    pub threshold: f32,
    /// Silence this long ends a unit.
    pub min_silence_s: f32,
    /// Silence this long is a place to cut an over-long unit.
    pub cut_silence_s: f32,
    /// Units shorter than this are dropped.
    pub min_speech_s: f32,
    /// Backstop: sherpa-onnx force-splits a unit this long. Kept well above
    /// [`SegmentPlan::max_segment_ms`] so the pause-aware cut decides.
    pub max_speech_s: f32,
}

impl Default for SileroSettings {
    fn default() -> Self {
        // min_silence 0.25 s is what scripts/huddle-stt-bench used.
        Self {
            threshold: 0.5,
            min_silence_s: 0.25,
            cut_silence_s: 0.05,
            min_speech_s: 0.25,
            max_speech_s: 120.0,
        }
    }
}

/// Silero VAD through sherpa-onnx.
#[derive(Debug, Clone)]
pub struct SileroVad {
    units: VadModelConfig,
    pauses: VadModelConfig,
    buffer_s: f32,
}

impl SileroVad {
    /// Detector using the Silero model at `model`.
    pub fn new(model: &Path, settings: SileroSettings) -> Result<Self, VadError> {
        if !model.is_file() {
            return Err(VadError::MissingModel(model.display().to_string()));
        }
        let config = |min_silence_s: f32, min_speech_s: f32| VadModelConfig {
            silero_vad: SileroVadModelConfig {
                model: Some(model.display().to_string()),
                threshold: settings.threshold,
                min_silence_duration: min_silence_s,
                min_speech_duration: min_speech_s,
                window_size: SILERO_WINDOW as i32,
                max_speech_duration: settings.max_speech_s,
            },
            sample_rate: VAD_SAMPLE_RATE as i32,
            num_threads: 1,
            provider: Some("cpu".into()),
            debug: false,
            ..Default::default()
        };
        Ok(Self {
            units: config(settings.min_silence_s, settings.min_speech_s),
            // When looking for a place to cut, a short word ("네") is speech,
            // not a pause, so short spans are kept.
            pauses: config(settings.cut_silence_s, settings.cut_silence_s),
            buffer_s: settings.max_speech_s * 2.0,
        })
    }

    fn run(
        config: &VadModelConfig,
        buffer_s: f32,
        pcm_16k: &[f32],
    ) -> Result<Vec<SpeechSpan>, VadError> {
        // A fresh detector per call: no state leaks between people or regions.
        let vad = VoiceActivityDetector::create(config, buffer_s).ok_or(VadError::CreateFailed)?;
        let mut spans = Vec::new();
        let drain = |vad: &VoiceActivityDetector, spans: &mut Vec<SpeechSpan>| {
            while let Some(segment) = vad.front() {
                let start = usize::try_from(segment.start()).unwrap_or(0);
                let len = usize::try_from(segment.n()).unwrap_or(0);
                drop(segment);
                vad.pop();
                spans.push(SpeechSpan {
                    start,
                    end: start + len,
                });
            }
        };
        for window in pcm_16k.chunks(SILERO_WINDOW) {
            vad.accept_waveform(window);
            drain(&vad, &mut spans);
        }
        vad.flush();
        drain(&vad, &mut spans);
        Ok(spans)
    }
}

impl SpeechDetector for SileroVad {
    fn detect(&mut self, pcm_16k: &[f32]) -> Result<Vec<SpeechSpan>, VadError> {
        Self::run(&self.units, self.buffer_s, pcm_16k)
    }

    fn detect_pauses(&mut self, pcm_16k: &[f32]) -> Result<Vec<SpeechSpan>, VadError> {
        Self::run(&self.pauses, self.buffer_s, pcm_16k)
    }
}

/// How speech units become transcription pieces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SegmentPlan {
    /// Longest piece, for the speech and for the padded audio alike.
    /// Default 29 s: under the 30 s the design sets (Chirp 3 Recognize takes
    /// under a minute).
    pub max_segment_ms: u64,
    /// Padding on each side of the audio sent, never past half the pause to
    /// a neighbouring piece and never past the limit.
    pub pad_ms: u64,
}

impl Default for SegmentPlan {
    fn default() -> Self {
        Self {
            max_segment_ms: 29_000,
            pad_ms: 200,
        }
    }
}

/// One transcription piece.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Piece {
    /// The speech; its times go into the script.
    pub speech: SpeechSpan,
    /// The audio sent to the transcriber: the speech plus padding.
    pub audio: SpeechSpan,
}

/// Turn the speech units of one track (`total_len` samples at
/// `sample_rate`) into transcription pieces, in order. `pauses_in` is asked
/// for finer spans inside a unit only when the unit is over the limit.
pub fn plan_segments<F>(
    units: &[SpeechSpan],
    sample_rate: u32,
    total_len: usize,
    plan: &SegmentPlan,
    mut pauses_in: F,
) -> Result<Vec<Piece>, VadError>
where
    F: FnMut(SpeechSpan) -> Result<Vec<SpeechSpan>, VadError>,
{
    let to_samples = |ms: u64| usize::try_from(ms * u64::from(sample_rate) / 1_000).unwrap_or(0);
    let max_len = to_samples(plan.max_segment_ms).max(1);
    let pad = to_samples(plan.pad_ms);

    // In range, sorted, overlapping spans folded together (never across a
    // pause).
    let mut pieces = Vec::new();
    for unit in fold(
        units,
        SpeechSpan {
            start: 0,
            end: total_len,
        },
    ) {
        if unit.len() <= max_len {
            pieces.push(unit);
            continue;
        }
        // The unit's own edges stay; inner spans only add places to cut.
        let mut inner = fold(&pauses_in(unit)?, unit);
        if let Some(first) = inner.first_mut() {
            first.start = unit.start;
        } else {
            inner.push(unit);
        }
        if let Some(last) = inner.last_mut() {
            last.end = unit.end;
        }
        split_group(&inner, max_len, &mut pieces);
    }

    // Pad the audio without crossing into a neighbour or past the limit.
    let mut planned = Vec::with_capacity(pieces.len());
    for (i, piece) in pieces.iter().enumerate() {
        let room_before = match i.checked_sub(1) {
            Some(prev) => (piece.start - pieces[prev].end) / 2,
            None => piece.start,
        };
        let room_after = match pieces.get(i + 1) {
            Some(next) => (next.start - piece.end) / 2,
            None => total_len - piece.end,
        };
        let spare = max_len.saturating_sub(piece.len());
        let mut before = pad.min(room_before);
        let mut after = pad.min(room_after);
        if before + after > spare {
            // Share what the limit leaves; a side with little room gives
            // the rest to the other side.
            let half = spare / 2;
            if before <= half {
                after = spare - before;
            } else if after <= half {
                before = spare - after;
            } else {
                before = half;
                after = spare - half;
            }
        }
        planned.push(Piece {
            speech: *piece,
            audio: SpeechSpan {
                start: piece.start - before,
                end: piece.end + after,
            },
        });
    }
    Ok(planned)
}

/// Clip `spans` to `within`, drop empty ones, sort, fold overlaps.
fn fold(spans: &[SpeechSpan], within: SpeechSpan) -> Vec<SpeechSpan> {
    let mut clean: Vec<SpeechSpan> = spans
        .iter()
        .map(|span| SpeechSpan {
            start: span.start.clamp(within.start, within.end),
            end: span.end.clamp(within.start, within.end),
        })
        .filter(|span| !span.is_empty())
        .collect();
    clean.sort_by_key(|span| span.start);
    let mut folded: Vec<SpeechSpan> = Vec::with_capacity(clean.len());
    for span in clean {
        match folded.last_mut() {
            Some(last) if span.start <= last.end => last.end = last.end.max(span.end),
            _ => folded.push(span),
        }
    }
    folded
}

/// Cut a run of spans (one over-long unit) at its longest pauses until
/// every piece fits; a stretch with no pause left is cut into equal parts.
fn split_group(group: &[SpeechSpan], max_len: usize, out: &mut Vec<SpeechSpan>) {
    let (Some(first), Some(last)) = (group.first(), group.last()) else {
        return;
    };
    let len = last.end - first.start;
    if len <= max_len {
        out.push(SpeechSpan {
            start: first.start,
            end: last.end,
        });
        return;
    }
    if group.len() == 1 {
        let pieces = len.div_ceil(max_len);
        let step = len.div_ceil(pieces);
        let mut start = first.start;
        while start < last.end {
            let end = (start + step).min(last.end);
            out.push(SpeechSpan { start, end });
            start = end;
        }
        return;
    }
    // Cut at the longest pause; on a tie, the earliest one.
    let mut cut = 1;
    for i in 2..group.len() {
        if group[i].start - group[i - 1].end > group[cut].start - group[cut - 1].end {
            cut = i;
        }
    }
    split_group(&group[..cut], max_len, out);
    split_group(&group[cut..], max_len, out);
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 1_000; // 1 sample = 1 ms keeps the numbers readable

    fn span(start: usize, end: usize) -> SpeechSpan {
        SpeechSpan { start, end }
    }

    fn plan(max: u64, pad: u64) -> SegmentPlan {
        SegmentPlan {
            max_segment_ms: max,
            pad_ms: pad,
        }
    }

    fn no_pauses(_: SpeechSpan) -> Result<Vec<SpeechSpan>, VadError> {
        Ok(Vec::new())
    }

    fn speech_of(pieces: &[Piece]) -> Vec<SpeechSpan> {
        pieces.iter().map(|p| p.speech).collect()
    }

    #[test]
    fn units_are_never_joined_across_a_pause() {
        let units = [span(100, 900), span(1_150, 2_000), span(3_000, 3_500)];
        let pieces = plan_segments(&units, RATE, 10_000, &plan(29_000, 0), no_pauses).unwrap();
        assert_eq!(speech_of(&pieces), units);
    }

    #[test]
    fn a_long_unit_is_cut_at_its_longest_inner_pause() {
        // Inner pauses: 300, 450, 200 ms. The unit is 40 s > 29 s.
        let inner = vec![
            span(0, 10_000),
            span(10_300, 20_000),
            span(20_450, 30_000),
            span(30_200, 40_000),
        ];
        let mut asked = Vec::new();
        let pieces = plan_segments(&[span(0, 40_000)], RATE, 50_000, &plan(29_000, 0), |unit| {
            asked.push(unit);
            Ok(inner.clone())
        })
        .unwrap();
        assert_eq!(asked, [span(0, 40_000)]);
        assert_eq!(speech_of(&pieces), [span(0, 20_000), span(20_450, 40_000)]);
    }

    #[test]
    fn short_units_never_ask_for_pauses() {
        let pieces = plan_segments(&[span(0, 29_000)], RATE, 30_000, &plan(29_000, 0), |_| {
            panic!("asked for pauses inside a unit that fits")
        })
        .unwrap();
        assert_eq!(speech_of(&pieces), [span(0, 29_000)]);
    }

    #[test]
    fn a_long_unit_without_pauses_is_cut_into_equal_pieces() {
        let pieces = plan_segments(
            &[span(0, 70_000)],
            RATE,
            70_000,
            &plan(29_000, 200),
            no_pauses,
        )
        .unwrap();
        assert_eq!(
            speech_of(&pieces),
            [span(0, 23_334), span(23_334, 46_668), span(46_668, 70_000)]
        );
        // Back to back: no room for padding.
        assert!(pieces.iter().all(|p| p.audio == p.speech));
    }

    #[test]
    fn padding_goes_on_the_audio_only_within_half_the_pause_and_the_limit() {
        let units = [span(50, 1_000), span(1_600, 2_000), span(5_000, 5_990)];
        let pieces = plan_segments(&units, RATE, 6_000, &plan(1_100, 200), no_pauses).unwrap();
        assert_eq!(speech_of(&pieces), units);
        let audio: Vec<SpeechSpan> = pieces.iter().map(|p| p.audio).collect();
        assert_eq!(
            audio,
            [
                // 50 ms of room before; the 1 100 limit leaves 150 → 50 + 100.
                span(0, 1_100),
                // half of the 600 ms pause each way is 300 → full 200 pad.
                span(1_400, 2_200),
                // 10 ms to the end of the track; the limit leaves 110, so 100 goes before.
                span(4_900, 6_000),
            ]
        );
        assert!(audio.iter().all(|a| a.len() <= 1_100));
    }

    #[test]
    fn overlapping_and_out_of_range_spans_are_cleaned() {
        let units = [
            span(500, 900),
            span(100, 600),
            span(9_000, 12_000),
            span(3, 3),
        ];
        let pieces = plan_segments(&units, RATE, 10_000, &plan(29_000, 0), no_pauses).unwrap();
        assert_eq!(speech_of(&pieces), [span(100, 900), span(9_000, 10_000)]);
    }
}
