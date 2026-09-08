//! Named provider accounts (Claude and Codex) for per-agent login selection.
//!
//! The owner may hold several Claude or ChatGPT/OpenAI subscriptions. Each
//! becomes a named account whose secret — the `claude setup-token` output for
//! Claude, the OpenAI API key for a Codex `api_key` account — is kept in the
//! OS keyring under `claude-account:<id>` / `codex-account:<id>` (the same
//! blob the agent nsecs live in), while the non-secret metadata (id, label,
//! provider, created_at, a `…last4` hint) lives in
//! `<app-data>/agents/claude-accounts.json`, written `0o600` like the agent
//! store. The file name predates the Codex provider and stays for
//! back-compat; records without a `provider` field deserialize as `claude`.
//! Codex `chatgpt` accounts keep no keyring secret at all — their login lives
//! in a per-account `CODEX_HOME` directory (see `codex_accounts`).
//!
//! A managed agent references an account by id
//! (`ManagedAgentRecord.claude_account_id` / `codex_account_id`). The secret
//! is resolved from the keyring at spawn time and written straight onto the
//! child `Command` (`CLAUDE_CODE_OAUTH_TOKEN` / `OPENAI_API_KEY`); it is never
//! copied into `env_vars`, the spawn snapshot, logs, or any IPC response.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::discovery::KnownAcpRuntime;
use super::env_vars::MAX_ENV_VALUE_BYTES;
use super::storage::{atomic_write_json_restricted, managed_agents_base_dir};
use super::types::ManagedAgentRecord;
use crate::app_state::keyring_service;
use crate::secret_store::SecretStore;

/// Env var the Claude Code CLI reads for a subscription OAuth token.
pub(crate) const CLAUDE_OAUTH_TOKEN_ENV: &str = "CLAUDE_CODE_OAUTH_TOKEN";

const ACCOUNTS_FILE_NAME: &str = "claude-accounts.json";
const MAX_LABEL_CHARS: usize = 64;
/// Real `claude setup-token` output is far longer; anything shorter is a paste
/// mistake, and the `…last4` hint would otherwise disclose a large share of it.
const MIN_TOKEN_CHARS: usize = 16;

/// Which CLI login a stored account belongs to.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AccountProvider {
    /// `claude` — records written before the field existed deserialize here.
    #[default]
    Claude,
    Codex,
}

/// How a Codex account authenticates. `None` on Claude accounts.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CodexAuthKind {
    /// OpenAI API key in the keyring, injected as `OPENAI_API_KEY`.
    ApiKey,
    /// ChatGPT-subscription login living in the account's own `CODEX_HOME`
    /// directory (`codex login` run there by the owner).
    Chatgpt,
}

/// One stored provider account. Never carries the secret.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderAccount {
    /// Random UUID minted on add; what `ManagedAgentRecord.claude_account_id`
    /// (or `codex_account_id`) points at.
    pub id: String,
    /// Owner-chosen display name, unique (case-insensitively) among the same
    /// provider's accounts.
    pub label: String,
    /// RFC 3339 timestamp of the add.
    pub created_at: String,
    /// `…` plus the last four characters of the secret — enough to tell two
    /// accounts apart, never enough to reconstruct one. Empty for Codex
    /// `chatgpt` accounts, which keep no secret here.
    #[serde(default)]
    pub token_hint: String,
    /// Which CLI this account signs in. Absent in records written before the
    /// Codex provider existed — those are Claude accounts.
    #[serde(default)]
    pub provider: AccountProvider,
    /// Codex-only: how the account authenticates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_kind: Option<CodexAuthKind>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ClaudeAccountsFile {
    #[serde(default)]
    accounts: Vec<ProviderAccount>,
}

/// The keyring operations the account store needs, abstracted so the store
/// can be unit-tested against an in-memory fake without touching the OS
/// keyring.
pub(crate) trait AccountTokenStore {
    /// `Ok(None)` is "no such entry"; `Err` is a backend failure. Callers must
    /// not collapse the two.
    fn load(&self, name: &str) -> Result<Option<String>, String>;
    fn store(&self, name: &str, value: &str) -> Result<(), String>;
    fn delete(&self, name: &str) -> Result<(), String>;
}

impl AccountTokenStore for SecretStore {
    fn load(&self, name: &str) -> Result<Option<String>, String> {
        SecretStore::load(self, name)
    }
    fn store(&self, name: &str, value: &str) -> Result<(), String> {
        SecretStore::store(self, name, value)
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        SecretStore::delete(self, name)
    }
}

