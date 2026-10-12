//! `huddle-transcript/1`, field for field as in
//! `docs/huddle-minutes-worker.md`.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Value of [`Transcript::format`].
pub const TRANSCRIPT_FORMAT: &str = "huddle-transcript/1";

/// One meeting's script.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Transcript {
    /// Always [`TRANSCRIPT_FORMAT`].
    pub format: String,
    /// Community of the huddle.
    pub community_id: Uuid,
    /// Huddle channel.
    pub channel_id: Uuid,
    /// Parent channel, when a manifest named one.
    pub parent_channel_id: Option<Uuid>,
    /// Recording sessions joined into this meeting, earliest first.
    pub session_ids: Vec<Uuid>,
    /// First session start, UTC.
    pub started_at: String,
    /// Last session end, UTC.
    pub ended_at: String,
    /// `ended_at - started_at`.
    pub duration_ms: u64,
    /// Everyone who was in the room, in order of first appearance.
    pub participants: Vec<Participant>,
    /// Speech pieces in start order.
    pub segments: Vec<Segment>,
    /// The mixed playback audio.
    pub audio: AudioRef,
    /// Which transcriber ran.
    pub stt: SttInfo,
}

/// One person in the meeting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Participant {
    /// Hex x-only pubkey.
    pub pubkey: String,
    /// Total detected speech, ms.
    pub speech_ms: u64,
}

/// One transcribed speech piece. Times are ms from the meeting start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Segment {
    /// Start, ms from the meeting start.
    pub start_ms: u64,
    /// End, ms from the meeting start.
    pub end_ms: u64,
    /// Hex x-only pubkey of the speaker.
    pub speaker: String,
    /// Transcribed text, or [`crate::stt::FAILED_TEXT`].
    pub text: String,
}

/// Where the mixed audio is stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioRef {
    /// Object key of the mixed audio.
    pub key: String,
    /// When the recording bucket's lifecycle rule deletes it, UTC.
    pub expires_at: String,
}

/// Transcriber identity and billing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SttInfo {
    /// Engine name, e.g. `google-chirp_3`.
    pub engine: String,
    /// Processing region.
    pub region: String,
    /// Language code.
    pub language: String,
    /// Seconds the engine billed for.
    pub billed_seconds: u64,
}
