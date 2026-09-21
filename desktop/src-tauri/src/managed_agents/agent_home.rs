//! Per-agent data homes: the agent identity (its pubkey) owns its memory.
//!
//! What an agent remembers — a harness's memories, sessions, state — used to
//! live wherever the harness keeps it by default, shared by every agent on
//! the machine (or on the same account). Here each agent gets its own home,
//! keyed by pubkey only, so two agents on one account never see each other's
//! state and one agent keeps its state across account or model changes.
//!
//! Auth is deliberately *not* in that home. A Codex home links `auth.json`
//! to the account's file (one file, never a copy — a copied refresh token
//! races the original). A Hermes profile borrows the root home's sign-ins,
//! which Hermes itself reads as a fallback and writes rotated grants back to.
//!
//! Which home a runtime gets is a catalog fact (`DataHomeKind` on
//! `KnownAcpRuntime` / `PresetHarness`), projected to the UI so the "Memory"
//! note and the spawn can never disagree.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;

use super::codex_accounts::{CodexSpawnAuth, CODEX_HOME_ENV};

pub(crate) const HERMES_HOME_ENV: &str = "HERMES_HOME";
const HERMES_PROFILES_DIR: &str = "profiles";
const HERMES_PROFILE_PREFIX: &str = "buzz-";
const HERMES_PROFILE_HEX: usize = 16;
const HOMES_DIR_NAME: &str = "homes";
const CODEX_SUBDIR: &str = "codex";
const CODEX_AUTH_FILE: &str = "auth.json";
const CODEX_CONFIG_FILE: &str = "config.toml";
const PROFILE_CREATE_TIMEOUT: Duration = Duration::from_secs(90);

/// Which per-agent home a runtime family gets. `None` = not isolated yet
/// (the runtime's default home is shared) — shown as such in the UI.
/// Why Buzz accounts do not apply to a runtime — shown in the edit dialog's
/// disabled account field. Catalog facts, keyed by runtime/preset.
pub(crate) const GOOSE_ACCOUNT_REASON: &str = "Goose signs in with its own provider keys (set them in the environment variables below). A2D2 accounts apply only to Claude Code and Codex.";
pub(crate) const BUZZ_AGENT_ACCOUNT_REASON: &str = "buzz-agent uses the provider and key configured below. A2D2 accounts apply only to Claude Code and Codex.";
pub(crate) const HERMES_ACCOUNT_REASON: &str = "Hermes keeps its own sign-ins in your Hermes home; this agent's profile borrows them. A A2D2 account can't be lent to it: Hermes would override a Claude token with the machine's Claude Code login, and a Codex login can't be shared without racing its single-use refresh token.";
pub(crate) const GENERIC_ACCOUNT_REASON: &str =
    "This harness signs in on its own. A2D2 accounts apply only to Claude Code and Codex runtimes.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DataHomeKind {
    None,
    /// `HERMES_HOME=<hermes root>/profiles/buzz-<pubkey16>` (Hermes profile
    /// mode: own memories/sessions/state, root sign-ins borrowed).
    HermesProfile,
    /// `CODEX_HOME=<app data>/agents/homes/<pubkey>/codex` with `auth.json`
    /// (and `config.toml`) linked to the account's — or the app login's — file.
    CodexHome,
}

/// Where a Codex agent home points its auth and config links. `None` = no
/// link (an api-key account carries its key in the env).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodexAgentHomeSources {
    pub auth_json: Option<PathBuf>,
    pub config_toml: Option<PathBuf>,
}

/// The env var + directory the spawn writes for the agent's home.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DataHomePlan {
    pub env_key: &'static str,
    pub dir: PathBuf,
}

/// Everything `plan_data_home` needs, resolved by the caller (no `AppHandle`).
pub(crate) struct DataHomeContext<'a> {
    /// `<app data>/agents` — Codex homes live under `homes/<pubkey>/`.
    pub agents_base_dir: &'a Path,
    /// The `hermes` CLI (creates profiles); `None` refuses Hermes spawns.
    pub hermes_cli: Option<PathBuf>,
    /// The Hermes root home (`~/.hermes` unless the user env says otherwise).
    pub hermes_root: Option<PathBuf>,
    /// PATH for the profile-create child (the augmented agent PATH).
    pub path_env: Option<String>,
    /// The app's own Codex home (`~/.codex` unless the user env says otherwise);
    /// `None` refuses Codex spawns.
    pub codex_app_home: Option<PathBuf>,
}

