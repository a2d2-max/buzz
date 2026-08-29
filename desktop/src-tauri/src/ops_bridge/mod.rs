mod client;
mod types;
mod watch;

use std::{path::PathBuf, sync::Arc};
use tauri::Emitter;

use crate::app_state::AppState;
use client::{OpsBridgeClient, OpsBridgeConfig, OpsBridgeError};
use types::{
    OpsBridgeCapabilities, OpsBridgeSnapshot, OpsDraftReceipt, OpsDraftRequest, OpsPageRequest,
    OpsPageResult, OpsSelection, OpsSyncAckRequest, OpsSyncAckResult, OpsTransitionReceipt,
    OpsTransitionRequest, OpsWatchStartResult, DEFAULT_HUB_PORT, MAX_RESPONSE_BYTES,
};
use watch::OpsBridgeWatcher;

/// App-lifetime native state for the strict loopback client and singleton
/// invalidation watcher.
pub(crate) struct OpsBridgeState {
    client: Result<Arc<OpsBridgeClient>, OpsBridgeError>,
    watcher: OpsBridgeWatcher,
}

impl OpsBridgeState {
    pub(crate) fn from_env() -> Self {
        let config = native_config();
        Self {
            client: config.and_then(OpsBridgeClient::new).map(Arc::new),
            watcher: OpsBridgeWatcher::default(),
        }
    }

    fn client(&self) -> Result<Arc<OpsBridgeClient>, OpsBridgeError> {
        self.client.clone()
    }

    pub(crate) async fn stop_watch(&self) -> Result<(), OpsBridgeError> {
        self.watcher.stop_async().await
    }

    pub(crate) fn stop_watch_now(&self) {
        self.watcher.stop_now();
    }
}

#[tauri::command]
pub(crate) async fn ops_bridge_capabilities(
    state: tauri::State<'_, OpsBridgeState>,
) -> Result<OpsBridgeCapabilities, String> {
    state
        .client()
        .map_err(public_error)?
        .capabilities()
        .await
        .map_err(public_error)
}

#[tauri::command]
pub(crate) async fn ops_bridge_snapshot(
    selection: OpsSelection,
    state: tauri::State<'_, OpsBridgeState>,
) -> Result<OpsBridgeSnapshot, String> {
    state
        .client()
        .map_err(public_error)?
        .snapshot(&selection)
        .await
        .map_err(public_error)
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OpsPageErrorCode {
    InvalidCursor,
    StaleCursor,
}

#[derive(Debug, serde::Serialize)]
#[serde(untagged)]
pub(crate) enum OpsPageCommandError {
    Cursor { error: OpsPageErrorCode },
    Bridge(String),
}

#[tauri::command]
pub(crate) async fn ops_bridge_page(
    request: OpsPageRequest,
    state: tauri::State<'_, OpsBridgeState>,
) -> Result<OpsPageResult, OpsPageCommandError> {
    state
        .client()
        .map_err(page_error)?
        .page(&request)
        .await
        .map_err(page_error)
}

#[tauri::command]
pub(crate) async fn ops_bridge_create_draft(
    request: OpsDraftRequest,
    bridge_state: tauri::State<'_, OpsBridgeState>,
    app_state: tauri::State<'_, AppState>,
) -> Result<OpsDraftReceipt, String> {
    app_state.require_active_identity()?;
    bridge_state
        .client()
        .map_err(public_error)?
        .create_draft(&request)
        .await
        .map_err(public_error)
}

#[tauri::command]
pub(crate) async fn ops_bridge_transition(
    request: OpsTransitionRequest,
    bridge_state: tauri::State<'_, OpsBridgeState>,
    app_state: tauri::State<'_, AppState>,
) -> Result<OpsTransitionReceipt, String> {
    request.validate_initial_profile().map_err(public_error)?;
    app_state.require_active_identity()?;
    bridge_state
        .client()
        .map_err(public_error)?
        .transition(&request)
        .await
        .map_err(public_error)
}

#[tauri::command]
pub(crate) async fn ops_bridge_start_watch(
    app: tauri::AppHandle,
    state: tauri::State<'_, OpsBridgeState>,
) -> Result<OpsWatchStartResult, String> {
    let started = state
        .watcher
        .start(app, state.client().map_err(public_error)?)
        .await
        .map_err(public_error)?;
    let (connection_generation, sync_required, anchor_sequence) =
        state.watcher.sync_status().map_err(public_error)?;
    Ok(OpsWatchStartResult {
        started,
        connection_generation,
        sync_required,
        anchor_sequence,
    })
}

#[tauri::command]
pub(crate) async fn ops_bridge_stop_watch(
    state: tauri::State<'_, OpsBridgeState>,
) -> Result<(), String> {
    state.stop_watch().await.map_err(public_error)
}

#[tauri::command]
pub(crate) async fn ops_bridge_ack_sync(
    request: OpsSyncAckRequest,
    app: tauri::AppHandle,
    state: tauri::State<'_, OpsBridgeState>,
) -> Result<OpsSyncAckResult, String> {
    state
        .watcher
        .ack_sync_with_emitter(
            &request,
            Arc::new(move |event| {
                let _ = app.emit("buzz://ops-invalidated", event);
            }),
        )
        .await
        .map_err(public_error)
}

fn native_config() -> Result<OpsBridgeConfig, OpsBridgeError> {
    let port = match std::env::var("BUZZ_OPS_HUB_PORT") {
        Ok(value) => value
            .parse::<u16>()
            .ok()
            .filter(|port| *port != 0)
            .ok_or(OpsBridgeError::InvalidConfig)?,
        Err(_) => DEFAULT_HUB_PORT,
    };
    let token_file = match std::env::var_os("BUZZ_OPS_HUB_TOKEN_FILE") {
        Some(path) => PathBuf::from(path),
        None => match std::env::var_os("HUB_STATE_DIR") {
            Some(directory) => PathBuf::from(directory).join("hub.token"),
            None => std::env::current_dir()
                .map(|directory| directory.join("state").join("hub.token"))
                .unwrap_or_default(),
        },
    };
    Ok(OpsBridgeConfig {
        port,
        token_file,
        max_response_bytes: MAX_RESPONSE_BYTES,
    })
}

fn public_error(error: OpsBridgeError) -> String {
    error.to_string()
}

fn page_error(error: OpsBridgeError) -> OpsPageCommandError {
    match error {
        OpsBridgeError::InvalidCursor => OpsPageCommandError::Cursor {
            error: OpsPageErrorCode::InvalidCursor,
        },
        OpsBridgeError::StaleCursor => OpsPageCommandError::Cursor {
            error: OpsPageErrorCode::StaleCursor,
        },
        _ => OpsPageCommandError::Bridge(public_error(error)),
    }
}

#[cfg(test)]
#[path = "tests/page_tests.rs"]
mod page_tests;
#[cfg(test)]
mod tests;
