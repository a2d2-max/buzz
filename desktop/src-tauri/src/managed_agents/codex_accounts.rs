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

pub(crate) use super::claude_accounts::ExternalCodexAccount;
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
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedCodexHome {
    pub path: PathBuf,
    pub external_read_only: bool,
}

pub(crate) fn resolve_codex_home(
    app_owned_home: PathBuf,
    external_home: Option<PathBuf>,
) -> ResolvedCodexHome {
    match external_home {
        Some(path) => ResolvedCodexHome {
            path,
            external_read_only: true,
        },
        None => ResolvedCodexHome {
            path: app_owned_home,
            external_read_only: false,
        },
    }
}

pub(crate) fn external_home_auth_kind(auth_kind: Option<CodexAuthKind>) -> Result<(), String> {
    if auth_kind == Some(CodexAuthKind::Chatgpt) {
        Ok(())
    } else {
        Err("an external Codex home is valid only for a ChatGPT account".to_string())
    }
}

fn external_codex_account_roots(home: &Path) -> Result<[PathBuf; 3], String> {
    let canonical = std::fs::canonicalize(home)
        .map_err(|error| format!("external Codex home is unavailable: {error}"))?;
    if canonical != home {
        return Err("external Codex home changed after import; re-import it from Orca".to_string());
    }
    if home.file_name().and_then(|name| name.to_str()) != Some("home") {
        return Err(
            "external Codex home no longer has Orca's account-home shape; re-import it".to_string(),
        );
    }
    let codex_accounts_root = home
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| "external Codex home has no Orca source root".to_string())?;
    if codex_accounts_root
        .file_name()
        .and_then(|name| name.to_str())
        != Some("codex-accounts")
    {
        return Err(
            "external Codex home is outside Orca's account source tree; re-import it".to_string(),
        );
    }
    let orca_root = codex_accounts_root
        .parent()
        .filter(|root| root.file_name().and_then(|name| name.to_str()) == Some("orca"))
        .ok_or_else(|| {
            "external Codex home is outside Orca's app-data tree; re-import it".to_string()
        })?;
    let canonical_orca_root = std::fs::canonicalize(orca_root)
        .map_err(|error| format!("Orca Codex account source tree is unavailable: {error}"))?;
    if canonical_orca_root != orca_root {
        return Err(
            "Orca Codex account source tree changed after import; re-import it".to_string(),
        );
    }
    let claude_accounts_root = canonical_orca_root.join("claude-accounts");
    match std::fs::symlink_metadata(&claude_accounts_root) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("Orca Claude account source root is not a regular directory".to_string());
        }
        Ok(_) => {
            let canonical = std::fs::canonicalize(&claude_accounts_root).map_err(|error| {
                format!("failed to resolve Orca Claude account source root: {error}")
            })?;
            if canonical != claude_accounts_root {
                return Err("Orca Claude account source root changed unexpectedly".to_string());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "failed to inspect Orca Claude account source root: {error}"
            ));
        }
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::MetadataExt;

        for name in ["auth.json", "config.toml"] {
            let path = home.join(name);
            let metadata = match std::fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(format!("failed to inspect external Codex {name}: {error}"));
                }
            };
            if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.nlink() > 1 {
                return Err(format!(
                    "external Codex {name} is not a single regular file; repair it in Orca before using this account"
                ));
            }
        }
    }
    Ok([
        canonical_orca_root,
        codex_accounts_root.to_path_buf(),
        claude_accounts_root,
    ])
}

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
/// holds real OAuth tokens (`auth.json`), so this must succeed before account
/// metadata is removed. Imported external homes remain read-only references.
pub(crate) fn remove_codex_home_dir<R: tauri::Runtime>(
    app: &AppHandle<R>,
    account: &super::claude_accounts::ProviderAccount,
) -> Result<(), String> {
    let app_home = codex_home_dir(app, &account.id)?;
    let home = resolve_codex_home(app_home, account.external_home.clone());
    remove_resolved_codex_home_dir(&home)
}

