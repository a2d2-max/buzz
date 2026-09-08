//! `record_agent_command` / `try_record_agent_command` resolution tests.
//! Split out of `discovery/tests.rs` to hold that file under the desktop
//! file-size ratchet.
//!
//! `use super::*` pulls the parent test module's helpers (`record_with`,
//! `persona_with_runtime`) and its imported command surface
//! (`record_agent_command`, `try_record_agent_command`, `default_agent_command`).

use super::*;

#[test]
fn record_agent_command_own_runtime_wins_over_persona() {
    // A record with its own runtime never consults the persona list.
    let personas = vec![persona_with_runtime("p1", Some("goose"))];
    let record = record_with(Some("claude"), Some("p1"), None);
    assert_eq!(record_agent_command(&record, &personas), "claude-agent-acp");
}

#[test]
fn record_agent_command_override_beats_runtime() {
    let record = record_with(Some("claude"), None, Some("codex-acp"));
    assert_eq!(record_agent_command(&record, &[]), "codex-acp");
}

#[test]
fn record_agent_command_legacy_persona_fallback() {
    // Pre-migration record: persona_id set, no runtime — resolves through
    // the legacy persona path unchanged.
    let personas = vec![persona_with_runtime("p1", Some("goose"))];
    let record = record_with(None, Some("p1"), None);
    assert_eq!(record_agent_command(&record, &personas), "goose");
}

#[test]
fn record_agent_command_bare_record_defaults() {
    let record = record_with(None, None, None);
    assert_eq!(record_agent_command(&record, &[]), default_agent_command());
}

/// When the record carries a dangling (unknown) runtime id, `try_record_agent_command`
/// must return `Err` containing "DANGLING_HARNESS_ID" — NEVER the buzz-agent default.
/// This test would fail if the function silently fell back to `default_agent_command()`.
#[test]
fn try_record_agent_command_dangling_runtime_id_returns_err() {
    let record = record_with(Some("my-deleted-harness"), None, None);
    let result = try_record_agent_command(&record, &[]);
    assert!(
        result.is_err(),
        "dangling runtime id must produce Err, got Ok({:?})",
        result.ok()
    );
    assert!(
        result.unwrap_err().contains("DANGLING_HARNESS_ID"),
        "error must name the dangling id"
    );
}

/// When the persona carries a dangling runtime id, `try_record_agent_command`
/// must also error — the error must not silently resolve to the default.
#[test]
fn try_record_agent_command_dangling_persona_runtime_returns_err() {
    let personas = vec![persona_with_runtime("p1", Some("ghost-harness"))];
    let record = record_with(None, Some("p1"), None);
    let result = try_record_agent_command(&record, &personas);
    assert!(
        result.is_err(),
        "dangling persona runtime id must produce Err"
    );
}

/// When neither the record nor persona has any runtime id, `try_record_agent_command`
/// falls back to `default_agent_command()` — this is the legacy-agent path.
#[test]
fn try_record_agent_command_no_runtime_id_defaults_to_buzz_agent() {
    let record = record_with(None, None, None);
    let result = try_record_agent_command(&record, &[]);
    assert_eq!(
        result,
        Ok(default_agent_command()),
        "no runtime id must fall back to the safe default"
    );
}

/// An explicit agent_command_override always wins, even for a dangling runtime id.
#[test]
fn try_record_agent_command_override_beats_dangling_id() {
    let record = record_with(Some("gone-harness"), None, Some("cursor-agent"));
    let result = try_record_agent_command(&record, &[]);
    assert_eq!(
        result,
        Ok("cursor-agent".to_string()),
        "explicit override must beat a dangling runtime id"
    );
}

// ── OAuth-token capability projection ────────────────────────────────────────

#[test]
fn oauth_token_env_var_projection_follows_the_spawn_side_command_match() {
    // Spawn gates token injection on `known_acp_runtime(command)`; the catalog
    // must project the same answer for every constructor (builtin, preset,
    // custom discovery, custom save) or the picker hides / clears an account
    // the spawn still honours.
    use crate::managed_agents::oauth_token_env_var_for_command;
    assert_eq!(
        oauth_token_env_var_for_command("claude-agent-acp").as_deref(),
        Some("CLAUDE_CODE_OAUTH_TOKEN")
    );
    assert_eq!(
        oauth_token_env_var_for_command("/opt/shim/claude-agent-acp").as_deref(),
        Some("CLAUDE_CODE_OAUTH_TOKEN"),
        "absolute paths match by basename, like spawn"
    );
    assert_eq!(oauth_token_env_var_for_command("goose"), None);
    assert_eq!(oauth_token_env_var_for_command("cursor-agent"), None);
}
