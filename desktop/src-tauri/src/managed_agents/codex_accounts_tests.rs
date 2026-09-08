//! Unit tests for `managed_agents/codex_accounts.rs` and the Codex side of
//! the provider-account store. Sibling file (`#[path]`-included) so the
//! module stays small; the keyring is an in-memory fake.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use tempfile::TempDir;

use super::{
    apply_codex_account_env, codex_account_spawn_auth, codex_auth_supplied, codex_login_command,
    detach_codex_account, CodexSpawnAuth, CODEX_HOME_ENV, OPENAI_API_KEY_ENV,
};
use crate::managed_agents::claude_accounts::{
    token_keyring_name, AccountProvider, AccountTokenStore, CodexAuthKind, ProviderAccountStore,
};
use crate::managed_agents::ManagedAgentRecord;

const KEY: &str = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
const CLAUDE_TOKEN: &str = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789";

struct FakeTokenStore {
    stored: RefCell<HashMap<String, String>>,
}

impl FakeTokenStore {
    fn working() -> Self {
        Self {
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
        self.stored
            .borrow_mut()
            .insert(name.to_string(), value.to_string());
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        self.stored.borrow_mut().remove(name);
        Ok(())
    }
}

fn store_in<'a>(dir: &TempDir, tokens: &'a FakeTokenStore) -> ProviderAccountStore<'a> {
    ProviderAccountStore::new(dir.path().join("claude-accounts.json"), tokens)
}

// ── store: provider split ─────────────────────────────────────────────────────

#[test]
fn codex_api_key_account_stores_the_key_under_the_codex_keyring_name() {
    let dir = TempDir::new().expect("tempdir");
    let tokens = FakeTokenStore::working();
    let store = store_in(&dir, &tokens);

    let account = store
        .add_codex(CodexAuthKind::ApiKey, "Work", Some(KEY))
        .expect("add codex account");

    assert_eq!(account.provider, AccountProvider::Codex);
    assert_eq!(account.auth_kind, Some(CodexAuthKind::ApiKey));
    assert_eq!(account.token_hint, "…6789");
    assert_eq!(
        tokens
            .stored()
            .get(&token_keyring_name(AccountProvider::Codex, &account.id))
            .map(String::as_str),
        Some(KEY)
    );
    let text =
        std::fs::read_to_string(dir.path().join("claude-accounts.json")).expect("accounts file");
    assert!(
        !text.contains(KEY),
        "key must never land in the metadata file: {text}"
    );
    assert!(
        text.contains("\"codex\"") && text.contains("\"api_key\""),
        "provider and auth kind are recorded: {text}"
    );
}

#[test]
fn codex_chatgpt_account_keeps_no_keyring_secret_and_no_hint() {
    let dir = TempDir::new().expect("tempdir");
    let tokens = FakeTokenStore::working();
    let store = store_in(&dir, &tokens);

    let account = store
        .add_codex(CodexAuthKind::Chatgpt, "Team", None)
        .expect("add chatgpt account");

    assert_eq!(account.auth_kind, Some(CodexAuthKind::Chatgpt));
    assert_eq!(account.token_hint, "");
    assert!(tokens.stored().is_empty(), "no secret for a chatgpt login");
}

#[test]
fn codex_add_rejects_a_missing_or_misplaced_key() {
    let dir = TempDir::new().expect("tempdir");
    let tokens = FakeTokenStore::working();
    let store = store_in(&dir, &tokens);

    let error = store
        .add_codex(CodexAuthKind::ApiKey, "Work", None)
        .expect_err("api_key without a key");
    assert!(error.contains("API key"), "error explains: {error}");

    let error = store
        .add_codex(CodexAuthKind::Chatgpt, "Work", Some(KEY))
        .expect_err("chatgpt with a key");
    assert!(error.contains("API key"), "error explains: {error}");
    assert!(tokens.stored().is_empty());
}

#[test]
fn provider_lists_are_disjoint_and_labels_are_unique_per_provider() {
    let dir = TempDir::new().expect("tempdir");
    let tokens = FakeTokenStore::working();
    let store = store_in(&dir, &tokens);

    store.add("Work", CLAUDE_TOKEN).expect("claude add");
    store
        .add_codex(CodexAuthKind::ApiKey, "Work", Some(KEY))
        .expect("the same label under another provider is fine");
    store
        .add_codex(CodexAuthKind::Chatgpt, " work ", None)
        .expect_err("duplicate codex label");

    let claude = store.list(AccountProvider::Claude).expect("claude list");
    let codex = store.list(AccountProvider::Codex).expect("codex list");
    assert_eq!(claude.len(), 1);
    assert_eq!(codex.len(), 1);
    assert_eq!(claude[0].provider, AccountProvider::Claude);
    assert_eq!(codex[0].provider, AccountProvider::Codex);
}

