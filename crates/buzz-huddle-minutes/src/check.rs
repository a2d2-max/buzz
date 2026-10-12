//! Compare a script against a fake meeting's answer sheet.
//!
//! - **Speaker**: a piece is right when at least half of it lies on
//!   sentences of the person it is labelled with. A piece that lies mostly
//!   on other people's sentences is wrong (someone's voice under another
//!   name); one that overlaps nothing is a false alarm.
//! - **Coverage**: every speech unit inside a sentence (the same detection
//!   run on the clean clip) must be at least half covered by its speaker's
//!   pieces, so a hole in the middle of a sentence cannot hide behind
//!   good start and end times.
//! - **Found**: each sentence's text must appear in exactly one piece, and
//!   that piece must be its own speaker's and overlap it.
//! - **Order**: sentences read in script order must be in answer-sheet order.
//! - **Time**: pieces and sentences of one person that overlap form groups
//!   (one sentence split in two pieces, or two sentences in one piece, stay
//!   one group). Start error = first piece start − first sentence start;
//!   end error = last piece end − last sentence end.
//!
//! - **Merged**: no piece may hold two sentences — the sentences in the
//!   fake meeting are at least 0.7 s apart, so a piece spanning two means a
//!   pause was not cut.
//!
//! The time limits are the measured range plus a small margin (see
//! [`Tolerance::default`]). `start_ms` is where playback jumps when a line
//! is clicked; `end_ms` marks the line while it plays. Script times are the
//! speech without the padding sent to the transcriber; relay receive times
//! trail the speech by the network delay, so both edges run slightly late.

use std::collections::HashMap;

use serde::Serialize;

use crate::sim::Truth;
use crate::stt::FAILED_TEXT;
use crate::transcript::Transcript;

/// Signed errors in ms over all groups.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ErrorStats {
    /// Number of values.
    pub count: usize,
    /// Mean of the absolute values.
    pub mean_abs: f64,
    /// 95th percentile of the absolute values (nearest rank).
    pub p95_abs: i64,
    /// Largest absolute value.
    pub max_abs: i64,
    /// Smallest signed value (most early).
    pub min: i64,
    /// Largest signed value (most late).
    pub max: i64,
}

impl ErrorStats {
    fn from(values: &[i64]) -> Self {
        if values.is_empty() {
            return Self::default();
        }
        let mut abs: Vec<i64> = values.iter().map(|v| v.abs()).collect();
        abs.sort_unstable();
        let rank = (abs.len() * 95).div_ceil(100).max(1) - 1;
        Self {
            count: values.len(),
            mean_abs: abs.iter().sum::<i64>() as f64 / abs.len() as f64,
            p95_abs: abs[rank],
            max_abs: abs[abs.len() - 1],
            min: values.iter().copied().min().unwrap_or(0),
            max: values.iter().copied().max().unwrap_or(0),
        }
    }
}

/// Allowed time errors, ms (all non-negative).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Tolerance {
    /// A piece may start this much before its sentence.
    pub start_early_ms: i64,
    /// A piece may start this much after its sentence.
    pub start_late_ms: i64,
    /// A piece may end this much before its sentence.
    pub end_early_ms: i64,
    /// A piece may end this much after its sentence.
    pub end_late_ms: i64,
}

impl Default for Tolerance {
    fn default() -> Self {
        // Measured on FLEURS seeds 1–8 (unpadded script times): starts
        // −165…+160 ms (one +598 ms where Silero missed a first syllable),
        // ends −13…+633 ms. Limits = that range plus about 70–90 ms, so a
        // real shift of a few hundred ms fails instead of hiding inside a
        // wide band.
        Self {
            start_early_ms: 250,
            start_late_ms: 200,
            end_early_ms: 100,
            end_late_ms: 700,
        }
    }
}

