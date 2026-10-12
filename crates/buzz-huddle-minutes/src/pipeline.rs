//! Steps 2–6 for one gathered meeting: rebuild each person, find speech,
//! transcribe, write the script, mix the playback audio.
//!
//! People are handled one at a time and each person's 48 kHz track is
//! dropped after it is added to the mix, so memory grows with the meeting
//! length, not with the number of people.

use buzz_huddle_recording::format_utc_millis;

use crate::audio::{resample, write_wav_mono_i16, Mixer};
use crate::collect::Meeting;
use crate::ledger::{piece_key, Outcome, SttLedger};
use crate::stt::{SpeechToText, SttErrorKind, SttRequest, FAILED_TEXT};
use crate::tracks::{demux, DecodeStats, DemuxStats, REGION_GAP_MS, SAMPLE_RATE};
use crate::transcript::{AudioRef, Participant, Segment, Transcript, TRANSCRIPT_FORMAT};
use crate::vad::{
    plan_segments, SegmentPlan, SpeechDetector, SpeechSpan, VadError, VAD_SAMPLE_RATE,
};

/// Mixed audio rate. 16 kHz mono 16-bit WAV: about 115 MB per hour.
pub const MIX_SAMPLE_RATE: u32 = 16_000;
/// File extension of the mixed audio.
pub const MIX_EXTENSION: &str = "wav";
/// The recording bucket deletes objects 15 days after they are written.
pub const RECORDING_RETENTION_DAYS: u64 = 15;

/// How transcription failures are handled.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SttPolicy {
    /// Extra attempts for a piece after a transient or rate-limit failure.
    pub retries: u32,
    /// Wait before the first retry after a transient failure, ms; doubles
    /// on each further retry.
    pub retry_delay_ms: u64,
    /// Wait before the first retry after a rate limit (HTTP 429), ms;
    /// doubles on each further retry.
    pub rate_limit_delay_ms: u64,
    /// Runs a meeting gets. While pieces still fail transiently after
    /// their retries, a run before this one does not write the meeting and
    /// the next run sends only those pieces again (finished ones come from
    /// the ledger); this run writes it with the failures marked.
    pub max_runs: u32,
}

impl Default for SttPolicy {
    fn default() -> Self {
        Self {
            retries: 3,
            retry_delay_ms: 500,
            rate_limit_delay_ms: 5_000,
            max_runs: 3,
        }
    }
}

/// Knobs for one run.
#[derive(Debug, Clone)]
pub struct MinutesSettings {
    /// How speech spans become pieces.
    pub segment_plan: SegmentPlan,
    /// How transcription failures are handled.
    pub stt: SttPolicy,
    /// Settings version for ledger keys: anything that changes how pieces
    /// are cut (segment plan, VAD model and settings) must change it.
    pub ledger_version: String,
    /// Object key the mixed audio will be stored under.
    pub audio_key: String,
    /// When the mixed audio is written, UTC ms (for `audio.expires_at`).
    pub now_unix_ms: u64,
}

