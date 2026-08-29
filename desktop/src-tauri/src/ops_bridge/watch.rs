use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::Emitter;
use tokio_util::sync::CancellationToken;

use super::{
    client::{OpsBridgeClient, OpsBridgeError},
    types::{parse_event_sequence, OpsSyncAckRequest, OpsSyncAckResult},
};

const INVALIDATION_EVENT: &str = "buzz://ops-invalidated";
const MAX_SSE_LINE_BYTES: usize = 64 * 1024;
const MAX_PENDING_INVALIDATIONS: usize = 256;
const BACKOFF: [Duration; 5] = [
    Duration::from_millis(250),
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
];

/// Sanitized invalidation emitted to the webview. SSE `data` is never retained
/// or serialized.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct OpsInvalidationEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_type: Option<String>,
    pub connection_generation: u64,
    #[serde(skip_serializing_if = "is_false")]
    pub sync_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_sequence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub full_reload: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Default)]
pub(crate) struct ReconnectBackoff {
    index: usize,
}

impl ReconnectBackoff {
    pub(crate) fn next_delay(&mut self) -> Duration {
        let delay = BACKOFF[self.index.min(BACKOFF.len() - 1)];
        self.index = self.index.saturating_add(1).min(BACKOFF.len() - 1);
        delay
    }

    fn reset(&mut self) {
        self.index = 0;
    }
}

#[derive(Debug, Clone)]
struct SanitizedRecord {
    sequence: u64,
    event_id: String,
    event_type: String,
}

/// Explicit canonical-refetch barrier shared by the watcher task and the ACK
/// command. It retains only decimal sequence numbers and sanitized event types.
pub(crate) struct WatchSyncState {
    connection_generation: u64,
    connected_once: bool,
    sync_required: bool,
    required_anchor: Option<u64>,
    last_applied_sequence: Option<u64>,
    queued: VecDeque<SanitizedRecord>,
}

impl Default for WatchSyncState {
    fn default() -> Self {
        Self {
            connection_generation: 0,
            connected_once: false,
            sync_required: false,
            required_anchor: None,
            last_applied_sequence: None,
            queued: VecDeque::new(),
        }
    }
}

impl WatchSyncState {
    pub(crate) fn begin_connection(&mut self) -> OpsInvalidationEvent {
        self.connection_generation = self.connection_generation.saturating_add(1);
        let reason = if self.connected_once {
            "reconnect"
        } else {
            "initial"
        };
        self.connected_once = true;
        self.sync_required = true;
        self.required_anchor = self.last_applied_sequence;
        self.queued.clear();
        self.sync_event(reason)
    }

    pub(crate) fn observe(
        &mut self,
        event_id: &str,
        event_type: &str,
    ) -> Result<Vec<OpsInvalidationEvent>, OpsBridgeError> {
        let sequence =
            parse_event_sequence(event_id).map_err(|_| OpsBridgeError::InvalidRequest)?;
        let record = SanitizedRecord {
            sequence,
            event_id: event_id.to_owned(),
            event_type: event_type.to_owned(),
        };

        if event_type == "snapshot.required" {
            self.sync_required = true;
            self.required_anchor = Some(sequence);
            self.queued.clear();
            return Ok(vec![self.sync_event("control")]);
        }

        if self.sync_required {
            if self.queued.len() == MAX_PENDING_INVALIDATIONS {
                self.new_sync_generation("queue_overflow", Some(record))
                    .map(|event| vec![event])
            } else {
                self.queued.push_back(record);
                Ok(Vec::new())
            }
        } else {
            let applied = self.last_applied_sequence.unwrap_or(0);
            if sequence <= applied {
                Ok(Vec::new())
            } else if sequence == applied.saturating_add(1) {
                self.last_applied_sequence = Some(sequence);
                Ok(vec![self.live_event(record)])
            } else {
                self.new_sync_generation("gap", Some(record))
                    .map(|event| vec![event])
            }
        }
    }

    pub(crate) fn ack(
        &mut self,
        generation: u64,
        applied_sequence: &str,
    ) -> Result<(OpsSyncAckResult, Vec<OpsInvalidationEvent>), OpsBridgeError> {
        let applied =
            parse_event_sequence(applied_sequence).map_err(|_| OpsBridgeError::InvalidRequest)?;
        if generation != self.connection_generation || !self.sync_required {
            return Ok((self.ack_result(false), Vec::new()));
        }
        if self
            .required_anchor
            .is_some_and(|required| applied < required)
        {
            return Ok((self.ack_result(false), Vec::new()));
        }

        self.last_applied_sequence = Some(applied);
        self.sync_required = false;
        let mut emitted = Vec::new();
        while let Some(record) = self.queued.pop_front() {
            let current = self.last_applied_sequence.unwrap_or(0);
            if record.sequence <= current {
                continue;
            }
            if record.sequence == current.saturating_add(1) {
                self.last_applied_sequence = Some(record.sequence);
                emitted.push(self.live_event(record));
                continue;
            }
            let sync = self.new_sync_generation("gap", Some(record))?;
            emitted.push(sync);
            break;
        }
        Ok((self.ack_result(true), emitted))
    }

