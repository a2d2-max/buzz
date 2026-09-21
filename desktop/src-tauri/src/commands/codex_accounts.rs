//! Tauri commands for the named Codex accounts a managed agent can run on.
//!
//! `list_codex_accounts` / `add_codex_account` / `rename_codex_account` /
//! `remove_codex_account` / `test_codex_account` / `get_codex_login_command` /
//! `start_codex_account_login` / `poll_codex_account_login` /
//! `cancel_codex_account_login`.
//! The API key crosses the IPC boundary exactly once, on `add`; every
//! response carries only the `…last4` hint. Mutations take the managed-agents
//! store lock because `remove` also detaches the account from any agent that
//! references it. Mirrors `commands/claude_accounts.rs`.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::app_state::AppState;
use crate::managed_agents::{
    codex_accounts,
    codex_login::{
        callback_port_in_use, login_start_conflict, spawn_codex_login, CodexLoginLaunch,
        CodexLoginSnapshot, CODEX_LOGIN_CALLBACK_PORT, DEFAULT_LOGIN_TIMEOUT,
    },
    detach_codex_account, load_managed_agents, output_with_timeout, resolve_command,
    save_managed_agents, with_claude_account_store, AccountProvider, CodexAuthKind,
    ProviderAccount,
};

const TEST_TIMEOUT: Duration = Duration::from_secs(60);
const TEST_MESSAGE_MAX_CHARS: usize = 200;
const ORCA_LIST_TIMEOUT: Duration = Duration::from_secs(15);

/// Result of `remove_codex_account`: agents that pointed at the removed
/// account now run on the app's own login and will show the restart badge.
#[derive(Debug, Clone, Serialize)]
pub struct RemoveCodexAccountResult {
    pub detached_agent_pubkeys: Vec<String>,
    /// Set when the account is gone but its keyring entry could not be
    /// deleted; the owner should know. Home cleanup is fail-closed earlier.
    pub warning: Option<String>,
}

