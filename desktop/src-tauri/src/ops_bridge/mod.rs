mod artifacts;
mod capabilities;
mod client;
mod dormant;
mod page;
mod task5;
mod types;
mod watch;

use std::{path::PathBuf, sync::Arc};
use tauri::Emitter;

use crate::app_state::AppState;
pub(crate) use artifacts::OpsArtifactState;
use client::{OpsBridgeClient, OpsBridgeConfig, OpsBridgeError};
use page::OpsPageResult;
use task5::{OpsRepositoryDetailV1, OpsResearchDetailV1};
use types::{
    OpsArtifactHandleChunk, OpsArtifactHandleReadRequest, OpsArtifactHandleReleaseRequest,
    OpsArtifactHandleReleaseResult, OpsArtifactReadRequest, OpsArtifactReadResult,
    OpsBridgeCapabilities, OpsBridgeSnapshot, OpsDetailRequest, OpsDraftReceipt, OpsDraftRequest,
    OpsPageRequest, OpsSelection, OpsSyncAckRequest, OpsSyncAckResult, OpsTransitionReceipt,
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
    Unavailable,
    ContractInvalid,
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
pub(crate) async fn ops_bridge_research_detail(
    request: OpsDetailRequest,
    state: tauri::State<'_, OpsBridgeState>,
) -> Result<OpsResearchDetailV1, OpsPageCommandError> {
    state
        .client()
        .map_err(page_error)?
        .research_detail(&request)
        .await
        .map_err(page_error)
}

#[tauri::command]
pub(crate) async fn ops_bridge_repository_detail(
    request: OpsDetailRequest,
    state: tauri::State<'_, OpsBridgeState>,
) -> Result<OpsRepositoryDetailV1, OpsPageCommandError> {
    state
        .client()
        .map_err(page_error)?
        .repository_detail(&request)
        .await
        .map_err(page_error)
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OpsArtifactErrorCode {
    InvalidArtifactRequest,
    ArtifactNotFound,
    ArtifactVersionNotFound,
    ArtifactReadDenied,
    ArtifactIntegrityMismatch,
    ArtifactTooLarge,
    ArtifactMediaUnsupported,
}

#[derive(Debug, serde::Serialize)]
#[serde(untagged)]
pub(crate) enum OpsArtifactCommandError {
    Artifact { error: OpsArtifactErrorCode },
    Bridge(String),
}

#[tauri::command]
pub(crate) async fn ops_bridge_read_artifact(
    request: OpsArtifactReadRequest,
    bridge_state: tauri::State<'_, OpsBridgeState>,
    artifact_state: tauri::State<'_, OpsArtifactState>,
) -> Result<OpsArtifactReadResult, OpsArtifactCommandError> {
    request.validate().map_err(artifact_error)?;
    let client = bridge_state.client().map_err(artifact_error)?;
    let store = artifact_state.store().map_err(artifact_error)?;
    artifacts::read_verified_artifact(client, store, request)
        .await
        .map_err(artifact_error)
}

#[tauri::command]
pub(crate) fn ops_bridge_read_artifact_handle(
    request: OpsArtifactHandleReadRequest,
    artifact_state: tauri::State<'_, OpsArtifactState>,
) -> Result<OpsArtifactHandleChunk, OpsArtifactCommandError> {
    request.validate().map_err(artifact_error)?;
    artifact_state
        .store()
        .map_err(artifact_error)?
        .read_at(
            &request.handle,
            request.offset,
            request.length,
            std::time::SystemTime::now(),
        )
        .map_err(artifact_error)
}

#[tauri::command]
pub(crate) fn ops_bridge_release_artifact_handle(
    request: OpsArtifactHandleReleaseRequest,
    artifact_state: tauri::State<'_, OpsArtifactState>,
) -> Result<OpsArtifactHandleReleaseResult, OpsArtifactCommandError> {
    request.validate().map_err(artifact_error)?;
    let released = artifact_state
        .store()
        .map_err(artifact_error)?
        .release(&request.handle)
        .map_err(artifact_error)?;
    Ok(OpsArtifactHandleReleaseResult { released })
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
        OpsBridgeError::Unavailable => OpsPageCommandError::Cursor {
            error: OpsPageErrorCode::Unavailable,
        },
        OpsBridgeError::ResponseContentType
        | OpsBridgeError::ResponseTooLarge
        | OpsBridgeError::ResponseInvalidJson
        | OpsBridgeError::ContractMismatch => OpsPageCommandError::Cursor {
            error: OpsPageErrorCode::ContractInvalid,
        },
        _ => OpsPageCommandError::Bridge(public_error(error)),
    }
}

fn artifact_error(error: OpsBridgeError) -> OpsArtifactCommandError {
    let code = match error {
        OpsBridgeError::InvalidRequest | OpsBridgeError::InvalidArtifactRequest => {
            Some(OpsArtifactErrorCode::InvalidArtifactRequest)
        }
        OpsBridgeError::ArtifactNotFound => Some(OpsArtifactErrorCode::ArtifactNotFound),
        OpsBridgeError::ArtifactVersionNotFound => {
            Some(OpsArtifactErrorCode::ArtifactVersionNotFound)
        }
        OpsBridgeError::ArtifactReadDenied => Some(OpsArtifactErrorCode::ArtifactReadDenied),
        OpsBridgeError::ArtifactIntegrityMismatch => {
            Some(OpsArtifactErrorCode::ArtifactIntegrityMismatch)
        }
        OpsBridgeError::ArtifactTooLarge => Some(OpsArtifactErrorCode::ArtifactTooLarge),
        OpsBridgeError::ArtifactMediaUnsupported => {
            Some(OpsArtifactErrorCode::ArtifactMediaUnsupported)
        }
        _ => None,
    };
    match code {
        Some(error) => OpsArtifactCommandError::Artifact { error },
        None => OpsArtifactCommandError::Bridge(public_error(error)),
    }
}

#[cfg(test)]
#[path = "tests/artifact_tests.rs"]
mod artifact_tests;
#[cfg(test)]
#[path = "tests/dormant_page_tests.rs"]
mod dormant_page_tests;
#[cfg(test)]
#[path = "tests/page_tests.rs"]
mod page_tests;
#[cfg(test)]
#[path = "tests/task5_tests.rs"]
mod task5_tests;
#[cfg(test)]
mod tests;