/// The comparison result.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CheckReport {
    /// Sentences in the answer sheet.
    pub truth_sentences: usize,
    /// Pieces in the script.
    pub segments: usize,
    /// Pieces marked as failed transcriptions.
    pub failed_segments: usize,
    /// Pieces lying at least half on sentences of their own speaker.
    pub speaker_right: usize,
    /// Pieces lying mostly on other people's sentences.
    pub speaker_wrong: usize,
    /// Pieces overlapping no sentence at all.
    pub false_alarms: usize,
    /// Speech units inside sentences (from the answer sheet).
    pub speech_units: usize,
    /// Units less than half covered by their speaker's pieces.
    pub speech_units_under_half_covered: usize,
    /// Smallest covered fraction of any unit.
    pub min_unit_coverage: f64,
    /// `speaker_right / (speaker_right + speaker_wrong)`.
    pub speaker_accuracy: f64,
    /// Sentences found exactly once with their text.
    pub sentences_found: usize,
    /// Ids of sentences not found exactly once.
    pub sentences_missing: Vec<String>,
    /// Pairs of found sentences in the wrong order.
    pub order_inversions: usize,
    /// Person groups (see the module docs).
    pub groups: usize,
    /// Groups where one sentence spans several pieces.
    pub split_groups: usize,
    /// Groups holding several sentences: some piece reaches across the
    /// pause between two of them.
    pub merged_groups: usize,
    /// Start errors, ms (piece − sentence; negative = piece starts early).
    pub start_error_ms: ErrorStats,
    /// End errors, ms (piece − sentence; positive = piece ends late).
    pub end_error_ms: ErrorStats,
    /// Allowed errors.
    pub tolerance: Tolerance,
    /// Groups whose start or end is outside the allowed errors.
    pub groups_out_of_tolerance: usize,
    /// Every check passed.
    pub pass: bool,
}