    pub(crate) fn last_event_id(&self) -> Option<String> {
        self.last_applied_sequence.map(|value| value.to_string())
    }

    pub(crate) fn status(&self) -> (u64, bool, Option<String>) {
        (
            self.connection_generation,
            self.sync_required,
            self.required_anchor.map(|value| value.to_string()),
        )
    }

    pub(crate) fn reset(&mut self) {
        self.connection_generation = self.connection_generation.saturating_add(1);
        self.connected_once = false;
        self.sync_required = false;
        self.required_anchor = None;
        self.last_applied_sequence = None;
        self.queued.clear();
    }

    fn new_sync_generation(
        &mut self,
        reason: &str,
        first_record: Option<SanitizedRecord>,
    ) -> Result<OpsInvalidationEvent, OpsBridgeError> {
        self.connection_generation = self.connection_generation.saturating_add(1);
        self.sync_required = true;
        self.required_anchor = self.last_applied_sequence;
        self.queued.clear();
        if let Some(record) = first_record {
            self.queued.push_back(record);
        }
        Ok(self.sync_event(reason))
    }

    fn sync_event(&self, reason: &str) -> OpsInvalidationEvent {
        OpsInvalidationEvent {
            event_id: None,
            event_type: None,
            connection_generation: self.connection_generation,
            sync_required: true,
            anchor_sequence: self.required_anchor.map(|value| value.to_string()),
            reason: Some(reason.to_owned()),
            full_reload: true,
        }
    }

    fn live_event(&self, record: SanitizedRecord) -> OpsInvalidationEvent {
        OpsInvalidationEvent {
            event_id: Some(record.event_id),
            event_type: Some(record.event_type),
            connection_generation: self.connection_generation,
            sync_required: false,
            anchor_sequence: None,
            reason: None,
            full_reload: false,
        }
    }

    fn ack_result(&self, accepted: bool) -> OpsSyncAckResult {
        OpsSyncAckResult {
            accepted,
            connection_generation: self.connection_generation,
        }
    }
}

type InvalidationEmitter = Arc<dyn Fn(OpsInvalidationEvent) + Send + Sync + 'static>;

struct WatchTask {
    cancel: CancellationToken,
    handle: tauri::async_runtime::JoinHandle<()>,
}

/// Owns at most one app-lifetime Ops SSE watcher.
pub(crate) struct OpsBridgeWatcher {
    task: Mutex<Option<WatchTask>>,
    running: Arc<AtomicBool>,
    sync: Arc<Mutex<WatchSyncState>>,
}

impl Default for OpsBridgeWatcher {
    fn default() -> Self {
        Self {
            task: Mutex::new(None),
            running: Arc::new(AtomicBool::new(false)),
            sync: Arc::new(Mutex::new(WatchSyncState::default())),
        }
    }
}

impl OpsBridgeWatcher {
    pub(crate) fn start(
        &self,
        app: tauri::AppHandle,
        client: Arc<OpsBridgeClient>,
    ) -> Result<bool, OpsBridgeError> {
        let emitter: InvalidationEmitter = Arc::new(move |event| {
            let _ = app.emit(INVALIDATION_EVENT, event);
        });
        self.start_with_emitter(client, emitter)
    }

    pub(crate) fn start_with_emitter(
        &self,
        client: Arc<OpsBridgeClient>,
        emitter: InvalidationEmitter,
    ) -> Result<bool, OpsBridgeError> {
        let mut task = self.task.lock().map_err(|_| OpsBridgeError::WatchState)?;
        if self.running.swap(true, Ordering::SeqCst) {
            return Ok(false);
        }
        if let Some(existing) = task.take() {
            existing.cancel.cancel();
            existing.handle.abort();
        }
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let running = Arc::clone(&self.running);
        let sync = Arc::clone(&self.sync);
        let handle = tauri::async_runtime::spawn(async move {
            let _running_guard = RunningGuard(running);
            watch_loop(client, emitter, task_cancel, sync).await;
        });
        *task = Some(WatchTask { cancel, handle });
        Ok(true)
    }

    pub(crate) fn stop(&self) {
        let Ok(mut task) = self.task.lock() else {
            return;
        };
        if let Some(task) = task.take() {
            task.cancel.cancel();
            task.handle.abort();
        }
        self.running.store(false, Ordering::SeqCst);
        if let Ok(mut sync) = self.sync.lock() {
            sync.reset();
        }
    }

    pub(crate) fn ack_sync(
        &self,
        request: &OpsSyncAckRequest,
    ) -> Result<(OpsSyncAckResult, Vec<OpsInvalidationEvent>), OpsBridgeError> {
        self.sync
            .lock()
            .map_err(|_| OpsBridgeError::WatchState)?
            .ack(request.generation, &request.applied_sequence)
    }

    pub(crate) fn sync_status(&self) -> Result<(u64, bool, Option<String>), OpsBridgeError> {
        self.sync
            .lock()
            .map_err(|_| OpsBridgeError::WatchState)
            .map(|sync| sync.status())
    }
}

