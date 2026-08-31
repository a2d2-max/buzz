use tauri::State;

use crate::app_state::AppState;

type CmdResult<T> = Result<T, String>;

fn require_mesh_command_identity(state: &AppState) -> Result<(), String> {
    state.require_active_identity()
}

#[tauri::command]
pub async fn mesh_start_node(
    _app: tauri::AppHandle,
    state: State<'_, AppState>,
    _request: serde_json::Value,
) -> CmdResult<serde_json::Value> {
    require_mesh_command_identity(&state)?;
    Err("mesh-llm feature not enabled".to_string())
}

#[tauri::command]
pub async fn mesh_stop_node(
    _app: tauri::AppHandle,
    _state: State<'_, AppState>,
) -> CmdResult<serde_json::Value> {
    Err("mesh-llm feature not enabled".to_string())
}

#[tauri::command]
pub async fn mesh_node_status(_state: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    Err("mesh-llm feature not enabled".to_string())
}

#[tauri::command]
pub async fn mesh_serving_usage(_state: State<'_, AppState>) -> CmdResult<serde_json::Value> {
    Err("mesh-llm feature not enabled".to_string())
}

#[tauri::command]
pub async fn mesh_installed_models(
    _state: State<'_, AppState>,
) -> CmdResult<Vec<serde_json::Value>> {
    Err("mesh-llm feature not enabled".to_string())
}

#[tauri::command]
pub async fn mesh_model_catalog() -> CmdResult<serde_json::Value> {
    Err("mesh-llm feature not enabled".to_string())
}

#[cfg(test)]
mod recovery_command_tests {
    use super::require_mesh_command_identity;
    use crate::app_state::build_app_state;
    use std::sync::atomic::Ordering;

    fn recovery_state(lost: bool, locked: bool) -> crate::AppState {
        let state = build_app_state();
        state.identity_lost.store(lost, Ordering::Release);
        state.keyring_locked.store(locked, Ordering::Release);
        state
    }

    #[test]
    fn mesh_start_rejects_lost_and_locked_identity() {
        for (lost, locked) in [(true, false), (false, true)] {
            let state = recovery_state(lost, locked);
            let error = require_mesh_command_identity(&state)
                .expect_err("recovery identity must not start mesh provider work");
            assert!(error.contains("recovery mode"));
        }
    }

    #[test]
    fn mesh_start_passes_recovery_gate_for_normal_identity() {
        let state = recovery_state(false, false);
        require_mesh_command_identity(&state)
            .expect("normal identity may reach mesh provider validation");
    }
}
