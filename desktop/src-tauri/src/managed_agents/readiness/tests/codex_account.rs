//! Readiness must not demand the app's own `codex login status` when the
//! agent brings its own login — a stored Codex account or a hand-typed
//! `OPENAI_API_KEY` / `CODEX_HOME` env var. The Codex mirror of
//! `claude_account.rs`.

use std::collections::BTreeMap;

use super::super::{collect_missing_requirements, resolve_effective_agent_env, EffectiveAgentEnv};
use crate::managed_agents::{known_acp_runtime, ManagedAgentRecord};

fn record(codex_account: Option<&str>, env: &[(&str, &str)]) -> ManagedAgentRecord {
    let mut record: ManagedAgentRecord = serde_json::from_value(serde_json::json!({
        "pubkey": "p", "name": "p", "relay_url": "", "acp_command": "",
        "agent_command": "codex-acp", "agent_args": [], "mcp_command": "",
        "turn_timeout_seconds": 0, "system_prompt": null, "created_at": "",
        "updated_at": "", "last_started_at": null, "last_stopped_at": null,
        "last_exit_code": null, "last_error": null
    }))
    .expect("record");
    record.codex_account_id = codex_account.map(str::to_string);
    record.env_vars = env
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    record
}

#[test]
fn codex_agent_with_its_own_login_needs_no_cli_login() {
    let effective = EffectiveAgentEnv {
        env: BTreeMap::new(),
        config_file_path: None,
        effective_command: "codex-acp".to_string(),
        oauth_token_supplied: true,
    };
    let missing = collect_missing_requirements(&effective, known_acp_runtime("codex-acp"));
    assert!(
        missing.is_empty(),
        "a supplied login satisfies Codex readiness: {missing:?}"
    );
    // (The no-login direction probes the machine's real `codex login status`,
    // so it cannot be asserted here — same reason the Claude mirror omits it.)
}

#[test]
fn login_supplied_follows_the_account_or_either_env_var() {
    let codex = known_acp_runtime("codex-acp");
    let global = Default::default();

    let with_account = resolve_effective_agent_env(&record(Some("acct"), &[]), &[], codex, &global);
    assert!(with_account.oauth_token_supplied);

    for key in ["OPENAI_API_KEY", "CODEX_HOME"] {
        let with_env =
            resolve_effective_agent_env(&record(None, &[(key, "value")]), &[], codex, &global);
        assert!(
            with_env.oauth_token_supplied,
            "a hand-typed {key} counts as a supplied login"
        );
        let blank = resolve_effective_agent_env(&record(None, &[(key, "  ")]), &[], codex, &global);
        assert!(!blank.oauth_token_supplied, "a blank {key} is no login");
    }

    let neither = resolve_effective_agent_env(&record(None, &[]), &[], codex, &global);
    assert!(!neither.oauth_token_supplied);

    // A Codex account on a runtime that does not honor it supplies nothing.
    let goose = known_acp_runtime("goose");
    let mut on_goose = record(Some("acct"), &[]);
    on_goose.agent_command = "goose".to_string();
    let resolved = resolve_effective_agent_env(&on_goose, &[], goose, &global);
    assert!(!resolved.oauth_token_supplied);
}
