//! Huddle recorder: writes the audio frames and roster changes a huddle room
//! relays to storage, in the `buzz-huddle-recording/1` format
//! (`docs/huddle-recording.md`, codec in the `buzz-huddle-recording` crate).
//!
//! ```text
//! Room::add_peer / remove_peer*   ── roster events (never dropped) ──┐
//! Room::broadcast_frame           ── frames (capped, dropped on full) ┤ one FIFO
//! Room::record_mesh_ingress       ── owner-side remote frames ────────┘   │
//!                                                                          ▼
//!                       per-room task: sessions → chunks → uploads → manifest
//! ```
//!
//! # What gets recorded
//!
//! Only the authoritative room records: a single pod, or the mesh owner pod.
//! A session starts on the first *owner-assigned* admission (`add_peer`) and
//! ends when that room's last participant leaves. A mesh mirror admits peers
//! with `add_peer_at_index`, which feeds nothing here, so a mirror never opens
//! a session and the same sound is never stored twice.
//!
//! # The hot path never waits
//!
//! Roster events and frames share one unbounded FIFO so a join is always
//! written before that participant's first frame. Frames are admitted only
//! while fewer than the frame capacity are queued (an atomic counter); past
//! that they are dropped and counted in `dropped_frames`. Roster events are
//! human-rate (at most 25 seats) and are never dropped. Nothing on the relay
//! path awaits, and the only lock taken is the room's existing admission
//! mutex, which roster mutations already hold.
//!
//! # Chunks
//!
//! A chunk is sealed and uploaded once `CHUNK_SECS` have passed since the
//! previous chunk was written, or before it would pass 4 MiB. When everyone is
//! silent no record arrives (muted clients send no frames), so the room's tick
//! writes a keep-alive chunk holding only the present roster as `type=2`
//! records. While anyone is in the room an object therefore appears at least
//! every `CHUNK_SECS`, which is what the minutes worker's "no new object for a
//! long time means the pod died" rule relies on.
//!
//! # Ending
//!
//! The end condition is "the room's recorded roster is empty", never "the
//! channel was archived": archiving can fail (for example when the desktop
//! archived first) and must not leave a session open. While the relay is
//! shutting down (SIGTERM flag) a session that empties ends as `shutdown`, and
//! [`HuddleRecorder::shutdown`] finishes whatever is still open the same way.
//! `manifest.json` is written only after every chunk upload has settled.
//!
//! Audio bytes are never logged.

use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use buzz_core::CommunityId;
use buzz_huddle_recording::{
    self as format, ChunkHeader, EndReason, Manifest, ManifestChunk, ManifestParticipant, Record,
};
use bytes::Bytes;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::config::{HuddleRecordingConfig, HuddleRecordingMode};

/// Frames one room may have queued for its recorder task before new frames
/// are dropped. 2048 frames is ~1.6 s of a full 25-peer room at 20 ms frames.
const FRAME_QUEUE_CAPACITY: usize = 2048;
/// A chunk is sealed before it would grow past 4 MiB.
const MAX_CHUNK_BYTES: usize = 4 * 1024 * 1024;
/// Longest single session; a longer huddle continues in a new session.
const MAX_SESSION: Duration = Duration::from_secs(6 * 60 * 60);
/// How often a room re-checks chunk cadence and session length when no
/// record arrives (this is what writes keep-alive chunks during silence).
const TICK: Duration = Duration::from_secs(1);
/// Upper bound for one storage write attempt.
const UPLOAD_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(30);
/// Waits between storage write attempts (so 4 attempts in total).
const RETRY_BACKOFF: [Duration; 3] = [
    Duration::from_millis(250),
    Duration::from_secs(1),
    Duration::from_secs(4),
];

/// Errors from building the recorder or writing its objects.
#[derive(Debug, thiserror::Error)]
pub enum RecorderError {
    /// Local filesystem failure.
    #[error("huddle recording io error: {0}")]
    Io(#[from] std::io::Error),
    /// Object-store failure (message from the S3 client).
    #[error("huddle recording storage error: {0}")]
    Storage(String),
    /// The configured storage cannot be used.
    #[error("huddle recording config error: {0}")]
    Config(String),
    /// One write attempt exceeded its time budget.
    #[error("huddle recording write timed out")]
    Timeout,
}

/// Destination for finished chunk and manifest objects.
#[async_trait::async_trait]
pub trait RecordingSink: Send + Sync + 'static {
    /// Store `body` under `key`, replacing any previous object.
    async fn put(&self, key: &str, body: &[u8], content_type: &str) -> Result<(), RecorderError>;
}

/// Writes objects as files under a root directory. Each file is written to a
/// `.part` sibling and renamed into place, so a reader never sees a partial
/// `manifest.json`. Recordings are private audio: on unix every directory the
/// sink creates is `0700` and every file it writes is `0600`.
pub struct LocalSink {
    root: PathBuf,
}

/// Mode of directories the local sink creates.
#[cfg(unix)]
const LOCAL_DIR_MODE: u32 = 0o700;
/// Mode of files the local sink writes.
#[cfg(unix)]
const LOCAL_FILE_MODE: u32 = 0o600;

impl LocalSink {
    /// Use `root`, creating it (owner-only on unix) if needed. An existing
    /// directory keeps its permissions.
    pub fn new(root: PathBuf) -> Result<Self, RecorderError> {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, LOCAL_DIR_MODE);
        builder.create(&root)?;
        Ok(Self { root })
    }
}

#[async_trait::async_trait]
impl RecordingSink for LocalSink {
    async fn put(&self, key: &str, body: &[u8], _content_type: &str) -> Result<(), RecorderError> {
        let relative = Path::new(key);
        if !relative
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        {
            return Err(RecorderError::Config(format!(
                "object key {key:?} is not a plain relative path"
            )));
        }
        let path = self.root.join(relative);
        if let Some(parent) = path.parent() {
            let mut builder = tokio::fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            builder.mode(LOCAL_DIR_MODE);
            builder.create(parent).await?;
        }
        let mut partial = path.clone().into_os_string();
        partial.push(".part");
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        options.mode(LOCAL_FILE_MODE);
        let mut file = options.open(&partial).await?;
        // `mode` applies only when the file is created; a `.part` left by a
        // crash keeps its old bits, so tighten them before writing audio.
        #[cfg(unix)]
        file.set_permissions(std::os::unix::fs::PermissionsExt::from_mode(
            LOCAL_FILE_MODE,
        ))
        .await?;
        tokio::io::AsyncWriteExt::write_all(&mut file, body).await?;
        tokio::io::AsyncWriteExt::flush(&mut file).await?;
        drop(file);
        tokio::fs::rename(&partial, &path).await?;
        Ok(())
    }
}

/// Writes objects to an S3-compatible bucket with path-style addressing,
/// which both GCS (`https://storage.googleapis.com` + HMAC keys) and MinIO
/// accept.
pub struct S3Sink {
    bucket: Box<s3::Bucket>,
}

impl S3Sink {
    /// Build the client. Credential selection matches media storage: both
    /// keys set → static keys; both empty → the AWS default credential chain.
    pub fn new(
        bucket: &str,
        endpoint: &str,
        region: &str,
        access_key: &str,
        secret_key: &str,
    ) -> Result<Self, RecorderError> {
        let region = s3::Region::Custom {
            region: region.to_string(),
            endpoint: endpoint.to_string(),
        };
        let credentials = match (access_key.is_empty(), secret_key.is_empty()) {
            (false, false) => {
                s3::creds::Credentials::new(Some(access_key), Some(secret_key), None, None, None)
            }
            (true, true) => s3::creds::Credentials::default(),
            _ => {
                return Err(RecorderError::Config(
                    "access and secret key must be set together".to_string(),
                ))
            }
        }
        .map_err(|e| RecorderError::Config(e.to_string()))?;
        let bucket = s3::Bucket::new(bucket, region, credentials)
            .map_err(|e| RecorderError::Config(e.to_string()))?
            .with_path_style();
        Ok(Self { bucket })
    }
}

#[async_trait::async_trait]
impl RecordingSink for S3Sink {
    async fn put(&self, key: &str, body: &[u8], content_type: &str) -> Result<(), RecorderError> {
        self.bucket
            .put_object_with_content_type(key, body, content_type)
            .await
            .map(|_| ())
            .map_err(|e| RecorderError::Storage(e.to_string()))
    }
}

/// Time source for the recorder, injectable so tests can cross chunk and
/// session limits without sleeping.
pub trait RecorderClock: Send + Sync + 'static {
    /// Monotonic time; every `t_ms` is measured on this clock.
    fn now(&self) -> Instant;
    /// Wall clock in UTC milliseconds since the Unix epoch.
    fn unix_ms(&self) -> u64;
}

/// The process clocks.
pub struct SystemClock;

impl RecorderClock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn unix_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
            .unwrap_or(0)
    }
}

