//! Unit tests for `managed_agents/claude_accounts.rs`.
//!
//! Sibling file (`#[path]`-included) so the module stays small. The keyring is
//! replaced by an in-memory [`AccountTokenStore`] so nothing here touches the
//! OS keychain.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};

use tempfile::TempDir;

use super::{
    apply_claude_account_env, claude_account_spawn_auth, config_dir_spawn_auth,
    configure_claude_login_command, detach_claude_account, is_app_owned_claude_config_dir,
    token_keyring_name, validate_existing_claude_config_dir, AccountProvider, AccountTokenStore,
    ClaudeAuthKind, ClaudeSpawnAuth, ProviderAccountStore, ANTHROPIC_API_KEY_ENV,
    ANTHROPIC_AUTH_TOKEN_ENV, CLAUDE_CONFIG_DIR_ENV, CLAUDE_OAUTH_TOKEN_ENV,
};
use crate::managed_agents::ManagedAgentRecord;

const TOKEN: &str = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789";

/// In-memory token store. `fail_writes` simulates a keyring outage.
struct FakeTokenStore {
    fail_writes: bool,
    fail_delete: bool,
    stored: RefCell<HashMap<String, String>>,
}

impl FakeTokenStore {
    fn working() -> Self {
        Self {
            fail_writes: false,
            fail_delete: false,
            stored: RefCell::new(HashMap::new()),
        }
    }
    fn broken() -> Self {
        Self {
            fail_writes: true,
            fail_delete: false,
            stored: RefCell::new(HashMap::new()),
        }
    }
    fn delete_fails() -> Self {
        Self {
            fail_writes: false,
            fail_delete: true,
            stored: RefCell::new(HashMap::new()),
        }
    }
    fn stored(&self) -> HashMap<String, String> {
        self.stored.borrow().clone()
    }
}

impl AccountTokenStore for FakeTokenStore {
    fn load(&self, name: &str) -> Result<Option<String>, String> {
        Ok(self.stored.borrow().get(name).cloned())
    }
    fn store(&self, name: &str, value: &str) -> Result<(), String> {
        if self.fail_writes {
            return Err("keyring backend unreachable".to_string());
        }
        self.stored
            .borrow_mut()
            .insert(name.to_string(), value.to_string());
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        if self.fail_delete {
            return Err("keyring delete refused".to_string());
        }
        self.stored.borrow_mut().remove(name);
        Ok(())
    }
}

fn store_in<'a>(dir: &TempDir, tokens: &'a FakeTokenStore) -> ProviderAccountStore<'a> {
    ProviderAccountStore::new(dir.path().join("claude-accounts.json"), tokens)
}

/// The Claude keyring name — every store test here works on Claude accounts.
fn kr(id: &str) -> String {
    token_keyring_name(AccountProvider::Claude, id)
}

fn file_text(dir: &TempDir) -> String {
    std::fs::read_to_string(dir.path().join("claude-accounts.json")).expect("accounts file")
}

// ── add ───────────────────────────────────────────────────────────────────────

#[test]
fn add_persists_metadata_on_disk_and_token_only_in_the_token_store() {
    let dir = TempDir::new().expect("tempdir");
    let tokens = FakeTokenStore::working();
    let store = store_in(&dir, &tokens);

    let account = store.add("  Work  ", TOKEN).expect("add account");

    assert_eq!(account.label, "Work", "label is trimmed");
    assert!(!account.id.is_empty());
    assert!(!account.created_at.is_empty());
    assert_eq!(
        account.token_hint, "…6789",
        "hint is an ellipsis plus the last four"
    );

    let text = file_text(&dir);
    assert!(
        text.contains("\"Work\""),
        "metadata file carries the label: {text}"
    );
    assert!(
        !text.contains(TOKEN) && !text.contains("abcdefghijkl"),
        "token must never land in the metadata file: {text}"
    );
    assert_eq!(
        tokens.stored().get(&kr(&account.id)).map(String::as_str),
        Some(TOKEN),
        "token lives in the token store under the account's keyring name"
    );
}

