//! Tauri commands for the named Codex accounts a managed agent can run on.
//!
//! `list_codex_accounts` / `add_codex_account` / `rename_codex_account` /
//! `remove_codex_account` / `test_codex_account` / `get_codex_login_command`.
//! The API key crosses the IPC boundary exactly once, on `add`; every
//! response carries only the `…last4` hint. Mutations take the managed-agents
//! store lock because `remove` also detaches the account from any agent that
//! references it. Mirrors `commands/claude_accounts.rs`.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::app_state::AppState;
use crate::managed_agents::{
    codex_accounts, detach_codex_account, load_managed_agents, output_with_timeout,
    resolve_command, save_managed_agents, with_claude_account_store, AccountProvider,
    CodexAuthKind, ProviderAccount,
};

const TEST_TIMEOUT: Duration = Duration::from_secs(60);
const TEST_MESSAGE_MAX_CHARS: usize = 200;

/// Result of `remove_codex_account`: agents that pointed at the removed
/// account now run on the app's own login and will show the restart badge.
#[derive(Debug, Clone, Serialize)]
pub struct RemoveCodexAccountResult {
    pub detached_agent_pubkeys: Vec<String>,
    /// Set when the account is gone but its keyring entry or `CODEX_HOME`
    /// directory could not be deleted; the owner should know.
    pub warning: Option<String>,
}

/// Result of `test_codex_account`.
#[derive(Debug, Clone, Serialize)]
pub struct CodexAccountTestResult {
    pub ok: bool,
    /// One short, secret-scrubbed line of CLI output or a status sentence.
    pub message: String,
}

async fn run_blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|error| format!("spawn_blocking failed: {error}"))?
}

fn parse_auth_kind(auth_kind: &str) -> Result<CodexAuthKind, String> {
    match auth_kind {
        "api_key" => Ok(CodexAuthKind::ApiKey),
        "chatgpt" => Ok(CodexAuthKind::Chatgpt),
        other => Err(format!("unknown Codex auth kind {other:?}")),
    }
}

/// All stored Codex accounts (no keys).
#[tauri::command]
pub async fn list_codex_accounts(app: AppHandle) -> Result<Vec<ProviderAccount>, String> {
    run_blocking(move || {
        with_claude_account_store(&app, |store| store.list(AccountProvider::Codex))
    })
    .await
}

/// Store a Codex account under `label`. `auth_kind` is `"api_key"` (with the
/// key) or `"chatgpt"` (no key — the owner logs the account's `CODEX_HOME`
/// directory in with `codex login` afterwards).
#[tauri::command]
pub async fn add_codex_account(
    label: String,
    auth_kind: String,
    api_key: Option<String>,
    app: AppHandle,
) -> Result<ProviderAccount, String> {
    run_blocking(move || {
        let kind = parse_auth_kind(&auth_kind)?;
        let state = app.state::<AppState>();
        let _guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| format!("failed to acquire store lock: {error}"))?;
        let account = with_claude_account_store(&app, |store| {
            store.add_codex(kind, &label, api_key.as_deref())
        })?;
        // The directory is what makes the account selectable at spawn; create
        // it now so the login command is runnable the moment the dialog shows
        // it. A failure here still leaves a working record — spawn re-ensures.
        if let Err(error) = codex_accounts::ensure_codex_home_dir(&app, &account.id) {
            eprintln!("buzz-desktop: {error}");
        }
        Ok(account)
    })
    .await
}