/// Keyring key name for an account's secret, namespaced like `agent:<pubkey>`.
/// Claude entries predate the provider split and keep their historical prefix.
pub(crate) fn token_keyring_name(provider: AccountProvider, id: &str) -> String {
    match provider {
        AccountProvider::Claude => format!("claude-account:{id}"),
        AccountProvider::Codex => format!("codex-account:{id}"),
    }
}

/// Metadata file plus token store. Pure over its inputs — no `AppHandle`.
pub(crate) struct ProviderAccountStore<'a> {
    path: PathBuf,
    tokens: &'a dyn AccountTokenStore,
}

impl<'a> ProviderAccountStore<'a> {
    pub(crate) fn new(path: PathBuf, tokens: &'a dyn AccountTokenStore) -> Self {
        Self { path, tokens }
    }

    /// `provider`'s accounts in insertion order. Fails loudly on a corrupt
    /// file rather than presenting an empty list that a later save would make
    /// permanent.
    pub(crate) fn list(&self, provider: AccountProvider) -> Result<Vec<ProviderAccount>, String> {
        let mut accounts = self.read()?.accounts;
        accounts.retain(|account| account.provider == provider);
        Ok(accounts)
    }

    /// Store a Claude `claude setup-token` result under `label`. The token is
    /// written first: an account whose token never reached the keyring must
    /// not exist, and a failed metadata write rolls the token back.
    pub(crate) fn add(&self, label: &str, token: &str) -> Result<ProviderAccount, String> {
        self.add_with_secret(AccountProvider::Claude, None, label, Some(token))
    }

    /// Store a Codex account. `api_key` is required for `ApiKey` accounts and
    /// must be absent for `Chatgpt` ones (their login lives in the account's
    /// `CODEX_HOME` directory, not the keyring).
    pub(crate) fn add_codex(
        &self,
        auth_kind: CodexAuthKind,
        label: &str,
        api_key: Option<&str>,
    ) -> Result<ProviderAccount, String> {
        match (auth_kind, api_key) {
            (CodexAuthKind::ApiKey, None) => {
                Err("an API key is required for this account type".to_string())
            }
            (CodexAuthKind::Chatgpt, Some(_)) => {
                Err("a ChatGPT-login account does not take an API key".to_string())
            }
            _ => self.add_with_secret(AccountProvider::Codex, Some(auth_kind), label, api_key),
        }
    }

    fn add_with_secret(
        &self,
        provider: AccountProvider,
        auth_kind: Option<CodexAuthKind>,
        label: &str,
        secret: Option<&str>,
    ) -> Result<ProviderAccount, String> {
        let label = normalize_label(label)?;
        let secret = secret.map(normalize_token).transpose()?;
        let mut file = self.read()?;
        ensure_unique_label(&file.accounts, provider, &label, None)?;

        let account = ProviderAccount {
            id: uuid::Uuid::new_v4().to_string(),
            label,
            created_at: crate::util::now_iso(),
            token_hint: secret.as_deref().map(token_hint).unwrap_or_default(),
            provider,
            auth_kind,
        };
        let name = token_keyring_name(provider, &account.id);
        if let Some(ref secret) = secret {
            self.tokens.store(&name, secret)?;
        }
        file.accounts.push(account.clone());
        if let Err(error) = self.write(&file) {
            if secret.is_some() {
                let _ = self.tokens.delete(&name);
            }
            return Err(error);
        }
        Ok(account)
    }

    pub(crate) fn rename(&self, id: &str, label: &str) -> Result<ProviderAccount, String> {
        let label = normalize_label(label)?;
        let mut file = self.read()?;
        let provider = file
            .accounts
            .iter()
            .find(|account| account.id == id)
            .ok_or_else(|| not_found(id))?
            .provider;
        ensure_unique_label(&file.accounts, provider, &label, Some(id))?;
        let account = file
            .accounts
            .iter_mut()
            .find(|account| account.id == id)
            .ok_or_else(|| not_found(id))?;
        account.label = label;
        let renamed = account.clone();
        self.write(&file)?;
        Ok(renamed)
    }

