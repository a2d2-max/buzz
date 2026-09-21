use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;

use super::*;

const PUBKEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_PUBKEY: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// A stand-in `hermes` that records how it was called and creates the
/// profile directory the way the real CLI does. `mode`: "ok", "fail", "noop".
#[cfg(unix)]
fn fake_hermes(dir: &Path, mode: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let record = dir.join("calls.log");
    let script = dir.join("hermes");
    let body = match mode {
        "ok" => format!(
            "#!/bin/sh\nprintf 'HOME=%s ARGS=%s\\n' \"$HERMES_HOME\" \"$*\" >> '{}'\nmkdir -p \"$HERMES_HOME/profiles/$3\"\nprintf 'model:\\n  provider: openai-codex\\n' > \"$HERMES_HOME/profiles/$3/config.yaml\"\n",
            record.display()
        ),
        "fail" => "#!/bin/sh\necho 'boom: profile name taken' >&2\nexit 3\n".to_string(),
        _ => "#!/bin/sh\nexit 0\n".to_string(),
    };
    std::fs::write(&script, body).expect("write fake hermes");
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    script
}

#[cfg(unix)]
fn calls(dir: &Path) -> Vec<String> {
    std::fs::read_to_string(dir.join("calls.log"))
        .map(|s| s.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

fn envs(cmd: &Command) -> BTreeMap<String, Option<String>> {
    cmd.get_envs()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.map(|v| v.to_string_lossy().into_owned()),
            )
        })
        .collect()
}

// ── Hermes profile naming / root ─────────────────────────────────────────────

#[test]
fn hermes_profile_name_is_buzz_plus_the_first_16_hex_of_the_pubkey() {
    assert_eq!(
        hermes_profile_name(PUBKEY).unwrap(),
        "buzz-0123456789abcdef"
    );
    assert_eq!(
        hermes_profile_name(&PUBKEY.to_uppercase()).unwrap(),
        "buzz-0123456789abcdef",
        "Hermes profile ids are lowercase"
    );
    assert!(hermes_profile_name("0123").is_err(), "too short");
    assert!(hermes_profile_name("../../etc").is_err(), "not hex");
    assert!(hermes_profile_name("").is_err());
}

#[test]
fn hermes_root_prefers_a_user_hermes_home_and_unwraps_a_profile_path() {
    let default = || Some(PathBuf::from("/home/u/.hermes"));
    assert_eq!(
        hermes_root(&env(&[]), default).unwrap(),
        PathBuf::from("/home/u/.hermes")
    );
    assert_eq!(
        hermes_root(&env(&[("HERMES_HOME", "  ")]), default).unwrap(),
        PathBuf::from("/home/u/.hermes"),
        "blank is unset"
    );
    assert_eq!(
        hermes_root(&env(&[("HERMES_HOME", "/opt/hermes")]), default).unwrap(),
        PathBuf::from("/opt/hermes")
    );
    assert_eq!(
        hermes_root(
            &env(&[("HERMES_HOME", "/opt/hermes/profiles/work")]),
            default
        )
        .unwrap(),
        PathBuf::from("/opt/hermes"),
        "a profile home in the user env still isolates under its root"
    );
    assert!(
        hermes_root(&env(&[]), || None).is_err(),
        "no home dir → refuse"
    );
}

#[test]
fn hermes_profile_dir_depends_only_on_root_and_pubkey() {
    let root = Path::new("/home/u/.hermes");
    assert_eq!(
        hermes_profile_dir(root, PUBKEY).unwrap(),
        PathBuf::from("/home/u/.hermes/profiles/buzz-0123456789abcdef")
    );
    assert_ne!(
        hermes_profile_dir(root, PUBKEY).unwrap(),
        hermes_profile_dir(root, OTHER_PUBKEY).unwrap(),
        "two agents never share a profile"
    );
}