/// Change an account's label; id, key, and directory are untouched.
#[tauri::command]
pub async fn rename_codex_account(
    id: String,
    label: String,
    app: AppHandle,
) -> Result<ProviderAccount, String> {
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

/// Remove the account, its keyring key, and its `CODEX_HOME` directory,
/// first detaching every agent that referenced it — same ordering contract as
/// `remove_claude_account`.
#[tauri::command]
pub async fn remove_codex_account(
    id: String,
    app: AppHandle,
) -> Result<RemoveCodexAccountResult, String> {
    run_blocking(move || {
        let state = app.state::<AppState>();
        let _guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| format!("failed to acquire store lock: {error}"))?;

        let mut records = load_managed_agents(&app)?;
        let detached_agent_pubkeys = detach_codex_account(&mut records, &id);
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

        let keyring_warning = with_claude_account_store(&app, |store| store.remove(&id))
            .map(|(_removed, warning)| warning)
            .map_err(|error| {
                if detached_agent_pubkeys.is_empty() {
                    error
                } else {
                    format!(
                        "{error} — note: {} agent(s) were already switched to the app's own Codex login; retry removing the account",
                        detached_agent_pubkeys.len()
                    )
                }
            })?;
        let dir_warning = codex_accounts::remove_codex_home_dir(&app, &id);
        let warning = match (keyring_warning, dir_warning) {
            (Some(a), Some(b)) => Some(format!("{a}; {b}")),
            (a, b) => a.or(b),
        };
        Ok(RemoveCodexAccountResult {
            detached_agent_pubkeys,
            warning,
        })
    })
    .await
}

/// The one-time login command for a `chatgpt` account, for the UI to show
/// with a copy button. Also ensures the directory exists so the command works.
#[tauri::command]
pub async fn get_codex_login_command(id: String, app: AppHandle) -> Result<String, String> {
    run_blocking(move || {
        let account = with_claude_account_store(&app, |store| store.find(&id))?
            .filter(|account| account.provider == AccountProvider::Codex)
            .ok_or_else(|| format!("Codex account {id} not found"))?;
        let dir = codex_accounts::ensure_codex_home_dir(&app, &account.id)?;
        Ok(codex_accounts::codex_login_command(&dir))
    })
    .await
}

