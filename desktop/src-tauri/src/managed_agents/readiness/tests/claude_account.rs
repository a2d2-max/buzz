//! Readiness must not demand the app's own `claude auth status` login when
//! the agent brings its own OAuth token — a stored Claude account or a
//! hand-typed `CLAUDE_CODE_OAUTH_TOKEN` env var. Without this the main user
//! of per-agent accounts (owner not logged in on the desktop CLI) lands in
//! setup mode with a working token.

use std::collections::BTreeMap;

use super::super::{collect_missing_requirements, resolve_effective_agent_env, EffectiveAgentEnv};
use crate::managed_agents::{known_acp_runtime, ManagedAgentRecord};

fn record(agent_command: &str, account: Option<&str>, env: &[(&str, &str)]) -> ManagedAgentRecord {
    let mut record: ManagedAgentRecord = serde_json::from_value(serde_json::json!({
        "pubkey": "p", "name": "p", "relay_url": "", "acp_command": "",
        "agent_command": agent_command, "agent_args": [], "mcp_command": "",
        "turn_timeout_seconds": 0, "system_prompt": null, "created_at": "",
        "updated_at": "", "last_started_at": null, "last_stopped_at": null,
        "last_exit_code": null, "last_error": null
    }))
    .expect("record");
    record.claude_account_id = account.map(str::to_string);
    record.env_vars = env
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    record
}

#[test]
fn claude_agent_with_its_own_token_needs_no_cli_login() {
    let effective = EffectiveAgentEnv {
        env: BTreeMap::new(),
        config_file_path: None,
        effective_command: "claude-agent-acp".to_string(),
        oauth_token_supplied: true,
    };
    let missing = collect_missing_requirements(&effective, known_acp_runtime("claude-agent-acp"));
    assert!(
        missing.is_empty(),
        "a supplied token satisfies Claude readiness: {missing:?}"
    );
}

#[test]
fn token_supplied_follows_the_account_or_env_only_for_token_reading_runtimes() {
    let claude = known_acp_runtime("claude-agent-acp");
    let global = Default::default();

    let with_account = resolve_effective_agent_env(
        &record("claude-agent-acp", Some("acct"), &[]),
        &[],
        claude,
        &global,
    );
    assert!(with_account.oauth_token_supplied);

    let with_env = resolve_effective_agent_env(
        &record(
            "claude-agent-acp",
            None,
            &[("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-x")],
        ),
        &[],
        claude,
        &global,
    );
    assert!(with_env.oauth_token_supplied);

    let blank_env = resolve_effective_agent_env(
        &record(
            "claude-agent-acp",
            None,
            &[("CLAUDE_CODE_OAUTH_TOKEN", "  ")],
        ),
        &[],
        claude,
        &global,
    );
    assert!(!blank_env.oauth_token_supplied, "a blank value is no token");

    let neither =
        resolve_effective_agent_env(&record("claude-agent-acp", None, &[]), &[], claude, &global);
    assert!(!neither.oauth_token_supplied);

    let goose = known_acp_runtime("goose");
    let goose_with_account =
        resolve_effective_agent_env(&record("goose", Some("acct"), &[]), &[], goose, &global);
    assert!(
        !goose_with_account.oauth_token_supplied,
        "runtimes without an OAuth token env var never count as supplied"
    );
}