/// Result of `test_codex_account`.
#[derive(Debug, Clone, Serialize)]
pub struct CodexAccountTestResult {
    pub ok: bool,
    /// One short, secret-scrubbed line of CLI output or a status sentence.
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrcaCodexAccount {
    pub id: String,
    pub email: String,
    pub workspace_label: Option<String>,
    pub home_path: String,
    pub already_imported: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOrcaCodexAccountsResult {
    pub imported: Vec<ProviderAccount>,
    pub skipped_existing_count: usize,
    pub skipped_label_conflicts: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct OrcaEnvelope {
    ok: bool,
    result: OrcaResult,
}

#[derive(Debug, Deserialize)]
struct OrcaResult {
    codex: OrcaCodexBucket,
}

#[derive(Debug, Deserialize)]
struct OrcaCodexBucket {
    #[serde(default)]
    accounts: Vec<OrcaCodexWireAccount>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrcaCodexWireAccount {
    id: String,
    email: String,
    #[serde(default)]
    workspace_label: Option<String>,
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

fn parse_auth_kind(auth_kind: &str) -> Result<CodexAuthKind, String> {
    match auth_kind {
        "api_key" => Ok(CodexAuthKind::ApiKey),
        "chatgpt" => Ok(CodexAuthKind::Chatgpt),
        other => Err(format!("unknown Codex auth kind {other:?}")),
    }
}

fn cleanup_before_codex_account_removal<T>(
    cleanup_home: impl FnOnce() -> Result<(), String>,
    remove_metadata: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    cleanup_home()?;
    remove_metadata()
}

fn parse_orca_codex_accounts(raw: &[u8]) -> Result<Vec<OrcaCodexWireAccount>, String> {
    let envelope: OrcaEnvelope = serde_json::from_slice(raw)
        .map_err(|error| format!("failed to parse Orca account list: {error}"))?;
    if !envelope.ok {
        return Err("Orca account list reported a failure".to_string());
    }
    Ok(envelope.result.codex.accounts)
}

fn orca_codex_home(id: &str) -> Result<std::path::PathBuf, String> {
    if id.is_empty()
        || id == "."
        || id == ".."
        || id
            .chars()
            .any(|character| character == '/' || character == '\\')
    {
        return Err("Orca returned an invalid Codex account id".to_string());
    }
    let home = dirs::home_dir().ok_or_else(|| "home directory is unavailable".to_string())?;
    Ok(home
        .join("Library/Application Support/orca/codex-accounts")
        .join(id)
        .join("home"))
}

fn load_orca_codex_accounts() -> Result<Vec<OrcaCodexWireAccount>, String> {
    #[cfg(not(target_os = "macos"))]
    return Err("Orca account import is available only on macOS".to_string());

    #[cfg(target_os = "macos")]
    {
        let binary = resolve_command("orca")
            .ok_or_else(|| "Orca CLI (`orca`) was not found on PATH".to_string())?;
        let mut command = codex_accounts::command_for_read_only_probe(&binary)?;
        command.args(["account", "list", "--json"]);
        if let Some(path) = crate::managed_agents::readiness::cli_probe::augmented_path() {
            command.env("PATH", path);
        }
        let output = output_with_timeout(command, ORCA_LIST_TIMEOUT).ok_or_else(|| {
            format!(
                "Orca account list did not respond within {}s",
                ORCA_LIST_TIMEOUT.as_secs()
            )
        })?;
        if !output.status.success() {
            let detail = safe_first_output_line(&output.stderr);
            return Err(match detail {
                Some(detail) => format!("Orca account list failed: {detail}"),
                None => "Orca account list failed".to_string(),
            });
        }
        parse_orca_codex_accounts(&output.stdout)
    }
}

/// Discover importable Codex accounts without reading auth/config contents.
#[tauri::command]
pub async fn list_orca_codex_accounts(
    app: AppHandle,
    caller: tauri::Webview,
) -> Result<Vec<OrcaCodexAccount>, String> {
    let trusted = super::upstream_apps::trusted_local_caller(&caller)?;
    run_trusted_blocking(trusted, move || {
        let accounts = load_orca_codex_accounts()?;
        let imported_paths: Vec<std::path::PathBuf> =
            with_claude_account_store(&app, |store| store.list(AccountProvider::Codex))?
                .into_iter()
                .filter_map(|account| account.external_home)
                .collect();
        accounts
            .into_iter()
            .map(|account| {
                let home = orca_codex_home(&account.id)?;
                let canonical = std::fs::canonicalize(&home).unwrap_or_else(|_| home.clone());
                let already_imported = imported_paths.iter().any(|known| {
                    std::fs::canonicalize(known).unwrap_or_else(|_| known.clone()) == canonical
                });
                Ok(OrcaCodexAccount {
                    id: account.id,
                    email: account.email,
                    workspace_label: account.workspace_label,
                    home_path: home.display().to_string(),
                    already_imported,
                })
            })
            .collect()
    })
    .await
}

/// Import selected Orca Codex homes by trusted account id. Paths are resolved
/// again in Rust, so the frontend cannot inject an arbitrary external path.
#[tauri::command]
pub async fn import_orca_codex_accounts(
    account_ids: Vec<String>,
    app: AppHandle,
    caller: tauri::Webview,
) -> Result<ImportOrcaCodexAccountsResult, String> {
    let trusted = super::upstream_apps::trusted_local_caller(&caller)?;
    run_trusted_blocking(trusted, move || {
        let wanted: std::collections::BTreeSet<String> = account_ids.into_iter().collect();
        let available = load_orca_codex_accounts()?;
        let mut candidates = Vec::new();
        for account in available {
            if wanted.contains(&account.id) {
                candidates.push(codex_accounts::ExternalCodexAccount::new(
                    account.email,
                    orca_codex_home(&account.id)?,
                ));
            }
        }
        if candidates.len() != wanted.len() {
            return Err(
                "One or more selected Orca Codex accounts are no longer available".to_string(),
            );
        }
        let state = app.state::<AppState>();
        let _guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| format!("failed to acquire store lock: {error}"))?;
        let result = with_claude_account_store(&app, |store| {
            store.import_external_codex_accounts(&candidates)
        })?;
        Ok(ImportOrcaCodexAccountsResult {
            imported: result.imported,
            skipped_existing_count: result.skipped_existing_paths.len(),
            skipped_label_conflicts: result.skipped_label_conflicts,
        })
    })
    .await
}

/// All stored Codex accounts (no keys).
#[tauri::command]
pub async fn list_codex_accounts(
    app: AppHandle,
    caller: tauri::Webview,
) -> Result<Vec<ProviderAccount>, String> {
    let trusted = super::upstream_apps::trusted_local_caller(&caller)?;
    run_trusted_blocking(trusted, move || {
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
        // Prepare the app-owned home before account metadata or a keyring
        // secret becomes durable. This avoids a cross-store rollback if the
        // credential policy cannot be written.
        let id = uuid::Uuid::new_v4().to_string();
        codex_accounts::create_codex_home_dir(&app, &id)?;
        match with_claude_account_store(&app, |store| {
            store.add_codex_with_id(id.clone(), kind, &label, api_key.as_deref())
        }) {
            Ok(account) => Ok(account),
            Err(error) => match codex_accounts::cleanup_created_codex_home_dir(&app, &id) {
                None => Err(error),
                Some(warning) => Err(format!("{error}; account cleanup warning: {warning}")),
            },
        }
    })
    .await
}

/// Change an account's label; id, key, and directory are untouched.
#[tauri::command]
pub async fn rename_codex_account(
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

/// Remove the account, its keyring key, and its app-owned `CODEX_HOME`
/// directory, first detaching every agent that referenced it. Home cleanup
/// must succeed before account metadata disappears, so a filesystem failure
/// leaves the same account id available for a safe retry. Imported Orca homes
/// are read-only references and are never removed.
#[tauri::command]
pub async fn remove_codex_account(
    id: String,
    app: AppHandle,
    caller: tauri::Webview,
) -> Result<RemoveCodexAccountResult, String> {
    let trusted = super::upstream_apps::trusted_local_caller(&caller)?;
    run_trusted_blocking(trusted, move || {
        let state = app.state::<AppState>();
        let _guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| format!("failed to acquire store lock: {error}"))?;

        let account = with_claude_account_store(&app, |store| store.find(&id))?
            .filter(|account| account.provider == AccountProvider::Codex)
            .ok_or_else(|| format!("Codex account {id} not found"))?;

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

        let (_removed, keyring_warning) = cleanup_before_codex_account_removal(
            || codex_accounts::remove_codex_home_dir(&app, &account),
            || with_claude_account_store(&app, |store| store.remove(&id)),
        )
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
        Ok(RemoveCodexAccountResult {
            detached_agent_pubkeys,
            warning: keyring_warning,
        })
    })
    .await
}

/// The one-time login command for a `chatgpt` account, for the UI to show
/// with a copy button. Also ensures the directory exists so the command works.
#[tauri::command]
pub async fn get_codex_login_command(
    id: String,
    app: AppHandle,
    caller: tauri::Webview,
) -> Result<String, String> {
    let trusted = super::upstream_apps::trusted_local_caller(&caller)?;
    run_trusted_blocking(trusted, move || {
        let account = with_claude_account_store(&app, |store| store.find(&id))?
            .filter(|account| account.provider == AccountProvider::Codex)
            .ok_or_else(|| format!("Codex account {id} not found"))?;
        if account.external_home.is_some() {
            return Err("Imported Orca accounts already use their existing login".to_string());
        }
        let dir = codex_accounts::ensure_codex_home_dir(&app, &account.id)?;
        Ok(codex_accounts::codex_login_command(
            &dir,
            resolve_command("codex").as_deref(),
        ))
    })
    .await
}

/// The Codex account `id` if it signs in through `codex login` (a `chatgpt`
/// account); API-key accounts have nothing to log in.
fn chatgpt_account(app: &AppHandle, id: &str) -> Result<ProviderAccount, String> {
    let account = with_claude_account_store(app, |store| store.find(id))?
        .filter(|account| account.provider == AccountProvider::Codex)
        .ok_or_else(|| format!("Codex account {id} not found"))?;
    match account.auth_kind {
        Some(CodexAuthKind::Chatgpt) => Ok(account),
        Some(CodexAuthKind::ApiKey) => Err(format!(
            "Codex account \"{}\" uses an API key; there is nothing to log in",
            account.label
        )),
        None => Err(format!(
            "Codex account \"{}\" has no auth kind recorded; remove it and add it again",
            account.label
        )),
    }
}

/// Start `codex login` for a `chatgpt` account inside the app: the CLI runs
/// by absolute path against the account's own `CODEX_HOME` (no shell, so no
/// function or alias can add flags) and opens the browser itself. Refuses
/// while another login is running — this account's, another account's, or
/// one started by hand that already holds the callback port.
#[tauri::command]
pub async fn start_codex_account_login(
    id: String,
    app: AppHandle,
    caller: tauri::Webview,
) -> Result<CodexLoginSnapshot, String> {
    let trusted = super::upstream_apps::trusted_local_caller(&caller)?;
    run_trusted_blocking(trusted, move || {
        let account = chatgpt_account(&app, &id)?;
        let Some(binary) = resolve_command("codex") else {
            return Err("Codex CLI (`codex`) was not found on PATH — install it, then try again".to_string());
        };
        let home_dir = codex_accounts::ensure_codex_home_dir(&app, &account.id)?;

        let state = app.state::<AppState>();
        let mut sessions = state
            .codex_login_sessions
            .lock()
            .map_err(|error| format!("failed to acquire login sessions lock: {error}"))?;
        let running = crate::managed_agents::codex_login::retain_running_login_sessions(
            &mut sessions,
        );
        let running: Vec<&str> = running.iter().map(String::as_str).collect();
        if let Some(conflict) = login_start_conflict(&running, &id) {
            return Err(conflict);
        }
        if callback_port_in_use(CODEX_LOGIN_CALLBACK_PORT) {
            return Err(format!(
                "a Codex login is already waiting on localhost:{CODEX_LOGIN_CALLBACK_PORT} (another window or a terminal); finish or cancel it first, then try again"
            ));
        }

        let session = spawn_codex_login(&CodexLoginLaunch {
            binary,
            cwd: home_dir.clone(),
            home_dir,
            path_env: crate::managed_agents::readiness::cli_probe::augmented_path(),
            timeout: DEFAULT_LOGIN_TIMEOUT,
        })?;
        let snapshot = session.snapshot();
        // A finished earlier session for this account is replaced; a running
        // one was refused above.
        sessions.insert(id, session);
        Ok(snapshot)
    })
    .await
}

/// Observe the account's login: `None` when none was started this app run.
#[tauri::command]
pub async fn poll_codex_account_login(
    id: String,
    app: AppHandle,
    caller: tauri::Webview,
) -> Result<Option<CodexLoginSnapshot>, String> {
    let trusted = super::upstream_apps::trusted_local_caller(&caller)?;
    run_trusted_blocking(trusted, move || {
        let state = app.state::<AppState>();
        let mut sessions = state
            .codex_login_sessions
            .lock()
            .map_err(|error| format!("failed to acquire login sessions lock: {error}"))?;
        Ok(sessions.get_mut(&id).map(|session| session.poll()))
    })
    .await
}

/// Stop the account's running login (kills the CLI; the browser tab, if
/// any, is simply left behind).
#[tauri::command]
pub async fn cancel_codex_account_login(
    id: String,
    app: AppHandle,
    caller: tauri::Webview,
) -> Result<Option<CodexLoginSnapshot>, String> {
    let trusted = super::upstream_apps::trusted_local_caller(&caller)?;
    run_trusted_blocking(trusted, move || {
        let state = app.state::<AppState>();
        let mut sessions = state
            .codex_login_sessions
            .lock()
            .map_err(|error| format!("failed to acquire login sessions lock: {error}"))?;
        Ok(sessions.get_mut(&id).map(|session| session.cancel()))
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
    caller: tauri::Webview,
) -> Result<CodexAccountTestResult, String> {
    let trusted = super::upstream_apps::trusted_local_caller(&caller)?;
    run_trusted_blocking(trusted, move || {
        let account = with_claude_account_store(&app, |store| store.find(&id))?
            .filter(|account| account.provider == AccountProvider::Codex)
            .ok_or_else(|| format!("Codex account {id} not found"))?;
        let Some(binary) = resolve_command("codex") else {
            return Ok(CodexAccountTestResult {
                ok: false,
                message: "Codex CLI (`codex`) was not found on PATH".to_string(),
            });
        };
        let app_home = codex_accounts::codex_home_dir(&app, &account.id)?;
        let home = codex_accounts::resolve_codex_home(app_home, account.external_home.clone());
        if home.external_read_only {
            codex_accounts::external_home_auth_kind(account.auth_kind)?;
        }
        if !home.external_read_only {
            std::fs::create_dir_all(&home.path).map_err(|error| {
                format!("failed to create the account's Codex directory: {error}")
            })?;
        }
        let home_dir = home.path.clone();

        let mut command = if home.external_read_only {
            codex_accounts::command_for_read_only_probe(&binary)?
        } else {
            std::process::Command::new(binary)
        };
        command.env_remove("ORCA_CODEX_HOME");
        command.env_remove("ORCA_CODEX_LAUNCH_PREFLIGHT");
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

        Ok(finish_codex_account_probe(command, key.as_deref()))
    })
    .await
}

/// Execute the exact command assembled by `test_codex_account` and reduce its
/// bounded output to the public, secret-scrubbed result.
fn finish_codex_account_probe(
    command: std::process::Command,
    key: Option<&str>,
) -> CodexAccountTestResult {
    let Some(output) = output_with_timeout(command, TEST_TIMEOUT) else {
        return CodexAccountTestResult {
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
    let message = summarize_probe_output(&String::from_utf8_lossy(&raw), key, ok);
    CodexAccountTestResult { ok, message }
}

/// First non-empty line of the CLI output, with the key (and anything else
/// shaped like an OpenAI secret) scrubbed and the length capped. Falls back
/// to a status sentence when the CLI said nothing.
fn summarize_probe_output(raw: &str, key: Option<&str>, ok: bool) -> String {
    let raw = match key {
        Some(key) => raw.replace(key, "…"),
        None => raw.to_string(),
    };
    let Some(line) = safe_first_output_line(raw.as_bytes()) else {
        return if ok {
            "Codex answered".to_string()
        } else {
            "Codex CLI exited with an error and no output".to_string()
        };
    };
    line
}

fn safe_first_output_line(raw: &[u8]) -> Option<String> {
    let raw = String::from_utf8_lossy(raw);
    let scrubbed = scrub_secrets(&raw);
    let line = scrubbed
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let mut out: String = line.chars().take(TEST_MESSAGE_MAX_CHARS).collect();
    if line.chars().count() > TEST_MESSAGE_MAX_CHARS {
        out.push('…');
    }
    Some(out)
}

/// One scrubber for every Codex output that reaches the UI.
fn scrub_secrets(text: &str) -> String {
    crate::managed_agents::codex_login::scrub_openai_secrets(text)
}

#[cfg(test)]
mod tests {
    use super::{
        cleanup_before_codex_account_removal, finish_codex_account_probe, load_orca_codex_accounts,
        parse_auth_kind, parse_orca_codex_accounts, safe_first_output_line, summarize_probe_output,
    };
    use crate::managed_agents::{
        codex_accounts::{remove_resolved_codex_home_dir, resolve_codex_home},
        CodexAuthKind,
    };

    #[cfg(unix)]
    fn failing_probe_command(secret: &str) -> std::process::Command {
        let mut command = std::process::Command::new("sh");
        command
            .args([
                "-c",
                "printf 'rejected %s key=sk-other-secret\\n' \"$PROBE_SECRET\" >&2; exit 7",
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
                "echo rejected %PROBE_SECRET% key=sk-other-secret 1>&2 & exit /B 7",
            ])
            .env("PROBE_SECRET", secret);
        command
    }

    #[test]
    fn auth_kind_parses_the_two_wire_values_and_rejects_the_rest() {
        assert_eq!(parse_auth_kind("api_key"), Ok(CodexAuthKind::ApiKey));
        assert_eq!(parse_auth_kind("chatgpt"), Ok(CodexAuthKind::Chatgpt));
        let error = parse_auth_kind("oauth").expect_err("unknown kind");
        assert!(error.contains("oauth"), "error names the kind: {error}");
    }

    #[test]
    fn codex_removal_keeps_the_retry_handle_until_owned_home_cleanup_succeeds() {
        let temp = tempfile::TempDir::new().expect("tempdir");
        let home_path = temp.path().join("codex-home");
        std::fs::write(&home_path, b"failure shape").expect("blocking file");
        let home = resolve_codex_home(home_path.clone(), None);
        let metadata_removals = std::cell::Cell::new(0usize);

        let error = cleanup_before_codex_account_removal(
            || remove_resolved_codex_home_dir(&home),
            || {
                metadata_removals.set(metadata_removals.get() + 1);
                Ok(())
            },
        )
        .expect_err("a non-directory owned home must fail closed");
        assert!(error.contains("account was kept"), "{error}");
        assert_eq!(metadata_removals.get(), 0, "metadata remains retryable");
        assert!(
            home_path.is_file(),
            "failed cleanup cannot erase the record first"
        );

        std::fs::remove_file(&home_path).expect("repair fixture");
        std::fs::create_dir(&home_path).expect("owned home");
        std::fs::write(home_path.join("auth.json"), b"fixture token").expect("auth fixture");
        cleanup_before_codex_account_removal(
            || remove_resolved_codex_home_dir(&home),
            || {
                metadata_removals.set(metadata_removals.get() + 1);
                Ok(())
            },
        )
        .expect("the same deletion can be retried after repair");
        assert_eq!(metadata_removals.get(), 1);
        assert!(!home_path.exists(), "retry cleans the owned home first");
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

    #[test]
    fn production_probe_marks_nonzero_as_failed_and_scrubs_captured_stderr() {
        let key = "sk-proj-account-verify-dummy";
        let result = finish_codex_account_probe(failing_probe_command(key), Some(key));

        assert!(!result.ok, "a nonzero CLI exit must never report success");
        assert_eq!(result.message, "rejected … key=…");
        assert!(!result.message.contains(key));
        assert!(!result.message.contains("sk-"));
    }

    #[test]
    fn orca_parser_reads_codex_bucket_without_expecting_provider_or_auth_method() {
        let raw = br#"{
          "ok": true,
          "result": {
            "claude": {"accounts": [{"id":"claude-id","email":"c@example.com","authMethod":"subscription-oauth"}]},
            "codex": {"accounts": [{"id":"codex-id","email":"x@example.com","workspaceLabel":"Team"}]},
            "rateLimits": {}
          }
        }"#;
        let accounts = parse_orca_codex_accounts(raw).expect("parse actual bucket shape");
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].id, "codex-id");
        assert_eq!(accounts[0].email, "x@example.com");
        assert_eq!(accounts[0].workspace_label.as_deref(), Some("Team"));
    }

    #[test]
    fn orca_failure_detail_is_bounded_to_one_secret_scrubbed_line() {
        let long = "x".repeat(500);
        let raw = format!("first sk-proj-not-real {long}\nsecond line");
        let line = safe_first_output_line(raw.as_bytes()).expect("first line");
        assert!(!line.contains("sk-proj-"));
        assert!(!line.contains("second line"));
        assert_eq!(line.chars().count(), 201);
        assert!(line.ends_with('…'));
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "live smoke: validator only; runs Orca list through the production probe helper"]
    fn live_orca_account_list_uses_the_production_read_only_probe() {
        assert!(!load_orca_codex_accounts()
            .expect("production sandboxed Orca account list")
            .is_empty());
    }
}
