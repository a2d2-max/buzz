//! Production-seam regression: an inbound access-policy change must not
//! COLD-START an agent that is not running.
//!
//! The `KIND_MANAGED_AGENT` arm used to derive relay URLs from the record's
//! stale scalar `runtime_pid` when no live runtime existed. `runtime_pid` is a
//! leftover of the pre-pair (one-runtime-per-agent) model: it survives a crash,
//! a previous launch, and an agent the user opted out of auto-start. Reading it
//! turned "another device edited this agent's access policy" into "spawn this
//! agent" — one more source of the runaway `buzz-acp` fan-out this branch caps.
//!
//! This drives the real inbound entrypoint
//! `reconcile_inbound_persona_event_blocking` over a `MockRuntime` `AppHandle`,
//! the same fn the live inbound subscription calls. Restoring the
//! `runtime_pid` fallback turns this row RED: the reconcile would return
//! `Some(InboundRuntimeRefresh::Local { .. })` and the caller would run
//! `start_local_agent_pairs_with_preflight`.

use super::{reconcile_inbound_persona_event_blocking, InboundRuntimeRefresh};
use crate::app_state::build_app_state;
use crate::managed_agents::{load_managed_agents, save_managed_agents, ManagedAgentRecord};
use nostr::JsonUtil;
use tauri::Manager;

const RELAY: &str = "wss://access-refresh-seam.example";

/// RAII override of a process env var; restores the prior value on drop so a
/// panicking assertion cannot leak `HOME` into the rest of the suite.
struct EnvVarGuard {
    key: String,
    prior: Option<std::ffi::OsString>,
}

impl EnvVarGuard {
    fn set(key: &str, value: &std::path::Path) -> Self {
        let prior = std::env::var_os(key);
        // SAFETY: the caller holds the crate-wide process-env lock.
        #[allow(deprecated)]
        unsafe {
            std::env::set_var(key, value)
        };
        Self {
            key: key.to_string(),
            prior,
        }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        #[allow(deprecated)]
        // SAFETY: the caller holds the crate-wide process-env lock.
        unsafe {
            match &self.prior {
                Some(value) => std::env::set_var(&self.key, value),
                None => std::env::remove_var(&self.key),
            }
        }
    }
}

/// A local agent the user has opted OUT of auto-start, carrying a stale
/// `runtime_pid` from a previous launch and no live runtime in this process.
fn opted_out_record(pubkey: &str) -> ManagedAgentRecord {
    let mut record: ManagedAgentRecord = serde_json::from_value(serde_json::json!({
        "pubkey": pubkey,
        "name": "Opted Out Agent",
        "relay_url": "",
        "acp_command": "buzz-acp",
        "agent_command": "goose",
        "agent_args": [],
        "mcp_command": "",
        "turn_timeout_seconds": 320,
        "parallelism": 4,
        "system_prompt": "Do the work.",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "last_started_at": null,
        "last_stopped_at": null,
        "last_exit_code": null,
        "last_error": null
    }))
    .unwrap();
    record.start_on_app_launch = false;
    // Stale: no such process, and no runtime is tracked for this pair.
    record.runtime_pid = Some(4_242_424);
    record.respond_to = crate::managed_agents::RespondTo::OwnerOnly;
    record
}

#[test]
fn inbound_access_change_never_cold_starts_an_agent_with_no_live_pair() {
    if crate::managed_agents::owner_only_access_build() {
        // An owner-only build projects every stored policy to the same runtime
        // gate, so `managed_agent_access_policy_changed` is always false and
        // the restart arm is unreachable by construction.
        return;
    }

    let _guard = crate::managed_agents::lock_path_mutex();
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let _home_guard = EnvVarGuard::set("HOME", &home);
    let _xdg_guard = EnvVarGuard::set("XDG_DATA_HOME", &home);

    let owner = nostr::Keys::generate();
    let agent_pubkey = nostr::Keys::generate().public_key().to_hex();

    let state = build_app_state();
    *state.keys.lock().unwrap() = owner.clone();
    *state.relay_url_override.lock().unwrap() = Some(RELAY.to_string());
    let app = tauri::test::mock_builder()
        .manage(state)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app builds headless");

    save_managed_agents(app.handle(), &[opted_out_record(&agent_pubkey)]).unwrap();
    assert!(
        app.state::<crate::app_state::AppState>()
            .managed_agent_processes
            .lock()
            .unwrap()
            .is_empty(),
        "fixture precondition: no live pair runtime for this agent"
    );

    // Another device widened this agent's access policy and published its
    // kind:30177 head.
    let mut published = opted_out_record(&agent_pubkey);
    published.respond_to = crate::managed_agents::RespondTo::Anyone;
    let event = crate::managed_agents::agent_events::build_agent_event(&published)
        .expect("managed-agent event builds")
        .sign_with_keys(&owner)
        .expect("managed-agent event signs");

    let refresh = reconcile_inbound_persona_event_blocking(
        event.as_json(),
        RELAY.to_string(),
        app.handle().clone(),
    )
    .expect("inbound reconcile of a signed 30177 head must succeed");

    // The policy DID land — so the access-changed arm really ran and this is
    // not a vacuous pass.
    let saved = load_managed_agents(app.handle()).unwrap();
    let saved_record = saved
        .iter()
        .find(|record| record.pubkey == agent_pubkey)
        .expect("the agent survives the inbound apply");
    assert_eq!(
        saved_record.respond_to,
        crate::managed_agents::RespondTo::Anyone,
        "the inbound policy must be persisted"
    );

    // …and nothing was scheduled to spawn.
    assert!(
        refresh.is_none(),
        "no live pair means no restart: a stale runtime_pid must not schedule a spawn, got {:?}",
        refresh.as_ref().map(|refresh| match refresh {
            InboundRuntimeRefresh::Local { relay_urls, .. } => relay_urls.clone(),
            InboundRuntimeRefresh::Provider { .. } => vec!["provider".to_string()],
        })
    );
    assert!(
        app.state::<crate::app_state::AppState>()
            .managed_agent_processes
            .lock()
            .unwrap()
            .is_empty(),
        "no runtime was registered"
    );
    assert!(
        !saved_record.start_on_app_launch,
        "the user's opt-out is untouched by the inbound edit"
    );
}