/// Prove the account works, under the exact env the spawn would use.
///
/// * `api_key` — round-trip through the Codex CLI: `codex exec ping` with
///   `CODEX_HOME=<account dir>` and `OPENAI_API_KEY` from the keyring, so
///   "Works" here means the spawn works.
/// * `chatgpt` — `codex login status` with `CODEX_HOME=<account dir>`: a
///   local check of the account directory's login (no tokens spent).
#[tauri::command]
pub async fn test_codex_account(
    id: String,
    app: AppHandle,
) -> Result<CodexAccountTestResult, String> {
    run_blocking(move || {
        let account = with_claude_account_store(&app, |store| store.find(&id))?
            .filter(|account| account.provider == AccountProvider::Codex)
            .ok_or_else(|| format!("Codex account {id} not found"))?;
        let Some(binary) = resolve_command("codex") else {
            return Ok(CodexAccountTestResult {
                ok: false,
                message: "Codex CLI (`codex`) was not found on PATH".to_string(),
            });
        };
        let home_dir = codex_accounts::ensure_codex_home_dir(&app, &account.id)?;

        let mut command = std::process::Command::new(binary);
        let mut key = None;
        match account.auth_kind {
            Some(CodexAuthKind::ApiKey) => {
                let api_key = with_claude_account_store(&app, |store| {
                    store.secret(AccountProvider::Codex, &id)
                })?
                .ok_or_else(|| format!("Codex account {id} not found"))?;
                command.args(["exec", "--skip-git-repo-check", "ping"]);
                command.env(codex_accounts::OPENAI_API_KEY_ENV, &api_key);
                key = Some(api_key);
            }
            Some(CodexAuthKind::Chatgpt) => {
                command.args(["login", "status"]);
                // The probe must prove THIS directory's login: an ambient key
                // must not make a never-logged-in account look good.
                command.env_remove(codex_accounts::OPENAI_API_KEY_ENV);
            }
            None => {
                return Ok(CodexAccountTestResult {
                    ok: false,
                    message: "account has no auth kind recorded; remove it and add it again"
                        .to_string(),
                });
            }
        }
        command.env(codex_accounts::CODEX_HOME_ENV, &home_dir);
        // Probe from an empty scratch directory so the CLI reads no project
        // files from wherever the desktop happens to run.
        let scratch = tempfile::tempdir().map_err(|error| {
            format!("failed to create a scratch directory for the probe: {error}")
        })?;
        command.current_dir(scratch.path());
        if let Some(path) = crate::managed_agents::readiness::cli_probe::augmented_path() {
            command.env("PATH", path);
        }

        let Some(output) = output_with_timeout(command, TEST_TIMEOUT) else {
            return Ok(CodexAccountTestResult {
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
        let message = summarize_probe_output(&String::from_utf8_lossy(&raw), key.as_deref(), ok);
        Ok(CodexAccountTestResult { ok, message })
    })
    .await
}

/// First non-empty line of the CLI output, with the key (and anything else
/// shaped like an OpenAI secret) scrubbed and the length capped. Falls back
/// to a status sentence when the CLI said nothing.
fn summarize_probe_output(raw: &str, key: Option<&str>, ok: bool) -> String {
    let raw = match key {
        Some(key) => raw.replace(key, "…"),
        None => raw.to_string(),
    };
    let scrubbed = scrub_secrets(&raw);
    let line = scrubbed
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    if line.is_empty() {
        return if ok {
            "Codex answered".to_string()
        } else {
            "Codex CLI exited with an error and no output".to_string()
        };
    }
    let mut out: String = line.chars().take(TEST_MESSAGE_MAX_CHARS).collect();
    if line.chars().count() > TEST_MESSAGE_MAX_CHARS {
        out.push('…');
    }
    out
}

/// Cut every OpenAI-shaped secret (`sk-…`) out of the text, including ones
/// glued to a prefix like `key=sk-…` — the CLI may echo an ambient key, not
/// only the probed one. Each hit is replaced from `sk-` to the end of that
/// word.
fn scrub_secrets(text: &str) -> String {
    text.split(' ')
        .map(|word| match word.find("sk-") {
            Some(index) => format!("{}…", &word[..index]),
            None => word.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::{parse_auth_kind, summarize_probe_output};
    use crate::managed_agents::CodexAuthKind;

    #[test]
    fn auth_kind_parses_the_two_wire_values_and_rejects_the_rest() {
        assert_eq!(parse_auth_kind("api_key"), Ok(CodexAuthKind::ApiKey));
        assert_eq!(parse_auth_kind("chatgpt"), Ok(CodexAuthKind::Chatgpt));
        let error = parse_auth_kind("oauth").expect_err("unknown kind");
        assert!(error.contains("oauth"), "error names the kind: {error}");
    }

    #[test]
    fn probe_summary_scrubs_the_key_and_takes_the_first_line() {
        let key = "sk-proj-secretsecretsecret";
        let raw = format!("\n\nInvalid key {key} rejected\nsecond line\n");
        let message = summarize_probe_output(&raw, Some(key), false);
        assert_eq!(message, "Invalid key … rejected");
    }

    #[test]
    fn probe_summary_scrubs_openai_shaped_secrets_even_without_the_stored_key() {
        let message = summarize_probe_output(
            "rejected sk-proj-somethingelse key=sk-abcdef retry",
            None,
            false,
        );
        assert!(
            !message.contains("sk-"),
            "no OpenAI-shaped secret may pass, even glued to a prefix: {message}"
        );
        assert_eq!(message, "rejected … key=… retry");
    }

    #[test]
    fn probe_summary_falls_back_to_status_sentences_and_caps_length() {
        assert_eq!(summarize_probe_output("  \n", None, true), "Codex answered");
        assert!(summarize_probe_output("", None, false).contains("no output"));
        let long = "x".repeat(500);
        let message = summarize_probe_output(&long, None, true);
        assert_eq!(message.chars().count(), 201);
        assert!(message.ends_with('…'));
    }
}