#[cfg(unix)]
#[test]
fn ensure_hermes_profile_creates_the_profile_through_the_hermes_cli_once() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("hermes-root");
    std::fs::create_dir_all(&root).unwrap();
    let cli = fake_hermes(tmp.path(), "ok");

    let dir = ensure_hermes_profile(&root, PUBKEY, &cli, None).expect("profile created");
    assert_eq!(dir, root.join("profiles/buzz-0123456789abcdef"));
    assert!(
        dir.join("config.yaml").is_file(),
        "the CLI seeded the profile"
    );
    assert_eq!(
        calls(tmp.path()),
        vec![format!(
            "HOME={} ARGS=profile create buzz-0123456789abcdef --no-alias",
            root.display()
        )],
        "created against the ROOT home, by name, without a shell wrapper"
    );

    // Second spawn: the profile exists, the CLI is not run again.
    let again = ensure_hermes_profile(&root, PUBKEY, &cli, None).expect("idempotent");
    assert_eq!(again, dir);
    assert_eq!(calls(tmp.path()).len(), 1, "no second create");
}

#[cfg(unix)]
#[test]
fn ensure_hermes_profile_fails_closed_when_the_cli_fails_or_makes_no_dir() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("hermes-root");
    std::fs::create_dir_all(&root).unwrap();

    let failing = fake_hermes(tmp.path(), "fail");
    let error = ensure_hermes_profile(&root, PUBKEY, &failing, None)
        .expect_err("a failed create must not start the agent on the shared home");
    assert!(
        error.contains("boom"),
        "carries the CLI's first error line: {error}"
    );
    assert!(!root.join("profiles/buzz-0123456789abcdef").exists());

    let silent = fake_hermes(tmp.path(), "noop");
    let error = ensure_hermes_profile(&root, PUBKEY, &silent, None)
        .expect_err("exit 0 without a directory is still a failure");
    assert!(
        error.contains("profiles/buzz-0123456789abcdef"),
        "names the missing profile dir: {error}"
    );
}

// ── Codex agent home ─────────────────────────────────────────────────────────

#[test]
fn codex_agent_home_dir_depends_only_on_base_and_pubkey() {
    let base = Path::new("/data/agents");
    assert_eq!(
        codex_agent_home_dir(base, PUBKEY).unwrap(),
        PathBuf::from(format!("/data/agents/homes/{PUBKEY}/codex"))
    );
    assert_ne!(
        codex_agent_home_dir(base, PUBKEY).unwrap(),
        codex_agent_home_dir(base, OTHER_PUBKEY).unwrap()
    );
    assert!(
        codex_agent_home_dir(base, "../escape").is_err(),
        "pubkey is a path segment"
    );
}

#[cfg(unix)]
#[test]
fn ensure_codex_agent_home_links_auth_and_config_to_the_sources_and_follows_account_switches() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = TempDir::new().unwrap();
    let account_a = tmp.path().join("codex-homes/a");
    let account_b = tmp.path().join("codex-homes/b");
    for account in [&account_a, &account_b] {
        std::fs::create_dir_all(account).unwrap();
        std::fs::write(account.join("auth.json"), "{}").unwrap();
        std::fs::write(account.join("config.toml"), "").unwrap();
    }
    let base = tmp.path().join("agents");
    let dir = codex_agent_home_dir(&base, PUBKEY).unwrap();

    let sources_a = CodexAgentHomeSources {
        auth_json: Some(account_a.join("auth.json")),
        config_toml: Some(account_a.join("config.toml")),
    };
    ensure_codex_agent_home(&dir, &sources_a).expect("home created");
    assert!(dir.is_dir());
    let owner_dir = base.join("homes").join(PUBKEY);
    assert_eq!(
        std::fs::metadata(&owner_dir).unwrap().permissions().mode() & 0o777,
        0o700,
        "the agent's home is private"
    );
    assert_eq!(
        std::fs::read_link(dir.join("auth.json")).unwrap(),
        account_a.join("auth.json"),
        "auth is a link to the account's file — never a copy"
    );
    assert_eq!(
        std::fs::read_link(dir.join("config.toml")).unwrap(),
        account_a.join("config.toml")
    );

    // A → B: same home (memory stays), the auth link follows the account.
    let sources_b = CodexAgentHomeSources {
        auth_json: Some(account_b.join("auth.json")),
        config_toml: Some(account_b.join("config.toml")),
    };
    std::fs::write(dir.join("history.jsonl"), "remembered\n").unwrap();
    ensure_codex_agent_home(&dir, &sources_b).expect("retargeted");
    assert_eq!(
        std::fs::read_link(dir.join("auth.json")).unwrap(),
        account_b.join("auth.json")
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("history.jsonl")).unwrap(),
        "remembered\n",
        "switching accounts keeps the agent's own data"
    );

    // B → A again, and an api-key account (no auth file): the stale link goes.
    ensure_codex_agent_home(&dir, &sources_a).expect("back to a");
    assert_eq!(
        std::fs::read_link(dir.join("auth.json")).unwrap(),
        account_a.join("auth.json")
    );
    let key_only = CodexAgentHomeSources {
        auth_json: None,
        config_toml: Some(account_a.join("config.toml")),
    };
    ensure_codex_agent_home(&dir, &key_only).expect("key account");
    assert!(
        std::fs::symlink_metadata(dir.join("auth.json")).is_err(),
        "no auth file for an api-key account — the key travels in the env"
    );
}

