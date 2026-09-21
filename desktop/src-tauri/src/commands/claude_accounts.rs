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
    claude_accounts::{
        self, ClaudeAuthKind, ClaudeSpawnAuth, ANTHROPIC_API_KEY_ENV, ANTHROPIC_AUTH_TOKEN_ENV,
        CLAUDE_CONFIG_DIR_ENV, CLAUDE_OAUTH_TOKEN_ENV,
    },
    codex_login::{
        retain_running_login_sessions, spawn_claude_login, ClaudeLoginLaunch, CodexLoginSnapshot,
        DEFAULT_LOGIN_TIMEOUT,
    },
    detach_claude_account, load_managed_agents, output_with_timeout, resolve_command,
    save_managed_agents, with_claude_account_store, AccountProvider, ProviderAccount,
};

/// Cheapest model for the round-trip probe; the point is the auth, not the answer.
const TEST_MODEL: &str = "claude-haiku-4-5-20251001";
const TEST_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_CONCURRENT_CLAUDE_LOGINS: usize = 2;
const TEST_MESSAGE_MAX_CHARS: usize = 200;

fn configure_config_dir_probe(
    command: &mut std::process::Command,
    label: &str,
    dir: std::path::PathBuf,
    validate: impl FnOnce(&std::path::Path) -> Result<bool, String>,
) -> Result<(), String> {
    let auth = claude_accounts::config_dir_spawn_auth(label, dir, validate)?;
    let ClaudeSpawnAuth::ConfigDir(dir) = auth else {
        return Err("Claude config-directory account resolved as a token".to_string());
    };
    command.args(["auth", "status", "--json"]);
    command.env(CLAUDE_CONFIG_DIR_ENV, dir);
    command.env_remove(CLAUDE_OAUTH_TOKEN_ENV);
    Ok(())
}

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

async fn run_trusted_blocking<T: Send + 'static>(
    _trusted: super::upstream_apps::TrustedLocalCaller,
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    run_blocking(f).await
}

fn parse_auth_kind(auth_kind: &str) -> Result<ClaudeAuthKind, String> {
    match auth_kind {
        "setup_token" => Ok(ClaudeAuthKind::SetupToken),
        "config_dir" => Ok(ClaudeAuthKind::ConfigDir),
        other => Err(format!("unknown Claude auth kind {other:?}")),
    }
}

fn claude_login_start_conflict(running: &[String], id: &str) -> Option<String> {
    if running.iter().any(|account_id| account_id == id) {
        return Some(
            "a login for this Claude account is already running — finish it in the browser or cancel it"
                .to_string(),
        );
    }
    (running.len() >= MAX_CONCURRENT_CLAUDE_LOGINS).then(|| {
        format!(
            "{MAX_CONCURRENT_CLAUDE_LOGINS} Claude account logins are already running — finish or cancel one first"
        )
    })
}

fn parse_claude_auth_status(raw: &[u8]) -> Result<bool, String> {
    let value: serde_json::Value = serde_json::from_slice(raw)
        .map_err(|error| format!("Claude returned an invalid auth status: {error}"))?;
    value
        .get("loggedIn")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| "Claude auth status did not include loggedIn".to_string())
}

fn cleanup_before_account_removal<T>(
    cleanup_required: bool,
    cleanup: impl FnOnce() -> Option<String>,
    remove_metadata: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if cleanup_required {
        if let Some(error) = cleanup() {
            return Err(error);
        }
    }
    remove_metadata()
}

/// All stored Claude accounts (no tokens).
#[tauri::command]
pub async fn list_claude_accounts(
    app: AppHandle,
    caller: tauri::Webview,
) -> Result<Vec<ProviderAccount>, String> {
    let trusted = super::upstream_apps::trusted_local_caller(&caller)?;
    run_trusted_blocking(trusted, move || {
        with_claude_account_store(&app, |store| store.list(AccountProvider::Claude))
    })
    .await
}

