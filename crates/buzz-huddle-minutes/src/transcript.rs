//! `huddle-transcript/2`, field for field as in
//! `docs/huddle-minutes-worker.md`. Scripts written as `huddle-transcript/1`
//! (one person per track, `speaker` = the track's pubkey) still read: their
//! lines get `device` = `speaker` and confidence 1.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Value of [`Transcript::format`].
pub const TRANSCRIPT_FORMAT: &str = "huddle-transcript/2";
/// The format before speakers were told apart inside a track.
pub const TRANSCRIPT_FORMAT_V1: &str = "huddle-transcript/1";

/// One meeting's script. `Default` is for tests that fill only a few
/// fields.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
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
///
/// 사람 식별은 하나로 통일한다: `speaker` 는 어느 경우든 그 사람의 pubkey 다.
/// - 자기 기기로 혼자 말한 트랙: `speaker` = 트랙 주인, `speaker_confidence` = 1.
/// - 회의실 마이크에 섞인 화자: `speaker_label` = "회의실 화자 N". 목소리로 맞으면
///   `speaker` = 그 사람, `speaker_confidence` = 코사인 유사도. 못 맞추면 `speaker` 와
///   `speaker_confidence` 는 null. 회의실 기기 주인이라고 그 pubkey 를 자동으로 주지 않는다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "SegmentWire")]
pub struct Segment {
    /// Start, ms from the meeting start.
    pub start_ms: u64,
    /// End, ms from the meeting start.
    pub end_ms: u64,
    /// Hex x-only pubkey of the track (device) the audio came from.
    pub device: String,
    /// Hex x-only pubkey of who spoke, or `None` when not known.
    pub speaker: Option<String>,
    /// "회의실 화자 N" for a speaker found inside a shared (room) track,
    /// numbered in order of first speech across the meeting; `None` for a
    /// track with one speaker.
    pub speaker_label: Option<String>,
    /// How sure `speaker` is: 1 for the owner of a one-speaker track, the
    /// voice similarity for a room speaker matched by voice, `None` when
    /// `speaker` is `None`.
    pub speaker_confidence: Option<f32>,
    /// Transcribed text, or [`crate::stt::FAILED_TEXT`].
    pub text: String,
}

/// `speaker_label` of a room line whose speaker cannot be told: nobody's,
/// not one person.
pub const UNPLACED_ROOM_SPEAKER: &str = "회의실 화자 ?";

impl Segment {
    /// One key per person: the pubkey when known, otherwise the room
    /// speaker's label ("회의실 화자 N"). `None` for a line nobody can place
    /// ([`UNPLACED_ROOM_SPEAKER`]) — never the device's owner.
    pub fn who(&self) -> Option<&str> {
        self.speaker.as_deref().or_else(|| {
            self.speaker_label
                .as_deref()
                .filter(|label| *label != UNPLACED_ROOM_SPEAKER)
        })
    }

    /// A line from a one-speaker track: the owner spoke, for sure.
    pub fn own(device: String, start_ms: u64, end_ms: u64, text: String) -> Self {
        Self {
            start_ms,
            end_ms,
            speaker: Some(device.clone()),
            device,
            speaker_label: None,
            speaker_confidence: Some(1.0),
            text,
        }
    }
}

/// A line as stored, old (`/1`) or new (`/2`).
#[derive(Deserialize)]
struct SegmentWire {
    start_ms: u64,
    end_ms: u64,
    #[serde(default)]
    device: Option<String>,
    #[serde(default)]
    speaker: Option<String>,
    #[serde(default)]
    speaker_label: Option<String>,
    #[serde(default)]
    speaker_confidence: Option<f32>,
    text: String,
}

impl TryFrom<SegmentWire> for Segment {
    type Error = &'static str;

    fn try_from(wire: SegmentWire) -> Result<Self, Self::Error> {
        match (wire.device, wire.speaker) {
            (Some(device), speaker) => Ok(Self {
                start_ms: wire.start_ms,
                end_ms: wire.end_ms,
                device,
                speaker,
                speaker_label: wire.speaker_label,
                speaker_confidence: wire.speaker_confidence,
                text: wire.text,
            }),
            // `/1`: the speaker was the track.
            (None, Some(speaker)) => Ok(Self::own(speaker, wire.start_ms, wire.end_ms, wire.text)),
            (None, None) => Err("a segment needs `device` or `speaker`"),
        }
    }
}

/// Where the mixed audio is stored.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioRef {
    /// Object key of the mixed audio.
    pub key: String,
    /// When the recording bucket's lifecycle rule deletes it, UTC.
    pub expires_at: String,
}

/// Transcriber identity and billing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_v1_script_still_reads_with_the_track_as_the_speaker() {
        let pubkey = "ab".repeat(32);
        let json = format!(
            r#"{{"format":"huddle-transcript/1","community_id":"00000000-0000-0000-0000-000000000001",
            "channel_id":"00000000-0000-0000-0000-000000000002","parent_channel_id":null,"session_ids":[],
            "started_at":"","ended_at":"","duration_ms":10,"participants":[],
            "segments":[{{"start_ms":1,"end_ms":2,"speaker":"{pubkey}","text":"네"}}],
            "audio":{{"key":"","expires_at":""}},
            "stt":{{"engine":"","region":"","language":"","billed_seconds":0}}}}"#
        );
        let transcript: Transcript = serde_json::from_str(&json).expect("v1 reads");
        assert_eq!(transcript.format, TRANSCRIPT_FORMAT_V1);
        let line = &transcript.segments[0];
        assert_eq!(line.device, pubkey);
        assert_eq!(line.speaker.as_deref(), Some(pubkey.as_str()));
        assert_eq!(line.speaker_label, None);
        assert_eq!(line.speaker_confidence, Some(1.0));
    }

    #[test]
    fn a_room_line_round_trips_with_nulls() {
        let line = Segment {
            start_ms: 5,
            end_ms: 9,
            device: "dd".repeat(32),
            speaker: None,
            speaker_label: Some("회의실 화자 2".into()),
            speaker_confidence: None,
            text: "말".into(),
        };
        let json = serde_json::to_value(&line).expect("json");
        assert_eq!(json["speaker"], serde_json::Value::Null);
        assert_eq!(json["speaker_confidence"], serde_json::Value::Null);
        assert_eq!(json["speaker_label"], "회의실 화자 2");
        let back: Segment = serde_json::from_value(json).expect("back");
        assert_eq!(back, line);
    }

    #[test]
    fn a_line_with_neither_device_nor_speaker_does_not_read() {
        let json = r#"{"start_ms":1,"end_ms":2,"text":"네"}"#;
        assert!(serde_json::from_str::<Segment>(json).is_err());
        let json = r#"{"start_ms":1,"end_ms":2,"speaker":null,"text":"네"}"#;
        assert!(serde_json::from_str::<Segment>(json).is_err());
    }
}
