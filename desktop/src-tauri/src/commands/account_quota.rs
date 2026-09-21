//! `account_quota` — how much of a stored account's subscription is left.
//!
//! Settings → Agents lists the accounts an agent can run on, but a listed
//! account that is out of quota looks exactly like a fresh one until an agent
//! fails to spawn. This command puts the provider's own remaining-quota
//! reading on each row.
//!
//! It reads through the path that already owns each provider's credentials —
//! see [`crate::managed_agents::account_quota`] for why — and returns only
//! percentages, window names, and reset phrasing. No secret crosses the IPC
//! boundary in either direction.

use std::io::Read;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use tauri::AppHandle;

use crate::managed_agents::account_quota::{
    claude_usage_result_text, codex_access_token, parse_claude_usage_text, parse_codex_usage,
    AccountQuota, AccountQuotaState, MAX_PAYLOAD_BYTES,
};
use crate::managed_agents::{
    claude_accounts::{
        self, ClaudeAuthKind, ClaudeSpawnAuth, ANTHROPIC_API_KEY_ENV, ANTHROPIC_AUTH_TOKEN_ENV,
        CLAUDE_CONFIG_DIR_ENV, CLAUDE_OAUTH_TOKEN_ENV,
    },
    codex_accounts, output_with_timeout, resolve_command, with_claude_account_store,
    AccountProvider, CodexAuthKind, ProviderAccount,
};

/// The Claude reading resolves its slash command locally and the Codex reading
/// is one small GET; neither should ever approach this.
const QUOTA_TIMEOUT: Duration = Duration::from_secs(30);
/// Provider probes are comparatively expensive (a CLI process or one remote
/// request). The account file has no cardinality limit, so the backend — not
/// only the mounted Settings rows — owns the concurrency bound.
const MAX_CONCURRENT_QUOTA_PROBES: usize = 4;
/// A full first wave may consume its 30-second provider deadline. One queued
/// wave gets a small handoff margin; later callers fail visibly instead of
/// accumulating an unbounded process backlog.
const QUOTA_QUEUE_TIMEOUT: Duration = Duration::from_secs(35);

static QUOTA_PROBE_SLOTS: LazyLock<Arc<tokio::sync::Semaphore>> =
    LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_QUOTA_PROBES)));

/// ChatGPT's remaining-quota document for one Codex account.
const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

async fn run_blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    run_blocking_with_slots(Arc::clone(&QUOTA_PROBE_SLOTS), QUOTA_QUEUE_TIMEOUT, f).await
}

async fn run_blocking_with_slots<T: Send + 'static>(
    slots: Arc<tokio::sync::Semaphore>,
    queue_timeout: Duration,
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let permit = tokio::time::timeout(queue_timeout, slots.acquire_owned())
        .await
        .map_err(|_| "remaining-quota readers are busy; reopen Settings to retry".to_string())?
        .map_err(|_| "remaining-quota reader is unavailable".to_string())?;
    tokio::task::spawn_blocking(move || {
        // Keep the permit in the blocking job. Dropping/cancelling the async
        // caller must not release capacity while its CLI/HTTP probe continues.
        let _permit = permit;
        f()
    })
    .await
    .map_err(|error| format!("spawn_blocking failed: {error}"))?
}

/// Remaining subscription quota for one stored Claude or Codex account.
///
/// A provider that cannot be reached returns an `unavailable` reading rather
/// than an error, so one unreachable account never blanks the whole list; a
/// genuine lookup failure (unknown id, unreadable store) still errors.
#[tauri::command]
pub async fn account_quota(
    id: String,
    app: AppHandle,
    caller: tauri::Webview,
) -> Result<AccountQuota, String> {
    super::upstream_apps::ensure_trusted_caller(&caller)?;
    run_blocking(move || {
        let account = with_claude_account_store(&app, |store| store.find(&id))?
            .ok_or_else(|| format!("account {id} not found"))?;
        match account.provider {
            AccountProvider::Claude => Ok(claude_account_quota(&app, &account)),
            AccountProvider::Codex => Ok(codex_account_quota(&app, &account)),
        }
    })
    .await
}

