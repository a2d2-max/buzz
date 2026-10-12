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
    /// What is known to be missing from this script. Read as all zero from
    /// a script written before this field existed.
    #[serde(default)]
    pub losses: Losses,
}

/// What is known to be missing from a meeting's recording or script.
/// Counts only, so a hole never goes unnoticed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Losses {
    /// Chunks the recorder could not upload (`lost_chunks` in manifests).
    pub lost_chunks: u64,
    /// Chunks that should be in storage but are not: listed in a manifest
    /// but absent, or (no manifest) numbers missing from 0 to the last one.
    pub missing_chunks: u64,
    /// Chunks present but unreadable (bad header, wrong session or number)
    /// in sessions that were otherwise read.
    pub unreadable_chunks: u64,
    /// Manifests that could not be read; their sessions were used as
    /// chunk-only sessions.
    pub unreadable_manifests: u64,
    /// Sessions with nothing readable at all (placed in this meeting by
    /// their write time); their chunks are not counted again above.
    pub unreadable_sessions: u64,
    /// Frames the recorder dropped because its queue was full.
    pub dropped_frames: u64,
    /// Pieces left as "받아쓰기 실패".
    pub failed_segments: u64,
}

impl Losses {
    /// Add `other` into `self`.
    pub fn add(&mut self, other: &Losses) {
        self.lost_chunks += other.lost_chunks;
        self.missing_chunks += other.missing_chunks;
        self.unreadable_chunks += other.unreadable_chunks;
        self.unreadable_manifests += other.unreadable_manifests;
        self.unreadable_sessions += other.unreadable_sessions;
        self.dropped_frames += other.dropped_frames;
        self.failed_segments += other.failed_segments;
    }
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
