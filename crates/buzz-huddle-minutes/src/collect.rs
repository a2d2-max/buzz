//! Gather a huddle's recording sessions into meetings (step 1 of the worker).
//!
//! A meeting can be split into several sessions — mesh owner change, relay
//! rollout, the 6-hour cap — and one channel can hold several meetings. Each
//! session folder holds `chunk-{seq:06}.bhr` objects and, once finished,
//! `manifest.json`. A session whose pod died has chunks only.

use std::collections::{BTreeMap, HashSet};

use buzz_huddle_recording::{decode_chunk, ChunkHeader, Manifest, CHUNK_HEADER_LEN, FORMAT};
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
        is_quiet(self.last_modified_unix_ms(), now_unix_ms, quiet_ms)
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
        skip_reason(
            self.sessions.iter().map(|session| session.session_id),
            self.started_at_unix_ms(),
            self.last_modified_unix_ms(),
            processed,
            now_unix_ms,
            quiet_ms,
        )
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

/// The quiet-time rule shared by [`Meeting`] and [`MeetingPlan`].
fn is_quiet(last_modified_unix_ms: u64, now_unix_ms: u64, quiet_ms: u64) -> bool {
    now_unix_ms.saturating_sub(last_modified_unix_ms) >= quiet_ms
}

/// The skip rules shared by [`Meeting`] and [`MeetingPlan`].
fn skip_reason(
    mut session_ids: impl Iterator<Item = Uuid>,
    started_at_unix_ms: u64,
    last_modified_unix_ms: u64,
    processed: &HashSet<Uuid>,
    now_unix_ms: u64,
    quiet_ms: u64,
) -> Option<Skip> {
    if session_ids.any(|session| processed.contains(&session)) {
        Some(Skip::AlreadyProcessed)
    } else if now_unix_ms.saturating_sub(started_at_unix_ms) > MAX_MEETING_AGE_MS {
        Some(Skip::TooOld)
    } else if !is_quiet(last_modified_unix_ms, now_unix_ms, quiet_ms) {
        Some(Skip::MaybeLive)
    } else {
        None
    }
}

#[derive(Debug, Clone, Default)]
struct SessionObjects {
    chunk_keys: BTreeMap<u32, String>,
    manifest_key: Option<String>,
    last_modified_unix_ms: u64,
}

/// One session as seen from the listing, its manifest or the start of its
/// chunks — no chunk bodies.
#[derive(Debug, Clone)]
pub struct SessionHead {
    /// Session id (the folder name).
    pub session_id: Uuid,
    /// Wall-clock session start, UTC ms.
    pub started_at_unix_ms: u64,
    /// Session end, UTC ms: the manifest's, or for a chunk-only session
    /// the latest record time found in the first bytes of its last
    /// readable chunk — up to one chunk short of the real end, which is
    /// fine for splitting meetings by a 10-minute gap.
    pub ended_at_unix_ms: u64,
    /// Newest write time among this session's objects, UTC ms.
    pub last_modified_unix_ms: u64,
    manifest: Option<Manifest>,
    unreadable_manifest: bool,
    objects: SessionObjects,
}

/// A meeting found by [`plan_meetings`]: which sessions, nothing loaded
/// yet. [`load`](Self::load) fetches its chunks.
#[derive(Debug, Clone)]
pub struct MeetingPlan {
    /// Community id from the storage path.
    pub community_id: Uuid,
    /// Huddle channel id.
    pub channel_id: Uuid,
    /// Sessions, earliest first.
    pub sessions: Vec<SessionHead>,
    /// Sessions of this meeting with nothing readable, placed here by
    /// their write time.
    pub unreadable_sessions: Vec<Uuid>,
    /// Sessions of the same channel with nothing readable that no meeting's
    /// time covers (the same list on every meeting of the channel).
    pub unplaced_in_channel: Vec<Uuid>,
}

impl MeetingPlan {
    /// Meeting start (first session start), UTC ms.
    pub fn started_at_unix_ms(&self) -> u64 {
        self.sessions
            .first()
            .map_or(0, |session| session.started_at_unix_ms)
    }