    /// Drop the account and its keyring secret. Metadata goes first so a
    /// keyring failure can never leave a listed account without a secret.
    /// Returns the removed record plus `Some(warning)` when the account is
    /// gone but its keyring entry could not be deleted — an orphaned entry is
    /// harmless, and reporting that as a failure would hide a removal that did
    /// happen. Codex `chatgpt` accounts have no keyring entry; the caller owns
    /// deleting their `CODEX_HOME` directory.
    pub(crate) fn remove(&self, id: &str) -> Result<(ProviderAccount, Option<String>), String> {
        let mut file = self.read()?;
        let index = file
            .accounts
            .iter()
            .position(|account| account.id == id)
            .ok_or_else(|| not_found(id))?;
        let removed = file.accounts.remove(index);
        self.write(&file)?;
        if removed.auth_kind == Some(CodexAuthKind::Chatgpt) {
            return Ok((removed, None));
        }
        let warning = self
            .tokens
            .delete(&token_keyring_name(removed.provider, id))
            .err()
            .map(|error| {
                format!("account removed, but its keyring entry could not be deleted: {error}")
            });
        Ok((removed, warning))
    }

    /// The keyring secret for `provider`'s account `id`. `Ok(None)` when no
    /// such account is recorded under that provider; an account that is
    /// recorded but has no keyring entry is an error, not "no secret" — the
    /// caller must not silently fall back to another login.
    pub(crate) fn secret(
        &self,
        provider: AccountProvider,
        id: &str,
    ) -> Result<Option<String>, String> {
        let file = self.read()?;
        let Some(account) = file
            .accounts
            .iter()
            .find(|account| account.id == id && account.provider == provider)
        else {
            return Ok(None);
        };
        match self.tokens.load(&token_keyring_name(provider, id))? {
            Some(token) => Ok(Some(token)),
            None => Err(format!(
                "account \"{}\" has no secret in the OS keyring; remove it and add it again",
                account.label
            )),
        }
    }

    /// The token for a Claude account — see `secret`.
    pub(crate) fn token(&self, id: &str) -> Result<Option<String>, String> {
        self.secret(AccountProvider::Claude, id)
    }

    /// The full record for `id`, any provider. `Ok(None)` when unknown.
    pub(crate) fn find(&self, id: &str) -> Result<Option<ProviderAccount>, String> {
        Ok(self
            .read()?
            .accounts
            .into_iter()
            .find(|account| account.id == id))
    }

    fn read(&self) -> Result<ClaudeAccountsFile, String> {
        if !self.path.exists() {
            return Ok(ClaudeAccountsFile::default());
        }
        let text = std::fs::read_to_string(&self.path)
            .map_err(|error| format!("failed to read {ACCOUNTS_FILE_NAME}: {error}"))?;
        serde_json::from_str(&text)
            .map_err(|error| format!("failed to parse {ACCOUNTS_FILE_NAME}: {error}"))
    }

    fn write(&self, file: &ClaudeAccountsFile) -> Result<(), String> {
        let payload = serde_json::to_vec_pretty(file)
            .map_err(|error| format!("failed to serialize {ACCOUNTS_FILE_NAME}: {error}"))?;
        atomic_write_json_restricted(&self.path, &payload)
    }
}

fn not_found(id: &str) -> String {
    format!("account {id} not found")
}

fn normalize_label(label: &str) -> Result<String, String> {
    let label = label.trim();
    if label.is_empty() {
        return Err("account label is required".to_string());
    }
    if label.chars().count() > MAX_LABEL_CHARS {
        return Err(format!(
            "account label is too long (max {MAX_LABEL_CHARS} characters)"
        ));
    }
    Ok(label.to_string())
}

/// Validate a pasted secret (Claude OAuth token or OpenAI API key). Errors
/// are generic on purpose — the value is a credential and must never be
/// echoed back.
fn normalize_token(token: &str) -> Result<String, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("a token or key is required".to_string());
    }
    if token.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("the token or key must be a single line with no spaces".to_string());
    }
    if token.chars().count() < MIN_TOKEN_CHARS {
        return Err("the token or key is too short to be real".to_string());
    }
    if token.len() > MAX_ENV_VALUE_BYTES {
        return Err("the token or key is too long".to_string());
    }
    Ok(token.to_string())
}

/// Labels are unique per provider (case-insensitively) — a "Work" Claude
/// account and a "Work" Codex account may coexist.
fn ensure_unique_label(
    accounts: &[ProviderAccount],
    provider: AccountProvider,
    label: &str,
    except_id: Option<&str>,
) -> Result<(), String> {
    let wanted = label.to_lowercase();
    let taken = accounts
        .iter()
        .filter(|account| account.provider == provider)
        .filter(|account| Some(account.id.as_str()) != except_id)
        .any(|account| account.label.to_lowercase() == wanted);
    if taken {
        return Err(format!("an account named \"{label}\" already exists"));
    }
    Ok(())
}

fn token_hint(token: &str) -> String {
    let chars: Vec<char> = token.chars().collect();
    let tail: String = chars[chars.len().saturating_sub(4)..].iter().collect();
    format!("…{tail}")
}

