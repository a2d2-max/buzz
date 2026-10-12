//! Gather a huddle's recording sessions into meetings (step 1 of the worker).
//!
//! A meeting can be split into several sessions — mesh owner change, relay
//! rollout, the 6-hour cap — and one channel can hold several meetings. Each
//! session folder holds `chunk-{seq:06}.bhr` objects and, once finished,
//! `manifest.json`. A session whose pod died has chunks only.

use std::collections::{BTreeMap, HashSet};

use buzz_huddle_recording::{decode_chunk, ChunkHeader, Manifest, FORMAT};
use uuid::Uuid;

use crate::store::{RecordingStore, StoreError};
pub use crate::transcript::Losses;

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
    /// Sessions of this meeting with nothing readable, placed here by
    /// their write time.
    pub unreadable_sessions: Vec<Uuid>,
    /// Sessions of the same channel with nothing readable that no meeting's
    /// time covers (the same list on every meeting of the channel).
    pub unplaced_in_channel: Vec<Uuid>,
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

    /// Why this meeting should be left alone this run, if it should.
    /// `processed` holds every session id already in a written script: any
    /// overlap means the meeting was processed. A meeting whose earliest
    /// session is over [`MAX_MEETING_AGE_MS`] old is not touched — the
    /// bucket's 15-day rule deletes the oldest sessions first, so it may be
    /// half gone.
    pub fn skip_reason(
        &self,
        processed: &HashSet<Uuid>,
        now_unix_ms: u64,
        quiet_ms: u64,
    ) -> Option<Skip> {
        if self
            .sessions
            .iter()
            .any(|session| processed.contains(&session.session_id))
        {
            Some(Skip::AlreadyProcessed)
        } else if now_unix_ms.saturating_sub(self.started_at_unix_ms()) > MAX_MEETING_AGE_MS {
            Some(Skip::TooOld)
        } else if !self.is_quiet(now_unix_ms, quiet_ms) {
            Some(Skip::MaybeLive)
        } else {
            None
        }
    }

    /// Everything known to be missing, over all sessions.
    pub fn losses(&self) -> Losses {
        let mut total = Losses {
            unreadable_sessions: self.unreadable_sessions.len() as u64,
            ..Losses::default()
        };
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
}

/// Meetings whose earliest session is older than this are not touched
/// (14 days; the bucket deletes after 15).
pub const MAX_MEETING_AGE_MS: u64 = 14 * 24 * 60 * 60 * 1_000;

/// Why a meeting is left alone this run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    /// One of its sessions is already in a written script.
    AlreadyProcessed,
    /// Its earliest session is over 14 days old.
    TooOld,
    /// Something was written less than the quiet time ago.
    MaybeLive,
}

impl Skip {
    /// Short name for logs.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AlreadyProcessed => "already processed",
            Self::TooOld => "older than 14 days",
            Self::MaybeLive => "may not be over",
        }
    }
}