#[test]
fn config_dir_account_persists_only_an_app_owned_path_and_no_keyring_secret() {
    let dir = TempDir::new().expect("tempdir");
    let tokens = FakeTokenStore::working();
    let store = store_in(&dir, &tokens);
    let config_dir = dir.path().join("claude-configs/account-id");

    let account = store
        .add_claude_config_dir("Browser login", config_dir.clone())
        .expect("add config-dir account");

    assert_eq!(account.claude_auth_kind, Some(ClaudeAuthKind::ConfigDir));
    assert_eq!(account.config_dir.as_deref(), Some(config_dir.as_path()));
    assert!(account.token_hint.is_empty());
    assert!(
        tokens.stored().is_empty(),
        "config-dir auth has no app keyring secret"
    );
    let text = file_text(&dir);
    assert!(text.contains("\"config_dir\""));
    assert!(text.contains("claude-configs/account-id"));
}

#[test]
fn config_dir_ownership_accepts_only_one_direct_child_of_the_app_root() {
    let root = std::path::Path::new("/app/agents/claude-configs");
    assert!(is_app_owned_claude_config_dir(
        root,
        std::path::Path::new("/app/agents/claude-configs/account")
    ));
    assert!(!is_app_owned_claude_config_dir(
        root,
        std::path::Path::new("/app/agents/claude-configs/account/nested")
    ));
    assert!(!is_app_owned_claude_config_dir(
        root,
        std::path::Path::new("/external/claude")
    ));
    for rejected in [
        "/app/agents/claude-configs",
        "/app/agents/claude-configs/..",
        "/app/agents/claude-configs/.",
        "/app/agents/claude-configs/account/../account",
        "/app/agents/claude-configs/account/.",
        "/app/agents/claude-configs/account/nested",
        "/app/agents/claude-configs-sibling/account",
    ] {
        assert!(
            !is_app_owned_claude_config_dir(root, std::path::Path::new(rejected)),
            "lexical path must be rejected: {rejected}"
        );
    }
}

#[cfg(unix)]
#[test]
fn config_dir_metadata_distinguishes_absent_directory_and_inspection_failures() {
    use std::os::unix::fs::symlink;

    let root = TempDir::new().expect("tempdir");
    let missing = root.path().join("missing");
    assert_eq!(
        validate_existing_claude_config_dir(&missing),
        Ok(false),
        "NotFound alone is a safe absent-directory result"
    );

    let directory = root.path().join("directory");
    std::fs::create_dir(&directory).expect("directory fixture");
    assert_eq!(validate_existing_claude_config_dir(&directory), Ok(true));

    let file = root.path().join("file");
    std::fs::write(&file, "not a directory").expect("file fixture");
    assert!(validate_existing_claude_config_dir(&file).is_err());

    let alias = root.path().join("alias");
    symlink(&directory, &alias).expect("symlink fixture");
    assert!(validate_existing_claude_config_dir(&alias).is_err());

    let not_a_directory = file.join("child");
    let error = validate_existing_claude_config_dir(&not_a_directory)
        .expect_err("NotADirectory must not be collapsed into absence");
    assert!(error.contains("failed to inspect"));
}

#[test]
fn add_trims_the_pasted_token() {
    let dir = TempDir::new().expect("tempdir");
    let tokens = FakeTokenStore::working();
    let store = store_in(&dir, &tokens);

    let account = store
        .add("Personal", &format!("  {TOKEN}\n"))
        .expect("surrounding whitespace is a paste artifact, not part of the token");

    assert_eq!(
        tokens.stored().get(&kr(&account.id)).map(String::as_str),
        Some(TOKEN)
    );
}

#[test]
fn add_rejects_blank_label() {
    let dir = TempDir::new().expect("tempdir");
    let tokens = FakeTokenStore::working();
    let store = store_in(&dir, &tokens);

    let error = store.add("   ", TOKEN).expect_err("blank label");
    assert!(error.contains("label"), "error names the label: {error}");
    assert!(
        tokens.stored().is_empty(),
        "nothing stored on a rejected add"
    );
}