#[cfg(unix)]
#[test]
fn ensure_codex_agent_home_refuses_a_private_auth_copy() {
    let tmp = TempDir::new().unwrap();
    let source = tmp.path().join("acct");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("auth.json"), "{}").unwrap();
    let dir = codex_agent_home_dir(&tmp.path().join("agents"), PUBKEY).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    // A regular file here means a token copy diverged from the source.
    std::fs::write(dir.join("auth.json"), "{\"stale\":true}").unwrap();
    let error = ensure_codex_agent_home(
        &dir,
        &CodexAgentHomeSources {
            auth_json: Some(source.join("auth.json")),
            config_toml: None,
        },
    )
    .expect_err("a diverged copy must not be silently replaced or used");
    assert!(error.contains("auth.json"), "names the file: {error}");
    assert_eq!(
        std::fs::read_to_string(dir.join("auth.json")).unwrap(),
        "{\"stale\":true}",
        "left untouched for the owner to inspect"
    );
}

// ── Spawn seam ───────────────────────────────────────────────────────────────

#[test]
fn apply_agent_data_home_sets_the_home_env_over_user_values_and_only_when_planned() {
    let mut cmd = Command::new("agent");
    cmd.env("CODEX_HOME", "/user/typed");
    let plan = DataHomePlan {
        env_key: "CODEX_HOME",
        dir: PathBuf::from("/data/agents/homes/pk/codex"),
    };
    let _proof = apply_agent_data_home(&mut cmd, Some(&plan));
    assert_eq!(
        envs(&cmd).get("CODEX_HOME"),
        Some(&Some("/data/agents/homes/pk/codex".to_string())),
        "isolation is not optional: the agent's own home wins"
    );

    let mut untouched = Command::new("agent");
    untouched.env("HERMES_HOME", "/user/typed");
    let _proof = apply_agent_data_home(&mut untouched, None);
    assert_eq!(
        envs(&untouched).get("HERMES_HOME"),
        Some(&Some("/user/typed".to_string())),
        "no plan → the command is left alone"
    );
}