/// Store either a setup token or an app-owned config-directory login.
#[tauri::command]
pub async fn add_claude_account(
    label: String,
    auth_kind: String,
    token: Option<String>,
    app: AppHandle,
    caller: tauri::Webview,
) -> Result<ProviderAccount, String> {
    let trusted = super::upstream_apps::trusted_local_caller(&caller)?;
    run_trusted_blocking(trusted, move || {
        let kind = parse_auth_kind(&auth_kind)?;
        let state = app.state::<AppState>();
        let _guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| format!("failed to acquire store lock: {error}"))?;
        match kind {
            ClaudeAuthKind::SetupToken => {
                let token = token.as_deref().ok_or_else(|| {
                    "a setup token is required for this account type".to_string()
                })?;
                with_claude_account_store(&app, |store| store.add(&label, token))
            }
            ClaudeAuthKind::ConfigDir => {
                if token.is_some() {
                    return Err("a config-directory account does not take a token".to_string());
                }
                let dir_id = uuid::Uuid::new_v4().to_string();
                let dir = claude_accounts::claude_config_dir(&app, &dir_id)?;
                let account = with_claude_account_store(&app, |store| {
                    store.add_claude_config_dir(&label, dir.clone())
                })?;
                if let Err(error) = std::fs::create_dir_all(&dir) {
                    return Err(format!(
                        "Claude account metadata was saved for retry, but its directory could not be created ({}): {error}",
                        dir.display()
                    ));
                }
                Ok(account)
            }
        }
    })
    .await
}

/// Resolve the app-owned login directory of a config-dir account, creating it
/// if the add left it missing. Shared by the copyable command and the launched
/// login so both go through the same ownership validation.
fn claude_login_dir(id: &str, app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let account = with_claude_account_store(app, |store| store.find(id))?
        .filter(|account| account.provider == AccountProvider::Claude)
        .ok_or_else(|| format!("Claude account {id} not found"))?;
    if account.claude_auth_kind != Some(ClaudeAuthKind::ConfigDir) {
        return Err("setup-token accounts do not need a browser login command".to_string());
    }
    let dir = account
        .config_dir
        .ok_or_else(|| "Claude account has no config directory".to_string())?;
    claude_accounts::validate_recorded_claude_config_dir(app, &dir)?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("failed to create the account's Claude directory: {error}"))?;
    Ok(dir)
}

/// One-time browser login command for an app-owned config-dir account.
#[tauri::command]
pub async fn get_claude_login_command(
    id: String,
    app: AppHandle,
    caller: tauri::Webview,
) -> Result<String, String> {
    let trusted = super::upstream_apps::trusted_local_caller(&caller)?;
    run_trusted_blocking(trusted, move || {
        let dir = claude_login_dir(&id, &app)?;
        Ok(claude_accounts::claude_login_command(&dir))
    })
    .await
}

/// Start the bounded browser login. Poll/cancel own the same backend session;
/// closing a dialog never orphans an unobservable CLI process.
#[tauri::command]
pub async fn start_claude_account_login(
    id: String,
    app: AppHandle,
    caller: tauri::Webview,
) -> Result<CodexLoginSnapshot, String> {
    let trusted = super::upstream_apps::trusted_local_caller(&caller)?;
    run_trusted_blocking(trusted, move || {
        let dir = claude_login_dir(&id, &app)?;
        let Some(binary) = resolve_command("claude") else {
            return Err(
                "Claude Code CLI (`claude`) was not found on PATH — install it, or copy \
                        the command and run it in a terminal that has it"
                    .to_string(),
            );
        };
        let state = app.state::<AppState>();
        let mut sessions = state
            .claude_login_sessions
            .lock()
            .map_err(|error| format!("failed to acquire Claude login sessions lock: {error}"))?;
        let running = retain_running_login_sessions(&mut sessions);
        if let Some(conflict) = claude_login_start_conflict(&running, &id) {
            return Err(conflict);
        }
        let session = spawn_claude_login(&ClaudeLoginLaunch {
            binary,
            config_dir: dir.clone(),
            cwd: dir,
            path_env: crate::managed_agents::readiness::cli_probe::augmented_path(),
            timeout: DEFAULT_LOGIN_TIMEOUT,
        })?;
        let snapshot = session.snapshot();
        sessions.insert(id, session);
        Ok(snapshot)
    })
    .await
}

