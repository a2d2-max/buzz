//! Per-agent Codex (OpenAI) account selection.
//!
//! Shares the provider-account store in `claude_accounts` (metadata file +
//! keyring); this module owns everything Codex-specific. The Codex CLI reads
//! its login from `$CODEX_HOME/auth.json`, and a ChatGPT login there BEATS an
//! ambient `OPENAI_API_KEY` (verified against codex-cli 0.153.4) — so merely
//! injecting a key cannot guarantee the picked account wins. Every account
//! therefore owns a `CODEX_HOME` directory under
//! `<app-data>/agents/codex-homes/<id>/`:
//!
//! * `api_key` accounts keep the key in the OS keyring and spawn with
//!   `CODEX_HOME=<dir>` (no `auth.json` inside) plus `OPENAI_API_KEY` — with
//!   no auth file present the CLI uses the env key (also verified).
//! * `chatgpt` accounts hold a real `codex login` inside the directory (the
//!   owner runs `CODEX_HOME=<dir> codex login` once); spawn sets
//!   `CODEX_HOME=<dir>` and removes `OPENAI_API_KEY` so an ambient key can
//!   never sign in a not-yet-logged-in account.
//!
//! An agent on a named Codex account reads `config.toml` from that account
//! directory, not `~/.codex` — the cost of making the explicit choice win.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use tauri::AppHandle;

use super::claude_accounts::{AccountProvider, CodexAuthKind};
use super::discovery::KnownAcpRuntime;
use super::storage::managed_agents_base_dir;
use super::types::ManagedAgentRecord;

/// Env var the Codex CLI reads an OpenAI API key from (when its
/// `CODEX_HOME` holds no `auth.json`).
pub(crate) const OPENAI_API_KEY_ENV: &str = "OPENAI_API_KEY";
/// Env var relocating the Codex CLI's config/auth directory.
pub(crate) const CODEX_HOME_ENV: &str = "CODEX_HOME";

const CODEX_HOMES_DIR_NAME: &str = "codex-homes";
const CODEX_CONFIG_FILE_NAME: &str = "config.toml";
const CODEX_CREDENTIAL_STORE_KEY: &str = "cli_auth_credentials_store";

/// The `CODEX_HOME` directory owned by account `id`.
pub(crate) fn codex_home_dir<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
) -> Result<PathBuf, String> {
    let id = validated_codex_account_id(id)?;
    Ok(managed_agents_base_dir(app)?
        .join(CODEX_HOMES_DIR_NAME)
        .join(id))
}

fn validated_codex_account_id(id: &str) -> Result<&str, String> {
    let parsed = uuid::Uuid::parse_str(id)
        .map_err(|_| "invalid Codex account id; remove the account and add it again".to_string())?;
    if parsed.to_string() != id {
        return Err("invalid Codex account id; remove the account and add it again".to_string());
    }
    Ok(id)
}

/// Create the account's `CODEX_HOME` and converge its credential store to a
/// file in that home (idempotent).
///
/// The ChatGPT spawn gate checks this home's `auth.json`. Letting Codex choose
/// `keyring` or `auto` can make `codex login` succeed without creating that
/// file, after which Buzz would reject the same account at spawn. This config
/// is app-owned, but owners can still add normal Codex settings to it, so the
/// edit preserves unrelated values and formatting.
pub(crate) fn ensure_codex_home_dir<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
) -> Result<PathBuf, String> {
    let dir = codex_home_dir(app, id)?;
    ensure_codex_home(&dir)?;
    Ok(dir)
}

/// Reserve and initialize a newly generated account home. Existing paths are
/// rejected so a failed add can safely remove only the directory it created.
pub(crate) fn create_codex_home_dir<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
) -> Result<PathBuf, String> {
    let dir = codex_home_dir(app, id)?;
    create_codex_home(&dir)?;
    Ok(dir)
}

fn create_codex_home(dir: &Path) -> Result<(), String> {
    create_codex_home_with(dir, converge_codex_credential_store)
}