#[cfg(unix)]
#[test]
fn plan_data_home_gives_each_agent_its_own_home_that_survives_account_changes() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("hermes-root");
    std::fs::create_dir_all(&root).unwrap();
    let cli = fake_hermes(tmp.path(), "ok");
    let base = tmp.path().join("agents");
    let account = tmp.path().join("codex-homes/acct");
    std::fs::create_dir_all(&account).unwrap();
    std::fs::write(account.join("auth.json"), "{}").unwrap();
    let app_codex = tmp.path().join("dot-codex");
    std::fs::create_dir_all(&app_codex).unwrap();
    std::fs::write(app_codex.join("auth.json"), "{}").unwrap();

    let ctx = DataHomeContext {
        agents_base_dir: &base,
        hermes_cli: Some(cli),
        hermes_root: Some(root.clone()),
        path_env: None,
        codex_app_home: Some(app_codex.clone()),
    };

    // Hermes: a profile under the root, keyed by pubkey.
    let hermes = plan_data_home(DataHomeKind::HermesProfile, PUBKEY, None, &ctx)
        .unwrap()
        .expect("hermes plan");
    assert_eq!(hermes.env_key, "HERMES_HOME");
    assert_eq!(hermes.dir, root.join("profiles/buzz-0123456789abcdef"));
    assert!(hermes.dir.is_dir());

    // Codex, app login → link to ~/.codex; account A → link to the account.
    let app_login = plan_data_home(DataHomeKind::CodexHome, PUBKEY, None, &ctx)
        .unwrap()
        .expect("codex plan");
    assert_eq!(app_login.env_key, "CODEX_HOME");
    assert_eq!(app_login.dir, base.join("homes").join(PUBKEY).join("codex"));
    assert_eq!(
        std::fs::read_link(app_login.dir.join("auth.json")).unwrap(),
        app_codex.join("auth.json")
    );
    let with_account = plan_data_home(
        DataHomeKind::CodexHome,
        PUBKEY,
        Some(&CodexAgentHomeSources {
            auth_json: Some(account.join("auth.json")),
            config_toml: None,
        }),
        &ctx,
    )
    .unwrap()
    .expect("codex plan");
    assert_eq!(
        with_account.dir, app_login.dir,
        "the account changed, the home did not"
    );
    assert_eq!(
        std::fs::read_link(with_account.dir.join("auth.json")).unwrap(),
        account.join("auth.json")
    );

    // Another agent on the same account: a different home.
    let other = plan_data_home(
        DataHomeKind::CodexHome,
        OTHER_PUBKEY,
        Some(&CodexAgentHomeSources {
            auth_json: Some(account.join("auth.json")),
            config_toml: None,
        }),
        &ctx,
    )
    .unwrap()
    .expect("codex plan");
    assert_ne!(other.dir, with_account.dir);

    // Runtimes without isolation get no plan (and no side effects).
    assert_eq!(
        plan_data_home(DataHomeKind::None, PUBKEY, None, &ctx).unwrap(),
        None
    );
}

#[cfg(unix)]
#[test]
fn plan_data_home_fails_closed_when_hermes_cannot_make_the_profile() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("hermes-root");
    std::fs::create_dir_all(&root).unwrap();
    let ctx = DataHomeContext {
        agents_base_dir: tmp.path(),
        hermes_cli: None,
        hermes_root: Some(root),
        path_env: None,
        codex_app_home: Some(tmp.path().join("dot-codex")),
    };
    let error = plan_data_home(DataHomeKind::HermesProfile, PUBKEY, None, &ctx)
        .expect_err("no hermes CLI → no profile → no spawn on the shared home");
    assert!(error.contains("hermes"), "{error}");
}

/// Real-CLI check of the one assumption the Codex design rests on: the CLI
/// writes `auth.json` through a symlink instead of replacing it. Ignored by
/// default (needs `codex` on PATH); run with `--ignored`. Uses a fake key in a
/// temp dir — no real login, no real account.
#[cfg(unix)]
#[test]
#[ignore]
fn real_codex_cli_writes_auth_json_through_the_symlink() {
    use std::io::Write;
    let Some(codex) = super::super::discovery::resolve_command("codex") else {
        eprintln!("codex not on PATH; skipping");
        return;
    };
    let tmp = TempDir::new().unwrap();
    let source = tmp.path().join("acct");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(
        source.join("auth.json"),
        "{\"OPENAI_API_KEY\":\"sk-fake-before\"}\n",
    )
    .unwrap();
    std::fs::write(
        source.join("config.toml"),
        "cli_auth_credentials_store = \"file\"\n",
    )
    .unwrap();
    let dir = tmp.path().join("agent");
    ensure_codex_agent_home(
        &dir,
        &CodexAgentHomeSources {
            auth_json: Some(source.join("auth.json")),
            config_toml: Some(source.join("config.toml")),
        },
    )
    .unwrap();
    let mut child = Command::new(codex)
        .args(["login", "--with-api-key"])
        .env("CODEX_HOME", &dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("run codex");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"sk-fake-after\n")
        .unwrap();
    assert!(child.wait().unwrap().success());
    assert!(
        std::fs::symlink_metadata(dir.join("auth.json"))
            .unwrap()
            .file_type()
            .is_symlink(),
        "codex must write through the link, not replace it"
    );
    assert!(std::fs::read_to_string(source.join("auth.json"))
        .unwrap()
        .contains("sk-fake-after"));
}

