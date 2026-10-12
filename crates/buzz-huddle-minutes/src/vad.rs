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
    /// Let speech detection hear a level-matched copy ([`level_for_vad`]) so
    /// quiet, far voices are found. Only where pieces are cut changes: the
    /// transcriber still gets the track as recorded (so the ledger key needs
    /// nothing new — its bounds already say where the cut landed).
    pub vad_level: bool,
}

impl Default for SegmentPlan {
    fn default() -> Self {
        Self {
            max_segment_ms: 29_000,
            pad_ms: 200,
            vad_level: false,
        }
    }
}

/// [`level_for_vad`] target: RMS over half a second.
pub const VAD_LEVEL_DBFS: f32 = -25.0;
/// [`level_for_vad`] most gain.
pub const VAD_LEVEL_MAX_GAIN_DB: f32 = 30.0;
/// [`level_for_vad`] floor: a half second quieter than this is left as it is
/// (room noise is not brought up to sound like speech).
pub const VAD_LEVEL_FLOOR_DBFS: f32 = -60.0;

/// A copy of 16 kHz `pcm` for speech detection only: every half second's RMS
/// brought up to [`VAD_LEVEL_DBFS`] (only up, at most
/// [`VAD_LEVEL_MAX_GAIN_DB`], never under [`VAD_LEVEL_FLOOR_DBFS`]), the gain
/// smoothed over a second, clipped to ±1 — the measurement script that found
/// far voices (`build_agc.py`: centred windows, zero outside the track) plus
/// the floor, worked out on 10 ms steps so an hour-long track needs no more
/// than the copy itself. The floor sits where a real huddle's room noise was
/// (median −60.1 dBFS) and under most far speech (docs "VAD 크기 맞춤").
pub fn level_for_vad(pcm: &[f32]) -> Vec<f32> {
    level_for_vad_above(pcm, VAD_LEVEL_FLOOR_DBFS)
}

/// [`level_for_vad`] with another floor (`f32::NEG_INFINITY`: none), for measuring.
pub fn level_for_vad_above(pcm: &[f32], floor_dbfs: f32) -> Vec<f32> {
    const HOP: usize = VAD_SAMPLE_RATE as usize / 100;
    const RMS_FRAMES: usize = 50;
    const GAIN_FRAMES: usize = 100;
    let target = 10f64.powf(f64::from(VAD_LEVEL_DBFS) / 20.0);
    let most = 10f64.powf(f64::from(VAD_LEVEL_MAX_GAIN_DB) / 20.0);
    let floor = 10f64.powf(f64::from(floor_dbfs) / 20.0);
    let energy: Vec<f64> = pcm
        .chunks(HOP)
        .map(|frame| frame.iter().map(|&x| f64::from(x) * f64::from(x)).sum())
        .collect();
    let gain: Vec<f64> = centred_mean(&energy, RMS_FRAMES)
        .into_iter()
        .map(|e| {
            let rms = (e / HOP as f64).max(0.0).sqrt();
            if rms < floor {
                1.0
            } else {
                (target / (rms + 1e-9)).clamp(1.0, most)
            }
        })
        .collect();
    // Averaging counts zero past the track's ends: never let that bring a
    // short answer or a track's end down (only up).
    let gain: Vec<f64> = centred_mean(&gain, GAIN_FRAMES)
        .into_iter()
        .map(|g| g.max(1.0))
        .collect();
    // Gain between frame middles is drawn as a straight line.
    let at = |n: usize| -> f64 {
        let position = (n as f64 - (HOP / 2) as f64) / HOP as f64;
        if position <= 0.0 {
            return gain.first().copied().unwrap_or(1.0);
        }
        let k = position.floor() as usize;
        match (gain.get(k), gain.get(k + 1)) {
            (Some(&a), Some(&b)) => a + (b - a) * (position - k as f64),
            (Some(&a), None) => a,
            _ => gain.last().copied().unwrap_or(1.0),
        }
    };
    pcm.iter()
        .enumerate()
        .map(|(n, &x)| (f64::from(x) * at(n)).clamp(-1.0, 1.0) as f32)
        .collect()
}