/// Compare `transcript` to `truth`.
pub fn check(transcript: &Transcript, truth: &Truth, tolerance: Tolerance) -> CheckReport {
    let sentences = &truth.utterances;
    let segments = &transcript.segments;
    let overlaps = |a: (u64, u64), b: (u64, u64)| a.0 < b.1 && b.0 < a.1;

    let overlap_ms = |a: (u64, u64), b: (u64, u64)| a.1.min(b.1).saturating_sub(a.0.max(b.0));
    let mut speaker_right = 0;
    let mut speaker_wrong = 0;
    let mut false_alarms = 0;
    for segment in segments {
        let span = (segment.start_ms, segment.end_ms);
        let own: u64 = sentences
            .iter()
            .filter(|s| segment.speaker.as_deref() == Some(s.speaker.as_str()))
            .map(|s| overlap_ms(span, (s.start_ms, s.end_ms)))
            .sum();
        let any = sentences
            .iter()
            .any(|s| overlaps(span, (s.start_ms, s.end_ms)));
        if own * 2 >= segment.end_ms - segment.start_ms && own > 0 {
            speaker_right += 1;
        } else if any {
            speaker_wrong += 1;
        } else {
            false_alarms += 1;
        }
    }

    // Each speech unit of a sentence, covered by that speaker's pieces.
    let mut units = 0;
    let mut units_under_half = 0;
    let mut min_unit_coverage = 1.0f64;
    for sentence in sentences {
        for &[from, to] in &sentence.speech_units_ms {
            if to <= from {
                continue;
            }
            let covered: u64 = segments
                .iter()
                .filter(|seg| seg.speaker.as_deref() == Some(sentence.speaker.as_str()))
                .map(|seg| overlap_ms((seg.start_ms, seg.end_ms), (from, to)))
                .sum();
            let coverage = covered.min(to - from) as f64 / (to - from) as f64;
            units += 1;
            min_unit_coverage = min_unit_coverage.min(coverage);
            if coverage < 0.5 {
                units_under_half += 1;
            }
        }
    }

    // Sentence → the one piece whose text holds it.
    let mut holder: Vec<Option<usize>> = Vec::with_capacity(sentences.len());
    let mut missing = Vec::new();
    for sentence in sentences {
        let holders: Vec<usize> = segments
            .iter()
            .enumerate()
            .filter(|(_, seg)| seg.text.contains(&sentence.text))
            .map(|(i, _)| i)
            .collect();
        let found = holders.len() == 1 && {
            let seg = &segments[holders[0]];
            seg.speaker.as_deref() == Some(sentence.speaker.as_str())
                && overlaps(
                    (seg.start_ms, seg.end_ms),
                    (sentence.start_ms, sentence.end_ms),
                )
        };
        holder.push(found.then(|| holders[0]));
        if !found {
            missing.push(sentence.id.clone());
        }
    }

    // Script order of found sentences vs answer-sheet order.
    let mut script_order: Vec<(u64, u64, usize)> = holder
        .iter()
        .enumerate()
        .filter_map(|(i, h)| h.map(|seg| (segments[seg].start_ms, sentences[i].start_ms, i)))
        .collect();
    script_order.sort_unstable();
    let ranks: Vec<usize> = script_order.iter().map(|&(_, _, i)| i).collect();
    let mut order_inversions = 0;
    for a in 0..ranks.len() {
        for b in a + 1..ranks.len() {
            if sentences[ranks[a]].start_ms > sentences[ranks[b]].start_ms {
                order_inversions += 1;
            }
        }
    }

    // Groups: connected pieces and sentences of one person.
    let mut starts = Vec::new();
    let mut ends = Vec::new();
    let mut groups = 0;
    let mut split_groups = 0;
    let mut merged_groups = 0;
    let mut seen_sentence = vec![false; sentences.len()];
    for root in 0..sentences.len() {
        if seen_sentence[root] {
            continue;
        }
        let speaker = &sentences[root].speaker;
        let mut group_sentences = vec![root];
        let mut group_segments: Vec<usize> = Vec::new();
        seen_sentence[root] = true;
        let mut changed = true;
        while changed {
            changed = false;
            for (j, seg) in segments.iter().enumerate() {
                if seg.speaker.as_deref() != Some(speaker.as_str()) || group_segments.contains(&j) {
                    continue;
                }
                let touches = group_sentences.iter().any(|&i| {
                    overlaps(
                        (seg.start_ms, seg.end_ms),
                        (sentences[i].start_ms, sentences[i].end_ms),
                    )
                });
                if touches {
                    group_segments.push(j);
                    changed = true;
                }
            }
            for (i, sentence) in sentences.iter().enumerate() {
                if seen_sentence[i] || &sentence.speaker != speaker {
                    continue;
                }
                let touches = group_segments.iter().any(|&j| {
                    overlaps(
                        (segments[j].start_ms, segments[j].end_ms),
                        (sentence.start_ms, sentence.end_ms),
                    )
                });
                if touches {
                    seen_sentence[i] = true;
                    group_sentences.push(i);
                    changed = true;
                }
            }
        }
        if group_segments.is_empty() {
            continue;
        }
        groups += 1;
        if group_sentences.len() == 1 && group_segments.len() > 1 {
            split_groups += 1;
        }
        if group_sentences.len() > 1 {
            merged_groups += 1;
        }
        let first_sentence = group_sentences.iter().map(|&i| sentences[i].start_ms).min();
        let last_sentence = group_sentences.iter().map(|&i| sentences[i].end_ms).max();
        let first_piece = group_segments.iter().map(|&j| segments[j].start_ms).min();
        let last_piece = group_segments.iter().map(|&j| segments[j].end_ms).max();
        if let (Some(fs), Some(ls), Some(fp), Some(lp)) =
            (first_sentence, last_sentence, first_piece, last_piece)
        {
            starts.push(signed(fp, fs));
            ends.push(signed(lp, ls));
        }
    }

    let groups_out_of_tolerance = starts
        .iter()
        .zip(&ends)
        .filter(|&(&start, &end)| {
            start < -tolerance.start_early_ms
                || start > tolerance.start_late_ms
                || end < -tolerance.end_early_ms
                || end > tolerance.end_late_ms
        })
        .count();
    let start_error_ms = ErrorStats::from(&starts);
    let end_error_ms = ErrorStats::from(&ends);
    let failed_segments = segments.iter().filter(|s| s.text == FAILED_TEXT).count();
    let speaker_checked = speaker_right + speaker_wrong;
    let speaker_accuracy = if speaker_checked == 0 {
        0.0
    } else {
        speaker_right as f64 / speaker_checked as f64
    };
    let pass = speaker_wrong == 0
        && false_alarms == 0
        && units_under_half == 0
        && missing.is_empty()
        && order_inversions == 0
        && merged_groups == 0
        && failed_segments == 0
        && groups_out_of_tolerance == 0
        && groups > 0;
    CheckReport {
        truth_sentences: sentences.len(),
        segments: segments.len(),
        failed_segments,
        speaker_right,
        speaker_wrong,
        false_alarms,
        speech_units: units,
        speech_units_under_half_covered: units_under_half,
        min_unit_coverage,
        speaker_accuracy,
        sentences_found: sentences.len() - missing.len(),
        sentences_missing: missing,
        order_inversions,
        groups,
        split_groups,
        merged_groups,
        start_error_ms,
        end_error_ms,
        tolerance,
        groups_out_of_tolerance,
        pass,
    }
}