// ── Removal on agent delete ──────────────────────────────────────────────────

#[test]
fn removal_targets_exactly_this_agents_dirs_and_tolerates_absence() {
    let tmp = TempDir::new().unwrap();
    let base = tmp.path().join("agents");
    let mine = codex_agent_home_dir(&base, PUBKEY).unwrap();
    let theirs = codex_agent_home_dir(&base, OTHER_PUBKEY).unwrap();
    std::fs::create_dir_all(&mine).unwrap();
    std::fs::create_dir_all(&theirs).unwrap();
    remove_agent_homes(&base, PUBKEY).unwrap();
    assert!(!base.join("homes").join(PUBKEY).exists());
    assert!(theirs.is_dir(), "the other agent's home is untouched");
    remove_agent_homes(&base, PUBKEY).unwrap();

    let root = tmp.path().join("hermes-root");
    let mine = hermes_profile_dir(&root, PUBKEY).unwrap();
    let theirs = hermes_profile_dir(&root, OTHER_PUBKEY).unwrap();
    std::fs::create_dir_all(&mine).unwrap();
    std::fs::create_dir_all(&theirs).unwrap();
    remove_hermes_profile(&root, PUBKEY).unwrap();
    assert!(!mine.exists());
    assert!(theirs.is_dir());
    remove_hermes_profile(&root, PUBKEY).unwrap();
}

#[test]
fn removal_propagates_a_disk_shape_failure_for_the_delete_command_to_report() {
    let tmp = TempDir::new().unwrap();
    let base = tmp.path().join("agents");
    let occupied = base.join("homes").join(PUBKEY);
    std::fs::create_dir_all(occupied.parent().unwrap()).unwrap();
    std::fs::write(&occupied, "not a directory").unwrap();

    let error = remove_agent_homes(&base, PUBKEY)
        .expect_err("a cleanup failure must not become successful agent deletion");
    assert!(error.contains("failed to remove the agent's data home"));
    assert_eq!(
        std::fs::read_to_string(occupied).unwrap(),
        "not a directory"
    );
}

#[cfg(unix)]
#[test]
fn plan_data_home_refuses_an_app_login_that_is_not_a_file() {
    // The app's Codex login lives in the OS keyring (no ~/.codex/auth.json):
    // an isolated home cannot see a keyring entry keyed by the shared home's
    // path, so the agent would start signed out. Refuse, and say what to do.
    let tmp = TempDir::new().unwrap();
    let app_codex = tmp.path().join("dot-codex");
    std::fs::create_dir_all(&app_codex).unwrap();
    std::fs::write(app_codex.join("config.toml"), "").unwrap();
    let ctx = DataHomeContext {
        agents_base_dir: tmp.path(),
        hermes_cli: None,
        hermes_root: None,
        path_env: None,
        codex_app_home: Some(app_codex.clone()),
    };
    let error = plan_data_home(DataHomeKind::CodexHome, PUBKEY, None, &ctx)
        .expect_err("no auth.json to link → refuse rather than start signed out");
    assert!(
        error.contains("auth.json"),
        "names the missing file: {error}"
    );
    assert!(
        error.contains("cli_auth_credentials_store"),
        "tells the owner how to get a file login: {error}"
    );
    assert!(
        !codex_agent_home_dir(tmp.path(), PUBKEY)
            .unwrap()
            .join("config.toml")
            .exists(),
        "nothing half-made"
    );
}
