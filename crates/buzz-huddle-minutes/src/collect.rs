//! Gather a huddle's recording sessions into meetings (step 1 of the worker).
//!
//! A meeting can be split into several sessions — mesh owner change, relay
//! rollout, the 6-hour cap — and one channel can hold several meetings. Each
//! session folder holds `chunk-{seq:06}.bhr` objects and, once finished,
//! `manifest.json`. A session whose pod died has chunks only.

use std::collections::BTreeMap;

use buzz_huddle_recording::{decode_chunk, ChunkHeader, Manifest, FORMAT};
use uuid::Uuid;

use crate::store::{RecordingStore, StoreError};

/// One chunk object, loaded.
#[derive(Debug, Clone)]
pub struct LoadedChunk {
    /// Header fields of the chunk.
    pub header: ChunkHeader,
    /// The whole object, header included.
    pub bytes: Vec<u8>,
}

/// One recording session, loaded.
#[derive(Debug, Clone)]
pub struct SessionRecording {
    /// Session id (the folder name).
    pub session_id: Uuid,
    /// Wall-clock session start, UTC ms.
    pub started_at_unix_ms: u64,
    /// Session length in ms: the manifest's `duration_ms`, or for a
    /// chunk-only session the last readable record's `t_ms`.
    pub duration_ms: u64,
    /// Huddle protocol version from the chunk headers (`0` when unknown).
    pub protocol_version: u8,
    /// The manifest, when the relay finished the session.
    pub manifest: Option<Manifest>,
    /// Readable chunks in `seq` order.
    pub chunks: Vec<LoadedChunk>,
    /// What is missing or was skipped.
    pub losses: Losses,
    /// Newest write time among this session's objects, UTC ms.
    pub last_modified_unix_ms: u64,
}

impl SessionRecording {
    /// Session end, UTC ms.
    pub fn ended_at_unix_ms(&self) -> u64 {
        self.started_at_unix_ms + self.duration_ms
    }
}

/// Recording that is known to be missing. Counts only, so a gap of audio
/// never goes unnoticed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Losses {
    /// `lost_chunks` from the manifests (uploads that failed).
    pub lost_chunks: u64,
    /// `dropped_frames` from the manifests (recorder queue full).
    pub dropped_frames: u64,
    /// Chunk numbers missing between the first and last chunk found.
    pub missing_chunk_numbers: u64,
    /// Chunks skipped because their header was unreadable or wrong.
    pub unreadable_chunks: u64,
}

impl Losses {
    fn add(&mut self, other: &Losses) {
        self.lost_chunks += other.lost_chunks;
        self.dropped_frames += other.dropped_frames;
        self.missing_chunk_numbers += other.missing_chunk_numbers;
        self.unreadable_chunks += other.unreadable_chunks;
    }
}

/// One meeting: sessions of one huddle that follow each other closely, in
/// `started_at` order.
#[derive(Debug, Clone)]
pub struct Meeting {
    /// Community id from the storage path.
    pub community_id: Uuid,
    /// Huddle channel id.
    pub channel_id: Uuid,
    /// First non-null `parent_channel_id` among the manifests.
    pub parent_channel_id: Option<Uuid>,
    /// Sessions, earliest first.
    pub sessions: Vec<SessionRecording>,
}

impl Meeting {
    /// Meeting start (first session start), UTC ms.
    pub fn started_at_unix_ms(&self) -> u64 {
        self.sessions
            .first()
            .map_or(0, |session| session.started_at_unix_ms)
    }

    /// Meeting end (latest session end), UTC ms.
    pub fn ended_at_unix_ms(&self) -> u64 {
        self.sessions
            .iter()
            .map(SessionRecording::ended_at_unix_ms)
            .max()
            .unwrap_or(0)
    }

