//! Tauri commands for the named Claude accounts a managed agent can run on.
//!
//! `list_claude_accounts` / `add_claude_account` / `rename_claude_account` /
//! `remove_claude_account` / `test_claude_account`. The token crosses the IPC
//! boundary exactly once, on `add`; every response carries only the `…last4`
//! hint. Mutations take the managed-agents store lock because `remove` also
//! detaches the account from any agent that references it.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::app_state::AppState;
use crate::managed_agents::{
    claude_accounts::CLAUDE_OAUTH_TOKEN_ENV, detach_claude_account, load_managed_agents,
    output_with_timeout, resolve_command, save_managed_agents, with_claude_account_store,
    ClaudeAccount,
};

/// Cheapest model for the round-trip probe; the point is the auth, not the answer.
const TEST_MODEL: &str = "claude-haiku-4-5-20251001";
const TEST_TIMEOUT: Duration = Duration::from_secs(60);
const TEST_MESSAGE_MAX_CHARS: usize = 200;

/// Result of `remove_claude_account`: agents that pointed at the removed
/// account now run on the app's own login and will show the restart badge.
#[derive(Debug, Clone, Serialize)]
pub struct RemoveClaudeAccountResult {
    pub detached_agent_pubkeys: Vec<String>,
    /// Set when the account is gone but its keyring entry could not be
    /// deleted; harmless, but the owner should know.
    pub warning: Option<String>,
}

/// Result of `test_claude_account`.
#[derive(Debug, Clone, Serialize)]
pub struct ClaudeAccountTestResult {
    pub ok: bool,
    /// One short, token-scrubbed line of CLI output or a status sentence.
    pub message: String,
}

async fn run_blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|error| format!("spawn_blocking failed: {error}"))?
}

/// All stored accounts (no tokens).
#[tauri::command]
pub async fn list_claude_accounts(app: AppHandle) -> Result<Vec<ClaudeAccount>, String> {
    run_blocking(move || with_claude_account_store(&app, |store| store.list())).await
}

/// Store a `claude setup-token` result under `label`.
#[tauri::command]
pub async fn add_claude_account(
    label: String,
    token: String,
    app: AppHandle,
) -> Result<ClaudeAccount, String> {
    run_blocking(move || {
        let state = app.state::<AppState>();
        let _guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| format!("failed to acquire store lock: {error}"))?;
        with_claude_account_store(&app, |store| store.add(&label, &token))
    })
    .await
}

/// Change an account's label; id and token are untouched.
#[tauri::command]
pub async fn rename_claude_account(
    id: String,
    label: String,
    app: AppHandle,
) -> Result<ClaudeAccount, String> {
    run_blocking(move || {
        let state = app.state::<AppState>();
        let _guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| format!("failed to acquire store lock: {error}"))?;
        with_claude_account_store(&app, |store| store.rename(&id, &label))
    })
    .await
}

/// Remove the account and its token, first detaching every agent that
/// referenced it so no record is left pointing at a missing account (which
/// would refuse to spawn). Agents are saved before the account goes away, so
/// a failure between the two steps leaves a consistent prefix.
#[tauri::command]
pub async fn remove_claude_account(
    id: String,
    app: AppHandle,
) -> Result<RemoveClaudeAccountResult, String> {
    run_blocking(move || {
        let state = app.state::<AppState>();
        let _guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| format!("failed to acquire store lock: {error}"))?;

        let mut records = load_managed_agents(&app)?;
        let detached_agent_pubkeys = detach_claude_account(&mut records, &id);
        if !detached_agent_pubkeys.is_empty() {
            let now = crate::util::now_iso();
            for record in records
                .iter_mut()
                .filter(|record| detached_agent_pubkeys.contains(&record.pubkey))
            {
                record.updated_at = now.clone();
            }
            save_managed_agents(&app, &records)?;
        }

        // The detach above is already durable: if the removal itself fails,
        // say so, so the owner knows those agents are on the app login now
        // and that retrying the removal is safe.
        let warning = with_claude_account_store(&app, |store| store.remove(&id)).map_err(
            |error| {
                if detached_agent_pubkeys.is_empty() {
                    error
                } else {
                    format!(
                        "{error} — note: {} agent(s) were already switched to the app's own Claude login; retry removing the account",
                        detached_agent_pubkeys.len()
                    )
                }
            },
        )?;
        Ok(RemoveClaudeAccountResult {
            detached_agent_pubkeys,
            warning,
        })
    })
    .await
}