/// Size and timing limits. Production uses [`Limits::default`]; tests shrink
/// them to reach the boundaries quickly.
#[derive(Debug, Clone)]
struct Limits {
    frame_capacity: usize,
    max_chunk_bytes: usize,
    max_session: Duration,
    tick: Duration,
    retry_backoff: Vec<Duration>,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            frame_capacity: FRAME_QUEUE_CAPACITY,
            max_chunk_bytes: MAX_CHUNK_BYTES,
            max_session: MAX_SESSION,
            tick: TICK,
            retry_backoff: RETRY_BACKOFF.to_vec(),
        }
    }
}

/// The relay-wide huddle recorder. One per process, installed on the
/// [`AudioRoomManager`](super::room::AudioRoomManager) at startup only when
/// `BUZZ_HUDDLE_RECORDING` is not `off`.
pub struct HuddleRecorder {
    sink: Arc<dyn RecordingSink>,
    prefix: String,
    chunk_span_ms: u64,
    clock: Arc<dyn RecorderClock>,
    /// The relay's SIGTERM flag (`AppState::shutting_down`), shared rather
    /// than copied so there is one source of truth.
    relay_shutting_down: Arc<AtomicBool>,
    cancel: CancellationToken,
    tasks: TaskTracker,
    limits: Limits,
}

impl HuddleRecorder {
    /// Build the recorder `config` asks for, or `None` when recording is off
    /// (in which case nothing is constructed at all).
    pub fn from_config(
        config: &HuddleRecordingConfig,
        relay_shutting_down: Arc<AtomicBool>,
    ) -> Result<Option<Arc<Self>>, RecorderError> {
        let sink: Arc<dyn RecordingSink> = match &config.mode {
            HuddleRecordingMode::Off => return Ok(None),
            HuddleRecordingMode::Local { dir } => Arc::new(LocalSink::new(dir.clone())?),
            HuddleRecordingMode::S3 {
                bucket,
                endpoint,
                region,
                access_key,
                secret_key,
            } => Arc::new(S3Sink::new(
                bucket, endpoint, region, access_key, secret_key,
            )?),
        };
        Ok(Some(Arc::new(Self::new(
            sink,
            config.prefix.clone(),
            Duration::from_secs(config.chunk_secs),
            Arc::new(SystemClock),
            relay_shutting_down,
            Limits::default(),
        ))))
    }

    fn new(
        sink: Arc<dyn RecordingSink>,
        prefix: String,
        chunk_span: Duration,
        clock: Arc<dyn RecorderClock>,
        relay_shutting_down: Arc<AtomicBool>,
        limits: Limits,
    ) -> Self {
        Self {
            sink,
            prefix,
            chunk_span_ms: u64::try_from(chunk_span.as_millis()).unwrap_or(u64::MAX),
            clock,
            relay_shutting_down,
            cancel: CancellationToken::new(),
            tasks: TaskTracker::new(),
            limits,
        }
    }

    /// Create the handle a new room records through and start that room's
    /// recorder task. The task lives until the room is dropped or
    /// [`Self::shutdown`] runs.
    pub(crate) fn attach(
        self: &Arc<Self>,
        community_id: CommunityId,
        channel_id: Uuid,
    ) -> RoomRecorder {
        let (tx, rx) = mpsc::unbounded_channel();
        let counters = Arc::new(RoomCounters::default());
        let task = RoomTask {
            recorder: Arc::clone(self),
            community_id: *community_id.as_uuid(),
            channel_id,
            counters: Arc::clone(&counters),
            session: None,
        };
        self.tasks.spawn(task.run(rx));
        RoomRecorder {
            tx,
            counters,
            frame_capacity: self.limits.frame_capacity,
            clock: Arc::clone(&self.clock),
        }
    }

    /// Finish every open session as `shutdown` and wait up to `timeout` for
    /// all chunk uploads and manifests. Returns `false` if the wait timed out
    /// (unfinished sessions then have chunks but no manifest, which the
    /// minutes worker handles by its own timeout).
    pub async fn shutdown(&self, timeout: Duration) -> bool {
        self.cancel.cancel();
        self.tasks.close();
        tokio::time::timeout(timeout, self.tasks.wait())
            .await
            .is_ok()
    }
}

#[derive(Default)]
struct RoomCounters {
    queued_frames: AtomicUsize,
    dropped_frames: AtomicU64,
}

enum Event {
    Join {
        at: Instant,
        peer_index: u8,
        epoch: u8,
        pubkey: [u8; 32],
        protocol_version: u8,
    },
    Leave {
        at: Instant,
        peer_index: u8,
        epoch: u8,
    },
    Frame {
        at: Instant,
        peer_index: u8,
        epoch: u8,
        payload: Bytes,
    },
    Parent(Uuid),
}

/// A room's handle into the recorder. Every method is synchronous and
/// non-blocking; it only timestamps and enqueues.
pub(crate) struct RoomRecorder {
    tx: mpsc::UnboundedSender<Event>,
    counters: Arc<RoomCounters>,
    frame_capacity: usize,
    clock: Arc<dyn RecorderClock>,
}

impl RoomRecorder {
    /// An owner-assigned admission. Call under the room's admission lock so
    /// roster events keep the room's revision order.
    pub(crate) fn joined(&self, peer_index: u8, epoch: u8, pubkey_hex: &str, protocol_version: u8) {
        let mut pubkey = [0u8; 32];
        if hex::decode_to_slice(pubkey_hex, &mut pubkey).is_err() {
            warn!(
                peer_index,
                "huddle recorder: participant pubkey is not 32-byte hex — not recorded"
            );
            return;
        }
        let _ = self.tx.send(Event::Join {
            at: self.clock.now(),
            peer_index,
            epoch,
            pubkey,
            protocol_version,
        });
    }

    /// A removal. Call under the room's admission lock. Removals of peers the
    /// recorder never saw join (mesh mirror peers) are ignored by the task.
    pub(crate) fn left(&self, peer_index: u8, epoch: u8) {
        let _ = self.tx.send(Event::Leave {
            at: self.clock.now(),
            peer_index,
            epoch,
        });
    }