// ── Spawn-time resolution ────────────────────────────────────────────────────

/// The token to inject for a spawn, or `None` when the agent runs on the
/// app's own Claude login. Only the Claude runtime reads the token, so a
/// stale account on a Goose/Codex agent is ignored rather than fatal; on a
/// Claude agent a missing account fails closed — silently launching on a
/// different subscription than the one the owner picked is worse than not
/// launching.
pub(crate) fn claude_account_spawn_token(
    account_id: Option<&str>,
    runtime_is_claude: bool,
    lookup: impl Fn(&str) -> Result<Option<String>, String>,
) -> Result<Option<String>, String> {
    let Some(id) = account_id.map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    if !runtime_is_claude {
        return Ok(None);
    }
    match lookup(id)? {
        Some(token) => Ok(Some(token)),
        None => Err(format!(
            "Claude account {id} no longer exists — pick another account (or Default) in the agent's settings before starting it"
        )),
    }
}

/// Whether the spawn will hand `runtime` an OAuth token: the record names a
/// stored Claude account, or the layered `env` carries a non-blank value under
/// the runtime's `oauth_token_env_var`. Shared by the readiness resolver and
/// the spawn-time setup-payload check so the two can never disagree.
pub(crate) fn oauth_token_supplied(
    record: &ManagedAgentRecord,
    runtime: Option<&KnownAcpRuntime>,
    env: &BTreeMap<String, String>,
) -> bool {
    runtime
        .and_then(|r| r.oauth_token_env_var)
        .is_some_and(|key| {
            record
                .claude_account_id
                .as_deref()
                .is_some_and(|id| !id.trim().is_empty())
                || env.get(key).is_some_and(|value| !value.trim().is_empty())
        })
}

/// Write the picked account's token onto the spawn command.
///
/// Called AFTER the layered user env so the picker's explicit choice beats a
/// hand-typed token. It also removes `ANTHROPIC_API_KEY`: Claude Code prefers
/// an API key over an OAuth token, so an ambient or global key would silently
/// run the agent on a different login than the one the owner picked.
/// `test_claude_account` probes under the same rule, so "Works" there means
/// the spawn works. `None` (no account, or a runtime without an OAuth env var)
/// leaves the command untouched.
pub(crate) fn apply_claude_account_env(
    command: &mut std::process::Command,
    oauth_token_env_var: Option<&str>,
    token: Option<&str>,
) {
    if let (Some(key), Some(token)) = (oauth_token_env_var, token) {
        command.env_remove("ANTHROPIC_API_KEY");
        command.env(key, token);
    }
}

/// Clear `claude_account_id` on every record that points at `id`; returns the
/// pubkeys touched so the caller can persist and report them.
pub(crate) fn detach_claude_account(records: &mut [ManagedAgentRecord], id: &str) -> Vec<String> {
    records
        .iter_mut()
        .filter(|record| record.claude_account_id.as_deref() == Some(id))
        .map(|record| {
            record.claude_account_id = None;
            record.pubkey.clone()
        })
        .collect()
}

/// Apply the tri-state `claudeAccountId` patch from an update request.
/// Absent = untouched; `null` or blank = clear; a value must name a `known`
/// account. Returns whether the record changed.
pub(crate) fn apply_claude_account_update(
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
            return Err(not_found(id));
        }
    }
    let changed = record.claude_account_id != next;
    record.claude_account_id = next;
    Ok(changed)
}

// ── App-facing ───────────────────────────────────────────────────────────────

fn claude_accounts_path<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(managed_agents_base_dir(app)?.join(ACCOUNTS_FILE_NAME))
}

/// Run `f` against the app's account store: metadata under the agents data
/// dir, secrets in the shared desktop keyring. Listing never touches the
/// keyring; in a build without a keyring backend every secret operation fails
/// with `SecretStore`'s own error.
pub(crate) fn with_claude_account_store<R: tauri::Runtime, T>(
    app: &AppHandle<R>,
    f: impl FnOnce(&ProviderAccountStore<'_>) -> Result<T, String>,
) -> Result<T, String> {
    let path = claude_accounts_path(app)?;
    let tokens: &'static SecretStore = SecretStore::shared(keyring_service());
    f(&ProviderAccountStore::new(path, tokens))
}

/// Keyring lookup for the spawn path: `Ok(None)` when the account is gone.
pub(crate) fn lookup_claude_account_token<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: &str,
) -> Result<Option<String>, String> {
    with_claude_account_store(app, |store| store.token(id))
}

#[cfg(test)]
#[path = "claude_accounts_tests.rs"]
mod tests;