/// Why a run failed.
#[derive(Debug, thiserror::Error)]
pub enum MinutesError {
    /// The meeting has no sessions.
    #[error("meeting has no sessions")]
    Empty,
    /// libopus refused to create a decoder.
    #[error("opus: {0}")]
    Opus(#[from] opus::Error),
    /// Speech detection failed.
    #[error(transparent)]
    Vad(#[from] VadError),
    /// Audio could not be resampled.
    #[error(transparent)]
    Resample(#[from] crate::audio::ResampleError),
    /// The transcriber refused credentials or ran out of quota; nothing
    /// was written and nothing more should be sent. Outcomes paid for so
    /// far are in the ledger.
    #[error("transcription stopped: {0}")]
    SttStopped(SttErrorKind),
    /// Some pieces still failed transiently after their retries; nothing
    /// was written so the next run sends just those pieces again.
    #[error(
        "{failed} of {pieces} pieces failed transiently on run {run} of {max_runs}; retry later"
    )]
    SttRetryLater {
        /// Pieces still failing.
        failed: usize,
        /// All pieces.
        pieces: usize,
        /// This run's number.
        run: u32,
        /// Runs a meeting gets.
        max_runs: u32,
    },
    /// The ledger could not be read or written.
    #[error("stt ledger: {0}")]
    Ledger(#[from] std::io::Error),
}

impl MinutesError {
    /// Whether the whole run should stop (later meetings would fail the
    /// same way), not just this meeting.
    pub fn stops_the_run(&self) -> bool {
        matches!(self, Self::SttStopped(_))
    }
}

/// What happened to one person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpeakerReport {
    /// Hex pubkey.
    pub pubkey: String,
    /// Frames routed to this person.
    pub frames: usize,
    /// Decode counters.
    pub decode: DecodeStats,
    /// Stretches with frames that speech detection ran on.
    pub sounding_regions: usize,
    /// Raw speech spans the detector found.
    pub speech_spans: usize,
    /// Pieces sent to the transcriber.
    pub segments: usize,
    /// Pieces the transcriber failed on.
    pub stt_failures: usize,
}

/// Counters for the whole run (no audio, no text, no keys).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunReport {
    /// Frame routing counters.
    pub demux: DemuxStats,
    /// Per-person counters.
    pub speakers: Vec<SpeakerReport>,
    /// What is known to be missing (also in the script).
    pub losses: crate::transcript::Losses,
    /// Unreadable sessions of this channel that no meeting's time covers.
    pub unplaced_sessions_in_channel: u64,
    /// This run's number for the meeting (1 for the first).
    pub run: u32,
    /// Ledger lines that could not be read back (a torn write).
    pub ledger_unreadable_lines: u64,
    /// Requests sent to the transcriber (retries included).
    pub stt_requests: u64,
    /// Pieces taken from the ledger instead of being sent again.
    pub stt_reused: u64,
    /// Retries after transient or rate-limit failures.
    pub stt_retries: u64,
    /// Pieces given up on, by failure kind.
    pub stt_failures_by_kind: Vec<(SttErrorKind, u64)>,
}

/// Script, mixed audio and counters.
#[derive(Debug, Clone)]
pub struct MinutesOutput {
    /// The `huddle-transcript/1` script.
    pub transcript: Transcript,
    /// The mixed audio file (WAV bytes).
    pub mixed_audio: Vec<u8>,
    /// Counters.
    pub report: RunReport,
}