#[test]
fn add_rejects_short_or_malformed_tokens_without_echoing_them() {
    let dir = TempDir::new().expect("tempdir");
    let tokens = FakeTokenStore::working();
    let store = store_in(&dir, &tokens);

    for bad in [
        "",
        "   ",
        "sk-x9q",
        "sk-ant-oat01-with space-inside-0123456789",
        "sk-ant\0nul-0123456789abcdef",
    ] {
        let error = store
            .add("Work", bad)
            .expect_err("malformed token must be rejected");
        assert!(error.contains("token"), "error names the token: {error}");
        assert!(
            bad.trim().is_empty() || !error.contains(bad.trim()),
            "error must not echo the pasted value: {error}"
        );
    }
    assert!(tokens.stored().is_empty());
    assert!(
        !dir.path().join("claude-accounts.json").exists(),
        "no metadata file is written for rejected adds"
    );
}

#[test]
fn add_rejects_duplicate_labels_case_insensitively() {
    let dir = TempDir::new().expect("tempdir");
    let tokens = FakeTokenStore::working();
    let store = store_in(&dir, &tokens);

    store.add("Work", TOKEN).expect("first add");
    let error = store.add(" work ", TOKEN).expect_err("duplicate label");
    assert!(
        error.contains("already"),
        "error explains the duplicate: {error}"
    );
    assert_eq!(store.list(AccountProvider::Claude).expect("list").len(), 1);
}

#[test]
fn add_writes_no_metadata_when_the_token_store_fails() {
    let dir = TempDir::new().expect("tempdir");
    let tokens = FakeTokenStore::broken();
    let store = store_in(&dir, &tokens);

    let error = store.add("Work", TOKEN).expect_err("token store outage");
    assert!(
        error.contains("unreachable"),
        "outage surfaces to the caller: {error}"
    );
    assert!(
        !dir.path().join("claude-accounts.json").exists(),
        "an account without a stored token must not exist"
    );
}

// ── list / rename / remove / token ────────────────────────────────────────────

#[test]
fn list_is_empty_before_any_add_and_preserves_insertion_order() {
    let dir = TempDir::new().expect("tempdir");
    let tokens = FakeTokenStore::working();
    let store = store_in(&dir, &tokens);

    assert!(store
        .list(AccountProvider::Claude)
        .expect("empty list")
        .is_empty());

    store.add("Second", TOKEN).expect("add");
    store.add("First", TOKEN).expect("add");
    let labels: Vec<String> = store
        .list(AccountProvider::Claude)
        .expect("list")
        .into_iter()
        .map(|a| a.label)
        .collect();
    assert_eq!(labels, vec!["Second", "First"]);
}

#[test]
fn list_fails_loudly_on_a_corrupt_metadata_file() {
    let dir = TempDir::new().expect("tempdir");
    std::fs::write(dir.path().join("claude-accounts.json"), "{not json").expect("write");
    let tokens = FakeTokenStore::working();
    let store = store_in(&dir, &tokens);

    let error = store
        .list(AccountProvider::Claude)
        .expect_err("corrupt file");
    assert!(
        error.contains("claude-accounts.json"),
        "error names the file: {error}"
    );
}

#[test]
fn rename_changes_the_label_and_keeps_id_and_token() {
    let dir = TempDir::new().expect("tempdir");
    let tokens = FakeTokenStore::working();
    let store = store_in(&dir, &tokens);

    let account = store.add("Work", TOKEN).expect("add");
    let renamed = store.rename(&account.id, " Team ").expect("rename");

    assert_eq!(renamed.id, account.id);
    assert_eq!(renamed.label, "Team");
    assert_eq!(renamed.token_hint, account.token_hint);
    assert_eq!(
        store.token(&account.id).expect("token"),
        Some(TOKEN.to_string())
    );
}

#[test]
fn rename_rejects_unknown_id_blank_label_and_duplicates() {
    let dir = TempDir::new().expect("tempdir");
    let tokens = FakeTokenStore::working();
    let store = store_in(&dir, &tokens);

    let work = store.add("Work", TOKEN).expect("add");
    store.add("Personal", TOKEN).expect("add");

    assert!(store
        .rename("missing", "X")
        .expect_err("unknown id")
        .contains("missing"));
    assert!(store
        .rename(&work.id, " ")
        .expect_err("blank")
        .contains("label"));
    assert!(store
        .rename(&work.id, "personal")
        .expect_err("duplicate")
        .contains("already"));
    // Renaming to its own label (case change) is fine.
    assert_eq!(
        store.rename(&work.id, "WORK").expect("self rename").label,
        "WORK"
    );
}