/// Ask Claude Code for its own `/usage` report against this account's login.
///
/// The slash command is answered from local state — it starts no model turn
/// and spends no tokens — so this is cheap enough to run when the panel opens.
fn claude_account_quota(app: &AppHandle, account: &ProviderAccount) -> AccountQuota {
    let Some(binary) = resolve_command("claude") else {
        return AccountQuota::unavailable("Claude Code CLI (`claude`) was not found on PATH");
    };
    let mut command = std::process::Command::new(binary);
    command.args(["-p", "/usage", "--output-format", "json"]);

    let auth = match claude_accounts::lookup_claude_account_auth(app, &account.id) {
        Ok(Some(auth)) => auth,
        Ok(None) => return AccountQuota::needs_login("This account no longer exists"),
        Err(error) => {
            return if account.claude_auth_kind == Some(ClaudeAuthKind::ConfigDir) {
                AccountQuota::needs_login(error)
            } else {
                AccountQuota::unavailable(error)
            }
        }
    };
    match auth {
        ClaudeSpawnAuth::SetupToken(stored) => {
            command.env_remove(CLAUDE_CONFIG_DIR_ENV);
            command.env(CLAUDE_OAUTH_TOKEN_ENV, stored);
        }
        ClaudeSpawnAuth::ConfigDir(dir) => {
            command.env(CLAUDE_CONFIG_DIR_ENV, dir);
            command.env_remove(CLAUDE_OAUTH_TOKEN_ENV);
        }
    }

    // Read from an empty scratch directory so the CLI picks up no project
    // CLAUDE.md, settings, or hooks; the point is this account's quota only.
    let scratch = match tempfile::tempdir() {
        Ok(scratch) => scratch,
        Err(error) => {
            return AccountQuota::unavailable(format!(
                "failed to create a scratch directory for the reading: {error}"
            ))
        }
    };
    command.current_dir(scratch.path());
    if let Some(path) = crate::managed_agents::readiness::cli_probe::augmented_path() {
        command.env("PATH", path);
    }
    // An ambient key from the desktop's own environment would report the
    // wrong account's quota.
    command.env_remove(ANTHROPIC_API_KEY_ENV);
    command.env_remove(ANTHROPIC_AUTH_TOKEN_ENV);

    let Some(output) = output_with_timeout(command, QUOTA_TIMEOUT) else {
        return AccountQuota::unavailable(format!(
            "no response within {}s",
            QUOTA_TIMEOUT.as_secs()
        ));
    };
    let text = match claude_usage_result_text(&output.stdout) {
        Ok(text) => text,
        Err(error) => {
            // A non-zero exit with unparseable output is a login problem far
            // more often than a transport one, and the owner's fix differs.
            return if output.status.success() {
                AccountQuota::unavailable(error)
            } else {
                AccountQuota::needs_login(error)
            };
        }
    };
    let windows = parse_claude_usage_text(&text);
    if windows.is_empty() {
        // Claude answered, but in a shape this parser does not know. Hand the
        // owner what it actually said rather than an empty meter.
        return AccountQuota {
            state: AccountQuotaState::Unavailable,
            plan: None,
            windows,
            message: Some(first_line(&text)),
        };
    }
    AccountQuota {
        state: AccountQuotaState::Ok,
        plan: None,
        windows,
        message: None,
    }
}

/// Ask ChatGPT for this Codex account's remaining quota.
///
/// The login lives in a Buzz-owned `CODEX_HOME`, so this reads a file the app
/// already owns — no keychain, and no prompt.
fn codex_account_quota(app: &AppHandle, account: &ProviderAccount) -> AccountQuota {
    match account.auth_kind {
        Some(CodexAuthKind::Chatgpt) => {}
        Some(CodexAuthKind::ApiKey) => {
            return AccountQuota {
                state: AccountQuotaState::NotApplicable,
                plan: None,
                windows: Vec::new(),
                message: Some("API-key accounts bill per request — no plan quota".to_string()),
            }
        }
        None => {
            return AccountQuota::unavailable(
                "account has no auth kind recorded; remove it and add it again",
            )
        }
    }

    let app_home = match codex_accounts::codex_home_dir(app, &account.id) {
        Ok(home) => home,
        Err(error) => return AccountQuota::unavailable(error),
    };
    let home = codex_accounts::resolve_codex_home(app_home, account.external_home.clone());
    if home.external_read_only && !home.path.is_absolute() {
        return AccountQuota::unavailable("Imported Codex account home is not absolute");
    }
    if let Err(error) = validate_quota_codex_home(&home.path) {
        return AccountQuota::unavailable(error);
    }
    let auth_path = home.path.join("auth.json");
    match std::fs::symlink_metadata(&auth_path) {
        Ok(file) if file.file_type().is_symlink() || !file.is_file() => {
            return AccountQuota::unavailable("Codex account auth path is not a safe file")
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return AccountQuota::unavailable(format!(
                "could not inspect the account's login: {error}"
            ))
        }
    }
    let raw = match read_bounded(&auth_path) {
        Ok(Some(raw)) => raw,
        Ok(None) => return AccountQuota::needs_login("This account is not signed in to ChatGPT"),
        Err(error) => return AccountQuota::unavailable(error),
    };
    // Only the access token is taken. Spending the refresh token here would
    // rotate it out from under the agents this same home spawns.
    let Some((access_token, account_id)) = codex_access_token(&raw) else {
        return AccountQuota::needs_login("This account's ChatGPT login is incomplete");
    };

    let client = match reqwest::blocking::Client::builder()
        .timeout(QUOTA_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(error) => return AccountQuota::unavailable(format!("HTTP client failed: {error}")),
    };
    let response = client
        .get(CODEX_USAGE_URL)
        .bearer_auth(access_token)
        .header("chatgpt-account-id", account_id)
        .header("accept", "application/json")
        .send();
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            return AccountQuota::unavailable(format!("could not reach ChatGPT: {error}"))
        }
    };
    if response.status() == reqwest::StatusCode::UNAUTHORIZED
        || response.status() == reqwest::StatusCode::FORBIDDEN
    {
        return AccountQuota::needs_login("ChatGPT rejected this login — sign in again");
    }
    if !response.status().is_success() {
        return AccountQuota::unavailable(format!("ChatGPT returned {}", response.status()));
    }
    // Bounded: a changed contract must not stream an unbounded body into the
    // settings panel.
    let mut body = String::new();
    if response
        .take(MAX_PAYLOAD_BYTES as u64 + 1)
        .read_to_string(&mut body)
        .is_err()
    {
        return AccountQuota::unavailable("ChatGPT returned an unreadable body");
    }
    match parse_codex_usage(&body) {
        Ok(quota) => quota,
        Err(error) => AccountQuota::unavailable(error),
    }
}

