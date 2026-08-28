use std::{
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

use super::client::{OpsBridgeClient, OpsBridgeError};

const INVALIDATION_EVENT: &str = "buzz://ops-invalidated";
const MAX_SSE_LINE_BYTES: usize = 64 * 1024;
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
    pub event_id: String,
    pub event_type: String,
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

type InvalidationEmitter = Arc<dyn Fn(OpsInvalidationEvent) + Send + Sync + 'static>;

struct WatchTask {
    cancel: CancellationToken,
    handle: tauri::async_runtime::JoinHandle<()>,
}

/// Owns at most one app-lifetime Ops SSE watcher.
pub(crate) struct OpsBridgeWatcher {
    task: Mutex<Option<WatchTask>>,
    running: Arc<AtomicBool>,
}

impl Default for OpsBridgeWatcher {
    fn default() -> Self {
        Self {
            task: Mutex::new(None),
            running: Arc::new(AtomicBool::new(false)),
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
        let handle = tauri::async_runtime::spawn(async move {
            let _running_guard = RunningGuard(running);
            watch_loop(client, emitter, task_cancel).await;
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
) {
    let mut last_event_id: Option<String> = None;
    let mut backoff = ReconnectBackoff::default();
    loop {
        let outcome = tokio::select! {
            _ = cancel.cancelled() => return,
            result = watch_once(&client, last_event_id.as_deref(), &emit, &cancel) => result,
        };
        if let Ok(outcome) = outcome {
            if let Some(event_id) = outcome.last_event_id {
                last_event_id = Some(event_id);
            }
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
    last_event_id: Option<String>,
    received_event: bool,
}

async fn watch_once(
    client: &OpsBridgeClient,
    last_event_id: Option<&str>,
    emit: &InvalidationEmitter,
    cancel: &CancellationToken,
) -> Result<WatchOutcome, OpsBridgeError> {
    let response = tokio::select! {
        _ = cancel.cancelled() => return Err(OpsBridgeError::Transport),
        response = client.event_stream(last_event_id) => response?,
    };
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
            emit(event);
        }
    }
    Ok(WatchOutcome {
        last_event_id: decoder.last_event_id,
        received_event,
    })
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

    fn push(&mut self, bytes: &[u8]) -> Result<Vec<OpsInvalidationEvent>, OpsBridgeError> {
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

    fn process_line(
        &mut self,
        line: &[u8],
    ) -> Result<Option<OpsInvalidationEvent>, OpsBridgeError> {
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
            let full_reload = event_type == "snapshot.required";
            return Ok(Some(OpsInvalidationEvent {
                event_id,
                event_type,
                full_reload,
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
    !value.is_empty() && value.len() <= 20 && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn valid_event_type(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}