#[test]
fn remove_deletes_metadata_and_token() {
    let dir = TempDir::new().expect("tempdir");
    let tokens = FakeTokenStore::working();
    let store = store_in(&dir, &tokens);

    let work = store.add("Work", TOKEN).expect("add");
    let personal = store.add("Personal", TOKEN).expect("add");

    store.remove(&work.id).expect("remove");

    let ids: Vec<String> = store
        .list(AccountProvider::Claude)
        .expect("list")
        .into_iter()
        .map(|a| a.id)
        .collect();
    assert_eq!(ids, vec![personal.id.clone()]);
    assert!(!tokens.stored().contains_key(&kr(&work.id)));
    assert!(tokens.stored().contains_key(&kr(&personal.id)));
    assert!(store
        .remove(&work.id)
        .expect_err("second remove")
        .contains(&work.id));
}

#[test]
fn token_is_none_for_unknown_account_and_present_for_known() {
    let dir = TempDir::new().expect("tempdir");
    let tokens = FakeTokenStore::working();
    let store = store_in(&dir, &tokens);

    assert_eq!(store.token("nope").expect("unknown"), None);
    let work = store.add("Work", TOKEN).expect("add");
    assert_eq!(
        store.token(&work.id).expect("known"),
        Some(TOKEN.to_string())
    );
}

#[test]
fn token_missing_from_the_token_store_for_a_known_account_is_an_error() {
    let dir = TempDir::new().expect("tempdir");
    let tokens = FakeTokenStore::working();
    let store = store_in(&dir, &tokens);

    let work = store.add("Work", TOKEN).expect("add");
    tokens
        .delete(&kr(&work.id))
        .expect("simulate lost keyring entry");

    let error = store.token(&work.id).expect_err("metadata without token");
    assert!(error.contains("Work"), "error names the account: {error}");
}

// ── spawn-time resolution ─────────────────────────────────────────────────────

fn auth_lookup_with<'a>(
    map: &'a BTreeMap<&'a str, ClaudeSpawnAuth>,
) -> impl Fn(&str) -> Result<Option<ClaudeSpawnAuth>, String> + 'a {
    move |id| Ok(map.get(id).cloned())
}

#[test]
fn spawn_auth_is_absent_without_an_account() {
    let calls = RefCell::new(0);
    let lookup = |_: &str| {
        *calls.borrow_mut() += 1;
        Ok(Some(ClaudeSpawnAuth::SetupToken(TOKEN.to_string())))
    };
    assert_eq!(claude_account_spawn_auth(None, true, lookup), Ok(None));
    assert_eq!(*calls.borrow(), 0, "no account, no keyring read");
}

#[test]
fn spawn_auth_fails_closed_when_the_runtime_cannot_honor_the_account() {
    // A runtime that never reads the account would silently start on whatever
    // login it finds — the global fallback the owner did not pick. Refuse.
    let calls = RefCell::new(0);
    let lookup = |_: &str| {
        *calls.borrow_mut() += 1;
        Ok(Some(ClaudeSpawnAuth::SetupToken(TOKEN.to_string())))
    };
    let error = claude_account_spawn_auth(Some("acct"), false, lookup)
        .expect_err("an account on a runtime that cannot use it must refuse to spawn");
    assert!(
        error.contains("Claude account"),
        "names the account kind: {error}"
    );
    assert!(
        error.contains("Default"),
        "tells the owner the way out (pick Default): {error}"
    );
    assert!(!error.contains(TOKEN), "never echoes the token: {error}");
    assert_eq!(*calls.borrow(), 0, "refused before any keyring read");
}

#[test]
fn spawn_auth_resolves_the_selected_account_for_claude() {
    let auth = ClaudeSpawnAuth::SetupToken(TOKEN.to_string());
    let map = BTreeMap::from([("acct", auth.clone())]);
    assert_eq!(
        claude_account_spawn_auth(Some("acct"), true, auth_lookup_with(&map)),
        Ok(Some(auth))
    );
}