    /// The first session's id; names the meeting's script and ledger.
    pub fn first_session_id(&self) -> Uuid {
        self.sessions
            .first()
            .map(|session| session.session_id)
            .unwrap_or_default()
    }

    fn ended_at_unix_ms(&self) -> u64 {
        self.sessions
            .iter()
            .map(|session| session.ended_at_unix_ms)
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

    /// See [`Meeting::skip_reason`]; needs nothing loaded.
    pub fn skip_reason(
        &self,
        processed: &HashSet<Uuid>,
        now_unix_ms: u64,
        quiet_ms: u64,
    ) -> Option<Skip> {
        skip_reason(
            self.sessions.iter().map(|session| session.session_id),
            self.started_at_unix_ms(),
            self.last_modified_unix_ms(),
            processed,
            now_unix_ms,
            quiet_ms,
        )
    }

    /// Fetch this meeting's chunks (and nothing of other meetings).
    pub async fn load<S: RecordingStore>(&self, store: &S) -> Result<Meeting, CollectError> {
        let mut meeting = Meeting {
            community_id: self.community_id,
            channel_id: self.channel_id,
            parent_channel_id: None,
            sessions: Vec::with_capacity(self.sessions.len()),
            unreadable_sessions: self.unreadable_sessions.clone(),
            unplaced_in_channel: self.unplaced_in_channel.clone(),
        };
        for head in &self.sessions {
            match load_session(store, head).await? {
                Some(session) => {
                    if meeting.parent_channel_id.is_none() {
                        meeting.parent_channel_id =
                            session.manifest.as_ref().and_then(|m| m.parent_channel_id);
                    }
                    meeting.sessions.push(session);
                }
                // Readable a moment ago, not now (deleted in between).
                None => meeting.unreadable_sessions.push(head.session_id),
            }
        }
        Ok(meeting)
    }
}

/// Every meeting under one huddle channel, nothing loaded yet.
#[derive(Debug, Clone)]
pub struct Planned {
    /// Meetings, earliest first.
    pub meetings: Vec<MeetingPlan>,
    /// Sessions with nothing readable that no meeting's time covers.
    pub unplaced_sessions: Vec<Uuid>,
}

/// Bytes read from the start of a chunk-only session's last chunk to find
/// when that chunk was opened (its first records).
const LAST_CHUNK_HEAD_BYTES: u64 = 4_096;

/// Find the sessions stored under `{prefix}/{community_id}/{channel_id}/`
/// and group them into meetings, reading only the listing, manifests and
/// the first bytes of chunks: a session that starts more than `gap_ms`
/// after everything before it has ended begins a new meeting (the design's
/// 10-minute rule; one channel can hold many meetings within the bucket's 15
/// days). Folders that are not session UUIDs and files that are neither
/// chunks nor a manifest are ignored (the mixed audio lives beside the
/// sessions). A session with nothing readable is placed by its write time.
pub async fn plan_meetings<S: RecordingStore>(
    store: &S,
    prefix: &str,
    community_id: Uuid,
    channel_id: Uuid,
    gap_ms: u64,
) -> Result<Planned, CollectError> {
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

    let mut heads = Vec::with_capacity(by_session.len());
    let mut unreadable: Vec<(Uuid, u64)> = Vec::new();
    for (session_id, objects) in by_session {
        let written = objects.last_modified_unix_ms;
        match head_session(store, session_id, objects).await? {
            Some(head) => heads.push(head),
            None => unreadable.push((session_id, written)),
        }
    }
    heads.sort_by_key(|head| (head.started_at_unix_ms, head.session_id));

    let mut meetings: Vec<MeetingPlan> = Vec::new();
    let mut ended = 0u64;
    for head in heads {
        let starts_new = meetings.is_empty() || head.started_at_unix_ms > ended + gap_ms;
        if starts_new {
            ended = 0;
            meetings.push(MeetingPlan {
                community_id,
                channel_id,
                sessions: Vec::new(),
                unreadable_sessions: Vec::new(),
                unplaced_in_channel: Vec::new(),
            });
        }
        ended = ended.max(head.ended_at_unix_ms);
        if let Some(meeting) = meetings.last_mut() {
            meeting.sessions.push(head);
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
    Ok(Planned {
        meetings,
        unplaced_sessions,
    })
}

/// [`plan_meetings`], then load every meeting. Nothing broken is fatal: an
/// unreadable chunk is skipped, an unreadable manifest leaves a chunk-only
/// session, a session with nothing readable is placed by its write time —
/// all counted in [`Losses`]. Loads the whole channel; the worker plans and
/// loads one meeting at a time instead.
pub async fn collect_meetings<S: RecordingStore>(
    store: &S,
    prefix: &str,
    community_id: Uuid,
    channel_id: Uuid,
    gap_ms: u64,
) -> Result<Collected, CollectError> {
    let planned = plan_meetings(store, prefix, community_id, channel_id, gap_ms).await?;
    let mut meetings = Vec::with_capacity(planned.meetings.len());
    for plan in &planned.meetings {
        meetings.push(plan.load(store).await?);
    }
    Ok(Collected {
        meetings,
        unplaced_sessions: planned.unplaced_sessions,
    })
}

/// A session's head: start and end from its manifest, or from the first
/// bytes of its chunks. `None` when nothing of it can be read.
async fn head_session<S: RecordingStore>(
    store: &S,
    session_id: Uuid,
    objects: SessionObjects,
) -> Result<Option<SessionHead>, CollectError> {
    let manifest = match &objects.manifest_key {
        Some(key) => load_manifest(store, key, session_id).await?,
        None => None,
    };
    let unreadable_manifest = objects.manifest_key.is_some() && manifest.is_none();
    let times = match &manifest {
        Some(manifest) => {
            parse_utc_ms(&manifest.started_at).map(|start| (start, start + manifest.duration_ms))
        }
        None => {
            let mut start = None;
            for (seq, key) in &objects.chunk_keys {
                let bytes = store.get_start(key, CHUNK_HEADER_LEN as u64).await?;
                if let Ok((header, _)) = decode_chunk(&bytes) {
                    if header.session_id == session_id && header.chunk_seq == *seq {
                        start = Some(header.session_start_unix_ms);
                        break;
                    }
                }
            }
            match start {
                Some(start) => {
                    let mut last_t_ms = 0;
                    for (seq, key) in objects.chunk_keys.iter().rev() {
                        let bytes = store.get_start(key, LAST_CHUNK_HEAD_BYTES).await?;
                        if let Ok((header, records)) = decode_chunk(&bytes) {
                            if header.session_id == session_id && header.chunk_seq == *seq {
                                last_t_ms = records
                                    .map_while(Result::ok)
                                    .map(|record| u64::from(record.t_ms()))
                                    .max()
                                    .unwrap_or(0);
                                break;
                            }
                        }
                    }
                    Some((start, start + last_t_ms))
                }
                None => None,
            }
        }
    };
    Ok(
        times.map(|(started_at_unix_ms, ended_at_unix_ms)| SessionHead {
            session_id,
            started_at_unix_ms,
            ended_at_unix_ms,
            last_modified_unix_ms: objects.last_modified_unix_ms,
            manifest,
            unreadable_manifest,
            objects,
        }),
    )
}

async fn load_session<S: RecordingStore>(
    store: &S,
    head: &SessionHead,
) -> Result<Option<SessionRecording>, CollectError> {
    let session_id = head.session_id;
    let objects = &head.objects;
    let manifest = head.manifest.clone();
    let mut losses = Losses::default();
    if head.unreadable_manifest {
        losses.unreadable_manifests += 1;
    }
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
    use buzz_huddle_recording::{chunk_key, manifest_key, Record};

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

    /// Test double wrapper: notes every read (key, and the length asked for
    /// when only the start was read).
    struct Reads<S> {
        inner: S,
        reads: std::sync::Mutex<Vec<(String, Option<u64>)>>,
    }

    impl<S> Reads<S> {
        fn take(&self) -> Vec<(String, Option<u64>)> {
            std::mem::take(&mut *self.reads.lock().expect("lock"))
        }
    }

    impl<S: RecordingStore + Sync> RecordingStore for Reads<S> {
        async fn list(&self, prefix: &str) -> Result<Vec<crate::store::ObjectInfo>, StoreError> {
            self.inner.list(prefix).await
        }

        async fn get(&self, key: &str) -> Result<Vec<u8>, StoreError> {
            self.reads
                .lock()
                .expect("lock")
                .push((key.to_string(), None));
            self.inner.get(key).await
        }

        async fn get_start(&self, key: &str, len: u64) -> Result<Vec<u8>, StoreError> {
            self.reads
                .lock()
                .expect("lock")
                .push((key.to_string(), Some(len)));
            self.inner.get_start(key, len).await
        }

        async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<(), StoreError> {
            self.inner.put(key, bytes).await
        }
    }

    /// Planning reads manifests and the first bytes of chunks only; loading
    /// a meeting reads that meeting's chunks and nothing else.
    #[tokio::test]
    async fn planning_reads_only_heads_and_loading_only_its_meeting() {
        let dir = tempfile::tempdir().expect("tempdir");
        let local = LocalStore::new(dir.path());
        let (community, channel) = (Uuid::from_u128(1), Uuid::from_u128(2));
        let day = 86_400_000;
        let monday = 1_791_781_200_000;
        // Monday: two chunk-only sessions 2 minutes apart. Wednesday: one
        // chunk-only session. Friday: one session with a manifest.
        let sessions = [
            (Uuid::from_u128(10), monday, vec![0u32, 2]),
            (Uuid::from_u128(11), monday + 62_000, vec![0]),
            (Uuid::from_u128(12), monday + 2 * day, vec![0, 1]),
            (Uuid::from_u128(13), monday + 4 * day, vec![0]),
        ];
        for (session, start, seqs) in &sessions {
            for &seq in seqs {
                let key = chunk_key("h", community, channel, *session, seq);
                local
                    .put(&key, chunk(*session, seq, *start, 60_000))
                    .await
                    .expect("put");
            }
        }
        let friday = Uuid::from_u128(13);
        local
            .put(
                &manifest_key("h", community, channel, friday),
                manifest(friday, monday + 4 * day, &[0], 0),
            )
            .await
            .expect("put");
        let store = Reads {
            inner: local,
            reads: std::sync::Mutex::new(Vec::new()),
        };

        let planned = plan_meetings(&store, "h", community, channel, 10 * 60_000)
            .await
            .expect("plan");
        let ids: Vec<Vec<u128>> = planned
            .meetings
            .iter()
            .map(|m| m.sessions.iter().map(|s| s.session_id.as_u128()).collect())
            .collect();
        assert_eq!(ids, [vec![10, 11], vec![12], vec![13]]);
        // A chunk-only session ends at the last record found in the start
        // of its last chunk.
        assert_eq!(
            planned.meetings[0].sessions[0].ended_at_unix_ms,
            monday + 60_000
        );
        for (key, len) in store.take() {
            match len {
                Some(len) => assert!(len <= LAST_CHUNK_HEAD_BYTES, "{key}: {len}"),
                None => assert!(key.ends_with("/manifest.json"), "whole {key} read"),
            }
        }

        let meeting = planned.meetings[1].load(&store).await.expect("load");
        assert_eq!(meeting.sessions[0].chunks.len(), 2);
        let mut read: Vec<String> = store.take().into_iter().map(|(key, _)| key).collect();
        read.sort();
        let wednesday = Uuid::from_u128(12);
        assert_eq!(
            read,
            [
                chunk_key("h", community, channel, wednesday, 0),
                chunk_key("h", community, channel, wednesday, 1),
            ]
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