struct RunningGuard(Arc<AtomicBool>);

impl Drop for RunningGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

async fn watch_loop(
    client: Arc<OpsBridgeClient>,
    emit: InvalidationEmitter,
    cancel: CancellationToken,
    sync: Arc<Mutex<WatchSyncState>>,
) {
    let mut backoff = ReconnectBackoff::default();
    loop {
        let last_event_id = sync.lock().ok().and_then(|state| state.last_event_id());
        let outcome = tokio::select! {
            _ = cancel.cancelled() => return,
            result = watch_once(&client, last_event_id.as_deref(), &emit, &cancel, &sync) => result,
        };
        if let Ok(outcome) = outcome {
            if outcome.received_event {
                backoff.reset();
            }
        }
        let delay = backoff.next_delay();
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(delay) => {}
        }
    }
}

struct WatchOutcome {
    received_event: bool,
}

async fn watch_once(
    client: &OpsBridgeClient,
    last_event_id: Option<&str>,
    emit: &InvalidationEmitter,
    cancel: &CancellationToken,
    sync: &Arc<Mutex<WatchSyncState>>,
) -> Result<WatchOutcome, OpsBridgeError> {
    let response = tokio::select! {
        _ = cancel.cancelled() => return Err(OpsBridgeError::Transport),
        response = client.event_stream(last_event_id) => response?,
    };
    let sync_event = sync
        .lock()
        .map_err(|_| OpsBridgeError::WatchState)?
        .begin_connection();
    emit(sync_event);
    let mut decoder = SseDecoder::new(last_event_id.map(str::to_owned));
    let mut stream = response.bytes_stream();
    let mut received_event = false;
    loop {
        let next = tokio::select! {
            _ = cancel.cancelled() => return Err(OpsBridgeError::Transport),
            next = stream.next() => next,
        };
        let Some(chunk) = next else {
            break;
        };
        let Ok(chunk) = chunk else {
            break;
        };
        let Ok(events) = decoder.push(&chunk) else {
            break;
        };
        for event in events {
            received_event = true;
            let outgoing = sync
                .lock()
                .map_err(|_| OpsBridgeError::WatchState)?
                .observe(&event.event_id, &event.event_type)?;
            for event in outgoing {
                emit(event);
            }
        }
    }
    Ok(WatchOutcome { received_event })
}

struct SseDecoder {
    buffer: Vec<u8>,
    current_event: Option<String>,
    pending_event_id: Option<String>,
    last_event_id: Option<String>,
}

impl SseDecoder {
    fn new(last_event_id: Option<String>) -> Self {
        Self {
            buffer: Vec::new(),
            current_event: None,
            pending_event_id: None,
            last_event_id,
        }
    }

    fn push(&mut self, bytes: &[u8]) -> Result<Vec<SanitizedRecord>, OpsBridgeError> {
        if self.buffer.len().saturating_add(bytes.len()) > MAX_SSE_LINE_BYTES
            && !bytes.contains(&b'\n')
        {
            return Err(OpsBridgeError::ResponseTooLarge);
        }
        self.buffer.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some(newline) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let mut line = self.buffer.drain(..=newline).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.len() > MAX_SSE_LINE_BYTES {
                return Err(OpsBridgeError::ResponseTooLarge);
            }
            if let Some(event) = self.process_line(&line)? {
                events.push(event);
            }
        }
        if self.buffer.len() > MAX_SSE_LINE_BYTES {
            return Err(OpsBridgeError::ResponseTooLarge);
        }
        Ok(events)
    }

    fn process_line(&mut self, line: &[u8]) -> Result<Option<SanitizedRecord>, OpsBridgeError> {
        if line.is_empty() {
            let Some(event_type) = self.current_event.take() else {
                self.pending_event_id = None;
                return Ok(None);
            };
            if let Some(event_id) = self.pending_event_id.take() {
                self.last_event_id = Some(event_id);
            }
            let Some(event_id) = self.last_event_id.clone() else {
                return Ok(None);
            };
            let sequence =
                parse_event_sequence(&event_id).map_err(|_| OpsBridgeError::InvalidRequest)?;
            return Ok(Some(SanitizedRecord {
                sequence,
                event_id,
                event_type,
            }));
        }
        if line.first() == Some(&b':') {
            return Ok(None);
        }
        let line = std::str::from_utf8(line).map_err(|_| OpsBridgeError::ResponseInvalidJson)?;
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "id" if valid_event_id(value) => self.pending_event_id = Some(value.to_owned()),
            "id" => return Err(OpsBridgeError::InvalidRequest),
            "event" if valid_event_type(value) => self.current_event = Some(value.to_owned()),
            "event" => return Err(OpsBridgeError::InvalidRequest),
            // Deliberately ignore data, retry, and unknown fields. They never
            // enter the webview invalidation payload or any persistent state.
            _ => {}
        }
        Ok(None)
    }
}

fn valid_event_id(value: &str) -> bool {
    value.len() <= 20 && parse_event_sequence(value).is_ok()
}

fn valid_event_type(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}