#[test]
fn spawn_auth_fails_closed_when_the_account_is_gone() {
    let map = BTreeMap::new();
    let error = claude_account_spawn_auth(Some("acct"), true, auth_lookup_with(&map))
        .expect_err("dangling account must refuse to spawn");
    assert!(
        error.contains("acct"),
        "error names the account id: {error}"
    );
    assert!(error.contains(CLAUDE_OAUTH_TOKEN_ENV) || error.contains("Claude account"));
}

#[test]
fn spawn_auth_distinguishes_legacy_tokens_from_config_directories() {
    let config = ClaudeSpawnAuth::ConfigDir(std::path::PathBuf::from("/app/claude/account"));
    let token = ClaudeSpawnAuth::SetupToken(TOKEN.to_string());
    let lookup = |id: &str| match id {
        "config" => Ok(Some(config.clone())),
        "token" => Ok(Some(token.clone())),
        _ => Ok(None),
    };

    assert_eq!(
        claude_account_spawn_auth(Some("config"), true, lookup),
        Ok(Some(config.clone()))
    );
    assert_eq!(
        claude_account_spawn_auth(Some("token"), true, lookup),
        Ok(Some(token.clone()))
    );
    assert!(claude_account_spawn_auth(Some("gone"), true, lookup).is_err());
    // A runtime that cannot honor the account fails closed for both kinds; it
    // used to return Ok(None), which silently fell back to the global login.
    assert!(claude_account_spawn_auth(Some("config"), false, lookup).is_err());
}

#[test]
fn spawn_auth_propagates_lookup_errors_without_a_secret_value() {
    let lookup = |_: &str| Err("keyring backend unreachable".to_string());
    let error = claude_account_spawn_auth(Some("acct"), true, lookup).expect_err("outage");
    assert!(error.contains("unreachable"));
    assert!(!error.contains(TOKEN));
}

#[test]
fn config_dir_spawn_auth_requires_a_login_marker_and_guides_recovery() {
    let dir = TempDir::new().expect("tempdir");
    let missing = dir.path().join("missing");
    let missing_error = config_dir_spawn_auth("Work", missing.clone(), |path| {
        validate_existing_claude_config_dir(path)
    })
    .expect_err("a missing directory is not authenticated");
    assert!(missing_error.contains("CLAUDE_CONFIG_DIR="));
    assert!(missing_error.contains("claude login"));

    let empty = dir.path().join("empty");
    std::fs::create_dir(&empty).expect("empty config dir");
    assert!(config_dir_spawn_auth("Work", empty.clone(), |path| {
        validate_existing_claude_config_dir(path)
    })
    .expect_err("an empty config directory is not authenticated")
    .contains("claude login"));

    for marker in [".claude.json", "oauth-account.json"] {
        let marked = dir.path().join(marker.replace('.', "_"));
        std::fs::create_dir(&marked).expect("marked config dir");
        std::fs::write(marked.join(marker), "fixture").expect("login marker");
        assert_eq!(
            config_dir_spawn_auth("Work", marked.clone(), |path| {
                validate_existing_claude_config_dir(path)
            }),
            Ok(ClaudeSpawnAuth::ConfigDir(marked))
        );
    }
}

// ── detach on remove ──────────────────────────────────────────────────────────

fn record(pubkey: &str, account: Option<&str>) -> ManagedAgentRecord {
    let mut record: ManagedAgentRecord = serde_json::from_value(serde_json::json!({
        "pubkey": pubkey, "name": pubkey, "relay_url": "", "acp_command": "",
        "agent_command": "", "agent_args": [], "mcp_command": "",
        "turn_timeout_seconds": 0, "system_prompt": null, "created_at": "",
        "updated_at": "", "last_started_at": null, "last_stopped_at": null,
        "last_exit_code": null, "last_error": null
    }))
    .expect("record");
    record.claude_account_id = account.map(str::to_string);
    record
}

#[test]
fn detach_clears_only_records_pointing_at_the_removed_account() {
    let mut records = vec![
        record("a", Some("acct")),
        record("b", Some("other")),
        record("c", None),
        record("d", Some("acct")),
    ];

    let detached = detach_claude_account(&mut records, "acct");

    assert_eq!(detached, vec!["a".to_string(), "d".to_string()]);
    assert_eq!(records[0].claude_account_id, None);
    assert_eq!(records[1].claude_account_id.as_deref(), Some("other"));
    assert_eq!(records[2].claude_account_id, None);
    assert_eq!(records[3].claude_account_id, None);
}