/// Character error rate of a script against the answer sheet.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CerReport {
    /// Edits (insertions, deletions, substitutions) over all speakers.
    pub edits: usize,
    /// Characters of the answer sheet compared.
    pub truth_chars: usize,
    /// `edits / truth_chars`.
    pub cer: f64,
}

/// CER per speaker, summed: each person's script lines in time order,
/// joined, against that person's sentences in time order, joined. Spaces
/// and punctuation are dropped and Latin letters lower-cased on both sides;
/// "받아쓰기 실패" lines count as empty.
pub fn cer(transcript: &Transcript, truth: &Truth) -> CerReport {
    let mut speakers: Vec<&str> = truth
        .utterances
        .iter()
        .map(|u| u.speaker.as_str())
        .collect();
    speakers.extend(
        transcript
            .segments
            .iter()
            .filter_map(|s| s.speaker.as_deref()),
    );
    speakers.sort_unstable();
    speakers.dedup();
    let (mut edits, mut truth_chars) = (0, 0);
    for speaker in speakers {
        let mut said: Vec<_> = truth
            .utterances
            .iter()
            .filter(|u| u.speaker == speaker)
            .collect();
        said.sort_by_key(|u| u.start_ms);
        let expected: Vec<char> = said.iter().flat_map(|u| normal_chars(&u.text)).collect();
        let mut lines: Vec<_> = transcript
            .segments
            .iter()
            .filter(|s| s.speaker.as_deref() == Some(speaker) && s.text != FAILED_TEXT)
            .collect();
        lines.sort_by_key(|s| s.start_ms);
        let heard: Vec<char> = lines.iter().flat_map(|s| normal_chars(&s.text)).collect();
        edits += edit_distance(&expected, &heard);
        truth_chars += expected.len();
    }
    CerReport {
        edits,
        truth_chars,
        cer: if truth_chars == 0 {
            0.0
        } else {
            edits as f64 / truth_chars as f64
        },
    }
}

/// The characters a CER counts: spaces and punctuation dropped, Latin
/// letters lower-cased.
pub(crate) fn normal_chars(text: &str) -> Vec<char> {
    text.chars()
        .filter(|c| {
            !c.is_whitespace() && !c.is_ascii_punctuation() && !"…·「」『』“”‘’".contains(*c)
        })
        .flat_map(char::to_lowercase)
        .collect()
}

/// Levenshtein distance over characters.
pub(crate) fn edit_distance(a: &[char], b: &[char]) -> usize {
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, x) in a.iter().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, y) in b.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = (above + 1)
                .min(row[j] + 1)
                .min(diagonal + usize::from(x != y));
            diagonal = above;
        }
    }
    row[b.len()]
}

fn signed(a: u64, b: u64) -> i64 {
    i64::try_from(a).unwrap_or(i64::MAX) - i64::try_from(b).unwrap_or(i64::MAX)
}

/// Where the mixed audio puts each sentence, against the clean sentence.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MixReport {
    /// Sentences measured.
    pub sentences: usize,
    /// Smallest lag, ms (positive = the mix is later than the answer sheet).
    pub lag_min_ms: i64,
    /// Largest lag, ms.
    pub lag_max_ms: i64,
    /// Middle lag, ms.
    pub lag_median_ms: i64,
    /// Lag of each sentence, answer-sheet order, ms.
    pub lags_ms: Vec<i64>,
    /// Weakest match between a sentence and the mix at its best lag.
    pub min_correlation: f64,
    /// Allowed lags, ms (inclusive).
    pub allowed_lag_ms: (i64, i64),
    /// Allowed `lag_max_ms - lag_min_ms`: every sentence must sit at the
    /// same offset, or something drifted.
    pub allowed_spread_ms: i64,
    /// Every lag inside the limits.
    pub pass: bool,
}

/// Lags searched, in 10 ms steps each way.
const MIX_SEARCH_STEPS: i64 = 30;