#[tauri::command]
pub async fn poll_claude_account_login(
    id: String,
    app: AppHandle,
    caller: tauri::Webview,
) -> Result<Option<CodexLoginSnapshot>, String> {
    let trusted = super::upstream_apps::trusted_local_caller(&caller)?;
    run_trusted_blocking(trusted, move || {
        let state = app.state::<AppState>();
        let mut sessions = state
            .claude_login_sessions
            .lock()
            .map_err(|error| format!("failed to acquire Claude login sessions lock: {error}"))?;
        Ok(sessions.get_mut(&id).map(|session| session.poll()))
    })
    .await
}

#[tauri::command]
pub async fn cancel_claude_account_login(
    id: String,
    app: AppHandle,
    caller: tauri::Webview,
) -> Result<Option<CodexLoginSnapshot>, String> {
    let trusted = super::upstream_apps::trusted_local_caller(&caller)?;
    run_trusted_blocking(trusted, move || {
        let state = app.state::<AppState>();
        let mut sessions = state
            .claude_login_sessions
            .lock()
            .map_err(|error| format!("failed to acquire Claude login sessions lock: {error}"))?;
        Ok(sessions.get_mut(&id).map(|session| session.cancel()))
    })
    .await
}

/// Change an account's label; id and token are untouched.
#[tauri::command]
pub async fn rename_claude_account(
    id: String,
    label: String,
    app: AppHandle,
    caller: tauri::Webview,
) -> Result<ProviderAccount, String> {
    let trusted = super::upstream_apps::trusted_local_caller(&caller)?;
    run_trusted_blocking(trusted, move || {
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
    caller: tauri::Webview,
) -> Result<RemoveClaudeAccountResult, String> {
    let trusted = super::upstream_apps::trusted_local_caller(&caller)?;
    run_trusted_blocking(trusted, move || {
        let state = app.state::<AppState>();
        let _guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| format!("failed to acquire store lock: {error}"))?;

        let account = with_claude_account_store(&app, |store| store.find(&id))?
            .filter(|account| account.provider == AccountProvider::Claude)
            .ok_or_else(|| format!("Claude account {id} not found"))?;

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
        let cleanup_required = account.claude_auth_kind == Some(ClaudeAuthKind::ConfigDir);
        let (_removed, keyring_warning) = cleanup_before_account_removal(
            cleanup_required,
            || claude_accounts::remove_claude_config_dir(&app, &account),
            || with_claude_account_store(&app, |store| store.remove(&id)),
        )
        .map_err(
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
            warning: keyring_warning,
        })
    })
    .await
}