/// Proof token: `apply_agent_data_home` ran for this spawn. `#[must_use]`
/// and privately constructed, consumed by `spawn_with_effort_proof`, so
/// dropping the call from the spawn site is a compile error.
#[must_use]
pub(crate) struct DataHomeApplied(());

fn validated_pubkey(pubkey: &str) -> Result<String, String> {
    let trimmed = pubkey.trim();
    if trimmed.len() != 64 || !trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid agent pubkey for a data home".to_string());
    }
    Ok(trimmed.to_ascii_lowercase())
}

// ── Hermes profile ───────────────────────────────────────────────────────────

/// `buzz-<first 16 hex of the pubkey>`: a valid Hermes profile id
/// (`[a-z0-9][a-z0-9_-]{0,63}`), stable for the agent's lifetime.
pub(crate) fn hermes_profile_name(pubkey: &str) -> Result<String, String> {
    let pubkey = validated_pubkey(pubkey)?;
    Ok(format!(
        "{HERMES_PROFILE_PREFIX}{}",
        &pubkey[..HERMES_PROFILE_HEX]
    ))
}

/// The Hermes root home: a non-blank `HERMES_HOME` in the layered user env
/// (a profile path there is unwrapped to its root, so the agent still
/// isolates under it), else the platform default.
pub(crate) fn hermes_root(
    env: &BTreeMap<String, String>,
    platform_default: impl FnOnce() -> Option<PathBuf>,
) -> Result<PathBuf, String> {
    if let Some(value) = env
        .get(HERMES_HOME_ENV)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        let path = PathBuf::from(value);
        if let Some(parent) = path.parent() {
            if parent
                .file_name()
                .is_some_and(|name| name == HERMES_PROFILES_DIR)
            {
                if let Some(root) = parent.parent() {
                    return Ok(root.to_path_buf());
                }
            }
        }
        return Ok(path);
    }
    platform_default()
        .ok_or_else(|| "cannot locate the Hermes home directory (no home dir)".to_string())
}

/// `~/.hermes` (Windows: `%LOCALAPPDATA%\hermes`), as Hermes resolves it.
pub(crate) fn platform_hermes_root() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join("AppData").join("Local")))
            .map(|base| base.join("hermes"))
    }
    #[cfg(not(windows))]
    {
        dirs::home_dir().map(|home| home.join(".hermes"))
    }
}

pub(crate) fn hermes_profile_dir(root: &Path, pubkey: &str) -> Result<PathBuf, String> {
    Ok(root
        .join(HERMES_PROFILES_DIR)
        .join(hermes_profile_name(pubkey)?))
}

/// Create the agent's profile through the Hermes CLI (against the ROOT home,
/// by name, no shell wrapper) unless it already exists. Hermes seeds the
/// profile's `config.yaml` from the root's model settings and nothing
/// secret; sign-ins stay in the root and are borrowed at run time.
pub(crate) fn ensure_hermes_profile(
    root: &Path,
    pubkey: &str,
    hermes_cli: &Path,
    path_env: Option<&str>,
) -> Result<PathBuf, String> {
    let name = hermes_profile_name(pubkey)?;
    let dir = root.join(HERMES_PROFILES_DIR).join(&name);
    if dir.is_dir() {
        return Ok(dir);
    }
    let mut command = Command::new(hermes_cli);
    command
        .args(["profile", "create", &name, "--no-alias"])
        .env(HERMES_HOME_ENV, root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = path_env {
        command.env("PATH", path);
    }
    crate::util::configure_no_window(&mut command);
    let output = super::output_with_timeout(command, PROFILE_CREATE_TIMEOUT).ok_or_else(|| {
        format!(
            "`hermes profile create {name}` did not complete safely within {}s",
            PROFILE_CREATE_TIMEOUT.as_secs()
        )
    })?;
    if !output.status.success() {
        let line = safe_first_line(&output.stderr)
            .or_else(|| safe_first_line(&output.stdout))
            .unwrap_or_else(|| "no safe output".to_string());
        return Err(format!(
            "`hermes profile create {name}` failed ({}): {line}",
            output.status,
        ));
    }
    if !dir.is_dir() {
        return Err(format!(
            "`hermes profile create {name}` finished without creating {}",
            dir.display()
        ));
    }
    Ok(dir)
}

fn safe_first_line(bytes: &[u8]) -> Option<String> {
    let output = String::from_utf8_lossy(bytes);
    let line = output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let lower = line.to_ascii_lowercase();
    if ["token", "secret", "api key", "auth", "sk-", "eyj", "sess-"]
        .iter()
        .any(|marker| lower.contains(marker))
    {
        return Some("provider output redacted".to_string());
    }
    Some(line.chars().take(200).collect())
}

/// Remove the agent's Hermes profile directory (exact path for this pubkey;
/// nothing else under `profiles/`). Missing is fine.
pub(crate) fn remove_hermes_profile(root: &Path, pubkey: &str) -> Result<(), String> {
    let dir = hermes_profile_dir(root, pubkey)?;
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to remove the agent's Hermes profile {}: {error}",
            dir.display()
        )),
    }
}