/// Run steps 2–6 on a gathered meeting. `ledger` holds the meeting's
/// earlier transcription outcomes (see [`crate::ledger`]); every outcome of
/// this run is added to it as it happens, also when the run stops early.
pub async fn build_minutes<D, T>(
    meeting: &Meeting,
    detector: &mut D,
    stt: &T,
    ledger: &mut SttLedger,
    settings: &MinutesSettings,
) -> Result<MinutesOutput, MinutesError>
where
    D: SpeechDetector,
    T: SpeechToText,
{
    if meeting.sessions.is_empty() {
        return Err(MinutesError::Empty);
    }
    let started_at = meeting.started_at_unix_ms();
    let ended_at = meeting.ended_at_unix_ms().max(started_at);
    let duration_ms = ended_at - started_at;

    let routed = demux(meeting);
    let mut mixer = Mixer::new(MIX_SAMPLE_RATE, duration_ms);
    let mut participants = Vec::with_capacity(routed.speakers.len());
    let mut segments = Vec::new();
    let mut speakers = Vec::with_capacity(routed.speakers.len());
    let mut stt_info = stt.info();
    stt_info.billed_seconds = 0;
    // This run counts only once it has gone through transcription.
    let run = ledger.runs() + 1;
    let mut stt_requests = 0u64;
    let mut stt_reused = 0u64;
    let mut transient_failed = 0usize;
    let mut stt_retries = 0u64;
    let mut failures_by_kind: std::collections::BTreeMap<SttErrorKind, u64> =
        std::collections::BTreeMap::new();

    for person in &routed.speakers {
        let mut report = SpeakerReport {
            pubkey: person.pubkey.clone(),
            frames: person.frame_count(),
            decode: DecodeStats::default(),
            sounding_regions: 0,
            speech_spans: 0,
            segments: 0,
            stt_failures: 0,
        };
        let mut speech_ms = 0;
        if person.frame_count() > 0 {
            let mut track = person.decode()?;
            let frame_digests = std::mem::take(&mut track.frame_digests);
            report.decode = track.stats.clone();
            let regions = track.sounding_regions(REGION_GAP_MS);
            let track_start_ms = track.start_ms;
            let pcm = resample(&track.pcm, SAMPLE_RATE, VAD_SAMPLE_RATE)?;
            // The 48 kHz copy is not needed past this point.
            drop(track);
            mixer.add(track_start_ms, &pcm);

            // Detect per sounding region, never across a stretch with no frames.
            let mut spans = Vec::new();
            report.sounding_regions = regions.len();
            for (from, to) in regions {
                let a = ms_to_samples(from - track_start_ms).min(pcm.len());
                let b = ms_to_samples(to - track_start_ms).min(pcm.len());
                for span in detector.detect(&pcm[a..b])? {
                    spans.push(SpeechSpan {
                        start: a + span.start,
                        end: a + span.end,
                    });
                }
            }
            report.speech_spans = spans.len();
            speech_ms = spans
                .iter()
                .map(|span| samples_to_ms(span.len()))
                .sum::<u64>();
            let pieces = plan_segments(
                &spans,
                VAD_SAMPLE_RATE,
                pcm.len(),
                &settings.segment_plan,
                |unit| {
                    let inner = detector.detect_pauses(&pcm[unit.start..unit.end])?;
                    Ok(inner
                        .into_iter()
                        .map(|span| SpeechSpan {
                            start: unit.start + span.start,
                            end: unit.start + span.end,
                        })
                        .collect())
                },
            )?;
            report.segments = pieces.len();
            // One piece = one request. The script gets the speech times; the
            // transcriber gets the padded audio.
            for piece in pieces {
                // Script times end with the meeting; a frame stamped past
                // the end cannot stretch it.
                let end_ms = (track_start_ms + samples_to_ms(piece.speech.end)).min(duration_ms);
                let start_ms = (track_start_ms + samples_to_ms(piece.speech.start)).min(end_ms);
                let request = SttRequest {
                    speaker: &person.pubkey,
                    start_ms: track_start_ms + samples_to_ms(piece.audio.start),
                    end_ms: track_start_ms + samples_to_ms(piece.audio.end),
                    pcm_16k: &pcm[piece.audio.start..piece.audio.end],
                };
                let first = frame_digests.partition_point(|(t, _)| *t < request.start_ms);
                let last = frame_digests.partition_point(|(t, _)| *t < request.end_ms);
                let key = piece_key(
                    &settings.ledger_version,
                    &person.pubkey,
                    request.start_ms,
                    request.end_ms,
                    &frame_digests[first..last],
                );
                // Finished on an earlier run: never sent (or paid for) again.
                let known = ledger.outcome(&key).cloned();
                let text = match known {
                    Some(Outcome::Done {
                        text,
                        billed_seconds,
                    }) => {
                        stt_reused += 1;
                        stt_info.billed_seconds += billed_seconds;
                        text
                    }
                    Some(Outcome::Rejected { .. }) => {
                        stt_reused += 1;
                        report.stt_failures += 1;
                        *failures_by_kind.entry(SttErrorKind::Rejected).or_default() += 1;
                        FAILED_TEXT.to_string()
                    }
                    None => {
                        let mut retries_left = settings.stt.retries;
                        let mut transient_wait = settings.stt.retry_delay_ms;
                        let mut rate_limit_wait = settings.stt.rate_limit_delay_ms;
                        loop {
                            stt_requests += 1;
                            match stt.transcribe(request).await {
                                Ok(output) => {
                                    stt_info.billed_seconds += output.billed_seconds;
                                    ledger.record(
                                        &key,
                                        Outcome::Done {
                                            text: output.text.clone(),
                                            billed_seconds: output.billed_seconds,
                                        },
                                    )?;
                                    break output.text;
                                }
                                Err(error) => match error.kind {
                                    SttErrorKind::Auth | SttErrorKind::Quota => {
                                        return Err(MinutesError::SttStopped(error.kind));
                                    }
                                    SttErrorKind::Rejected => {
                                        ledger
                                            .record(&key, Outcome::Rejected { code: error.code })?;
                                        report.stt_failures += 1;
                                        *failures_by_kind
                                            .entry(SttErrorKind::Rejected)
                                            .or_default() += 1;
                                        break FAILED_TEXT.to_string();
                                    }
                                    kind if retries_left > 0 => {
                                        retries_left -= 1;
                                        stt_retries += 1;
                                        let wait = if kind == SttErrorKind::RateLimited {
                                            &mut rate_limit_wait
                                        } else {
                                            &mut transient_wait
                                        };
                                        if *wait > 0 {
                                            tokio::time::sleep(std::time::Duration::from_millis(
                                                *wait,
                                            ))
                                            .await;
                                        }
                                        *wait = wait.saturating_mul(2);
                                    }
                                    kind => {
                                        // Not recorded: the next run sends it again.
                                        transient_failed += 1;
                                        report.stt_failures += 1;
                                        *failures_by_kind.entry(kind).or_default() += 1;
                                        break FAILED_TEXT.to_string();
                                    }
                                },
                            }
                        }
                    }
                };
                segments.push(Segment {
                    start_ms,
                    end_ms,
                    speaker: person.pubkey.clone(),
                    text,
                });
            }
        }
        participants.push(Participant {
            pubkey: person.pubkey.clone(),
            speech_ms,
        });
        speakers.push(report);
    }
    segments.sort_by(|a, b| (a.start_ms, &a.speaker).cmp(&(b.start_ms, &b.speaker)));

    ledger.finish_run(run)?;
    // Refused pieces never hold a meeting back. Transient ones do, until
    // the meeting's last run.
    if transient_failed > 0 && run < settings.stt.max_runs {
        return Err(MinutesError::SttRetryLater {
            failed: transient_failed,
            pieces: segments.len(),
            run,
            max_runs: settings.stt.max_runs,
        });
    }
    let failed: usize = speakers.iter().map(|s| s.stt_failures).sum();
    let mut losses = meeting.losses();
    losses.failed_segments = failed as u64;

    let expires_at = settings.now_unix_ms + RECORDING_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
    let transcript = Transcript {
        format: TRANSCRIPT_FORMAT.into(),
        community_id: meeting.community_id,
        channel_id: meeting.channel_id,
        parent_channel_id: meeting.parent_channel_id,
        session_ids: meeting.sessions.iter().map(|s| s.session_id).collect(),
        started_at: format_utc_millis(started_at),
        ended_at: format_utc_millis(ended_at),
        duration_ms,
        participants,
        segments,
        audio: AudioRef {
            key: settings.audio_key.clone(),
            expires_at: format_utc_millis(expires_at),
        },
        stt: stt_info,
        losses: losses.clone(),
    };
    // The mix ends with the meeting too.
    let mixed = mixer.samples();
    let keep = usize::try_from(duration_ms * u64::from(MIX_SAMPLE_RATE) / 1_000)
        .unwrap_or(usize::MAX)
        .min(mixed.len());
    Ok(MinutesOutput {
        transcript,
        mixed_audio: write_wav_mono_i16(mixer.sample_rate(), &mixed[..keep]),
        report: RunReport {
            demux: routed.stats,
            speakers,
            losses,
            unplaced_sessions_in_channel: meeting.unplaced_in_channel.len() as u64,
            run,
            ledger_unreadable_lines: ledger.unreadable_lines(),
            stt_requests,
            stt_reused,
            stt_retries,
            stt_failures_by_kind: failures_by_kind.into_iter().collect(),
        },
    })
}

fn ms_to_samples(ms: u64) -> usize {
    usize::try_from(ms * u64::from(VAD_SAMPLE_RATE) / 1_000).unwrap_or(usize::MAX)
}

fn samples_to_ms(samples: usize) -> u64 {
    samples as u64 * 1_000 / u64::from(VAD_SAMPLE_RATE)
}

/// Where the mixed audio of a meeting goes in the recording bucket:
/// `{prefix}/{community_id}/{channel_id}/mixed/{first_session_id}.wav`.
/// It sits beside the session folders (the bucket's 15-day rule covers it)
/// and is keyed by the first session so a rerun overwrites, not duplicates.
pub fn mixed_audio_key(prefix: &str, meeting: &Meeting) -> String {
    let first = meeting
        .sessions
        .first()
        .map(|session| session.session_id.to_string())
        .unwrap_or_default();
    format!(
        "{prefix}/{}/{}/mixed/{first}.{MIX_EXTENSION}",
        meeting.community_id, meeting.channel_id
    )
}