#[test]
fn claude_account_id_round_trips_through_json_and_is_omitted_when_absent() {
    let with = record("a", Some("acct"));
    let json = serde_json::to_string(&with).expect("serialize");
    assert!(json.contains("\"claude_account_id\":\"acct\""));
    let back: ManagedAgentRecord = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(back.claude_account_id.as_deref(), Some("acct"));

    let without = record("b", None);
    let json = serde_json::to_string(&without).expect("serialize");
    assert!(
        !json.contains("claude_account_id"),
        "absent account must not change the on-disk shape of older records: {json}"
    );
}

// ── update request application ────────────────────────────────────────────────

use super::apply_claude_account_update;

fn known(id: &str) -> bool {
    id == "acct"
}

#[test]
fn update_absent_leaves_the_account_untouched() {
    let mut r = record("a", Some("acct"));
    assert_eq!(apply_claude_account_update(&mut r, None, &known), Ok(false));
    assert_eq!(r.claude_account_id.as_deref(), Some("acct"));
}

#[test]
fn update_null_or_blank_clears_the_account() {
    let mut r = record("a", Some("acct"));
    assert_eq!(
        apply_claude_account_update(&mut r, Some(None), &known),
        Ok(true)
    );
    assert_eq!(r.claude_account_id, None);

    let mut r = record("a", Some("acct"));
    assert_eq!(
        apply_claude_account_update(&mut r, Some(Some("  ".into())), &known),
        Ok(true)
    );
    assert_eq!(r.claude_account_id, None);

    let mut r = record("a", None);
    assert_eq!(
        apply_claude_account_update(&mut r, Some(None), &known),
        Ok(false)
    );
}

#[test]
fn update_sets_a_known_account_and_rejects_an_unknown_one() {
    let mut r = record("a", None);
    assert_eq!(
        apply_claude_account_update(&mut r, Some(Some(" acct ".into())), &known),
        Ok(true)
    );
    assert_eq!(r.claude_account_id.as_deref(), Some("acct"));
    assert_eq!(
        apply_claude_account_update(&mut r, Some(Some("acct".into())), &known),
        Ok(false),
        "re-selecting the same account is not a change"
    );

    let error = apply_claude_account_update(&mut r, Some(Some("ghost".into())), &known)
        .expect_err("unknown account id");
    assert!(error.contains("ghost"), "error names the id: {error}");
    assert_eq!(
        r.claude_account_id.as_deref(),
        Some("acct"),
        "record untouched on error"
    );
}

#[test]
fn remove_reports_a_lingering_keyring_entry_as_a_warning_not_a_failure() {
    let dir = TempDir::new().expect("tempdir");
    let tokens = FakeTokenStore::delete_fails();
    let store = store_in(&dir, &tokens);

    let work = store.add("Work", TOKEN).expect("add");
    let (_removed, warning) = store
        .remove(&work.id)
        .expect("the account is gone even if the keyring entry lingers");
    assert!(
        warning.is_some_and(|w| w.contains("keyring")),
        "caller must learn about the orphaned keyring entry"
    );
    assert!(
        store
            .list(AccountProvider::Claude)
            .expect("list")
            .is_empty(),
        "metadata removal is what makes the account gone"
    );
}

// ── spawn env application ─────────────────────────────────────────────────────

fn env_map(cmd: &std::process::Command) -> BTreeMap<String, Option<String>> {
    cmd.get_envs()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.map(|v| v.to_string_lossy().into_owned()),
            )
        })
        .collect()
}