    /// One received client frame. Dropped and counted when the room already
    /// has `frame_capacity` frames waiting.
    pub(crate) fn frame(&self, peer_index: u8, epoch: u8, payload: Bytes) {
        let queued = &self.counters.queued_frames;
        if queued.fetch_add(1, Ordering::Relaxed) >= self.frame_capacity {
            queued.fetch_sub(1, Ordering::Relaxed);
            self.counters.dropped_frames.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let event = Event::Frame {
            at: self.clock.now(),
            peer_index,
            epoch,
            payload,
        };
        if self.tx.send(event).is_err() {
            // The task has stopped (relay shutdown); nothing will drain it.
            queued.fetch_sub(1, Ordering::Relaxed);
        }
    }

    /// The parent channel verified at join (kind:48100 linkage).
    pub(crate) fn parent_channel(&self, parent_channel_id: Uuid) {
        let _ = self.tx.send(Event::Parent(parent_channel_id));
    }
}

fn millis_u32(elapsed: Duration) -> u32 {
    u32::try_from(elapsed.as_millis()).unwrap_or(u32::MAX)
}

struct RoomTask {
    recorder: Arc<HuddleRecorder>,
    community_id: Uuid,
    channel_id: Uuid,
    counters: Arc<RoomCounters>,
    session: Option<Session>,
}

impl RoomTask {
    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Event>) {
        let mut tick = tokio::time::interval(self.recorder.limits.tick);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let cancel = self.recorder.cancel.clone();
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    // Keep what reached the queue before shutdown, bounded by
                    // the queue length now so a live sender cannot hold us.
                    for _ in 0..rx.len() {
                        let Ok(event) = rx.try_recv() else { break };
                        self.handle(event);
                    }
                    self.end_session(EndReason::Shutdown, None);
                    return;
                }
                event = rx.recv() => match event {
                    Some(event) => self.handle(event),
                    None => break,
                },
                _ = tick.tick() => self.on_tick(),
            }
        }
        // The room was dropped while the recorder still saw someone in it.
        self.end_session(EndReason::RoomEmpty, None);
    }

    fn handle(&mut self, event: Event) {
        match event {
            Event::Join {
                at,
                peer_index,
                epoch,
                pubkey,
                protocol_version,
            } => {
                if self.session.is_none() {
                    self.session =
                        Some(self.new_session(at, protocol_version, None, BTreeMap::new()));
                }
                let t = self.session_time(at);
                if let Some(session) = self.session.as_mut() {
                    let t = session.monotonic(t);
                    session.join(&self.recorder, t, peer_index, epoch, pubkey);
                }
            }
            Event::Leave {
                at,
                peer_index,
                epoch,
            } => {
                let known = self
                    .session
                    .as_ref()
                    .is_some_and(|s| s.roster.contains_key(&(peer_index, epoch)));
                if !known {
                    return;
                }
                let t = self.session_time(at);
                let mut emptied_at = None;
                if let Some(session) = self.session.as_mut() {
                    let t = session.monotonic(t);
                    if session.leave(&self.recorder, t, peer_index, epoch) {
                        emptied_at = Some(t);
                    }
                }
                if let Some(t) = emptied_at {
                    self.end_session(EndReason::RoomEmpty, Some(t));
                }
            }
            Event::Frame {
                at,
                peer_index,
                epoch,
                payload,
            } => {
                self.counters.queued_frames.fetch_sub(1, Ordering::Relaxed);
                if self.session.is_none() {
                    return;
                }
                let t = self.session_time(at);
                if let Some(session) = self.session.as_mut() {
                    let t = session.monotonic(t);
                    session.append(
                        &self.recorder,
                        Record::Frame {
                            t_ms: t,
                            peer_index,
                            epoch,
                            payload: &payload,
                        },
                    );
                }
            }
            Event::Parent(parent) => {
                if let Some(session) = self.session.as_mut() {
                    session.parent_channel_id.get_or_insert(parent);
                }
            }
        }
    }

    /// `t_ms` of `at` in the open session, first rolling the session over if
    /// it has reached the maximum length. Requires an open session.
    fn session_time(&mut self, at: Instant) -> u32 {
        let Some(session) = self.session.as_ref() else {
            return 0;
        };
        let elapsed = at.saturating_duration_since(session.start);
        if elapsed < self.recorder.limits.max_session {
            return millis_u32(elapsed);
        }
        self.roll_over(at);
        0
    }

    fn on_tick(&mut self) {
        let Some(session) = self.session.as_ref() else {
            return;
        };
        let now = self.recorder.clock.now();
        let elapsed = now.saturating_duration_since(session.start);
        if elapsed >= self.recorder.limits.max_session {
            self.roll_over(now);
            return;
        }
        let t = millis_u32(elapsed);
        if let Some(session) = self.session.as_mut() {
            if session.write_due(&self.recorder, t) {
                if session.chunk.is_some() {
                    session.seal(&self.recorder, t);
                } else {
                    // Everyone is silent (muted clients send no frames), so
                    // nothing opened a chunk. Write a keep-alive chunk so the
                    // minutes worker keeps seeing objects while people stay.
                    session.write_keepalive(&self.recorder, t);
                }
            }
        }
    }

    /// End the open session as `max_duration` at `at` and continue the same
    /// participants in a fresh session starting at `at`.
    fn roll_over(&mut self, at: Instant) {
        let Some(old) = self.session.take() else {
            return;
        };
        let end_t = millis_u32(at.saturating_duration_since(old.start)).max(old.last_t);
        let next = self.new_session(
            at,
            old.protocol_version,
            old.parent_channel_id,
            old.roster.clone(),
        );
        self.finish(old, EndReason::MaxDuration, end_t);
        self.session = Some(next);
    }

    fn new_session(
        &self,
        at: Instant,
        protocol_version: u8,
        parent_channel_id: Option<Uuid>,
        roster: BTreeMap<(u8, u8), [u8; 32]>,
    ) -> Session {
        let clock = &self.recorder.clock;
        let since_at = clock.now().saturating_duration_since(at);
        let start_unix_ms = clock
            .unix_ms()
            .saturating_sub(u64::try_from(since_at.as_millis()).unwrap_or(u64::MAX));
        let mut participants = Vec::with_capacity(roster.len());
        let mut open = HashMap::with_capacity(roster.len());
        for (&(peer_index, epoch), pubkey) in &roster {
            open.insert((peer_index, epoch), participants.len());
            participants.push(ParticipantSpan::new(pubkey, peer_index, epoch, 0));
        }
        Session {
            id: Uuid::new_v4(),
            community_id: self.community_id,
            channel_id: self.channel_id,
            start: at,
            start_unix_ms,
            protocol_version,
            parent_channel_id,
            roster,
            participants,
            open,
            chunk: None,
            next_seq: 0,
            uploads: JoinSet::new(),
            uploaded: Vec::new(),
            lost_chunks: 0,
            last_t: 0,
            last_sealed_t: 0,
        }
    }

    /// End the open session. `end_t` defaults to now. A room that empties
    /// while the relay is shutting down ends as `shutdown`.
    fn end_session(&mut self, reason: EndReason, end_t: Option<u32>) {
        let Some(session) = self.session.take() else {
            return;
        };
        let end_t = end_t
            .unwrap_or_else(|| {
                millis_u32(
                    self.recorder
                        .clock
                        .now()
                        .saturating_duration_since(session.start),
                )
            })
            .max(session.last_t);
        let reason = if reason == EndReason::RoomEmpty
            && self.recorder.relay_shutting_down.load(Ordering::Acquire)
        {
            EndReason::Shutdown
        } else {
            reason
        };
        self.finish(session, reason, end_t);
    }

    /// Seal the last chunk now and write the manifest in a tracked task once
    /// every upload has settled, so this room keeps consuming events.
    fn finish(&mut self, mut session: Session, reason: EndReason, end_t: u32) {
        session.seal(&self.recorder, end_t);
        let dropped_frames = self.counters.dropped_frames.swap(0, Ordering::Relaxed);
        let recorder = Arc::clone(&self.recorder);
        self.recorder.tasks.spawn(async move {
            session
                .write_manifest(&recorder, reason, end_t, dropped_frames)
                .await;
        });
    }
}

struct OpenChunk {
    seq: u32,
    buf: Vec<u8>,
    records: u64,
    first_t: u32,
    last_t: u32,
}

struct ParticipantSpan {
    pubkey: String,
    peer_index: u8,
    epoch: u8,
    joined_t_ms: u32,
    left_t_ms: Option<u32>,
}

impl ParticipantSpan {
    fn new(pubkey: &[u8; 32], peer_index: u8, epoch: u8, joined_t_ms: u32) -> Self {
        Self {
            pubkey: hex::encode(pubkey),
            peer_index,
            epoch,
            joined_t_ms,
            left_t_ms: None,
        }
    }
}

struct Session {
    id: Uuid,
    community_id: Uuid,
    channel_id: Uuid,
    start: Instant,
    start_unix_ms: u64,
    protocol_version: u8,
    parent_channel_id: Option<Uuid>,
    /// Who is present now, keyed by `(peer_index, epoch)`.
    roster: BTreeMap<(u8, u8), [u8; 32]>,
    participants: Vec<ParticipantSpan>,
    /// Open participant span per present `(peer_index, epoch)`.
    open: HashMap<(u8, u8), usize>,
    chunk: Option<OpenChunk>,
    next_seq: u32,
    uploads: JoinSet<(ManifestChunk, bool)>,
    uploaded: Vec<ManifestChunk>,
    lost_chunks: u64,
    /// Latest `t_ms` written. Senders stamp `at` on their own thread before
    /// enqueueing, so queue order can trail stamp order by a moment; records
    /// are clamped to this so `t_ms` never goes backwards within a session.
    last_t: u32,
    /// When the last chunk was sealed (handed to upload); session start
    /// before the first one. Chunk cadence is measured from here.
    last_sealed_t: u32,
}

impl Session {
    /// Clamp `t` so the session's record times never decrease.
    fn monotonic(&mut self, t: u32) -> u32 {
        self.last_t = self.last_t.max(t);
        self.last_t
    }

    fn join(&mut self, rec: &HuddleRecorder, t: u32, peer_index: u8, epoch: u8, pubkey: [u8; 32]) {
        if self.roster.contains_key(&(peer_index, epoch)) {
            return;
        }
        self.append(
            rec,
            Record::Join {
                t_ms: t,
                peer_index,
                epoch,
                pubkey,
            },
        );
        self.roster.insert((peer_index, epoch), pubkey);
        self.open
            .insert((peer_index, epoch), self.participants.len());
        self.participants
            .push(ParticipantSpan::new(&pubkey, peer_index, epoch, t));
    }

    /// Record a leave; returns true when nobody is left.
    fn leave(&mut self, rec: &HuddleRecorder, t: u32, peer_index: u8, epoch: u8) -> bool {
        let Some(&pubkey) = self.roster.get(&(peer_index, epoch)) else {
            return false;
        };
        self.append(
            rec,
            Record::Leave {
                t_ms: t,
                peer_index,
                epoch,
                pubkey,
            },
        );
        self.roster.remove(&(peer_index, epoch));
        if let Some(span) = self
            .open
            .remove(&(peer_index, epoch))
            .and_then(|i| self.participants.get_mut(i))
        {
            span.left_t_ms = Some(t);
        }
        self.roster.is_empty()
    }