#[test]
fn records_without_a_provider_field_deserialize_as_claude() {
    let dir = TempDir::new().expect("tempdir");
    // A file written by the pre-Codex build: no provider, no auth_kind.
    std::fs::write(
        dir.path().join("claude-accounts.json"),
        r#"{"accounts":[{"id":"old","label":"Legacy","created_at":"2026-01-01T00:00:00Z","token_hint":"…6789"}]}"#,
    )
    .expect("write legacy file");
    let tokens = FakeTokenStore::working();
    let store = store_in(&dir, &tokens);

    let claude = store.list(AccountProvider::Claude).expect("claude list");
    assert_eq!(claude.len(), 1, "legacy records are Claude accounts");
    assert_eq!(claude[0].provider, AccountProvider::Claude);
    assert_eq!(claude[0].auth_kind, None);
    assert!(store
        .list(AccountProvider::Codex)
        .expect("codex list")
        .is_empty());
}

#[test]
fn claude_secret_lookup_does_not_see_codex_accounts_and_vice_versa() {
    let dir = TempDir::new().expect("tempdir");
    let tokens = FakeTokenStore::working();
    let store = store_in(&dir, &tokens);

    let codex = store
        .add_codex(CodexAuthKind::ApiKey, "Work", Some(KEY))
        .expect("add codex");

    assert_eq!(
        store.token(&codex.id).expect("claude lookup of a codex id"),
        None,
        "a Codex id must not resolve as a Claude account"
    );
    assert_eq!(
        store
            .secret(AccountProvider::Codex, &codex.id)
            .expect("codex lookup"),
        Some(KEY.to_string())
    );
}

// ── spawn-time resolution ─────────────────────────────────────────────────────

fn auth(dir: &str, key: Option<&str>) -> CodexSpawnAuth {
    CodexSpawnAuth {
        home_dir: PathBuf::from(dir),
        api_key: key.map(str::to_string),
    }
}

fn lookup_with<'a>(
    map: &'a BTreeMap<&'a str, CodexSpawnAuth>,
) -> impl Fn(&str) -> Result<Option<CodexSpawnAuth>, String> + 'a {
    move |id| Ok(map.get(id).cloned())
}

#[test]
fn spawn_auth_is_absent_without_an_account_and_for_non_codex_runtimes() {
    let calls = RefCell::new(0);
    let lookup = |_: &str| {
        *calls.borrow_mut() += 1;
        Ok(Some(auth("/x", Some(KEY))))
    };
    assert_eq!(codex_account_spawn_auth(None, true, lookup), Ok(None));
    assert_eq!(codex_account_spawn_auth(Some("  "), true, lookup), Ok(None));
    assert_eq!(*calls.borrow(), 0, "no account, no store read");

    let map = BTreeMap::from([("acct", auth("/x", Some(KEY)))]);
    assert_eq!(
        codex_account_spawn_auth(Some("acct"), false, lookup_with(&map)),
        Ok(None),
        "a stale Codex account on a non-Codex runtime is ignored, not fatal"
    );
}

#[test]
fn spawn_auth_resolves_the_selected_account_and_fails_closed_when_gone() {
    let map = BTreeMap::from([("acct", auth("/homes/acct", Some(KEY)))]);
    assert_eq!(
        codex_account_spawn_auth(Some("acct"), true, lookup_with(&map)),
        Ok(Some(auth("/homes/acct", Some(KEY))))
    );

    let empty = BTreeMap::new();
    let error = codex_account_spawn_auth(Some("acct"), true, lookup_with(&empty))
        .expect_err("dangling account must refuse to spawn");
    assert!(error.contains("acct"), "error names the id: {error}");
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
fn spawn_env_api_key_account_sets_its_home_and_key_over_manual_values() {
    // Layered user env already wrote a hand-typed key and a CODEX_HOME. The
    // picked account must be what the CLI actually uses — and CODEX_HOME must
    // move too, because a ChatGPT login in the ambient home BEATS an env key.
    let mut cmd = std::process::Command::new("true");
    cmd.env(OPENAI_API_KEY_ENV, "manual-key");
    cmd.env(CODEX_HOME_ENV, "/somewhere/else");

    apply_codex_account_env(&mut cmd, Some(&auth("/homes/acct", Some(KEY))));

    let envs = env_map(&cmd);
    assert_eq!(envs.get(OPENAI_API_KEY_ENV), Some(&Some(KEY.to_string())));
    assert_eq!(
        envs.get(CODEX_HOME_ENV),
        Some(&Some("/homes/acct".to_string()))
    );
}

#[test]
fn spawn_env_chatgpt_account_sets_its_home_and_strips_the_ambient_key() {
    let mut cmd = std::process::Command::new("true");
    cmd.env(OPENAI_API_KEY_ENV, "manual-key");

    apply_codex_account_env(&mut cmd, Some(&auth("/homes/acct", None)));

    let envs = env_map(&cmd);
    assert_eq!(
        envs.get(OPENAI_API_KEY_ENV),
        Some(&None),
        "an ambient key must not take over if the directory login is revoked"
    );
    assert_eq!(
        envs.get(CODEX_HOME_ENV),
        Some(&Some("/homes/acct".to_string()))
    );
}

#[test]
fn spawn_env_is_untouched_without_an_account() {
    let mut cmd = std::process::Command::new("true");
    cmd.env(OPENAI_API_KEY_ENV, "manual-key");

    apply_codex_account_env(&mut cmd, None);

    let envs = env_map(&cmd);
    assert_eq!(
        envs.get(OPENAI_API_KEY_ENV),
        Some(&Some("manual-key".to_string()))
    );
    assert_eq!(envs.get(CODEX_HOME_ENV), None);
}

// ── readiness input ───────────────────────────────────────────────────────────

fn record(pubkey: &str, codex_account: Option<&str>) -> ManagedAgentRecord {
    let mut record: ManagedAgentRecord = serde_json::from_value(serde_json::json!({
        "pubkey": pubkey, "name": pubkey, "relay_url": "", "acp_command": "",
        "agent_command": "", "agent_args": [], "mcp_command": "",
        "turn_timeout_seconds": 0, "system_prompt": null, "created_at": "",
        "updated_at": "", "last_started_at": null, "last_stopped_at": null,
        "last_exit_code": null, "last_error": null
    }))
    .expect("record");
    record.codex_account_id = codex_account.map(str::to_string);
    record
}

fn codex_runtime() -> &'static crate::managed_agents::KnownAcpRuntime {
    crate::managed_agents::discovery::KNOWN_ACP_RUNTIMES
        .iter()
        .find(|runtime| runtime.id == "codex")
        .expect("codex runtime")
}

