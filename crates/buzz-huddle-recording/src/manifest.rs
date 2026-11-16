//! `manifest.json`: the index of one recording session, written last.
//!
//! Its presence means the session is finished. Field names and order follow
//! `docs/huddle-recording.md`.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Why a recording session ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    /// The last participant left the room.
    RoomEmpty,
    /// The relay was shutting down (SIGTERM).
    Shutdown,
    /// The session hit the maximum length and continued in a new session.
    MaxDuration,
}

/// One uploaded chunk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestChunk {
    /// Chunk sequence number inside the session.
    pub seq: u32,
    /// Object key of the chunk.
    pub key: String,
    /// Object size in bytes, header included.
    pub bytes: u64,
    /// Number of records in the chunk.
    pub records: u64,
    /// `t_ms` of the first record.
    pub first_t_ms: u32,
    /// `t_ms` of the last record.
    pub last_t_ms: u32,
}

/// One presence interval of one participant. Someone who joins twice has two
/// entries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestParticipant {
    /// Hex x-only pubkey.
    pub pubkey: String,
    /// Routing index during this interval.
    pub peer_index: u8,
    /// Per-index occupancy epoch during this interval.
    pub epoch: u8,
    /// Join time, ms since session start.
    pub joined_t_ms: u32,
    /// Leave time, ms since session start. A participant still present when
    /// the session ends gets the session's end time.
    pub left_t_ms: u32,
}

/// The session index object (`manifest.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    /// Always [`crate::FORMAT`].
    pub format: String,
    /// Community the huddle belongs to.
    pub community_id: Uuid,
    /// Huddle backing channel (ephemeral channel) UUID.
    pub channel_id: Uuid,
    /// Parent channel the relay verified with kind:48100 at join, or `null`.
    pub parent_channel_id: Option<Uuid>,
    /// Recording session id.
    pub session_id: Uuid,
    /// Session start, UTC (`2026-10-12T05:00:00.000Z`).
    pub started_at: String,
    /// Session end, UTC; always `started_at + duration_ms`.
    pub ended_at: String,
    /// Session length in ms on the relay's monotonic clock.
    pub duration_ms: u64,
    /// Huddle audio protocol version of the room; `0` when unknown.
    pub protocol_version: u8,
    /// Why the session ended.
    pub end_reason: EndReason,
    /// Uploaded chunks, ordered by `seq`. Chunks that failed to upload are
    /// missing here and counted in `lost_chunks`.
    pub chunks: Vec<ManifestChunk>,
    /// Presence intervals in join order.
    pub participants: Vec<ManifestParticipant>,
    /// Frames the relay dropped because the recorder queue was full.
    pub dropped_frames: u64,
    /// Chunks that could not be uploaded after retries.
    pub lost_chunks: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pins the JSON field names and value shapes the minutes worker reads.
    #[test]
    fn manifest_json_shape_matches_the_contract() {
        let manifest = Manifest {
            format: crate::FORMAT.to_string(),
            community_id: Uuid::from_u128(1),
            channel_id: Uuid::from_u128(2),
            parent_channel_id: None,
            session_id: Uuid::from_u128(3),
            started_at: "2026-10-12T05:00:00.000Z".into(),
            ended_at: "2026-10-12T05:42:10.120Z".into(),
            duration_ms: 2_530_120,
            protocol_version: 2,
            end_reason: EndReason::RoomEmpty,
            chunks: vec![ManifestChunk {
                seq: 0,
                key: "k/chunk-000000.bhr".into(),
                bytes: 123_456,
                records: 4321,
                first_t_ms: 0,
                last_t_ms: 29_980,
            }],
            participants: vec![ManifestParticipant {
                pubkey: "ab".repeat(32),
                peer_index: 0,
                epoch: 1,
                joined_t_ms: 0,
                left_t_ms: 2_530_000,
            }],
            dropped_frames: 0,
            lost_chunks: 0,
        };
        let value = serde_json::to_value(&manifest).expect("serialize");
        assert_eq!(
            value,
            serde_json::json!({
                "format": "buzz-huddle-recording/1",
                "community_id": Uuid::from_u128(1).to_string(),
                "channel_id": Uuid::from_u128(2).to_string(),
                "parent_channel_id": null,
                "session_id": Uuid::from_u128(3).to_string(),
                "started_at": "2026-10-12T05:00:00.000Z",
                "ended_at": "2026-10-12T05:42:10.120Z",
                "duration_ms": 2_530_120,
                "protocol_version": 2,
                "end_reason": "room_empty",
                "chunks": [{
                    "seq": 0, "key": "k/chunk-000000.bhr", "bytes": 123_456,
                    "records": 4321, "first_t_ms": 0, "last_t_ms": 29_980
                }],
                "participants": [{
                    "pubkey": "ab".repeat(32), "peer_index": 0, "epoch": 1,
                    "joined_t_ms": 0, "left_t_ms": 2_530_000
                }],
                "dropped_frames": 0,
                "lost_chunks": 0
            })
        );
        let back: Manifest = serde_json::from_value(value).expect("deserialize");
        assert_eq!(back, manifest);
    }

    #[test]
    fn end_reasons_use_snake_case() {
        for (reason, text) in [
            (EndReason::RoomEmpty, "\"room_empty\""),
            (EndReason::Shutdown, "\"shutdown\""),
            (EndReason::MaxDuration, "\"max_duration\""),
        ] {
            assert_eq!(serde_json::to_string(&reason).expect("serialize"), text);
        }
    }
}