/// Check that the mixed audio (16 kHz) carries every sentence where the
/// answer sheet says, by matching 10 ms loudness envelopes. `speakers` maps
/// a speaker label to that person's joined WAV (16 kHz) from the fake
/// meeting. The relay stamps frames when they arrive, so the mix trails the
/// answer sheet by about the network delay; a drift shows up as spread.
pub fn check_mix(
    mix_16k: &[f32],
    truth: &Truth,
    speakers: &HashMap<String, Vec<f32>>,
) -> MixReport {
    // The clean meeting: every sentence's clean speech where the answer
    // sheet puts it, so overlapping talk is in the reference too.
    let mut clean_mix = vec![0f32; mix_16k.len()];
    for sentence in &truth.utterances {
        let Some(own) = speakers.get(&sentence.label) else {
            continue;
        };
        let from = usize::try_from(sentence.speaker_wav_start_ms * 16).unwrap_or(usize::MAX);
        let to = usize::try_from(sentence.speaker_wav_end_ms * 16).unwrap_or(usize::MAX);
        let Some(clean) = own.get(from..to.min(own.len())) else {
            continue;
        };
        let at = usize::try_from(sentence.start_ms * 16).unwrap_or(usize::MAX);
        for (out, sample) in clean_mix.iter_mut().skip(at).zip(clean) {
            *out += sample;
        }
    }
    let mix = envelope(mix_16k);
    let clean = envelope(&clean_mix);
    let mut lags = Vec::new();
    let mut min_correlation = 1.0f64;
    for sentence in &truth.utterances {
        let from = usize::try_from(sentence.start_ms / 10).unwrap_or(usize::MAX);
        let to = usize::try_from(sentence.end_ms / 10).unwrap_or(usize::MAX);
        let Some(reference) = clean.get(from..to.min(clean.len())) else {
            continue;
        };
        let at = i64::try_from(from).unwrap_or(i64::MAX);
        let mut best: Option<(f64, i64)> = None;
        for step in -MIX_SEARCH_STEPS..=MIX_SEARCH_STEPS {
            let Some(r) = correlation(reference, &mix, at + step) else {
                continue;
            };
            if best.is_none_or(|(c, _)| r > c) {
                best = Some((r, step));
            }
        }
        if let Some((r, step)) = best {
            lags.push(step * 10);
            min_correlation = min_correlation.min(r);
        }
    }
    let in_order = lags.clone();
    lags.sort_unstable();
    let allowed_lag_ms = (0, 200);
    let allowed_spread_ms = 60;
    let lag_min_ms = lags.first().copied().unwrap_or(0);
    let lag_max_ms = lags.last().copied().unwrap_or(0);
    MixReport {
        sentences: lags.len(),
        lag_min_ms,
        lag_max_ms,
        lag_median_ms: lags.get(lags.len() / 2).copied().unwrap_or(0),
        lags_ms: in_order,
        min_correlation,
        allowed_lag_ms,
        allowed_spread_ms,
        pass: !lags.is_empty()
            && lags.len() == truth.utterances.len()
            && lag_min_ms >= allowed_lag_ms.0
            && lag_max_ms <= allowed_lag_ms.1
            && lag_max_ms - lag_min_ms <= allowed_spread_ms,
    }
}

/// Loudness envelope of 16 kHz audio: log energy per 10 ms.
fn envelope(pcm: &[f32]) -> Vec<f64> {
    pcm.chunks(160)
        .map(|frame| {
            let energy = frame
                .iter()
                .map(|s| f64::from(*s) * f64::from(*s))
                .sum::<f64>()
                / frame.len() as f64;
            (energy + 1e-10).log10()
        })
        .collect()
}

/// How well `sent` (16 kHz audio of one piece, starting at `start_ms` on
/// the meeting clock) matches `clean` (16 kHz, the same clock): the best
/// loudness-envelope correlation within ±`search_ms`, and how much later
/// `sent` is than `clean` there, ms. `None` when nothing in reach varies
/// (silence on one side).
pub fn audio_match(
    sent: &[f32],
    clean: &[f32],
    start_ms: u64,
    search_ms: i64,
) -> Option<(i64, f64)> {
    let reference = envelope(sent);
    let signal = envelope(clean);
    let at = i64::try_from(start_ms / 10).ok()?;
    let steps = search_ms / 10;
    let mut best: Option<(i64, f64)> = None;
    for step in -steps..=steps {
        if let Some(r) = correlation(&reference, &signal, at + step) {
            if best.is_none_or(|(_, c)| r > c) {
                best = Some((-step * 10, r));
            }
        }
    }
    best
}