fn ensure_codex_home(dir: &Path) -> Result<(), String> {
    create_codex_homes_parent(dir)?;
    let created = match std::fs::create_dir(dir) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            validate_existing_codex_home(dir)?;
            false
        }
        Err(error) => {
            return Err(format!(
                "failed to create the account's Codex directory: {error}"
            ))
        }
    };
    let config_path = dir.join(CODEX_CONFIG_FILE_NAME);
    if let Err(error) = converge_codex_credential_store(&config_path) {
        if created {
            return Err(with_new_codex_home_cleanup(error, dir));
        }
        return Err(error);
    }
    Ok(())
}

fn create_codex_home_with(
    dir: &Path,
    initialize: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    create_codex_homes_parent(dir)?;
    match std::fs::create_dir(dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(
                "the new Codex account directory already exists; try adding the account again"
                    .to_string(),
            )
        }
        Err(error) => {
            return Err(format!(
                "failed to create the new account's Codex directory: {error}"
            ))
        }
    }
    let config_path = dir.join(CODEX_CONFIG_FILE_NAME);
    initialize(&config_path).map_err(|error| with_new_codex_home_cleanup(error, dir))
}

fn create_codex_homes_parent(dir: &Path) -> Result<(), String> {
    let parent = dir
        .parent()
        .ok_or_else(|| "the Codex account directory has no parent".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create the Codex accounts directory: {error}"))
}

fn validate_existing_codex_home(dir: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(dir)
        .map_err(|error| format!("failed to inspect the account's Codex directory: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(
            "the account's Codex directory must be an app-owned directory, not a link or file"
                .to_string(),
        );
    }
    Ok(())
}

fn with_new_codex_home_cleanup(error: String, dir: &Path) -> String {
    match cleanup_created_codex_home(dir) {
        Ok(()) => error,
        Err(cleanup_error) => format!("{error}; new account home cleanup failed: {cleanup_error}"),
    }
}

fn cleanup_created_codex_home(dir: &Path) -> Result<(), String> {
    let config_path = dir.join(CODEX_CONFIG_FILE_NAME);
    match std::fs::symlink_metadata(&config_path) {
        Ok(metadata) if metadata.is_file() || metadata.file_type().is_symlink() => {
            std::fs::remove_file(&config_path)
                .map_err(|error| format!("failed to remove config.toml: {error}"))?;
        }
        Ok(_) => return Err("config.toml is not a removable file".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("failed to inspect config.toml: {error}")),
    }
    std::fs::remove_dir(dir).map_err(|error| format!("failed to remove account directory: {error}"))
}

/// Clean up a home reserved by [`create_codex_home_dir`] when the subsequent
/// account-store commit fails. Never recursively removes files.
pub(crate) fn cleanup_created_codex_home_dir<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
) -> Option<String> {
    let dir = match codex_home_dir(app, id) {
        Ok(dir) => dir,
        Err(error) => return Some(error),
    };
    cleanup_created_codex_home(&dir).err().map(|error| {
        format!(
            "the account was not added, but its new Codex directory could not be cleaned up ({}): {error}",
            dir.display()
        )
    })
}

fn converge_codex_credential_store(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(format!(
                "the account's Codex config must be an app-owned file, not a symbolic link ({})",
                path.display()
            ))
        }
        Ok(metadata) if !metadata.is_file() => {
            return Err(format!(
                "the account's Codex config is not a regular file ({})",
                path.display()
            ))
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "failed to inspect the account's Codex config ({}): {error}",
                path.display()
            ))
        }
    }
    let existing = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(format!(
                "failed to read the account's Codex config ({}): {error}",
                path.display()
            ))
        }
    };
    let mut document = existing
        .parse::<toml_edit::DocumentMut>()
        .map_err(|_| {
            format!(
                "failed to parse the account's Codex config ({}); fix or remove the malformed file and try again",
                path.display()
            )
        })?;
    if document
        .get(CODEX_CREDENTIAL_STORE_KEY)
        .and_then(toml_edit::Item::as_str)
        == Some("file")
    {
        return Ok(());
    }

    document[CODEX_CREDENTIAL_STORE_KEY] = toml_edit::value("file");
    atomic_write_codex_config(path, document.to_string().as_bytes())
}

