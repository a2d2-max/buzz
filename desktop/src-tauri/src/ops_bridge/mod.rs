mod client;
mod types;
mod watch;

use std::{path::PathBuf, sync::Arc};

use client::{OpsBridgeClient, OpsBridgeConfig, OpsBridgeError};
use types::{
    OpsBridgeCapabilities, OpsBridgeSnapshot, OpsDraftReceipt, OpsDraftRequest, OpsSelection,
    OpsTransitionReceipt, OpsTransitionRequest, OpsWatchStartResult, DEFAULT_HUB_PORT,
    MAX_RESPONSE_BYTES,
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

    pub(crate) fn stop_watch(&self) {
        self.watcher.stop();
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

#[tauri::command]
pub(crate) async fn ops_bridge_create_draft(
    request: OpsDraftRequest,
    state: tauri::State<'_, OpsBridgeState>,
) -> Result<OpsDraftReceipt, String> {
    state
        .client()
        .map_err(public_error)?
        .create_draft(&request)
        .await
        .map_err(public_error)
}

#[tauri::command]
pub(crate) async fn ops_bridge_transition(
    request: OpsTransitionRequest,
    state: tauri::State<'_, OpsBridgeState>,
) -> Result<OpsTransitionReceipt, String> {
    state
        .client()
        .map_err(public_error)?
        .transition(&request)
        .await
        .map_err(public_error)
}

#[tauri::command]
pub(crate) fn ops_bridge_start_watch(
    app: tauri::AppHandle,
    state: tauri::State<'_, OpsBridgeState>,
) -> Result<OpsWatchStartResult, String> {
    let started = state
        .watcher
        .start(app, state.client().map_err(public_error)?)
        .map_err(public_error)?;
    Ok(OpsWatchStartResult { started })
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

#[cfg(test)]
mod tests;
