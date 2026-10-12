//! Steps 2–6 for one gathered meeting: rebuild each person, find speech,
//! transcribe, write the script, mix the playback audio.
//!
//! People are handled one at a time and each person's 48 kHz track is
//! dropped after it is added to the mix, so memory grows with the meeting
//! length, not with the number of people.

use buzz_huddle_recording::format_utc_millis;

use crate::audio::{resample, write_wav_mono_i16, Mixer};
use crate::collect::Meeting;
use crate::stt::{SpeechToText, SttRequest, FAILED_TEXT};
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

/// Knobs for one run.
#[derive(Debug, Clone)]
pub struct MinutesSettings {
    /// How speech spans become pieces.
    pub segment_plan: SegmentPlan,
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

/// Run steps 2–6 on a gathered meeting.
pub async fn build_minutes<D, T>(
    meeting: &Meeting,
    detector: &mut D,
    stt: &T,
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
            let track = person.decode()?;
            report.decode = track.stats.clone();
            let regions = track.sounding_regions(REGION_GAP_MS);
            let track_start_ms = track.start_ms;
            let pcm = resample(&track.pcm, SAMPLE_RATE, VAD_SAMPLE_RATE);
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
                let start_ms = track_start_ms + samples_to_ms(piece.speech.start);
                let end_ms = track_start_ms + samples_to_ms(piece.speech.end);
                let request = SttRequest {
                    speaker: &person.pubkey,
                    start_ms: track_start_ms + samples_to_ms(piece.audio.start),
                    end_ms: track_start_ms + samples_to_ms(piece.audio.end),
                    pcm_16k: &pcm[piece.audio.start..piece.audio.end],
                };
                let text = match stt.transcribe(request).await {
                    Ok(output) => {
                        stt_info.billed_seconds += output.billed_seconds;
                        output.text
                    }
                    Err(_) => {
                        report.stt_failures += 1;
                        FAILED_TEXT.to_string()
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
    };
    Ok(MinutesOutput {
        transcript,
        mixed_audio: write_wav_mono_i16(mixer.sample_rate(), mixer.samples()),
        report: RunReport {
            demux: routed.stats,
            speakers,
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