/// Test setup tokens with a bounded ping and config-dir accounts with
/// `claude auth status --json` against their app-owned directory.
#[tauri::command]
pub async fn test_claude_account(
    id: String,
    app: AppHandle,
    caller: tauri::Webview,
) -> Result<ClaudeAccountTestResult, String> {
    let trusted = super::upstream_apps::trusted_local_caller(&caller)?;
    run_trusted_blocking(trusted, move || {
        let account = with_claude_account_store(&app, |store| store.find(&id))?
            .filter(|account| account.provider == AccountProvider::Claude)
            .ok_or_else(|| format!("Claude account {id} not found"))?;
        let Some(binary) = resolve_command("claude") else {
            return Ok(ClaudeAccountTestResult {
                ok: false,
                message: "Claude Code CLI (`claude`) was not found on PATH".to_string(),
            });
        };

        let mut command = std::process::Command::new(binary);
        let mut token = None;
        match account
            .claude_auth_kind
            .unwrap_or(ClaudeAuthKind::SetupToken)
        {
            ClaudeAuthKind::SetupToken => {
                let stored = with_claude_account_store(&app, |store| store.token(&id))?
                    .ok_or_else(|| format!("Claude account {id} not found"))?;
                command.args(["-p", "ping", "--model", TEST_MODEL]);
                command.env_remove(CLAUDE_CONFIG_DIR_ENV);
                command.env(CLAUDE_OAUTH_TOKEN_ENV, &stored);
                token = Some(stored);
            }
            ClaudeAuthKind::ConfigDir => {
                let dir = account
                    .config_dir
                    .ok_or_else(|| "Claude account has no config directory".to_string())?;
                configure_config_dir_probe(
                    &mut command,
                    &account.label,
                    dir,
                    |path| claude_accounts::validate_recorded_claude_config_dir(&app, path),
                )?;
            }
        }
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
        command.env_remove(ANTHROPIC_API_KEY_ENV);
        command.env_remove(ANTHROPIC_AUTH_TOKEN_ENV);

        // Config-dir accounts prove themselves with `claude auth status --json`:
        // there is no token to scrub, and the JSON has to be read because a
        // logged-out directory can still exit zero.
        if account.claude_auth_kind == Some(ClaudeAuthKind::ConfigDir) {
            let Some(output) = output_with_timeout(command, TEST_TIMEOUT) else {
                return Ok(ClaudeAccountTestResult {
                    ok: false,
                    message: format!("no response within {}s", TEST_TIMEOUT.as_secs()),
                });
            };
            let logged_in = match parse_claude_auth_status(&output.stdout) {
                Ok(logged_in) => logged_in,
                Err(_) => {
                    return Ok(ClaudeAccountTestResult {
                        ok: false,
                        message: "Claude returned an unsupported auth-status response; update Claude Code and try again".to_string(),
                    });
                }
            };
            let ok = output.status.success() && logged_in;
            return Ok(ClaudeAccountTestResult {
                ok,
                message: if ok {
                    "Logged in with Claude".to_string()
                } else {
                    "Claude login is not active for this account".to_string()
                },
            });
        }
        let token = token
            .as_deref()
            .ok_or_else(|| "setup-token account did not resolve a token".to_string())?;
        Ok(finish_claude_account_probe(command, token))
    })
    .await
}