/// Remove an app-owned Codex home. Imported external homes are references and
/// are deliberately left untouched.
pub(crate) fn remove_resolved_codex_home_dir(home: &ResolvedCodexHome) -> Result<(), String> {
    if home.external_read_only || !home.path.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&home.path).map_err(|error| {
        format!(
            "could not delete the account's Codex directory ({}): {error}; the account was kept so removal can be retried",
            home.path.display()
        )
    })
}

fn sandbox_string(value: &Path) -> Result<String, String> {
    let value = value
        .to_str()
        .ok_or_else(|| "external Codex home path is not valid UTF-8".to_string())?;
    if value.contains(['\n', '\r', '\0']) {
        return Err("external Codex home path contains unsupported characters".to_string());
    }
    Ok(value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Wrap the ACP harness so it and every descendant can read, but cannot write,
/// an imported Orca home. Workspace and other process writes remain allowed.
#[cfg(target_os = "macos")]
pub(crate) fn command_for_external_codex_home(
    program: &Path,
    home: &Path,
) -> Result<std::process::Command, String> {
    const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";
    if !Path::new(SANDBOX_EXEC).is_file() {
        return Err(
            "macOS sandbox-exec is unavailable; refusing to start with an external Codex home"
                .to_string(),
        );
    }
    let [orca_root, codex_accounts_root, claude_accounts_root] =
        external_codex_account_roots(home)?;
    let protected_ancestors = orca_root
        .ancestors()
        .map(sandbox_string)
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|ancestor| format!("(deny file-write* (literal \"{ancestor}\"))"))
        .collect::<String>();
    let codex_accounts_root = sandbox_string(&codex_accounts_root)?;
    let claude_accounts_root = sandbox_string(&claude_accounts_root)?;
    let profile = format!(
        "(version 1)(allow default){protected_ancestors}(deny file-write* (literal \"{codex_accounts_root}\"))(deny file-write* (subpath \"{codex_accounts_root}\"))(deny file-write* (literal \"{claude_accounts_root}\"))(deny file-write* (subpath \"{claude_accounts_root}\"))"
    );
    let mut command = std::process::Command::new(SANDBOX_EXEC);
    command.args(["-p", &profile]);
    command.arg(program);
    Ok(command)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn command_for_external_codex_home(
    _program: &Path,
    _home: &Path,
) -> Result<std::process::Command, String> {
    Err("external Orca Codex homes are supported only on macOS".to_string())
}

/// Status probes need no writes anywhere. Global denial also protects any
/// path reached through a symlink inside the imported home.
#[cfg(target_os = "macos")]
pub(crate) fn command_for_read_only_probe(program: &Path) -> Result<std::process::Command, String> {
    const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";
    if !Path::new(SANDBOX_EXEC).is_file() {
        return Err(
            "macOS sandbox-exec is unavailable; refusing to test an external Codex home"
                .to_string(),
        );
    }
    let mut command = std::process::Command::new(SANDBOX_EXEC);
    command.args([
        "-p",
        "(version 1)(allow default)(deny file-write*)(allow file-write-data (literal \"/dev/null\") (literal \"/dev/stdout\") (literal \"/dev/stderr\") (literal \"/dev/tty\"))",
    ]);
    command.arg(program);
    Ok(command)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn command_for_read_only_probe(
    _program: &Path,
) -> Result<std::process::Command, String> {
    Err("external Orca Codex homes are supported only on macOS".to_string())
}

/// The copyable one-time login command for a `chatgpt` account, built for
/// the owner's interactive shell.
///
/// A `codex` shell function or alias there (e.g. one that appends
/// `--profile …`, which `codex login` rejects) would intercept a bare
/// `codex`, so the CLI is named by the absolute path the resolver found —
/// `resolve_command` never returns a function — or, while the CLI is not on
/// PATH yet, through the POSIX `command` builtin, which also bypasses both.
/// Words are single-quoted (ASCII `'`) only when they need it; the double
/// quotes macOS text substitution turns into typographic quotes (leaving the
/// shell stuck on `dquote>`) are never used.
pub(crate) fn codex_login_command(dir: &Path, codex_binary: Option<&Path>) -> String {
    let home = posix_shell_word(&dir.display().to_string());
    match codex_binary {
        Some(binary) => format!(
            "{CODEX_HOME_ENV}={home} {} login",
            posix_shell_word(&binary.display().to_string())
        ),
        None => format!("{CODEX_HOME_ENV}={home} command codex login"),
    }
}

/// Quote `word` for a POSIX shell: left bare when it is plain
/// (`[A-Za-z0-9/_.:=-]`), otherwise wrapped in ASCII single quotes with any
/// embedded quote spelled `'\''`.
fn posix_shell_word(word: &str) -> String {
    let plain = !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.' | ':' | '='));
    if plain {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

/// What the spawn writes onto the child for a named Codex account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodexSpawnAuth {
    /// The account's `CODEX_HOME` directory.
    pub home_dir: PathBuf,
    /// The keyring API key for `api_key` accounts; `None` for `chatgpt`
    /// accounts, whose login lives in `home_dir` itself.
    pub api_key: Option<String>,
    /// Imported Orca homes must be protected from writes by the full child
    /// process tree.
    pub external_read_only: bool,
}

/// The auth to inject for a spawn, or `None` when the agent runs on the app's
/// own Codex login. Fails closed in both bad cases: a runtime that does not
/// honor the selection (a stale account id on a Claude/Goose/Hermes agent)
/// would silently start on the app's own login — the global fallback the
/// owner did not pick — and a missing account is just as wrong. Not
/// launching beats launching on a different login.
pub(crate) fn codex_account_spawn_auth(
    account_id: Option<&str>,
    runtime_is_codex: bool,
    lookup: impl Fn(&str) -> Result<Option<CodexSpawnAuth>, String>,
) -> Result<Option<CodexSpawnAuth>, String> {
    let Some(id) = account_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    if !runtime_is_codex {
        return Err(
            "this runtime cannot sign in with a Codex account, so the one picked for the agent would be ignored — pick Default (or a supported runtime) in the agent's settings before starting it"
                .to_string(),
        );
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
    let app_home = codex_home_dir(app, id)?;
    let home = resolve_codex_home(app_home, account.external_home.clone());
    if home.external_read_only {
        external_home_auth_kind(account.auth_kind)?;
    }
    if !home.external_read_only {
        std::fs::create_dir_all(&home.path)
            .map_err(|error| format!("failed to create the account's Codex directory: {error}"))?;
    }
    let home_dir = home.path.clone();
    match account.auth_kind {
        Some(CodexAuthKind::ApiKey) => {
            let api_key = super::claude_accounts::with_claude_account_store(app, |store| {
                store.secret(AccountProvider::Codex, id)
            })?
            .ok_or_else(|| format!("Codex account {id} not found"))?;
            Ok(Some(CodexSpawnAuth {
                home_dir,
                api_key: Some(api_key),
                external_read_only: false,
            }))
        }
        Some(CodexAuthKind::Chatgpt) => {
            if !home_dir.join("auth.json").exists() {
                return Err(missing_chatgpt_login_message(&account.label, &home));
            }
            Ok(Some(CodexSpawnAuth {
                home_dir,
                api_key: None,
                external_read_only: home.external_read_only,
            }))
        }
        None => Err(format!(
            "Codex account \"{}\" has no auth kind recorded; remove it and add it again",
            account.label
        )),
    }
}

pub(crate) fn missing_chatgpt_login_message(label: &str, home: &ResolvedCodexHome) -> String {
    if home.external_read_only {
        format!(
            "Codex account \"{label}\" is not logged in in Orca — sign in through Orca, then test or re-import the account"
        )
    } else {
        format!(
            "Codex account \"{label}\" is not logged in yet — sign it in from Settings → Agents → Codex accounts (or run `{}` once), then start the agent",
            codex_login_command(
                &home.path,
                super::discovery::resolve_command("codex").as_deref()
            )
        )
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
    // Orca's wrapper variables can redirect Codex away from CODEX_HOME. A
    // named Buzz account is the explicit choice, so remove only those known
    // account selectors before setting the exact home.
    command.env_remove("ORCA_CODEX_HOME");
    command.env_remove("ORCA_CODEX_LAUNCH_PREFLIGHT");
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