    /// `CHUNK_SECS` have passed since the last chunk was written. An open
    /// chunk is then sealed; with none open a keep-alive chunk is written.
    /// Measuring from the last write (not the open chunk's first record)
    /// keeps objects at most `CHUNK_SECS` apart while anyone is present, and
    /// a chunk still never spans more than `CHUNK_SECS`.
    fn write_due(&self, rec: &HuddleRecorder, t: u32) -> bool {
        u64::from(t.saturating_sub(self.last_sealed_t)) >= rec.chunk_span_ms
    }

    /// Write a chunk holding only the present roster (`type=2` records, the
    /// same shape as a chunk's opening re-statement) and seal it at once.
    fn write_keepalive(&mut self, rec: &HuddleRecorder, t: u32) {
        if self.roster.is_empty() {
            return;
        }
        let t = self.monotonic(t);
        self.open_chunk(t);
        self.seal(rec, t);
    }

    /// Append one record, sealing the open chunk first when the record would
    /// cross the chunk span or size limit. A new chunk starts by re-stating
    /// every present participant as `type=2`.
    fn append(&mut self, rec: &HuddleRecorder, record: Record<'_>) {
        let t = record.t_ms();
        let too_big = self.chunk.as_ref().is_some_and(|chunk| {
            chunk.buf.len() + record.encoded_len() > rec.limits.max_chunk_bytes
        });
        if too_big || (self.chunk.is_some() && self.write_due(rec, t)) {
            self.seal(rec, t);
        }
        if self.chunk.is_none() {
            self.open_chunk(t);
        }
        let Some(chunk) = self.chunk.as_mut() else {
            return;
        };
        if let Err(e) = record.encode_into(&mut chunk.buf) {
            warn!(session_id = %self.id, "huddle recorder: record not written: {e}");
            return;
        }
        chunk.records += 1;
        chunk.last_t = chunk.last_t.max(t);
    }

    fn open_chunk(&mut self, t: u32) {
        let header = ChunkHeader {
            protocol_version: self.protocol_version,
            session_id: self.id,
            chunk_seq: self.next_seq,
            session_start_unix_ms: self.start_unix_ms,
        };
        let mut chunk = OpenChunk {
            seq: self.next_seq,
            buf: Vec::with_capacity(64 * 1024),
            records: 0,
            first_t: t,
            last_t: t,
        };
        self.next_seq = self.next_seq.saturating_add(1);
        chunk.buf.extend_from_slice(&header.encode());
        for (&(peer_index, epoch), &pubkey) in &self.roster {
            let restated = Record::Join {
                t_ms: t,
                peer_index,
                epoch,
                pubkey,
            };
            if restated.encode_into(&mut chunk.buf).is_ok() {
                chunk.records += 1;
            }
        }
        self.chunk = Some(chunk);
    }

    /// Close the open chunk at session time `t` and upload it in the
    /// background.
    fn seal(&mut self, rec: &HuddleRecorder, t: u32) {
        while let Some(result) = self.uploads.try_join_next() {
            self.settle(result);
        }
        let Some(chunk) = self.chunk.take() else {
            return;
        };
        self.last_sealed_t = self.last_sealed_t.max(t);
        let key = format::chunk_key(
            &rec.prefix,
            self.community_id,
            self.channel_id,
            self.id,
            chunk.seq,
        );
        let entry = ManifestChunk {
            seq: chunk.seq,
            key: key.clone(),
            bytes: u64::try_from(chunk.buf.len()).unwrap_or(u64::MAX),
            records: chunk.records,
            first_t_ms: chunk.first_t,
            last_t_ms: chunk.last_t,
        };
        let sink = Arc::clone(&rec.sink);
        let backoff = rec.limits.retry_backoff.clone();
        self.uploads.spawn(async move {
            let stored = put_with_retry(
                sink.as_ref(),
                &key,
                &chunk.buf,
                format::CHUNK_CONTENT_TYPE,
                &backoff,
            )
            .await;
            (entry, stored)
        });
    }

    fn settle(&mut self, result: Result<(ManifestChunk, bool), tokio::task::JoinError>) {
        match result {
            Ok((entry, true)) => self.uploaded.push(entry),
            Ok((_, false)) | Err(_) => self.lost_chunks += 1,
        }
    }

    async fn write_manifest(
        mut self,
        rec: &HuddleRecorder,
        end_reason: EndReason,
        end_t: u32,
        dropped_frames: u64,
    ) {
        while let Some(result) = self.uploads.join_next().await {
            self.settle(result);
        }
        self.uploaded.sort_by_key(|chunk| chunk.seq);
        let manifest = Manifest {
            format: format::FORMAT.to_string(),
            community_id: self.community_id,
            channel_id: self.channel_id,
            parent_channel_id: self.parent_channel_id,
            session_id: self.id,
            started_at: format::format_utc_millis(self.start_unix_ms),
            ended_at: format::format_utc_millis(
                self.start_unix_ms.saturating_add(u64::from(end_t)),
            ),
            duration_ms: u64::from(end_t),
            protocol_version: self.protocol_version,
            end_reason,
            chunks: std::mem::take(&mut self.uploaded),
            participants: self
                .participants
                .iter()
                .map(|span| ManifestParticipant {
                    pubkey: span.pubkey.clone(),
                    peer_index: span.peer_index,
                    epoch: span.epoch,
                    joined_t_ms: span.joined_t_ms,
                    left_t_ms: span.left_t_ms.unwrap_or(end_t),
                })
                .collect(),
            dropped_frames,
            lost_chunks: self.lost_chunks,
        };
        let body = match serde_json::to_vec_pretty(&manifest) {
            Ok(body) => body,
            Err(e) => {
                warn!(session_id = %self.id, "huddle recorder: manifest not encoded: {e}");
                return;
            }
        };
        let key = format::manifest_key(&rec.prefix, self.community_id, self.channel_id, self.id);
        let stored = put_with_retry(
            rec.sink.as_ref(),
            &key,
            &body,
            format::MANIFEST_CONTENT_TYPE,
            &rec.limits.retry_backoff,
        )
        .await;
        if stored {
            info!(
                session_id = %self.id,
                channel_id = %self.channel_id,
                ?end_reason,
                duration_ms = end_t,
                chunks = manifest.chunks.len(),
                lost_chunks = manifest.lost_chunks,
                dropped_frames,
                "huddle recording session stored"
            );
        } else {
            warn!(
                session_id = %self.id,
                channel_id = %self.channel_id,
                "huddle recording manifest not stored; its chunks have no manifest"
            );
        }
    }
}