/// Execute the exact command assembled by `test_claude_account` and reduce its
/// bounded output to the public, token-scrubbed result.
fn finish_claude_account_probe(
    command: std::process::Command,
    token: &str,
) -> ClaudeAccountTestResult {
    let Some(output) = output_with_timeout(command, TEST_TIMEOUT) else {
        return ClaudeAccountTestResult {
            ok: false,
            message: format!("no response within {}s", TEST_TIMEOUT.as_secs()),
        };
    };
    let ok = output.status.success();
    let raw = if ok || output.stderr.is_empty() {
        output.stdout
    } else {
        output.stderr
    };
    let message = summarize_probe_output(&String::from_utf8_lossy(&raw), token, ok);
    ClaudeAccountTestResult { ok, message }
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
    use super::{
        claude_login_start_conflict, cleanup_before_account_removal, configure_config_dir_probe,
        finish_claude_account_probe, parse_claude_auth_status, summarize_probe_output,
    };
    use crate::managed_agents::claude_accounts::validate_existing_claude_config_dir;
    use std::cell::Cell;

    #[test]
    fn claude_login_sessions_refuse_same_account_and_n_plus_one() {
        assert_eq!(claude_login_start_conflict(&[], "a"), None);
        assert!(claude_login_start_conflict(&["a".into()], "a")
            .expect("same account conflict")
            .contains("already running"));
        let full = vec!["a".into(), "b".into()];
        assert!(claude_login_start_conflict(&full, "c")
            .expect("bounded session conflict")
            .contains('2'));
    }

    #[cfg(unix)]
    fn failing_probe_command(secret: &str) -> std::process::Command {
        let mut command = std::process::Command::new("sh");
        command
            .args([
                "-c",
                "printf 'rejected %s key=sk-ant-other-secret\\n' \"$PROBE_SECRET\" >&2; exit 7",
            ])
            .env("PROBE_SECRET", secret);
        command
    }

    #[cfg(windows)]
    fn failing_probe_command(secret: &str) -> std::process::Command {
        let mut command = std::process::Command::new("cmd");
        command
            .args([
                "/C",
                "echo rejected %PROBE_SECRET% key=sk-ant-other-secret 1>&2 & exit /B 7",
            ])
            .env("PROBE_SECRET", secret);
        command
    }

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

    #[test]
    fn production_probe_marks_nonzero_as_failed_and_scrubs_captured_stderr() {
        let token = "sk-ant-account-verify-dummy";
        let result = finish_claude_account_probe(failing_probe_command(token), token);

        assert!(!result.ok, "a nonzero CLI exit must never report success");
        assert_eq!(result.message, "rejected … key=…");
        assert!(!result.message.contains(token));
        assert!(!result.message.contains("sk-ant-"));
    }

    #[test]
    fn config_dir_auth_status_requires_the_logged_in_boolean() {
        assert_eq!(parse_claude_auth_status(br#"{"loggedIn":true}"#), Ok(true));
        assert_eq!(
            parse_claude_auth_status(br#"{"loggedIn":false}"#),
            Ok(false)
        );
        assert!(parse_claude_auth_status(br#"{"authMethod":"none"}"#).is_err());
    }

    #[test]
    fn config_dir_test_probe_refuses_missing_or_empty_directories_before_launch() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let account_dir = dir.path().join("account");
        let mut command = std::process::Command::new("/bin/true");

        let missing_error = configure_config_dir_probe(
            &mut command,
            "Work",
            account_dir.clone(),
            validate_existing_claude_config_dir,
        )
        .expect_err("missing config directory must not reach Claude");
        assert!(missing_error.contains("claude login"));
        assert!(command.get_args().next().is_none());

        std::fs::create_dir(&account_dir).expect("account dir");
        let error = configure_config_dir_probe(
            &mut command,
            "Work",
            account_dir.clone(),
            validate_existing_claude_config_dir,
        )
        .expect_err("empty config directory must not reach Claude");
        assert!(error.contains("claude login"));
        assert!(command.get_args().next().is_none());

        std::fs::write(account_dir.join(".claude.json"), "fixture").expect("login marker");
        configure_config_dir_probe(
            &mut command,
            "Work",
            account_dir,
            validate_existing_claude_config_dir,
        )
        .expect("marker permits the auth-status probe");
        assert_eq!(
            command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            ["auth", "status", "--json"]
        );
    }

    #[test]
    fn config_dir_cleanup_failure_keeps_the_metadata_removal_retryable() {
        let remove_called = Cell::new(false);
        let result: Result<(), String> = cleanup_before_account_removal(
            true,
            || Some("directory busy".to_string()),
            || {
                remove_called.set(true);
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(!remove_called.get(), "metadata must remain for retry");

        cleanup_before_account_removal(
            false,
            || panic!("not needed"),
            || {
                remove_called.set(true);
                Ok(())
            },
        )
        .expect("setup-token removal skips directory cleanup");
        assert!(remove_called.get());
    }

    #[test]
    fn config_dir_inspection_failure_keeps_the_metadata_removal_retryable() {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let file = dir.path().join("not-a-directory");
        std::fs::write(&file, "fixture").expect("file fixture");
        let invalid_path = file.join("account");
        let remove_called = Cell::new(false);

        let result: Result<(), String> = cleanup_before_account_removal(
            true,
            || validate_existing_claude_config_dir(&invalid_path).err(),
            || {
                remove_called.set(true);
                Ok(())
            },
        );

        assert!(result
            .expect_err("inspection failure must stop metadata removal")
            .contains("failed to inspect"));
        assert!(!remove_called.get(), "metadata must remain for retry");
    }
}