/// Round-trip the stored token through the Claude Code CLI:
/// `claude -p ping --model <haiku>` with `CLAUDE_CODE_OAUTH_TOKEN` set.
/// Bounded by `output_with_timeout` (deadline, output cap, tree teardown).
#[tauri::command]
pub async fn test_claude_account(
    id: String,
    app: AppHandle,
) -> Result<ClaudeAccountTestResult, String> {
    run_blocking(move || {
        let token = with_claude_account_store(&app, |store| store.token(&id))?
            .ok_or_else(|| format!("Claude account {id} not found"))?;
        let Some(binary) = resolve_command("claude") else {
            return Ok(ClaudeAccountTestResult {
                ok: false,
                message: "Claude Code CLI (`claude`) was not found on PATH".to_string(),
            });
        };

        let mut command = std::process::Command::new(binary);
        command.args(["-p", "ping", "--model", TEST_MODEL]);
        // Probe from an empty scratch directory so the CLI reads no project
        // CLAUDE.md, settings, or hooks from the agents' working directory;
        // the point is the auth round-trip, nothing else.
        let scratch = tempfile::tempdir().map_err(|error| {
            format!("failed to create a scratch directory for the probe: {error}")
        })?;
        command.current_dir(scratch.path());
        if let Some(path) = crate::managed_agents::readiness::cli_probe::augmented_path() {
            command.env("PATH", path);
        }
        // The probe must prove THIS token works: an ambient API key from the
        // desktop's own environment would make a bad token look good.
        command.env_remove("ANTHROPIC_API_KEY");
        command.env(CLAUDE_OAUTH_TOKEN_ENV, &token);

        let Some(output) = output_with_timeout(command, TEST_TIMEOUT) else {
            return Ok(ClaudeAccountTestResult {
                ok: false,
                message: format!("no response within {}s", TEST_TIMEOUT.as_secs()),
            });
        };
        let ok = output.status.success();
        let raw = if ok || output.stderr.is_empty() {
            output.stdout
        } else {
            output.stderr
        };
        let message = summarize_probe_output(&String::from_utf8_lossy(&raw), &token, ok);
        Ok(ClaudeAccountTestResult { ok, message })
    })
    .await
}

/// First non-empty line of the CLI output, with the token (and anything else
/// shaped like an Anthropic secret) scrubbed and the length capped. Falls
/// back to a status sentence when the CLI said nothing.
fn summarize_probe_output(raw: &str, token: &str, ok: bool) -> String {
    let scrubbed = scrub_secrets(&raw.replace(token, "…"));
    let line = scrubbed
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    if line.is_empty() {
        return if ok {
            "Claude answered".to_string()
        } else {
            "Claude CLI exited with an error and no output".to_string()
        };
    }
    let mut out: String = line.chars().take(TEST_MESSAGE_MAX_CHARS).collect();
    if line.chars().count() > TEST_MESSAGE_MAX_CHARS {
        out.push('…');
    }
    out
}

/// Cut every Anthropic-shaped secret (`sk-ant-…`) out of the text, including
/// ones glued to a prefix like `token=sk-ant-…` — the CLI may echo an ambient
/// key, not only the probed token. Each hit is replaced from `sk-ant-` to the
/// end of that word.
fn scrub_secrets(text: &str) -> String {
    text.split(' ')
        .map(|word| match word.find("sk-ant-") {
            Some(index) => format!("{}…", &word[..index]),
            None => word.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::summarize_probe_output;

    #[test]
    fn probe_summary_scrubs_the_token_and_takes_the_first_line() {
        let token = "sk-ant-oat01-secretsecretsecret";
        let raw = format!("\n\nInvalid token {token} rejected\nsecond line\n");
        let message = summarize_probe_output(&raw, token, false);
        assert_eq!(message, "Invalid token … rejected");
    }

    #[test]
    fn probe_summary_falls_back_to_status_sentences() {
        assert_eq!(
            summarize_probe_output("  \n", "tok-0123456789abcdef", true),
            "Claude answered"
        );
        assert!(summarize_probe_output("", "tok-0123456789abcdef", false).contains("no output"));
    }

    #[test]
    fn probe_summary_scrubs_other_anthropic_looking_secrets_too() {
        let message = summarize_probe_output(
            "rejected sk-ant-api03-somethingelse token=sk-ant-oat01-another key=\"sk-ant-x\" retry",
            "tok-0123456789abcdef",
            false,
        );
        assert!(
            !message.contains("sk-ant-"),
            "no Anthropic-shaped secret may pass, even glued to a prefix: {message}"
        );
        assert_eq!(message, "rejected … token=… key=\"… retry");
    }

    #[test]
    fn probe_summary_caps_the_length() {
        let long = "x".repeat(500);
        let message = summarize_probe_output(&long, "tok-0123456789abcdef", true);
        assert_eq!(message.chars().count(), 201);
        assert!(message.ends_with('…'));
    }
}