#[test]
fn spawn_env_account_token_wins_over_manual_env_and_strips_ambient_api_key() {
    // Layered user env already wrote a hand-typed token and an ambient API
    // key (e.g. from global agent env). The picked account must be what the
    // CLI actually uses: it overrides the manual token and the API key is
    // removed, because Claude Code prefers an API key over an OAuth token.
    let mut cmd = std::process::Command::new("true");
    cmd.env("ANTHROPIC_API_KEY", "ambient-key");
    cmd.env(CLAUDE_OAUTH_TOKEN_ENV, "manual-token");

    apply_claude_account_env(
        &mut cmd,
        Some(CLAUDE_OAUTH_TOKEN_ENV),
        Some(&ClaudeSpawnAuth::SetupToken(TOKEN.to_string())),
    );

    let envs = env_map(&cmd);
    assert_eq!(
        envs.get(CLAUDE_OAUTH_TOKEN_ENV),
        Some(&Some(TOKEN.to_string())),
        "account token must replace the hand-typed one"
    );
    assert_eq!(
        envs.get("ANTHROPIC_API_KEY"),
        Some(&None),
        "ambient API key must be removed so it cannot shadow the account"
    );
}

#[test]
fn spawn_env_config_dir_wins_and_clears_every_competing_claude_credential() {
    let mut cmd = std::process::Command::new("true");
    cmd.env(ANTHROPIC_API_KEY_ENV, "ambient-key");
    cmd.env(ANTHROPIC_AUTH_TOKEN_ENV, "ambient-auth");
    cmd.env(CLAUDE_OAUTH_TOKEN_ENV, "ambient-oauth");
    cmd.env(CLAUDE_CONFIG_DIR_ENV, "/somewhere/else");

    apply_claude_account_env(
        &mut cmd,
        Some(CLAUDE_OAUTH_TOKEN_ENV),
        Some(&ClaudeSpawnAuth::ConfigDir(std::path::PathBuf::from(
            "/app/claude/account",
        ))),
    );

    let envs = env_map(&cmd);
    assert_eq!(
        envs.get(CLAUDE_CONFIG_DIR_ENV),
        Some(&Some("/app/claude/account".to_string()))
    );
    for key in [
        ANTHROPIC_API_KEY_ENV,
        ANTHROPIC_AUTH_TOKEN_ENV,
        CLAUDE_OAUTH_TOKEN_ENV,
    ] {
        assert_eq!(envs.get(key), Some(&None), "{key} must be removed");
    }
}

#[test]
fn spawn_env_is_untouched_without_an_account_token() {
    let mut cmd = std::process::Command::new("true");
    cmd.env("ANTHROPIC_API_KEY", "ambient-key");
    cmd.env(CLAUDE_OAUTH_TOKEN_ENV, "manual-token");

    apply_claude_account_env(&mut cmd, Some(CLAUDE_OAUTH_TOKEN_ENV), None);
    apply_claude_account_env(
        &mut cmd,
        None,
        Some(&ClaudeSpawnAuth::SetupToken(TOKEN.to_string())),
    );

    let envs = env_map(&cmd);
    assert_eq!(
        envs.get("ANTHROPIC_API_KEY"),
        Some(&Some("ambient-key".to_string()))
    );
    assert_eq!(
        envs.get(CLAUDE_OAUTH_TOKEN_ENV),
        Some(&Some("manual-token".to_string()))
    );
}

/// The login the app runs must carry the same credential contract as spawn:
/// this account's directory wins, and every ambient competitor is dropped.
/// Without the removals an owner with `ANTHROPIC_API_KEY` exported would sign
/// in against a different login than the account they clicked.
#[test]
fn login_command_points_at_the_account_directory_and_drops_competing_credentials() {
    let mut command = std::process::Command::new("claude");
    configure_claude_login_command(&mut command, std::path::Path::new("/data/configs/acct"));

    let args: Vec<_> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    // The bare `claude login` TUI cannot run without a terminal; only this
    // subcommand goes straight to the browser.
    assert_eq!(args, ["auth", "login", "--claudeai"]);

    let envs: std::collections::HashMap<_, _> = command
        .get_envs()
        .map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                value.map(|value| value.to_string_lossy().into_owned()),
            )
        })
        .collect();
    assert_eq!(
        envs.get(CLAUDE_CONFIG_DIR_ENV),
        Some(&Some("/data/configs/acct".to_string()))
    );
    for key in [
        ANTHROPIC_API_KEY_ENV,
        ANTHROPIC_AUTH_TOKEN_ENV,
        CLAUDE_OAUTH_TOKEN_ENV,
    ] {
        assert_eq!(
            envs.get(key),
            Some(&None),
            "{key} must be cleared for the login"
        );
    }
}