/// Write one object, retrying with `backoff` between attempts. Returns
/// whether it was stored.
async fn put_with_retry(
    sink: &dyn RecordingSink,
    key: &str,
    body: &[u8],
    content_type: &str,
    backoff: &[Duration],
) -> bool {
    let mut attempt = 0usize;
    loop {
        let result =
            tokio::time::timeout(UPLOAD_ATTEMPT_TIMEOUT, sink.put(key, body, content_type))
                .await
                .unwrap_or(Err(RecorderError::Timeout));
        let error = match result {
            Ok(()) => return true,
            Err(error) => error,
        };
        let Some(delay) = backoff.get(attempt) else {
            warn!(
                key,
                attempts = attempt + 1,
                "huddle recording write failed: {error}"
            );
            return false;
        };
        debug!(
            key,
            attempt = attempt + 1,
            "huddle recording write failed, retrying: {error}"
        );
        tokio::time::sleep(*delay).await;
        attempt += 1;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use buzz_huddle_recording::decode_chunk;
    use buzz_relay_mesh::{FencedHeader, MeshDatagram, RuntimeId};

    use super::*;
    use crate::audio::mesh::MeshAudioRouter;
    use crate::audio::room::AudioRoomManager;

    const T0_UNIX_MS: u64 = 1_791_781_200_000;

    /// Monotonic + wall clock that only moves when told to.
    struct ManualClock {
        base: Instant,
        offset_ms: AtomicU64,
    }

    impl ManualClock {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                base: Instant::now(),
                offset_ms: AtomicU64::new(0),
            })
        }

        fn advance(&self, ms: u64) {
            self.offset_ms.fetch_add(ms, Ordering::SeqCst);
        }

        /// Jump to `ms` after the base, also backwards, to imitate a sender
        /// that stamped its time before another sender enqueued.
        fn set(&self, ms: u64) {
            self.offset_ms.store(ms, Ordering::SeqCst);
        }
    }

    impl RecorderClock for ManualClock {
        fn now(&self) -> Instant {
            self.base + Duration::from_millis(self.offset_ms.load(Ordering::SeqCst))
        }

        fn unix_ms(&self) -> u64 {
            T0_UNIX_MS + self.offset_ms.load(Ordering::SeqCst)
        }
    }

    /// Keeps objects in put order; can refuse chunk writes.
    #[derive(Default)]
    struct MemorySink {
        objects: Mutex<Vec<(String, Vec<u8>)>>,
        attempts: Mutex<HashMap<String, u32>>,
        fail_chunks: bool,
    }

    #[async_trait::async_trait]
    impl RecordingSink for MemorySink {
        async fn put(&self, key: &str, body: &[u8], _: &str) -> Result<(), RecorderError> {
            *self
                .attempts
                .lock()
                .expect("attempts lock")
                .entry(key.to_string())
                .or_default() += 1;
            if self.fail_chunks && key.ends_with(".bhr") {
                return Err(RecorderError::Storage("injected failure".into()));
            }
            self.objects
                .lock()
                .expect("objects lock")
                .push((key.to_string(), body.to_vec()));
            Ok(())
        }
    }

    impl MemorySink {
        fn keys(&self) -> Vec<String> {
            let objects = self.objects.lock().expect("objects lock");
            objects.iter().map(|(key, _)| key.clone()).collect()
        }

        fn get(&self, key: &str) -> Vec<u8> {
            let objects = self.objects.lock().expect("objects lock");
            objects
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, body)| body.clone())
                .unwrap_or_else(|| panic!("no object {key}"))
        }

        fn manifests(&self) -> Vec<Manifest> {
            let objects = self.objects.lock().expect("objects lock");
            objects
                .iter()
                .filter(|(key, _)| key.ends_with("/manifest.json"))
                .map(|(_, body)| serde_json::from_slice(body).expect("manifest parses"))
                .collect()
        }
    }

    #[derive(Debug, PartialEq, Eq)]
    enum Rec {
        Join(u32, u8, u8, [u8; 32]),
        Leave(u32, u8, u8, [u8; 32]),
        Frame(u32, u8, u8, Vec<u8>),
    }

    fn decode(bytes: &[u8]) -> (ChunkHeader, Vec<Rec>) {
        let (header, records) = decode_chunk(bytes).expect("chunk header");
        let records = records
            .map(|record| match record.expect("record decodes") {
                Record::Join {
                    t_ms,
                    peer_index,
                    epoch,
                    pubkey,
                } => Rec::Join(t_ms, peer_index, epoch, pubkey),
                Record::Leave {
                    t_ms,
                    peer_index,
                    epoch,
                    pubkey,
                } => Rec::Leave(t_ms, peer_index, epoch, pubkey),
                Record::Frame {
                    t_ms,
                    peer_index,
                    epoch,
                    payload,
                } => Rec::Frame(t_ms, peer_index, epoch, payload.to_vec()),
            })
            .collect();
        (header, records)
    }

    /// Fast test limits: no ticking, no retry waits.
    fn limits() -> Limits {
        Limits {
            tick: Duration::from_secs(3600),
            retry_backoff: Vec::new(),
            ..Limits::default()
        }
    }

    fn recorder(
        sink: Arc<dyn RecordingSink>,
        clock: &Arc<ManualClock>,
        chunk_secs: u64,
        limits: Limits,
        shutting_down: &Arc<AtomicBool>,
    ) -> Arc<HuddleRecorder> {
        Arc::new(HuddleRecorder::new(
            sink,
            "huddles".into(),
            Duration::from_secs(chunk_secs),
            Arc::clone(clock) as Arc<dyn RecorderClock>,
            Arc::clone(shutting_down),
            limits,
        ))
    }

    fn manager(recorder: &Arc<HuddleRecorder>) -> Arc<AudioRoomManager> {
        let manager = Arc::new(AudioRoomManager::new());
        assert!(manager.install_recorder(Arc::clone(recorder)).is_ok());
        manager
    }

    fn community() -> CommunityId {
        CommunityId::from_uuid(Uuid::from_u128(0xC0))
    }

    fn pk(byte: u8) -> String {
        hex::encode([byte; 32])
    }

    async fn eventually(mut done: impl FnMut() -> bool) {
        for _ in 0..400 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("condition not reached within 2s");
    }

    fn no_shutdown() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    /// The whole path on the real local sink: join → frames → leave → room
    /// empty produces one chunk and then `manifest.json` with every field
    /// derived from what the room relayed.
    #[tokio::test]
    async fn local_sink_session_ends_with_manifest_when_the_room_empties() {
        let dir = tempfile::tempdir().expect("tempdir");
        let clock = ManualClock::new();
        let sink = Arc::new(LocalSink::new(dir.path().to_path_buf()).expect("local sink"));
        let recorder = recorder(sink, &clock, 30, limits(), &no_shutdown());
        let rooms = manager(&recorder);
        let channel = Uuid::from_u128(0xCA);
        let parent = Uuid::from_u128(0xFA);
        let room = rooms.get_or_create(community(), channel);
        assert!(room.is_recording());

        let (alice, ..) = room.add_peer(pk(0xa1), 2).expect("alice admits");
        room.note_parent_channel(parent);
        clock.advance(20);
        let (bob, ..) = room.add_peer(pk(0xb2), 2).expect("bob admits");
        clock.advance(20);
        room.broadcast_frame(alice, Bytes::from_static(b"alice-frame"));
        clock.advance(20);
        room.broadcast_frame(bob, Bytes::from_static(b"bob-frame"));
        clock.advance(1000);
        room.remove_peer_and_check_ended(alice)
            .expect("alice leaves");
        clock.advance(500);
        let (_, ended) = room.remove_peer_and_check_ended(bob).expect("bob leaves");
        assert!(ended, "the last leave empties the room");

        let session_root = dir
            .path()
            .join("huddles")
            .join(community().to_string())
            .join(channel.to_string());
        let manifest_path = || {
            std::fs::read_dir(&session_root)
                .ok()
                .and_then(|mut dirs| dirs.next())
                .and_then(|entry| entry.ok())
                .map(|entry| entry.path().join("manifest.json"))
                .filter(|path| path.exists())
        };
        eventually(|| manifest_path().is_some()).await;
        assert!(recorder.shutdown(Duration::from_secs(5)).await);

        let session_dirs = std::fs::read_dir(&session_root)
            .expect("session root")
            .count();
        assert_eq!(session_dirs, 1, "one room occupancy is one session");
        let manifest_path = manifest_path().expect("manifest exists");
        let session_dir = manifest_path.parent().expect("session dir").to_path_buf();
        let manifest: Manifest =
            serde_json::from_slice(&std::fs::read(&manifest_path).expect("read manifest"))
                .expect("manifest parses");
        let mut names: Vec<String> = std::fs::read_dir(&session_dir)
            .expect("session dir")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();
        assert_eq!(
            names,
            ["chunk-000000.bhr", "manifest.json"],
            "no .part files left"
        );

        let chunk = std::fs::read(session_dir.join("chunk-000000.bhr")).expect("chunk");
        let base = format::session_path(
            "huddles",
            *community().as_uuid(),
            channel,
            manifest.session_id,
        );
        assert_eq!(
            manifest,
            Manifest {
                format: "buzz-huddle-recording/1".into(),
                community_id: *community().as_uuid(),
                channel_id: channel,
                parent_channel_id: Some(parent),
                session_id: manifest.session_id,
                started_at: format::format_utc_millis(T0_UNIX_MS),
                ended_at: format::format_utc_millis(T0_UNIX_MS + 1560),
                duration_ms: 1560,
                protocol_version: 2,
                end_reason: EndReason::RoomEmpty,
                chunks: vec![ManifestChunk {
                    seq: 0,
                    key: format!("{base}/chunk-000000.bhr"),
                    bytes: chunk.len() as u64,
                    records: 6,
                    first_t_ms: 0,
                    last_t_ms: 1560,
                }],
                participants: vec![
                    ManifestParticipant {
                        pubkey: pk(0xa1),
                        peer_index: 0,
                        epoch: 0,
                        joined_t_ms: 0,
                        left_t_ms: 1060,
                    },
                    ManifestParticipant {
                        pubkey: pk(0xb2),
                        peer_index: 1,
                        epoch: 0,
                        joined_t_ms: 20,
                        left_t_ms: 1560,
                    },
                ],
                dropped_frames: 0,
                lost_chunks: 0,
            }
        );

        let (header, records) = decode(&chunk);
        assert_eq!(
            header,
            ChunkHeader {
                protocol_version: 2,
                session_id: manifest.session_id,
                chunk_seq: 0,
                session_start_unix_ms: T0_UNIX_MS,
            }
        );
        assert_eq!(
            records,
            vec![
                Rec::Join(0, 0, 0, [0xa1; 32]),
                Rec::Join(20, 1, 0, [0xb2; 32]),
                Rec::Frame(40, 0, 0, b"alice-frame".to_vec()),
                Rec::Frame(60, 1, 0, b"bob-frame".to_vec()),
                Rec::Leave(1060, 0, 0, [0xa1; 32]),
                Rec::Leave(1560, 1, 0, [0xb2; 32]),
            ]
        );
    }

    /// `CHUNK_SECS` splits chunks; every new chunk re-states who is present
    /// before its first record; `manifest.json` is the last object written.
    #[tokio::test]
    async fn chunks_split_by_span_restate_the_roster_and_manifest_is_last() {
        let clock = ManualClock::new();
        let sink = Arc::new(MemorySink::default());
        let recorder = recorder(sink.clone(), &clock, 1, limits(), &no_shutdown());
        let rooms = manager(&recorder);
        let room = rooms.get_or_create(community(), Uuid::from_u128(0xCA));

        let (alice, ..) = room.add_peer(pk(0xa1), 3).expect("alice");
        clock.advance(100);
        let (bob, ..) = room.add_peer(pk(0xb2), 3).expect("bob");
        clock.advance(100);
        room.broadcast_frame(alice, Bytes::from_static(b"a1"));
        clock.advance(1000); // t = 1200: span of chunk 0 reached
        room.broadcast_frame(bob, Bytes::from_static(b"b1"));
        clock.advance(1100); // t = 2300: span of chunk 1 reached
        room.broadcast_frame(alice, Bytes::from_static(b"a2"));
        clock.advance(100);
        room.remove_peer_and_check_ended(bob).expect("bob leaves");
        clock.advance(100);
        room.remove_peer_and_check_ended(alice)
            .expect("alice leaves");

        eventually(|| !sink.manifests().is_empty()).await;
        assert!(recorder.shutdown(Duration::from_secs(5)).await);

        let keys = sink.keys();
        assert!(
            keys.last()
                .is_some_and(|key| key.ends_with("/manifest.json")),
            "manifest must be written last: {keys:?}"
        );
        let manifest = &sink.manifests()[0];
        let spans: Vec<_> = manifest
            .chunks
            .iter()
            .map(|c| (c.seq, c.records, c.first_t_ms, c.last_t_ms))
            .collect();
        assert_eq!(
            spans,
            vec![(0, 3, 0, 200), (1, 3, 1200, 1200), (2, 5, 2300, 2500)]
        );

        let a = [0xa1; 32];
        let b = [0xb2; 32];
        let expected = [
            vec![
                Rec::Join(0, 0, 0, a),
                Rec::Join(100, 1, 0, b),
                Rec::Frame(200, 0, 0, b"a1".to_vec()),
            ],
            vec![
                Rec::Join(1200, 0, 0, a),
                Rec::Join(1200, 1, 0, b),
                Rec::Frame(1200, 1, 0, b"b1".to_vec()),
            ],
            vec![
                Rec::Join(2300, 0, 0, a),
                Rec::Join(2300, 1, 0, b),
                Rec::Frame(2300, 0, 0, b"a2".to_vec()),
                Rec::Leave(2400, 1, 0, b),
                Rec::Leave(2500, 0, 0, a),
            ],
        ];
        for (chunk, expected) in manifest.chunks.iter().zip(expected) {
            let (header, records) = decode(&sink.get(&chunk.key));
            assert_eq!(header.chunk_seq, chunk.seq);
            assert_eq!(header.session_id, manifest.session_id);
            assert_eq!(header.protocol_version, 3);
            assert_eq!(records, expected, "chunk {}", chunk.seq);
        }
    }

    /// A chunk is sealed before a record would push it past the size limit.
    #[tokio::test]
    async fn chunks_split_before_exceeding_the_size_limit() {
        let clock = ManualClock::new();
        let sink = Arc::new(MemorySink::default());
        // header 36 + join 39 + one 50-byte frame record 59 = 134 bytes.
        let limits = Limits {
            max_chunk_bytes: 140,
            ..limits()
        };
        let recorder = recorder(sink.clone(), &clock, 30, limits, &no_shutdown());
        let rooms = manager(&recorder);
        let room = rooms.get_or_create(community(), Uuid::from_u128(0xCA));
        let (alice, ..) = room.add_peer(pk(0xa1), 2).expect("alice");
        for _ in 0..3 {
            room.broadcast_frame(alice, Bytes::from(vec![7u8; 50]));
        }
        room.remove_peer_and_check_ended(alice)
            .expect("alice leaves");

        eventually(|| !sink.manifests().is_empty()).await;
        let manifest = &sink.manifests()[0];
        let sizes: Vec<_> = manifest
            .chunks
            .iter()
            .map(|c| (c.bytes, c.records))
            .collect();
        assert_eq!(sizes, vec![(134, 2), (134, 2), (134, 2), (114, 2)]);
        for chunk in &manifest.chunks {
            assert_eq!(sink.get(&chunk.key).len() as u64, chunk.bytes);
        }
    }

    /// A full recorder queue drops frames and counts them; the relay's own
    /// fan-out is untouched and `broadcast_frame` never waits.
    #[tokio::test]
    async fn full_queue_drops_and_counts_frames_without_blocking_fan_out() {
        let clock = ManualClock::new();
        let sink = Arc::new(MemorySink::default());
        let limits = Limits {
            frame_capacity: 4,
            ..limits()
        };
        let recorder = recorder(sink.clone(), &clock, 30, limits, &no_shutdown());
        let rooms = manager(&recorder);
        let room = rooms.get_or_create(community(), Uuid::from_u128(0xCA));
        let (alice, ..) = room.add_peer(pk(0xa1), 2).expect("alice");
        let (bob, _, _, mut bob_audio, ..) = room.add_peer(pk(0xb2), 2).expect("bob");

        // Current-thread runtime: the recorder task cannot run until we
        // await, so its queue fills exactly.
        for i in 0..10u8 {
            room.broadcast_frame(alice, Bytes::from(vec![i]));
        }
        let mut delivered = 0;
        while bob_audio.try_recv().is_ok() {
            delivered += 1;
        }
        assert_eq!(delivered, 8, "fan-out still fills bob's 8-frame queue");

        room.remove_peer_and_check_ended(alice)
            .expect("alice leaves");
        room.remove_peer_and_check_ended(bob).expect("bob leaves");
        eventually(|| !sink.manifests().is_empty()).await;
        let manifest = &sink.manifests()[0];
        assert_eq!(manifest.dropped_frames, 6);
        let (_, records) = decode(&sink.get(&manifest.chunks[0].key));
        let frames: Vec<_> = records
            .iter()
            .filter_map(|r| match r {
                Rec::Frame(_, _, _, payload) => Some(payload.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(frames, vec![vec![0], vec![1], vec![2], vec![3]]);
    }

    /// Recording off: no recorder is built and rooms carry no handle.
    #[test]
    fn recording_off_builds_nothing() {
        let off = HuddleRecorder::from_config(&HuddleRecordingConfig::off(), no_shutdown())
            .expect("off config");
        assert!(off.is_none());
        let rooms = AudioRoomManager::new();
        assert!(rooms.recorder().is_none());
        assert!(!rooms
            .get_or_create(community(), Uuid::from_u128(0xCA))
            .is_recording());
    }

    /// A mesh mirror (owner elsewhere) stores nothing even though its room has
    /// a recorder handle; the owner records a remote participant's frame that
    /// arrives as a datagram, with the v3 prefix stripped.
    #[tokio::test]
    async fn mesh_mirror_records_nothing_and_owner_records_remote_ingress() {
        let clock = ManualClock::new();
        let sink = Arc::new(MemorySink::default());
        let recorder = recorder(sink.clone(), &clock, 30, limits(), &no_shutdown());
        let local = RuntimeId([1; 32]);
        let elsewhere = RuntimeId([2; 32]);

        // Mirror pod: two local clients admitted at owner-assigned indices,
        // the owner's fan-out of one of them arriving over the mesh.
        let mirror_channel = Uuid::from_u128(0xA0);
        let mirror_rooms = manager(&recorder);
        let mirror = mirror_rooms.get_or_create(community(), mirror_channel);
        let (m1, ..) = mirror
            .add_peer_at_index(pk(0x11), 3, 4)
            .expect("mirror admit 4");
        let (m2, ..) = mirror
            .add_peer_at_index(pk(0x12), 3, 5)
            .expect("mirror admit 5");
        let mirror_router = MeshAudioRouter::new(Arc::clone(&mirror_rooms), local);
        mirror_router.on_media_datagram(&MeshDatagram {
            fenced: FencedHeader {
                session_id: mirror_channel,
                generation: 1,
                owner_runtime_id: elsewhere,
            },
            seq: 0,
            payload: vec![5, 0, b'm'],
        });
        mirror.deliver_prefixed(5, Bytes::from_static(&[5, 0, b'm']));
        mirror.remove_peer(m1);
        mirror.remove_peer(m2);

        // Owner pod: the remote participant was admitted by the owner.
        let owner_channel = Uuid::from_u128(0xB0);
        let owner_rooms = manager(&recorder);
        let owner = owner_rooms.get_or_create(community(), owner_channel);
        let (remote, index, epoch, ..) = owner.add_peer(pk(0x22), 3).expect("owner admit");
        let owner_router = MeshAudioRouter::new(Arc::clone(&owner_rooms), local);
        let datagram = |owner_runtime_id, body: &[u8]| {
            let mut payload = vec![index, epoch];
            payload.extend_from_slice(body);
            MeshDatagram {
                fenced: FencedHeader {
                    session_id: owner_channel,
                    generation: 1,
                    owner_runtime_id,
                },
                seq: 0,
                payload,
            }
        };
        // Same room, but the header says another pod owns it: not ours.
        owner_router.on_media_datagram(&datagram(elsewhere, b"not-ours"));
        clock.advance(5);
        owner_router.on_media_datagram(&datagram(local, b"remote-frame"));
        clock.advance(5);
        owner
            .remove_peer_and_check_ended(remote)
            .expect("remote leaves");

        eventually(|| !sink.manifests().is_empty()).await;
        assert!(recorder.shutdown(Duration::from_secs(5)).await);

        let mirror_marker = mirror_channel.to_string();
        assert!(
            sink.keys().iter().all(|key| !key.contains(&mirror_marker)),
            "mirror must store nothing: {:?}",
            sink.keys()
        );
        let manifests = sink.manifests();
        assert_eq!(manifests.len(), 1);
        assert_eq!(manifests[0].channel_id, owner_channel);
        let (_, records) = decode(&sink.get(&manifests[0].chunks[0].key));
        assert_eq!(
            records,
            vec![
                Rec::Join(0, index, epoch, [0x22; 32]),
                Rec::Frame(5, index, epoch, b"remote-frame".to_vec()),
                Rec::Leave(10, index, epoch, [0x22; 32]),
            ]
        );
    }

    /// Past the maximum length the session ends as `max_duration` and the
    /// same participants continue in a new session whose first chunk
    /// re-states them at `t_ms = 0`.
    #[tokio::test]
    async fn long_session_rolls_over_with_max_duration() {
        let clock = ManualClock::new();
        let sink = Arc::new(MemorySink::default());
        let recorder = recorder(sink.clone(), &clock, 30, limits(), &no_shutdown());
        let rooms = manager(&recorder);
        let room = rooms.get_or_create(community(), Uuid::from_u128(0xCA));
        let (alice, ..) = room.add_peer(pk(0xa1), 2).expect("alice");
        let cut = MAX_SESSION.as_millis() as u64 + 5;
        clock.advance(cut);
        room.broadcast_frame(alice, Bytes::from_static(b"late"));
        clock.advance(100);
        room.remove_peer_and_check_ended(alice)
            .expect("alice leaves");

        eventually(|| sink.manifests().len() == 2).await;
        let manifests = sink.manifests();
        let first = manifests
            .iter()
            .find(|m| m.end_reason == EndReason::MaxDuration)
            .expect("first session");
        let second = manifests
            .iter()
            .find(|m| m.end_reason == EndReason::RoomEmpty)
            .expect("second session");
        assert_ne!(first.session_id, second.session_id);
        assert_eq!(first.duration_ms, cut);
        assert_eq!(first.participants[0].left_t_ms as u64, cut);
        assert_eq!(
            second.started_at,
            format::format_utc_millis(T0_UNIX_MS + cut)
        );
        assert_eq!(second.duration_ms, 100);
        assert_eq!(
            (
                second.participants[0].joined_t_ms,
                second.participants[0].left_t_ms
            ),
            (0, 100)
        );
        let (header, records) = decode(&sink.get(&second.chunks[0].key));
        assert_eq!(header.session_start_unix_ms, T0_UNIX_MS + cut);
        assert_eq!(
            records,
            vec![
                Rec::Join(0, 0, 0, [0xa1; 32]),
                Rec::Frame(0, 0, 0, b"late".to_vec()),
                Rec::Leave(100, 0, 0, [0xa1; 32]),
            ]
        );
    }

    /// SIGTERM semantics: a room that empties while the relay is shutting
    /// down ends as `shutdown`, and `shutdown()` finishes rooms still open.
    #[tokio::test]
    async fn shutdown_finishes_open_sessions_and_drained_rooms_as_shutdown() {
        let clock = ManualClock::new();
        let sink = Arc::new(MemorySink::default());
        let relay_shutting_down = no_shutdown();
        let recorder = recorder(sink.clone(), &clock, 30, limits(), &relay_shutting_down);
        let rooms = manager(&recorder);
        let open_channel = Uuid::from_u128(0xA1);
        let drained_channel = Uuid::from_u128(0xA2);

        let open = rooms.get_or_create(community(), open_channel);
        open.add_peer(pk(0xa1), 2).expect("alice");
        clock.advance(300);

        relay_shutting_down.store(true, Ordering::Release);
        let drained = rooms.get_or_create(community(), drained_channel);
        let (bob, ..) = drained.add_peer(pk(0xb2), 2).expect("bob");
        clock.advance(50);
        drained
            .remove_peer_and_check_ended(bob)
            .expect("bob leaves");
        eventually(|| !sink.manifests().is_empty()).await;

        assert!(recorder.shutdown(Duration::from_secs(5)).await);
        let manifests = sink.manifests();
        assert_eq!(manifests.len(), 2);
        for manifest in &manifests {
            assert_eq!(manifest.end_reason, EndReason::Shutdown, "{manifest:?}");
        }
        let open_manifest = manifests
            .iter()
            .find(|m| m.channel_id == open_channel)
            .expect("open room manifest");
        assert_eq!(open_manifest.duration_ms, 350);
        assert_eq!(open_manifest.participants[0].left_t_ms, 350);
        let drained_manifest = manifests
            .iter()
            .find(|m| m.channel_id == drained_channel)
            .expect("drained room manifest");
        assert_eq!(drained_manifest.duration_ms, 50);
    }

    /// A chunk that cannot be stored is retried, then counted as lost; the
    /// manifest is still written.
    #[tokio::test]
    async fn failed_chunk_uploads_are_retried_then_counted_lost() {
        let clock = ManualClock::new();
        let sink = Arc::new(MemorySink {
            fail_chunks: true,
            ..MemorySink::default()
        });
        let limits = Limits {
            retry_backoff: vec![Duration::ZERO, Duration::ZERO],
            ..limits()
        };
        let recorder = recorder(sink.clone(), &clock, 30, limits, &no_shutdown());
        let rooms = manager(&recorder);
        let room = rooms.get_or_create(community(), Uuid::from_u128(0xCA));
        let (alice, ..) = room.add_peer(pk(0xa1), 2).expect("alice");
        room.remove_peer_and_check_ended(alice)
            .expect("alice leaves");

        eventually(|| !sink.manifests().is_empty()).await;
        let manifest = &sink.manifests()[0];
        assert!(manifest.chunks.is_empty());
        assert_eq!(manifest.lost_chunks, 1);
        let attempts = sink.attempts.lock().expect("attempts lock");
        let chunk_attempts: Vec<u32> = attempts
            .iter()
            .filter(|(key, _)| key.ends_with(".bhr"))
            .map(|(_, n)| *n)
            .collect();
        assert_eq!(chunk_attempts, vec![3], "1 try + 2 retries");
    }

    /// With nobody talking, the idle tick still seals a chunk once its span
    /// is reached, so a long silence cannot keep one chunk open.
    #[tokio::test]
    async fn idle_tick_seals_a_chunk_after_its_span() {
        let clock = ManualClock::new();
        let sink = Arc::new(MemorySink::default());
        let limits = Limits {
            tick: Duration::from_millis(5),
            ..limits()
        };
        let recorder = recorder(sink.clone(), &clock, 1, limits, &no_shutdown());
        let rooms = manager(&recorder);
        let room = rooms.get_or_create(community(), Uuid::from_u128(0xCA));
        let (alice, ..) = room.add_peer(pk(0xa1), 2).expect("alice");
        room.broadcast_frame(alice, Bytes::from_static(b"hi"));
        tokio::task::yield_now().await;
        clock.advance(1500);

        eventually(|| sink.keys().iter().any(|k| k.ends_with("chunk-000000.bhr"))).await;
        assert!(sink.manifests().is_empty(), "the session is still open");
        room.remove_peer_and_check_ended(alice)
            .expect("alice leaves");
        eventually(|| !sink.manifests().is_empty()).await;
        let manifest = &sink.manifests()[0];
        let spans: Vec<_> = manifest
            .chunks
            .iter()
            .map(|c| (c.seq, c.first_t_ms, c.last_t_ms))
            .collect();
        assert_eq!(spans, vec![(0, 0, 0), (1, 1500, 1500)]);
    }
    /// Senders stamp `at` on their own threads before enqueueing, so a frame
    /// queued later can carry an earlier stamp. Stored `t_ms` must never go
    /// backwards — also across a chunk boundary — and each manifest chunk's
    /// `first_t_ms` is its earliest record.
    #[tokio::test]
    async fn record_times_never_go_backwards_when_stamps_arrive_out_of_order() {
        let clock = ManualClock::new();
        let sink = Arc::new(MemorySink::default());
        let recorder = recorder(sink.clone(), &clock, 1, limits(), &no_shutdown());
        let rooms = manager(&recorder);
        let room = rooms.get_or_create(community(), Uuid::from_u128(0xCA));
        let (alice, ..) = room.add_peer(pk(0xa1), 2).expect("alice");
        let (bob, ..) = room.add_peer(pk(0xb2), 2).expect("bob");
        clock.set(50);
        room.broadcast_frame(alice, Bytes::from_static(b"a1"));
        clock.set(30); // stamped before a1 was queued
        room.broadcast_frame(bob, Bytes::from_static(b"b1"));
        clock.set(1100); // chunk span reached: chunk 1 opens at 1100
        room.broadcast_frame(alice, Bytes::from_static(b"a2"));
        clock.set(900); // earlier than chunk 1's opening record
        room.broadcast_frame(bob, Bytes::from_static(b"b2"));
        clock.set(1200);
        room.remove_peer_and_check_ended(bob).expect("bob leaves");
        clock.set(1150);
        room.remove_peer_and_check_ended(alice)
            .expect("alice leaves");

        eventually(|| !sink.manifests().is_empty()).await;
        let manifest = &sink.manifests()[0];
        let a = [0xa1; 32];
        let b = [0xb2; 32];
        let expected = [
            vec![
                Rec::Join(0, 0, 0, a),
                Rec::Join(0, 1, 0, b),
                Rec::Frame(50, 0, 0, b"a1".to_vec()),
                Rec::Frame(50, 1, 0, b"b1".to_vec()),
            ],
            vec![
                Rec::Join(1100, 0, 0, a),
                Rec::Join(1100, 1, 0, b),
                Rec::Frame(1100, 0, 0, b"a2".to_vec()),
                Rec::Frame(1100, 1, 0, b"b2".to_vec()),
                Rec::Leave(1200, 1, 0, b),
                Rec::Leave(1200, 0, 0, a),
            ],
        ];
        let mut previous = 0;
        for (chunk, expected) in manifest.chunks.iter().zip(expected) {
            let (_, records) = decode(&sink.get(&chunk.key));
            assert_eq!(records, expected, "chunk {}", chunk.seq);
            let times: Vec<u32> = records
                .iter()
                .map(|r| match r {
                    Rec::Join(t, ..) | Rec::Leave(t, ..) | Rec::Frame(t, ..) => *t,
                })
                .collect();
            assert!(
                times[0] >= previous,
                "chunk {} starts before the last one ended",
                chunk.seq
            );
            assert!(
                times.windows(2).all(|w| w[0] <= w[1]),
                "t_ms went backwards: {times:?}"
            );
            assert_eq!(chunk.first_t_ms, times[0]);
            assert_eq!(chunk.last_t_ms, *times.last().expect("records"));
            previous = *times.last().expect("records");
        }
        assert_eq!(manifest.chunks.len(), 2);
        assert_eq!(manifest.duration_ms, 1200);
        let spans: Vec<_> = manifest
            .participants
            .iter()
            .map(|p| (p.joined_t_ms, p.left_t_ms))
            .collect();
        assert_eq!(spans, vec![(0, 1200), (0, 1200)]);
    }

    /// Local recordings are private audio: directories the sink creates are
    /// `0700`, files `0600` — including a stale `.part` a crash left behind.
    #[cfg(unix)]
    #[tokio::test]
    async fn local_sink_writes_owner_only_directories_and_files() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("recordings");
        let sink = LocalSink::new(root.clone()).expect("local sink");
        let session = root.join("huddles/c/ch/s");
        sink.put(
            "huddles/c/ch/s/chunk-000000.bhr",
            b"chunk",
            format::CHUNK_CONTENT_TYPE,
        )
        .await
        .expect("chunk put");
        let stale = session.join("manifest.json.part");
        std::fs::write(&stale, b"old").expect("stale part");
        std::fs::set_permissions(&stale, std::fs::Permissions::from_mode(0o644))
            .expect("loosen stale part");
        sink.put(
            "huddles/c/ch/s/manifest.json",
            b"{}",
            format::MANIFEST_CONTENT_TYPE,
        )
        .await
        .expect("manifest put");

        let mode = |path: &Path| {
            std::fs::metadata(path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777
        };
        for created in [
            root.clone(),
            root.join("huddles"),
            root.join("huddles/c"),
            root.join("huddles/c/ch"),
            session.clone(),
        ] {
            assert_eq!(mode(&created), 0o700, "{created:?}");
        }
        for file in ["chunk-000000.bhr", "manifest.json"] {
            assert_eq!(mode(&session.join(file)), 0o600, "{file}");
        }
        assert_eq!(
            std::fs::read(session.join("manifest.json")).expect("manifest"),
            b"{}"
        );
        assert!(!stale.exists(), "the .part file is renamed into place");
    }
    /// Everyone muted: no frames arrive, yet a roster-only chunk is written
    /// every `CHUNK_SECS` while someone is present, so the minutes worker
    /// never mistakes a live, silent huddle for a dead pod.
    #[tokio::test]
    async fn silent_room_writes_keepalive_chunks_every_chunk_span() {
        let clock = ManualClock::new();
        let sink = Arc::new(MemorySink::default());
        let limits = Limits {
            tick: Duration::from_millis(5),
            ..limits()
        };
        let recorder = recorder(sink.clone(), &clock, 1, limits, &no_shutdown());
        let rooms = manager(&recorder);
        let room = rooms.get_or_create(community(), Uuid::from_u128(0xCA));
        let (alice, ..) = room.add_peer(pk(0xa1), 2).expect("alice");
        let chunk_objects = || {
            sink.keys()
                .iter()
                .filter(|key| key.ends_with(".bhr"))
                .count()
        };
        // Walk past 3 x CHUNK_SECS with nobody talking: the joining chunk is
        // sealed at 1 s, then one keep-alive chunk per second.
        for (now, objects) in [(1000, 1), (2000, 2), (3000, 3)] {
            clock.set(now);
            eventually(|| chunk_objects() == objects).await;
        }
        clock.set(3500);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(chunk_objects(), 3, "no keep-alive before the next span");
        assert!(sink.manifests().is_empty(), "the session is still open");
        room.remove_peer_and_check_ended(alice)
            .expect("alice leaves");

        eventually(|| !sink.manifests().is_empty()).await;
        let manifest = &sink.manifests()[0];
        let a = [0xa1; 32];
        let chunks: Vec<_> = manifest
            .chunks
            .iter()
            .map(|c| {
                (
                    c.seq,
                    c.first_t_ms,
                    c.last_t_ms,
                    decode(&sink.get(&c.key)).1,
                )
            })
            .collect();
        assert_eq!(
            chunks,
            vec![
                (0, 0, 0, vec![Rec::Join(0, 0, 0, a)]),
                (1, 2000, 2000, vec![Rec::Join(2000, 0, 0, a)]),
                (2, 3000, 3000, vec![Rec::Join(3000, 0, 0, a)]),
                (
                    3,
                    3500,
                    3500,
                    vec![Rec::Join(3500, 0, 0, a), Rec::Leave(3500, 0, 0, a)]
                ),
            ]
        );
        assert_eq!(manifest.duration_ms, 3500);
    }

    /// While frames keep arriving, chunks are cut by the cadence and every
    /// one carries audio: no extra roster-only keep-alive chunk appears.
    #[tokio::test]
    async fn talking_room_writes_no_keepalive_chunks() {
        let clock = ManualClock::new();
        let sink = Arc::new(MemorySink::default());
        let limits = Limits {
            tick: Duration::from_millis(5),
            ..limits()
        };
        let recorder = recorder(sink.clone(), &clock, 1, limits, &no_shutdown());
        let rooms = manager(&recorder);
        let room = rooms.get_or_create(community(), Uuid::from_u128(0xCA));
        let (alice, ..) = room.add_peer(pk(0xa1), 2).expect("alice");
        for step in 1..=35u8 {
            clock.set(u64::from(step) * 100);
            room.broadcast_frame(alice, Bytes::from(vec![step]));
            // Let the 5 ms tick run between frames, as it would live.
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        room.remove_peer_and_check_ended(alice)
            .expect("alice leaves");

        eventually(|| !sink.manifests().is_empty()).await;
        let manifest = &sink.manifests()[0];
        assert!(manifest.chunks.len() >= 3, "{:?}", manifest.chunks);
        let mut frames = Vec::new();
        for chunk in &manifest.chunks {
            let (_, records) = decode(&sink.get(&chunk.key));
            let audio: Vec<u8> = records
                .iter()
                .filter_map(|r| match r {
                    Rec::Frame(_, _, _, payload) => payload.first().copied(),
                    _ => None,
                })
                .collect();
            assert!(
                !audio.is_empty(),
                "chunk {} carries no audio: {records:?}",
                chunk.seq
            );
            frames.extend(audio);
        }
        assert_eq!(
            frames,
            (1..=35u8).collect::<Vec<_>>(),
            "every frame once, in order"
        );
    }
}