/// The `hermes` CLI: next to the resolved adapter (`hermes-acp` and `hermes`
/// are installed side by side), else on the agent PATH.
pub(crate) fn resolve_hermes_cli(adapter_binary: Option<&Path>) -> Option<PathBuf> {
    let name = format!("hermes{}", std::env::consts::EXE_SUFFIX);
    adapter_binary
        .and_then(Path::parent)
        .map(|dir| dir.join(&name))
        .filter(|path| path.is_file())
        .or_else(|| super::discovery::resolve_command("hermes"))
}

// ── Codex agent home ─────────────────────────────────────────────────────────

/// `<agents base>/homes/<pubkey>/codex`, keyed by pubkey only.
pub(crate) fn codex_agent_home_dir(base: &Path, pubkey: &str) -> Result<PathBuf, String> {
    Ok(base
        .join(HOMES_DIR_NAME)
        .join(validated_pubkey(pubkey)?)
        .join(CODEX_SUBDIR))
}

/// The app's own Codex home: a non-blank `CODEX_HOME` in the layered user
/// env, else `~/.codex`.
pub(crate) fn codex_app_home(env: &BTreeMap<String, String>) -> Option<PathBuf> {
    env.get(CODEX_HOME_ENV)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
}

/// Link targets for a picked Codex account: a `chatgpt` account's own
/// `auth.json` (its login) and `config.toml`; an api-key account links only
/// the config — the key travels in the env.
pub(crate) fn codex_sources_for_account(auth: &CodexSpawnAuth) -> CodexAgentHomeSources {
    CodexAgentHomeSources {
        auth_json: auth
            .api_key
            .is_none()
            .then(|| auth.home_dir.join(CODEX_AUTH_FILE)),
        config_toml: Some(auth.home_dir.join(CODEX_CONFIG_FILE)),
    }
}

/// Link targets for the app's own Codex login. The login must be a file:
/// a keyring-stored login is keyed by the shared home's path, so an isolated
/// home could never see it and the agent would start signed out — refuse
/// instead, before anything is created.
fn app_login_sources(app_home: &Path) -> Result<CodexAgentHomeSources, String> {
    let auth_json = app_home.join(CODEX_AUTH_FILE);
    if !auth_json.is_file() {
        return Err(format!(
            "the app's Codex login is not stored as a file ({} is missing), so this agent's own Codex home cannot borrow it — run `codex login` with `cli_auth_credentials_store = \"file\"` in {}, or pick a Codex account for the agent",
            auth_json.display(),
            app_home.join(CODEX_CONFIG_FILE).display()
        ));
    }
    let config_toml = app_home.join(CODEX_CONFIG_FILE);
    Ok(CodexAgentHomeSources {
        auth_json: Some(auth_json),
        config_toml: config_toml.is_file().then_some(config_toml),
    })
}

/// Create the agent's Codex home (private) and point its `auth.json` /
/// `config.toml` links at `sources`, retargeting stale links (an account
/// switch) and dropping links with no source. A regular `auth.json` is
/// refused: it can only be a diverged token copy.
#[cfg(unix)]
pub(crate) fn ensure_codex_agent_home(
    dir: &Path,
    sources: &CodexAgentHomeSources,
) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let owner = dir
        .parent()
        .ok_or_else(|| "the Codex agent home has no parent directory".to_string())?;
    for path in [owner, dir] {
        std::fs::create_dir_all(path)
            .map_err(|error| format!("failed to create {}: {error}", path.display()))?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("failed to restrict {}: {error}", path.display()))?;
    }
    relink(
        &dir.join(CODEX_AUTH_FILE),
        sources.auth_json.as_deref(),
        RegularFile::Refuse,
    )?;
    relink(
        &dir.join(CODEX_CONFIG_FILE),
        sources.config_toml.as_deref(),
        RegularFile::Keep,
    )
}