/// Pearson correlation of `reference` against `signal` starting at `at`.
fn correlation(reference: &[f64], signal: &[f64], at: i64) -> Option<f64> {
    let start = usize::try_from(at).ok()?;
    let window = signal.get(start..start + reference.len())?;
    let n = reference.len() as f64;
    let mean_a = reference.iter().sum::<f64>() / n;
    let mean_b = window.iter().sum::<f64>() / n;
    let (mut num, mut da, mut db) = (0.0, 0.0, 0.0);
    for (a, b) in reference.iter().zip(window) {
        num += (a - mean_a) * (b - mean_b);
        da += (a - mean_a) * (a - mean_a);
        db += (b - mean_b) * (b - mean_b);
    }
    let den = (da * db).sqrt();
    (den > 0.0).then(|| num / den)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_distance_counts_character_edits() {
        let chars = |t: &str| t.chars().collect::<Vec<_>>();
        assert_eq!(
            edit_distance(&chars("회의를 시작"), &chars("회의를 시작")),
            0
        );
        assert_eq!(edit_distance(&chars("회의를"), &chars("회이를")), 1);
        assert_eq!(edit_distance(&chars("회의"), &chars("")), 2);
        assert_eq!(edit_distance(&chars(""), &chars("네")), 1);
        assert_eq!(edit_distance(&chars("kitten"), &chars("sitting")), 3);
    }
    use crate::sim::{TruthUtterance, TRUTH_FORMAT};
    use crate::transcript::{AudioRef, Losses, Segment, SttInfo, TRANSCRIPT_FORMAT};
    use uuid::Uuid;

    fn sentence(id: &str, start_ms: u64, end_ms: u64) -> TruthUtterance {
        TruthUtterance {
            id: id.into(),
            speaker: "aa".into(),
            label: "A".into(),
            start_ms,
            end_ms,
            text: format!("문장 {id}"),
            speaker_wav_start_ms: 0,
            speaker_wav_end_ms: 0,
            speech_units_ms: vec![[start_ms, end_ms]],
        }
    }

    fn script(segments: Vec<Segment>) -> Transcript {
        Transcript {
            format: TRANSCRIPT_FORMAT.into(),
            community_id: Uuid::nil(),
            channel_id: Uuid::nil(),
            parent_channel_id: None,
            session_ids: Vec::new(),
            started_at: String::new(),
            ended_at: String::new(),
            duration_ms: 10_000,
            participants: Vec::new(),
            segments,
            audio: AudioRef {
                key: String::new(),
                expires_at: String::new(),
            },
            stt: SttInfo {
                engine: String::new(),
                region: String::new(),
                language: String::new(),
                billed_seconds: 0,
            },
            losses: Losses::default(),
        }
    }

    fn line(start_ms: u64, end_ms: u64, text: &str) -> Segment {
        Segment::own("aa".into(), start_ms, end_ms, text.into())
    }

    /// One piece reaching across the pause between two sentences fails the
    /// check even when every time edge and every text is fine.
    #[test]
    fn a_piece_across_two_sentences_fails() {
        let truth = Truth {
            format: TRUTH_FORMAT.into(),
            community_id: Uuid::nil(),
            channel_id: Uuid::nil(),
            prefix: String::new(),
            started_at: String::new(),
            duration_ms: 10_000,
            speakers: Vec::new(),
            sessions: Vec::new(),
            utterances: vec![sentence("1", 1_000, 3_000), sentence("2", 4_000, 6_000)],
        };
        let apart = script(vec![
            line(1_050, 3_050, "문장 1"),
            line(4_050, 6_050, "문장 2"),
        ]);
        let report = check(&apart, &truth, Tolerance::default());
        assert!(report.pass, "{report:#?}");
        assert_eq!(report.merged_groups, 0);

        let joined = script(vec![line(1_050, 6_050, "문장 1 문장 2")]);
        let report = check(&joined, &truth, Tolerance::default());
        assert_eq!(report.merged_groups, 1);
        assert_eq!(report.groups_out_of_tolerance, 0);
        assert!(!report.pass);
    }
}