/// Everything found under one huddle channel.
#[derive(Debug, Clone)]
pub struct Collected {
    /// Meetings, earliest first.
    pub meetings: Vec<Meeting>,
    /// Sessions with nothing readable that no meeting's time covers.
    pub unplaced_sessions: Vec<Uuid>,
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
/// sessions). Nothing broken is fatal: an unreadable chunk is skipped, an
/// unreadable manifest leaves a chunk-only session, a session with nothing
/// readable is placed by its write time — all counted in [`Losses`].
pub async fn collect_meetings<S: RecordingStore>(
    store: &S,
    prefix: &str,
    community_id: Uuid,
    channel_id: Uuid,
    gap_ms: u64,
) -> Result<Collected, CollectError> {
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
    let mut unreadable: Vec<(Uuid, u64)> = Vec::new();
    for (session_id, objects) in by_session {
        match load_session(store, session_id, &objects).await? {
            Some(session) => sessions.push(session),
            None => unreadable.push((session_id, objects.last_modified_unix_ms)),
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
                unreadable_sessions: Vec::new(),
                unplaced_in_channel: Vec::new(),
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

    // A session with nothing readable has no start time; its objects' write
    // time puts it in the meeting that was being recorded then.
    let mut unplaced_sessions = Vec::new();
    for (session_id, written) in unreadable {
        let home = meetings.iter_mut().find(|meeting| {
            let last = meeting
                .ended_at_unix_ms()
                .max(meeting.last_modified_unix_ms());
            (meeting.started_at_unix_ms()..=last + gap_ms).contains(&written)
        });
        match home {
            Some(meeting) => meeting.unreadable_sessions.push(session_id),
            None => unplaced_sessions.push(session_id),
        }
    }
    for meeting in &mut meetings {
        meeting.unplaced_in_channel.clone_from(&unplaced_sessions);
    }
    Ok(Collected {
        meetings,
        unplaced_sessions,
    })
}

async fn load_session<S: RecordingStore>(
    store: &S,
    session_id: Uuid,
    objects: &SessionObjects,
) -> Result<Option<SessionRecording>, CollectError> {
    let mut losses = Losses::default();
    let manifest = match &objects.manifest_key {
        Some(key) => {
            let manifest = load_manifest(store, key, session_id).await?;
            if manifest.is_none() {
                losses.unreadable_manifests += 1;
            }
            manifest
        }
        None => None,
    };
    match &manifest {
        // The recorder numbers a chunk when it opens it, so a gap in the
        // numbers is a failed upload — already in `lost_chunks`. What the
        // manifest lists but storage lacks is missing on top of that.
        Some(manifest) => {
            losses.lost_chunks = manifest.lost_chunks;
            losses.dropped_frames = manifest.dropped_frames;
            losses.missing_chunks = manifest
                .chunks
                .iter()
                .filter(|chunk| !objects.chunk_keys.contains_key(&chunk.seq))
                .count() as u64;
        }
        // Without a manifest every number from 0 to the last one found
        // should be there.
        None => {
            if let Some(last) = objects.chunk_keys.keys().next_back() {
                losses.missing_chunks = u64::from(*last) + 1 - objects.chunk_keys.len() as u64;
            }
        }
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
    if let Some(manifest) = &manifest {
        // A chunk the manifest does not list but storage holds and can read
        // was uploaded after all (e.g. the upload "failed" on a permission
        // check after the object was written): not lost.
        let recovered = chunks
            .iter()
            .filter(|chunk| {
                !manifest
                    .chunks
                    .iter()
                    .any(|m| m.seq == chunk.header.chunk_seq)
            })
            .count() as u64;
        losses.lost_chunks = losses.lost_chunks.saturating_sub(recovered);
    }
    let started_at_unix_ms = match (&manifest, chunks.first()) {
        (Some(manifest), _) => match parse_utc_ms(&manifest.started_at) {
            Some(ms) => ms,
            None => return Ok(None),
        },
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

/// A readable manifest of this session, or `None` when it is not valid
/// JSON, has another format (e.g. a future `/2`) or names another session.
async fn load_manifest<S: RecordingStore>(
    store: &S,
    key: &str,
    session_id: Uuid,
) -> Result<Option<Manifest>, CollectError> {
    let bytes = store.get(key).await?;
    let Ok(manifest) = serde_json::from_slice::<Manifest>(&bytes) else {
        return Ok(None);
    };
    let usable = manifest.format == FORMAT
        && manifest.session_id == session_id
        && parse_utc_ms(&manifest.started_at).is_some();
    Ok(usable.then_some(manifest))
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
            .expect("collect")
            .meetings;
        assert_eq!(meetings.len(), 2);
        let ids: Vec<Vec<u128>> = meetings
            .iter()
            .map(|m| m.sessions.iter().map(|s| s.session_id.as_u128()).collect())
            .collect();
        assert_eq!(ids, [vec![10, 11], vec![12]]);
        assert_eq!(meetings[0].losses().missing_chunks, 1);
        assert_eq!(meetings[0].ended_at_unix_ms(), monday + 62_000 + 60_000);
        assert_eq!(meetings[1].losses().unreadable_chunks, 1);
        assert_eq!(meetings[1].sessions[0].chunks.len(), 1);
    }

    fn manifest(session: Uuid, start_unix_ms: u64, seqs: &[u32], lost: u64) -> Vec<u8> {
        let manifest = Manifest {
            format: FORMAT.into(),
            community_id: Uuid::from_u128(1),
            channel_id: Uuid::from_u128(2),
            parent_channel_id: None,
            session_id: session,
            started_at: buzz_huddle_recording::format_utc_millis(start_unix_ms),
            ended_at: buzz_huddle_recording::format_utc_millis(start_unix_ms + 60_000),
            duration_ms: 60_000,
            protocol_version: 2,
            end_reason: buzz_huddle_recording::EndReason::RoomEmpty,
            chunks: seqs
                .iter()
                .map(|&seq| buzz_huddle_recording::ManifestChunk {
                    seq,
                    key: chunk_key("h", Uuid::from_u128(1), Uuid::from_u128(2), session, seq),
                    bytes: 0,
                    records: 2,
                    first_t_ms: 0,
                    last_t_ms: 60_000,
                })
                .collect(),
            participants: Vec::new(),
            dropped_frames: 3,
            lost_chunks: lost,
        };
        serde_json::to_vec(&manifest).expect("manifest")
    }

    /// Every way a session can be incomplete is counted once, and none of
    /// them stops the others from being read.
    #[tokio::test]
    async fn losses_are_counted_once_and_nothing_broken_is_fatal() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = LocalStore::new(dir.path());
        let (community, channel) = (Uuid::from_u128(1), Uuid::from_u128(2));
        let start = 1_791_781_200_000;
        let put = |session: u128, name: String, bytes: Vec<u8>| {
            let key = format!(
                "h/{community}/{channel}/{}/{name}",
                Uuid::from_u128(session)
            );
            let store = store.clone();
            async move { store.put(&key, bytes).await.expect("put") }
        };
        let chunk_name = |seq: u32| format!("chunk-{seq:06}.bhr");
        // 20: manifest lists 0 and 2, chunk 1 failed to upload (lost 1):
        //     the gap is the lost chunk, not counted again.
        put(
            20,
            chunk_name(0),
            chunk(Uuid::from_u128(20), 0, start, 60_000),
        )
        .await;
        put(
            20,
            chunk_name(2),
            chunk(Uuid::from_u128(20), 2, start, 60_000),
        )
        .await;
        put(
            20,
            "manifest.json".into(),
            manifest(Uuid::from_u128(20), start, &[0, 2], 1),
        )
        .await;
        // 21: manifest lists 0 and 1, storage has only 0: one missing.
        put(
            21,
            chunk_name(0),
            chunk(Uuid::from_u128(21), 0, start + 1_000, 60_000),
        )
        .await;
        put(
            21,
            "manifest.json".into(),
            manifest(Uuid::from_u128(21), start + 1_000, &[0, 1], 0),
        )
        .await;
        // 22: broken manifest, chunks 1 and 2 only: used chunk-only, chunk 0 missing.
        put(
            22,
            chunk_name(1),
            chunk(Uuid::from_u128(22), 1, start + 2_000, 60_000),
        )
        .await;
        put(
            22,
            chunk_name(2),
            chunk(Uuid::from_u128(22), 2, start + 2_000, 60_000),
        )
        .await;
        put(22, "manifest.json".into(), b"{not json".to_vec()).await;
        // 23: a manifest of a future format: also used chunk-only.
        let mut future: serde_json::Value =
            serde_json::from_slice(&manifest(Uuid::from_u128(23), start + 3_000, &[0], 0))
                .expect("json");
        future["format"] = "buzz-huddle-recording/2".into();
        put(
            23,
            chunk_name(0),
            chunk(Uuid::from_u128(23), 0, start + 3_000, 60_000),
        )
        .await;
        put(
            23,
            "manifest.json".into(),
            serde_json::to_vec(&future).expect("json"),
        )
        .await;
        // 25: manifest lists only 0 and says 1 was lost, but chunk 1 is in
        //     storage and readable: it was uploaded after all, not lost.
        put(
            25,
            chunk_name(0),
            chunk(Uuid::from_u128(25), 0, start + 4_000, 60_000),
        )
        .await;
        put(
            25,
            chunk_name(1),
            chunk(Uuid::from_u128(25), 1, start + 4_000, 60_000),
        )
        .await;
        put(
            25,
            "manifest.json".into(),
            manifest(Uuid::from_u128(25), start + 4_000, &[0], 1),
        )
        .await;
        // 24: nothing readable at all.
        put(24, chunk_name(0), b"BHR1 broken".to_vec()).await;

        let collected = collect_meetings(&store, "h", community, channel, 10 * 60_000)
            .await
            .expect("collect");
        assert_eq!(collected.meetings.len(), 1);
        assert!(collected.unplaced_sessions.is_empty());
        let meeting = &collected.meetings[0];
        let ids: Vec<u128> = meeting
            .sessions
            .iter()
            .map(|s| s.session_id.as_u128())
            .collect();
        assert_eq!(ids, [20, 21, 22, 23, 25]);
        assert_eq!(meeting.unreadable_sessions, [Uuid::from_u128(24)]);
        assert_eq!(
            meeting.losses(),
            Losses {
                lost_chunks: 1,
                missing_chunks: 2,
                // Session 24's chunk is counted once, as an unreadable session.
                unreadable_chunks: 0,
                unreadable_manifests: 2,
                unreadable_sessions: 1,
                dropped_frames: 9,
                failed_segments: 0,
            }
        );
    }

    /// Pin an object's write time (what the bucket would report).
    fn set_written(dir: &std::path::Path, key: &str, unix_ms: u64) {
        std::fs::File::options()
            .write(true)
            .open(dir.join(key))
            .expect("open")
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(unix_ms))
            .expect("set write time");
    }

    /// Every time here is set from the meeting's own start, never from the
    /// clock: the same checks hold for a meeting in 2026 and for one that
    /// starts 30 days from whenever the test runs.
    #[tokio::test]
    async fn processed_old_and_live_meetings_are_left_alone() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_millis() as u64;
        for start in [1_791_781_200_000u64, now + 30 * 86_400_000] {
            let dir = tempfile::tempdir().expect("tempdir");
            let store = LocalStore::new(dir.path());
            let (community, channel) = (Uuid::from_u128(1), Uuid::from_u128(2));
            for session in [30u128, 31] {
                let key = chunk_key("h", community, channel, Uuid::from_u128(session), 0);
                let started = start + (session as u64 - 30) * 1_000;
                store
                    .put(&key, chunk(Uuid::from_u128(session), 0, started, 60_000))
                    .await
                    .expect("put");
                set_written(dir.path(), &key, started + 61_000);
            }
            let meeting = collect_meetings(&store, "h", community, channel, 10 * 60_000)
                .await
                .expect("collect")
                .meetings
                .remove(0);
            let written = start + 62_000;
            assert_eq!(meeting.last_modified_unix_ms(), written);
            let quiet = 10 * 60_000;
            let later = written + quiet;
            let nothing = HashSet::new();
            assert_eq!(meeting.skip_reason(&nothing, later, quiet), None, "{start}");
            let second = HashSet::from([Uuid::from_u128(31)]);
            assert_eq!(
                meeting.skip_reason(&second, later, quiet),
                Some(Skip::AlreadyProcessed)
            );
            assert_eq!(
                meeting.skip_reason(&nothing, written + 60_000, quiet),
                Some(Skip::MaybeLive)
            );
            assert_eq!(
                meeting.skip_reason(&nothing, start + MAX_MEETING_AGE_MS, quiet),
                None,
                "14 days to the ms is still in"
            );
            assert_eq!(
                meeting.skip_reason(&nothing, start + MAX_MEETING_AGE_MS + 1, quiet),
                Some(Skip::TooOld)
            );
        }
    }

    /// An unreadable session that no meeting's time covers is not lost
    /// either: the channel and every meeting of it carry its id.
    #[tokio::test]
    async fn an_unreadable_session_outside_every_meeting_is_still_counted() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = LocalStore::new(dir.path());
        let (community, channel) = (Uuid::from_u128(1), Uuid::from_u128(2));
        let start = 1_791_781_200_000u64;
        let good = chunk_key("h", community, channel, Uuid::from_u128(40), 0);
        store
            .put(&good, chunk(Uuid::from_u128(40), 0, start, 60_000))
            .await
            .expect("put");
        set_written(dir.path(), &good, start + 61_000);
        let broken = chunk_key("h", community, channel, Uuid::from_u128(41), 0);
        store
            .put(&broken, b"BHR1 broken".to_vec())
            .await
            .expect("put");
        set_written(dir.path(), &broken, start - 3 * 86_400_000);

        let collected = collect_meetings(&store, "h", community, channel, 10 * 60_000)
            .await
            .expect("collect");
        assert_eq!(collected.unplaced_sessions, [Uuid::from_u128(41)]);
        assert_eq!(collected.meetings.len(), 1);
        assert!(collected.meetings[0].unreadable_sessions.is_empty());
        assert_eq!(
            collected.meetings[0].unplaced_in_channel,
            [Uuid::from_u128(41)]
        );
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