#[cfg(not(unix))]
pub(crate) fn ensure_codex_agent_home(
    _dir: &Path,
    _sources: &CodexAgentHomeSources,
) -> Result<(), String> {
    Err(
        "per-agent Codex homes use symbolic links, which A2D2 does not create on this platform yet"
            .to_string(),
    )
}

#[cfg(unix)]
#[derive(Clone, Copy)]
enum RegularFile {
    /// A regular file here means a diverged token copy — refuse.
    Refuse,
    /// A regular file here is the harness's own rewrite — leave it.
    Keep,
}

#[cfg(unix)]
fn relink(link: &Path, target: Option<&Path>, regular: RegularFile) -> Result<(), String> {
    match std::fs::symlink_metadata(link) {
        Ok(meta) if meta.file_type().is_symlink() => {
            if target.is_some_and(|target| std::fs::read_link(link).ok().as_deref() == Some(target))
            {
                return Ok(());
            }
            std::fs::remove_file(link)
                .map_err(|error| format!("failed to replace {}: {error}", link.display()))?;
        }
        Ok(_) => match regular {
            RegularFile::Refuse => {
                return Err(format!(
                    "{} is a regular file, not a link to the account's login — it may hold a diverged token copy; move it away and start the agent again",
                    link.display()
                ))
            }
            RegularFile::Keep => return Ok(()),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("failed to inspect {}: {error}", link.display())),
    }
    if let Some(target) = target {
        std::os::unix::fs::symlink(target, link)
            .map_err(|error| format!("failed to link {}: {error}", link.display()))?;
    }
    Ok(())
}

/// Remove everything under `<agents base>/homes/<pubkey>` (exact path for
/// this pubkey). Missing is fine.
pub(crate) fn remove_agent_homes(base: &Path, pubkey: &str) -> Result<(), String> {
    let dir = base.join(HOMES_DIR_NAME).join(validated_pubkey(pubkey)?);
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to remove the agent's data home {}: {error}",
            dir.display()
        )),
    }
}

// ── Spawn seam ───────────────────────────────────────────────────────────────

/// Resolve (and materialize) the agent's home for this runtime. `Ok(None)`
/// for runtimes without isolation; `Err` refuses the spawn rather than fall
/// back to the shared home.
pub(crate) fn plan_data_home(
    kind: DataHomeKind,
    pubkey: &str,
    codex_sources: Option<&CodexAgentHomeSources>,
    ctx: &DataHomeContext<'_>,
) -> Result<Option<DataHomePlan>, String> {
    match kind {
        DataHomeKind::None => Ok(None),
        DataHomeKind::HermesProfile => {
            let root = ctx
                .hermes_root
                .clone()
                .ok_or_else(|| "cannot locate the Hermes home directory".to_string())?;
            let cli = ctx.hermes_cli.as_deref().ok_or_else(|| {
                "the hermes CLI was not found next to hermes-acp or on PATH; it is needed to create this agent's own Hermes profile".to_string()
            })?;
            let dir = ensure_hermes_profile(&root, pubkey, cli, ctx.path_env.as_deref())?;
            Ok(Some(DataHomePlan {
                env_key: HERMES_HOME_ENV,
                dir,
            }))
        }
        DataHomeKind::CodexHome => {
            if !cfg!(unix) {
                // No symlinks here yet: the shared home, as before (reported
                // as a gap, not silently isolated-looking).
                return Ok(None);
            }
            let dir = codex_agent_home_dir(ctx.agents_base_dir, pubkey)?;
            let app_login;
            let sources = match codex_sources {
                Some(sources) => sources,
                None => {
                    let app_home = ctx.codex_app_home.as_deref().ok_or_else(|| {
                        "cannot locate the app's Codex home directory".to_string()
                    })?;
                    app_login = app_login_sources(app_home)?;
                    &app_login
                }
            };
            ensure_codex_agent_home(&dir, sources)?;
            Ok(Some(DataHomePlan {
                env_key: CODEX_HOME_ENV,
                dir,
            }))
        }
    }
}

/// Write the planned home onto the spawn command. Called after the user env
/// and the account env: isolation is not a preference, so the agent's own
/// home wins over a hand-typed `CODEX_HOME`/`HERMES_HOME`.
pub(crate) fn apply_agent_data_home(
    command: &mut Command,
    plan: Option<&DataHomePlan>,
) -> DataHomeApplied {
    if let Some(plan) = plan {
        command.env(plan.env_key, &plan.dir);
    }
    DataHomeApplied(())
}

#[cfg(test)]
#[path = "agent_home_tests.rs"]
mod tests;