    /// Newest object write time in the meeting, UTC ms.
    pub fn last_modified_unix_ms(&self) -> u64 {
        self.sessions
            .iter()
            .map(|session| session.last_modified_unix_ms)
            .max()
            .unwrap_or(0)
    }

    /// The first-cut "meeting is over" rule from the design: nothing new was
    /// written for this meeting for `quiet_ms`. That covers both "no new
    /// session after the last manifest" and "a manifest-less session whose
    /// last chunk is old". While anyone is in the room the recorder writes an
    /// object at least every `CHUNK_SECS`, even when everyone is muted (a
    /// roster-only keepalive chunk), so `quiet_ms` (10 min) with no new object
    /// means the room is empty or its pod died, not that everyone is muted.
    pub fn is_quiet(&self, now_unix_ms: u64, quiet_ms: u64) -> bool {
        now_unix_ms.saturating_sub(self.last_modified_unix_ms()) >= quiet_ms
    }

    /// Everything known to be missing, over all sessions.
    pub fn losses(&self) -> Losses {
        let mut total = Losses::default();
        for session in &self.sessions {
            total.add(&session.losses);
        }
        total
    }
}

/// Why a huddle could not be gathered.
#[derive(Debug, thiserror::Error)]
pub enum CollectError {
    /// The store failed.
    #[error(transparent)]
    Store(#[from] StoreError),
    /// No session folder under the huddle.
    #[error("no recording sessions under {0}")]
    NoSessions(String),
    /// A manifest is not valid JSON or has another format.
    #[error("session {session_id}: bad manifest: {reason}")]
    BadManifest {
        /// Session folder.
        session_id: Uuid,
        /// What was wrong.
        reason: String,
    },
}

#[derive(Default)]
struct SessionObjects {
    chunk_keys: BTreeMap<u32, String>,
    manifest_key: Option<String>,
    last_modified_unix_ms: u64,
}

/// Load every session stored under `{prefix}/{community_id}/{channel_id}/`
/// and group them into meetings: a session that starts more than `gap_ms`
/// after everything before it has ended begins a new meeting (the design's
/// 10-minute rule; one channel can hold many meetings within the bucket's 15
/// days). Folders that are not session UUIDs and files that are neither
/// chunks nor a manifest are ignored (the mixed audio lives beside the
/// sessions). An unreadable chunk is skipped and counted, not fatal.
pub async fn collect_meetings<S: RecordingStore>(
    store: &S,
    prefix: &str,
    community_id: Uuid,
    channel_id: Uuid,
    gap_ms: u64,
) -> Result<Vec<Meeting>, CollectError> {
    let base = format!("{prefix}/{community_id}/{channel_id}/");
    let mut by_session: BTreeMap<Uuid, SessionObjects> = BTreeMap::new();
    for object in store.list(&base).await? {
        let rest = &object.key[base.len()..];
        let Some((folder, name)) = rest.split_once('/') else {
            continue;
        };
        let Ok(session_id) = Uuid::parse_str(folder) else {
            continue;
        };
        let entry = by_session.entry(session_id).or_default();
        if name == "manifest.json" {
            entry.manifest_key = Some(object.key.clone());
        } else if let Some(seq) = chunk_seq(name) {
            entry.chunk_keys.insert(seq, object.key.clone());
        } else {
            continue;
        }
        entry.last_modified_unix_ms = entry.last_modified_unix_ms.max(object.modified_unix_ms);
    }
    if by_session.is_empty() {
        return Err(CollectError::NoSessions(base));
    }

    let mut sessions = Vec::with_capacity(by_session.len());
    for (session_id, objects) in by_session {
        if let Some(session) = load_session(store, session_id, &objects).await? {
            sessions.push(session);
        }
    }
    sessions.sort_by_key(|session| (session.started_at_unix_ms, session.session_id));

    let mut meetings: Vec<Meeting> = Vec::new();
    let mut ended = 0u64;
    for session in sessions {
        let starts_new = meetings.is_empty() || session.started_at_unix_ms > ended + gap_ms;
        if starts_new {
            ended = 0;
            meetings.push(Meeting {
                community_id,
                channel_id,
                parent_channel_id: None,
                sessions: Vec::new(),
            });
        }
        ended = ended.max(session.ended_at_unix_ms());
        if let Some(meeting) = meetings.last_mut() {
            if meeting.parent_channel_id.is_none() {
                meeting.parent_channel_id =
                    session.manifest.as_ref().and_then(|m| m.parent_channel_id);
            }
            meeting.sessions.push(session);
        }
    }
    Ok(meetings)
}

async fn load_session<S: RecordingStore>(
    store: &S,
    session_id: Uuid,
    objects: &SessionObjects,
) -> Result<Option<SessionRecording>, CollectError> {
    let manifest = match &objects.manifest_key {
        Some(key) => Some(load_manifest(store, key, session_id).await?),
        None => None,
    };
    let mut losses = Losses::default();
    if let Some(manifest) = &manifest {
        losses.lost_chunks = manifest.lost_chunks;
        losses.dropped_frames = manifest.dropped_frames;
    }
    if let (Some(first), Some(last)) = (
        objects.chunk_keys.keys().next(),
        objects.chunk_keys.keys().next_back(),
    ) {
        let expected = u64::from(last - first) + 1;
        losses.missing_chunk_numbers = expected - objects.chunk_keys.len() as u64;
    }
    let mut chunks = Vec::with_capacity(objects.chunk_keys.len());
    for (seq, key) in &objects.chunk_keys {
        let bytes = store.get(key).await?;
        match decode_chunk(&bytes) {
            Ok((header, _)) if header.session_id == session_id && header.chunk_seq == *seq => {
                chunks.push(LoadedChunk { header, bytes });
            }
            _ => losses.unreadable_chunks += 1,
        }
    }
    let started_at_unix_ms = match (&manifest, chunks.first()) {
        (Some(manifest), _) => {
            parse_utc_ms(&manifest.started_at).ok_or_else(|| CollectError::BadManifest {
                session_id,
                reason: format!(
                    "started_at {:?} is not a UTC timestamp",
                    manifest.started_at
                ),
            })?
        }
        (None, Some(chunk)) => chunk.header.session_start_unix_ms,
        (None, None) => return Ok(None),
    };
    let duration_ms = match &manifest {
        Some(manifest) => manifest.duration_ms,
        None => chunks
            .iter()
            .filter_map(|chunk| decode_chunk(&chunk.bytes).ok())
            .flat_map(|(_, records)| records.map_while(Result::ok))
            .map(|record| u64::from(record.t_ms()))
            .max()
            .unwrap_or(0),
    };
    let protocol_version = chunks
        .first()
        .map(|chunk| chunk.header.protocol_version)
        .or_else(|| manifest.as_ref().map(|m| m.protocol_version))
        .unwrap_or(0);
    Ok(Some(SessionRecording {
        session_id,
        started_at_unix_ms,
        duration_ms,
        protocol_version,
        manifest,
        chunks,
        losses,
        last_modified_unix_ms: objects.last_modified_unix_ms,
    }))
}

async fn load_manifest<S: RecordingStore>(
    store: &S,
    key: &str,
    session_id: Uuid,
) -> Result<Manifest, CollectError> {
    let bytes = store.get(key).await?;
    let manifest: Manifest =
        serde_json::from_slice(&bytes).map_err(|error| CollectError::BadManifest {
            session_id,
            reason: error.to_string(),
        })?;
    if manifest.format != FORMAT || manifest.session_id != session_id {
        return Err(CollectError::BadManifest {
            session_id,
            reason: format!(
                "format {:?} session {} (expected {FORMAT} {session_id})",
                manifest.format, manifest.session_id
            ),
        });
    }
    Ok(manifest)
}

fn chunk_seq(name: &str) -> Option<u32> {
    let digits = name.strip_prefix("chunk-")?.strip_suffix(".bhr")?;
    if digits.len() < 6 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// Parse a manifest timestamp (`2026-10-12T05:00:00.000Z`) into UTC ms.
pub fn parse_utc_ms(text: &str) -> Option<u64> {
    let parsed = chrono::DateTime::parse_from_rfc3339(text).ok()?;
    u64::try_from(parsed.timestamp_millis()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::store::LocalStore;
    use buzz_huddle_recording::{chunk_key, Record};

    fn chunk(session: Uuid, seq: u32, start_unix_ms: u64, last_t_ms: u32) -> Vec<u8> {
        let mut bytes = ChunkHeader {
            protocol_version: 2,
            session_id: session,
            chunk_seq: seq,
            session_start_unix_ms: start_unix_ms,
        }
        .encode()
        .to_vec();
        for t_ms in [0, last_t_ms] {
            Record::Join {
                t_ms,
                peer_index: 0,
                epoch: 1,
                pubkey: [7; 32],
            }
            .encode_into(&mut bytes)
            .expect("record");
        }
        bytes
    }

    #[tokio::test]
    async fn sessions_far_apart_are_separate_meetings_and_bad_chunks_are_counted() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = LocalStore::new(dir.path());
        let (community, channel) = (Uuid::from_u128(1), Uuid::from_u128(2));
        let day = 86_400_000;
        let monday = 1_791_781_200_000;
        // Monday: two sessions 2 minutes apart (one meeting, chunk 1 lost).
        // Wednesday: one session, one chunk unreadable.
        let sessions = [
            (Uuid::from_u128(10), monday, vec![0u32, 2]),
            (Uuid::from_u128(11), monday + 62_000, vec![0]),
            (Uuid::from_u128(12), monday + 2 * day, vec![0, 1]),
        ];
        for (session, start, seqs) in &sessions {
            for &seq in seqs {
                let key = chunk_key("h", community, channel, *session, seq);
                store
                    .put(&key, chunk(*session, seq, *start, 60_000))
                    .await
                    .expect("put");
            }
        }
        let broken = chunk_key("h", community, channel, Uuid::from_u128(12), 1);
        store
            .put(&broken, b"BHR1 broken".to_vec())
            .await
            .expect("put");

        let meetings = collect_meetings(&store, "h", community, channel, 10 * 60_000)
            .await
            .expect("collect");
        assert_eq!(meetings.len(), 2);
        let ids: Vec<Vec<u128>> = meetings
            .iter()
            .map(|m| m.sessions.iter().map(|s| s.session_id.as_u128()).collect())
            .collect();
        assert_eq!(ids, [vec![10, 11], vec![12]]);
        assert_eq!(meetings[0].losses().missing_chunk_numbers, 1);
        assert_eq!(meetings[0].ended_at_unix_ms(), monday + 62_000 + 60_000);
        assert_eq!(meetings[1].losses().unreadable_chunks, 1);
        assert_eq!(meetings[1].sessions[0].chunks.len(), 1);
    }

    #[test]
    fn chunk_names_follow_the_contract() {
        assert_eq!(chunk_seq("chunk-000000.bhr"), Some(0));
        assert_eq!(chunk_seq("chunk-000042.bhr"), Some(42));
        assert_eq!(chunk_seq("chunk-1234567.bhr"), Some(1_234_567));
        assert_eq!(chunk_seq("chunk-42.bhr"), None);
        assert_eq!(chunk_seq("chunk-00000a.bhr"), None);
        assert_eq!(chunk_seq("mixed.wav"), None);
    }

    #[test]
    fn timestamps_parse_to_utc_millis() {
        assert_eq!(
            parse_utc_ms("2026-10-12T05:00:00.120Z"),
            Some(1_791_781_200_120)
        );
        assert_eq!(parse_utc_ms("yesterday"), None);
    }
}