/// `numpy.convolve(x, ones(w) / w, mode="same")`: for each item the sum of
/// the `w` items around it (from `w / 2` before to `w - w / 2 - 1` after,
/// zero outside) divided by `w`.
fn centred_mean(x: &[f64], w: usize) -> Vec<f64> {
    let mut prefix = Vec::with_capacity(x.len() + 1);
    prefix.push(0.0);
    for &v in x {
        prefix.push(prefix[prefix.len() - 1] + v);
    }
    (0..x.len())
        .map(|n| {
            let from = n.saturating_sub(w / 2);
            let to = (n + w - w / 2).min(x.len());
            (prefix[to] - prefix[from]) / w as f64
        })
        .collect()
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

    fn dbfs(pcm: &[f32]) -> f32 {
        let ms = pcm.iter().map(|x| x * x).sum::<f32>() / pcm.len() as f32;
        10.0 * ms.max(1e-20).log10()
    }

    fn tone_ms(ms: usize, dbfs: f32) -> Vec<f32> {
        let amplitude = 10f32.powf(dbfs / 20.0) * 2f32.sqrt();
        (0..ms * 16)
            .map(|i| amplitude * (std::f32::consts::TAU * 220.0 * i as f32 / 16_000.0).sin())
            .collect()
    }

    fn tone(seconds: usize, dbfs: f32) -> Vec<f32> {
        let amplitude = 10f32.powf(dbfs / 20.0) * 2f32.sqrt();
        (0..seconds * 16_000)
            .map(|i| amplitude * (std::f32::consts::TAU * 220.0 * i as f32 / 16_000.0).sin())
            .collect()
    }

    /// Quiet sound is brought up to −25 dBFS (at most +30 dB, nothing under
    /// the −60 dBFS floor: room noise stays noise), loud sound and silence
    /// are left alone (the middle of a long tone, away from the ends where
    /// the windows run out).
    #[test]
    fn detection_hears_quiet_sound_at_minus_25_dbfs() {
        let middle = |pcm: &[f32]| dbfs(&pcm[3 * 16_000..7 * 16_000]);
        // Without a floor, at most +30 dB.
        let out = level_for_vad_above(&tone(10, -70.0), f32::NEG_INFINITY);
        assert!((middle(&out) + 40.0).abs() < 0.2, "{}", middle(&out));
        for (input, expected) in [
            (-40.0, -25.0),
            (-55.0, -25.0),
            (-59.0, -29.0),
            (-61.0, -61.0),
            (-70.0, -70.0),
            (-10.0, -10.0),
        ] {
            let out = level_for_vad(&tone(10, input));
            assert!(
                (middle(&out) - expected).abs() < 0.2,
                "{input} dBFS → {} (expected {expected})",
                middle(&out)
            );
        }
        assert!(level_for_vad(&vec![0.0; 16_000]).iter().all(|&x| x == 0.0));
        assert!(level_for_vad(&[]).is_empty());
        // Only up, also where the windows run out: a short "네" (0.3 s at
        // −20 dBFS) keeps its level, and so does every sample at a track's end.
        let short = tone_ms(300, -20.0);
        let out = level_for_vad(&short);
        assert!(
            dbfs(&out) >= dbfs(&short) - 0.01,
            "{} → {}",
            dbfs(&short),
            dbfs(&out)
        );
        let long = tone(10, -40.0);
        let out = level_for_vad(&long);
        assert!(
            long.iter()
                .zip(&out)
                .all(|(x, y)| y.abs() >= x.abs() - 1e-7),
            "gain under 1 somewhere"
        );
    }

    fn plan(max: u64, pad: u64) -> SegmentPlan {
        SegmentPlan {
            vad_level: false,
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