fn claude_runtime() -> &'static crate::managed_agents::KnownAcpRuntime {
    crate::managed_agents::discovery::KNOWN_ACP_RUNTIMES
        .iter()
        .find(|runtime| runtime.id == "claude")
        .expect("claude runtime")
}

#[test]
fn codex_auth_supplied_by_account_or_env_only_on_the_codex_runtime() {
    let env = BTreeMap::new();
    assert!(codex_auth_supplied(
        &record("a", Some("acct")),
        Some(codex_runtime()),
        &env
    ));
    assert!(!codex_auth_supplied(
        &record("a", None),
        Some(codex_runtime()),
        &env
    ));
    assert!(
        !codex_auth_supplied(&record("a", Some("acct")), Some(claude_runtime()), &env),
        "a Codex account on a Claude runtime supplies nothing"
    );
    assert!(!codex_auth_supplied(&record("a", Some("acct")), None, &env));

    for key in [OPENAI_API_KEY_ENV, CODEX_HOME_ENV] {
        let env = BTreeMap::from([(key.to_string(), "value".to_string())]);
        assert!(
            codex_auth_supplied(&record("a", None), Some(codex_runtime()), &env),
            "a hand-typed {key} counts as supplied auth"
        );
        let blank = BTreeMap::from([(key.to_string(), "  ".to_string())]);
        assert!(!codex_auth_supplied(
            &record("a", None),
            Some(codex_runtime()),
            &blank
        ));
    }
}

// ── detach / update / misc ────────────────────────────────────────────────────

#[test]
fn detach_clears_only_records_pointing_at_the_removed_account() {
    let mut records = vec![
        record("a", Some("acct")),
        record("b", Some("other")),
        record("c", None),
    ];
    let detached = detach_codex_account(&mut records, "acct");
    assert_eq!(detached, vec!["a".to_string()]);
    assert_eq!(records[0].codex_account_id, None);
    assert_eq!(records[1].codex_account_id.as_deref(), Some("other"));
}

#[test]
fn codex_account_id_round_trips_through_json_and_is_omitted_when_absent() {
    let with = record("a", Some("acct"));
    let json = serde_json::to_string(&with).expect("serialize");
    assert!(json.contains("\"codex_account_id\":\"acct\""));
    let back: ManagedAgentRecord = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(back.codex_account_id.as_deref(), Some("acct"));

    let without = record("b", None);
    let json = serde_json::to_string(&without).expect("serialize");
    assert!(
        !json.contains("codex_account_id"),
        "absent account must not change the on-disk shape of older records: {json}"
    );
}

use super::apply_codex_account_update;

fn known(id: &str) -> bool {
    id == "acct"
}

#[test]
fn update_follows_the_tri_state_contract() {
    let mut r = record("a", Some("acct"));
    assert_eq!(apply_codex_account_update(&mut r, None, &known), Ok(false));
    assert_eq!(r.codex_account_id.as_deref(), Some("acct"));

    assert_eq!(
        apply_codex_account_update(&mut r, Some(None), &known),
        Ok(true)
    );
    assert_eq!(r.codex_account_id, None);

    assert_eq!(
        apply_codex_account_update(&mut r, Some(Some(" acct ".into())), &known),
        Ok(true)
    );
    assert_eq!(r.codex_account_id.as_deref(), Some("acct"));

    let error = apply_codex_account_update(&mut r, Some(Some("ghost".into())), &known)
        .expect_err("unknown account id");
    assert!(error.contains("ghost"), "error names the id: {error}");
    assert_eq!(r.codex_account_id.as_deref(), Some("acct"));
}

#[test]
fn login_command_quotes_the_directory() {
    let command = codex_login_command(std::path::Path::new("/data/codex homes/acct"));
    assert_eq!(command, "CODEX_HOME=\"/data/codex homes/acct\" codex login");
}