/// Read a small credential file, capped. `Ok(None)` is "not signed in yet";
/// an unreadable existing file is an error, never a silent absence.
fn read_bounded(path: &std::path::Path) -> Result<Option<String>, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("could not read the account's login: {error}")),
    };
    let mut raw = String::new();
    file.take(MAX_PAYLOAD_BYTES as u64 + 1)
        .read_to_string(&mut raw)
        .map_err(|error| format!("could not read the account's login: {error}"))?;
    if raw.len() > MAX_PAYLOAD_BYTES {
        return Err("the account login file is larger than the quota reader accepts".to_string());
    }
    Ok(Some(raw))
}

fn validate_quota_codex_home(home: &std::path::Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(home)
        .map_err(|error| format!("Codex account home is unavailable: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Codex account home is not a safe directory".into());
    }
    Ok(())
}

/// First non-empty line of a provider message, bounded for display.
fn first_line(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Claude returned an unrecognized usage report");
    line.chars().take(200).collect()
}

#[cfg(test)]
mod concurrency_tests {
    use std::sync::{Arc, Barrier};
    use std::time::Duration;

    use tokio::sync::oneshot;

    use super::{run_blocking_with_slots, MAX_CONCURRENT_QUOTA_PROBES};

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn n_plus_one_probe_is_bounded_and_capacity_returns_after_completion() {
        let slots = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_QUOTA_PROBES));
        let release = Arc::new(Barrier::new(MAX_CONCURRENT_QUOTA_PROBES + 1));
        let mut running = Vec::new();
        let mut ready = Vec::new();

        for _ in 0..MAX_CONCURRENT_QUOTA_PROBES {
            let slots = Arc::clone(&slots);
            let release = Arc::clone(&release);
            let (ready_tx, ready_rx) = oneshot::channel();
            ready.push(ready_rx);
            running.push(tokio::spawn(async move {
                run_blocking_with_slots(slots, Duration::from_secs(1), move || {
                    let _ = ready_tx.send(());
                    release.wait();
                    Ok(())
                })
                .await
            }));
        }
        for ready_rx in ready {
            ready_rx.await.expect("fixture probe started");
        }

        let overflow =
            run_blocking_with_slots(Arc::clone(&slots), Duration::from_millis(10), || Ok(()))
                .await
                .expect_err("N+1 must not start another blocking provider probe");
        assert!(overflow.contains("busy"));

        release.wait();
        for task in running {
            task.await.unwrap().unwrap();
        }
        run_blocking_with_slots(slots, Duration::from_millis(10), || Ok(()))
            .await
            .expect("completed probes return their capacity");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_waiter_does_not_release_a_still_running_probe() {
        let slots = Arc::new(tokio::sync::Semaphore::new(1));
        let release = Arc::new(Barrier::new(2));
        let (ready_tx, ready_rx) = oneshot::channel();
        let task = tokio::spawn({
            let slots = Arc::clone(&slots);
            let release = Arc::clone(&release);
            async move {
                run_blocking_with_slots(slots, Duration::from_secs(1), move || {
                    let _ = ready_tx.send(());
                    release.wait();
                    Ok(())
                })
                .await
            }
        });
        ready_rx.await.expect("fixture probe started");
        task.abort();

        let overflow =
            run_blocking_with_slots(Arc::clone(&slots), Duration::from_millis(10), || Ok(()))
                .await
                .expect_err("cancelled caller must not free a live blocking probe");
        assert!(overflow.contains("busy"));

        release.wait();
        tokio::time::sleep(Duration::from_millis(10)).await;
        run_blocking_with_slots(slots, Duration::from_millis(50), || Ok(()))
            .await
            .expect("blocking completion returns capacity after cancellation");
    }
}