fn atomic_write_codex_config(path: &Path, payload: &[u8]) -> Result<(), String> {
    use atomic_write_file::AtomicWriteFile;

    let mut file = AtomicWriteFile::open(path).map_err(|error| {
        format!(
            "failed to open the account's Codex config for atomic write ({}): {error}",
            path.display()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|error| {
                format!(
                    "failed to secure the account's Codex config ({}): {error}",
                    path.display()
                )
            })?;
    }
    file.write_all(payload).map_err(|error| {
        format!(
            "failed to write the account's Codex config ({}): {error}",
            path.display()
        )
    })?;
    file.commit().map_err(|error| {
        format!(
            "failed to commit the account's Codex config ({}): {error}",
            path.display()
        )
    })
}

/// Delete the account's `CODEX_HOME` directory. For `chatgpt` accounts it
/// holds real OAuth tokens (`auth.json`), so a removal must take it along;
/// a failure is returned as a warning — the account itself is already gone.
pub(crate) fn remove_codex_home_dir<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
) -> Option<String> {
    let dir = match codex_home_dir(app, id) {
        Ok(dir) => dir,
        Err(error) => return Some(error),
    };
    if !dir.exists() {
        return None;
    }
    std::fs::remove_dir_all(&dir).err().map(|error| {
        format!(
            "account removed, but its Codex directory could not be deleted ({}): {error}",
            dir.display()
        )
    })
}

/// The copyable one-time login command for a `chatgpt` account.
pub(crate) fn codex_login_command(dir: &std::path::Path) -> String {
    format!("CODEX_HOME=\"{}\" codex login", dir.display())
}

/// What the spawn writes onto the child for a named Codex account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodexSpawnAuth {
    /// The account's `CODEX_HOME` directory.
    pub home_dir: PathBuf,
    /// The keyring API key for `api_key` accounts; `None` for `chatgpt`
    /// accounts, whose login lives in `home_dir` itself.
    pub api_key: Option<String>,
}

/// The auth to inject for a spawn, or `None` when the agent runs on the app's
/// own Codex login. Only the Codex runtime honors the selection, so a stale
/// account id on a Claude/Goose agent is ignored rather than fatal; on a
/// Codex agent a missing account fails closed — silently launching on a
/// different login than the one the owner picked is worse than not launching.
pub(crate) fn codex_account_spawn_auth(
    account_id: Option<&str>,
    runtime_is_codex: bool,
    lookup: impl Fn(&str) -> Result<Option<CodexSpawnAuth>, String>,
) -> Result<Option<CodexSpawnAuth>, String> {
    let Some(id) = account_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    if !runtime_is_codex {
        return Ok(None);
    }
    match lookup(id)? {
        Some(auth) => Ok(Some(auth)),
        None => Err(format!(
            "Codex account {id} no longer exists — pick another account (or Default) in the agent's settings before starting it"
        )),
    }
}

/// Resolve account `id` into spawn auth: `Ok(None)` when the account is gone.
/// An `api_key` account whose keyring entry is missing is an error (see
/// `ProviderAccountStore::secret`); a `chatgpt` account that was never logged
/// in refuses the spawn with the login command, so the child does not start
/// on whatever `~/.codex` happens to hold.
pub(crate) fn lookup_codex_spawn_auth<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
) -> Result<Option<CodexSpawnAuth>, String> {
    let Some(account) =
        super::claude_accounts::with_claude_account_store(app, |store| store.find(id))?
    else {
        return Ok(None);
    };
    if account.provider != AccountProvider::Codex {
        return Ok(None);
    }
    let home_dir = ensure_codex_home_dir(app, id)?;
    match account.auth_kind {
        Some(CodexAuthKind::ApiKey) => {
            let api_key = super::claude_accounts::with_claude_account_store(app, |store| {
                store.secret(AccountProvider::Codex, id)
            })?
            .ok_or_else(|| format!("Codex account {id} not found"))?;
            Ok(Some(CodexSpawnAuth {
                home_dir,
                api_key: Some(api_key),
            }))
        }
        Some(CodexAuthKind::Chatgpt) => {
            if !home_dir.join("auth.json").exists() {
                return Err(format!(
                    "Codex account \"{}\" is not logged in yet — run `{}` once, then start the agent",
                    account.label,
                    codex_login_command(&home_dir)
                ));
            }
            Ok(Some(CodexSpawnAuth {
                home_dir,
                api_key: None,
            }))
        }
        None => Err(format!(
            "Codex account \"{}\" has no auth kind recorded; remove it and add it again",
            account.label
        )),
    }
}

/// Write the picked account's auth onto the spawn command.
///
/// Called AFTER the layered user env so the picker's explicit choice beats a
/// hand-typed `CODEX_HOME`/`OPENAI_API_KEY`. A `chatgpt` account also removes
/// `OPENAI_API_KEY`: with the account's own `auth.json` present the CLI would
/// prefer it anyway, but if that login is ever revoked an ambient key must not
/// silently take over. `None` leaves the command untouched.
pub(crate) fn apply_codex_account_env(
    command: &mut std::process::Command,
    auth: Option<&CodexSpawnAuth>,
) {
    let Some(auth) = auth else {
        return;
    };
    command.env(CODEX_HOME_ENV, &auth.home_dir);
    match auth.api_key.as_deref() {
        Some(key) => {
            command.env(OPENAI_API_KEY_ENV, key);
        }
        None => {
            command.env_remove(OPENAI_API_KEY_ENV);
        }
    }
}

/// Whether the spawn will hand the Codex runtime its own login: the record
/// names a stored Codex account, or the layered `env` already carries a
/// non-blank `OPENAI_API_KEY` or `CODEX_HOME`. Shared by the readiness
/// resolver and the spawn-time setup-payload check so the two can never
/// disagree — the counterpart of `claude_accounts::oauth_token_supplied`.
pub(crate) fn codex_auth_supplied(
    record: &ManagedAgentRecord,
    runtime: Option<&KnownAcpRuntime>,
    env: &BTreeMap<String, String>,
) -> bool {
    runtime.is_some_and(|r| r.supports_codex_accounts)
        && (record
            .codex_account_id
            .as_deref()
            .is_some_and(|id| !id.trim().is_empty())
            || [OPENAI_API_KEY_ENV, CODEX_HOME_ENV]
                .iter()
                .any(|key| env.get(*key).is_some_and(|value| !value.trim().is_empty())))
}

/// Clear `codex_account_id` on every record that points at `id`; returns the
/// pubkeys touched so the caller can persist and report them.
pub(crate) fn detach_codex_account(records: &mut [ManagedAgentRecord], id: &str) -> Vec<String> {
    records
        .iter_mut()
        .filter(|record| record.codex_account_id.as_deref() == Some(id))
        .map(|record| {
            record.codex_account_id = None;
            record.pubkey.clone()
        })
        .collect()
}

/// Apply the tri-state `codexAccountId` patch from an update request.
/// Absent = untouched; `null` or blank = clear; a value must name a `known`
/// account. Returns whether the record changed.
pub(crate) fn apply_codex_account_update(
    record: &mut ManagedAgentRecord,
    update: Option<Option<String>>,
    known: &dyn Fn(&str) -> bool,
) -> Result<bool, String> {
    let Some(update) = update else {
        return Ok(false);
    };
    let next = update
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    if let Some(id) = next.as_deref() {
        if !known(id) {
            return Err(format!("account {id} not found"));
        }
    }
    let changed = record.codex_account_id != next;
    record.codex_account_id = next;
    Ok(changed)
}

#[cfg(test)]
#[path = "codex_accounts_tests.rs"]
mod tests;
