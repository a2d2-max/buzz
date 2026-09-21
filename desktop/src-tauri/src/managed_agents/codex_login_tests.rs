//! Unit tests for `managed_agents/codex_login.rs`. Every test drives a fake
//! `codex` shell script — the real CLI, its login server, and the owner's
//! auth files are never touched.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tempfile::TempDir;

use super::{
    auth_url_from_output, callback_port_in_use, login_start_conflict,
    retain_running_login_sessions, spawn_claude_login, spawn_codex_login, ClaudeLoginLaunch,
    CodexLoginLaunch, CodexLoginSession, CodexLoginSnapshot, CodexLoginState,
};

#[cfg(unix)]
fn fake_codex(temp: &TempDir, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = temp.path().join("codex");
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write fake codex");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    path
}

fn launch(binary: &Path, home: &Path, cwd: &Path, timeout: Duration) -> CodexLoginLaunch {
    CodexLoginLaunch {
        binary: binary.to_path_buf(),
        home_dir: home.to_path_buf(),
        cwd: cwd.to_path_buf(),
        path_env: None,
        timeout,
    }
}

fn wait_terminal(session: &mut CodexLoginSession, max: Duration) -> CodexLoginSnapshot {
    let deadline = Instant::now() + max;
    loop {
        let snapshot = session.poll();
        if snapshot.state != CodexLoginState::Running || Instant::now() > deadline {
            return snapshot;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(unix)]
#[test]
fn login_success_reports_succeeded_and_the_sign_in_url() {
    let temp = TempDir::new().expect("tempdir");
    let fake = fake_codex(
        &temp,
        "printf 'Starting local login server on http://localhost:1455.\\nIf your browser did not open, navigate to this URL:\\n\\nhttps://auth.example/oauth/authorize?state=abc\\n'; exit 0",
    );
    let home = temp.path().join("home");
    std::fs::create_dir_all(&home).expect("home");
    let mut session =
        spawn_codex_login(&launch(&fake, &home, temp.path(), Duration::from_secs(10)))
            .expect("spawn");

    let snapshot = wait_terminal(&mut session, Duration::from_secs(10));
    assert_eq!(snapshot.state, CodexLoginState::Succeeded, "{snapshot:?}");
    assert_eq!(
        snapshot.auth_url.as_deref(),
        Some("https://auth.example/oauth/authorize?state=abc")
    );
    assert_eq!(snapshot.message, None);
}

#[cfg(unix)]
#[test]
fn login_failure_reports_a_scrubbed_first_error_line() {
    let temp = TempDir::new().expect("tempdir");
    let fake = fake_codex(
        &temp,
        "printf 'Error: refused key=sk-proj-secret-value\\nmore\\n' >&2; exit 3",
    );
    let home = temp.path().join("home");
    std::fs::create_dir_all(&home).expect("home");
    let mut session =
        spawn_codex_login(&launch(&fake, &home, temp.path(), Duration::from_secs(10)))
            .expect("spawn");

    let snapshot = wait_terminal(&mut session, Duration::from_secs(10));
    assert_eq!(snapshot.state, CodexLoginState::Failed, "{snapshot:?}");
    let message = snapshot.message.expect("failure message");
    assert!(message.starts_with("Error: refused key=…"), "{message}");
    assert!(!message.contains("sk-proj"), "{message}");
    assert!(!message.contains("more"), "only the first line: {message}");
}

#[cfg(unix)]
#[test]
fn login_cancel_kills_the_cli() {
    let temp = TempDir::new().expect("tempdir");
    let fake = fake_codex(&temp, "sleep 30");
    let home = temp.path().join("home");
    std::fs::create_dir_all(&home).expect("home");
    let mut session =
        spawn_codex_login(&launch(&fake, &home, temp.path(), Duration::from_secs(60)))
            .expect("spawn");
    assert_eq!(session.poll().state, CodexLoginState::Running);

    let snapshot = session.cancel();
    assert_eq!(snapshot.state, CodexLoginState::Cancelled);
    assert!(
        session.is_finished(),
        "the child must be reaped after cancel"
    );
    // A terminal snapshot is stable: polling again does not resurrect it.
    assert_eq!(session.poll().state, CodexLoginState::Cancelled);
}

#[cfg(unix)]
#[test]
fn login_timeout_kills_the_cli() {
    let temp = TempDir::new().expect("tempdir");
    let fake = fake_codex(&temp, "sleep 30");
    let home = temp.path().join("home");
    std::fs::create_dir_all(&home).expect("home");
    let mut session = spawn_codex_login(&launch(
        &fake,
        &home,
        temp.path(),
        Duration::from_millis(200),
    ))
    .expect("spawn");

    let snapshot = wait_terminal(&mut session, Duration::from_secs(10));
    assert_eq!(snapshot.state, CodexLoginState::TimedOut, "{snapshot:?}");
    assert!(session.is_finished());
}

#[cfg(unix)]
#[test]
fn login_child_gets_the_account_home_and_no_ambient_api_key() {
    let temp = TempDir::new().expect("tempdir");
    let fake = fake_codex(
        &temp,
        "printf 'HOME=%s KEY=%s\\n' \"$CODEX_HOME\" \"${OPENAI_API_KEY-unset}\"; exit 0",
    );
    let home = temp.path().join("acct home");
    std::fs::create_dir_all(&home).expect("home");
    let mut session =
        spawn_codex_login(&launch(&fake, &home, temp.path(), Duration::from_secs(10)))
            .expect("spawn");
    let snapshot = wait_terminal(&mut session, Duration::from_secs(10));
    assert_eq!(snapshot.state, CodexLoginState::Succeeded, "{snapshot:?}");
    assert_eq!(
        session.stdout_text().trim(),
        format!("HOME={} KEY=unset", home.display()),
        "CODEX_HOME must be the account home and an ambient key must not leak in"
    );
}

#[cfg(unix)]
#[test]
fn claude_login_uses_the_config_dir_and_strips_every_ambient_auth_input() {
    let temp = TempDir::new().expect("tempdir");
    let fake = fake_codex(
        &temp,
        "printf 'ARGS=%s DIR=%s API=%s AUTH=%s OAUTH=%s\\n' \"$*\" \"$CLAUDE_CONFIG_DIR\" \"${ANTHROPIC_API_KEY-unset}\" \"${ANTHROPIC_AUTH_TOKEN-unset}\" \"${CLAUDE_CODE_OAUTH_TOKEN-unset}\"; exit 0",
    );
    let config_dir = temp.path().join("claude account");
    std::fs::create_dir_all(&config_dir).expect("config dir");
    let mut session = spawn_claude_login(&ClaudeLoginLaunch {
        binary: fake,
        config_dir: config_dir.clone(),
        cwd: temp.path().to_path_buf(),
        path_env: None,
        timeout: Duration::from_secs(10),
    })
    .expect("spawn Claude login");

    let snapshot = wait_terminal(&mut session, Duration::from_secs(10));
    assert_eq!(snapshot.state, CodexLoginState::Succeeded, "{snapshot:?}");
    assert_eq!(
        session.stdout_text().trim(),
        format!(
            "ARGS=auth login --claudeai DIR={} API=unset AUTH=unset OAUTH=unset",
            config_dir.display()
        )
    );
}

#[cfg(unix)]
#[test]
fn successful_login_reaps_a_background_descendant_from_the_owned_process_group() {
    let temp = TempDir::new().expect("tempdir");
    let pid_file = temp.path().join("descendant.pid");
    let fake = fake_codex(
        &temp,
        &format!(
            "sleep 30 & printf '%s' $! > '{}'; exit 0",
            pid_file.display()
        ),
    );
    let home = temp.path().join("home");
    std::fs::create_dir_all(&home).expect("home");
    let mut session =
        spawn_codex_login(&launch(&fake, &home, temp.path(), Duration::from_secs(10)))
            .expect("spawn");

    let snapshot = wait_terminal(&mut session, Duration::from_secs(10));
    assert_eq!(snapshot.state, CodexLoginState::Succeeded, "{snapshot:?}");
    let pid: u32 = std::fs::read_to_string(&pid_file)
        .expect("descendant pid")
        .parse()
        .expect("numeric pid");
    let deadline = Instant::now() + Duration::from_secs(2);
    while crate::managed_agents::runtime::process_is_running(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !crate::managed_agents::runtime::process_is_running(pid),
        "successful login must not leave descendant {pid} running"
    );
}

#[cfg(unix)]
#[test]
fn successful_cli_exit_is_not_success_until_group_cleanup_succeeds() {
    let temp = TempDir::new().expect("tempdir");
    let fake = fake_codex(&temp, "exit 0");
    let home = temp.path().join("home");
    std::fs::create_dir_all(&home).expect("home");
    let mut session =
        spawn_codex_login(&launch(&fake, &home, temp.path(), Duration::from_secs(10)))
            .expect("spawn");

    let deadline = Instant::now() + Duration::from_secs(10);
    let failed = loop {
        let snapshot = session.poll_with_cleanup(|_| Err("injected group cleanup failure".into()));
        if snapshot.state != CodexLoginState::Running || Instant::now() > deadline {
            break snapshot;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    assert_eq!(failed.state, CodexLoginState::Failed, "{failed:?}");
    assert_eq!(failed.finished_at, None, "cleanup remains retryable");
    assert!(
        !session.is_finished(),
        "failed containment retains its session"
    );
    assert!(
        failed
            .message
            .as_deref()
            .is_some_and(|message| message.contains("Couldn't fully stop")),
        "{failed:?}"
    );

    let recovered = session.poll_with_cleanup(|_| Ok(()));
    assert_eq!(recovered.state, CodexLoginState::Succeeded, "{recovered:?}");
    assert!(session.is_finished());
}

#[cfg(unix)]
#[test]
fn cancel_is_not_terminal_until_group_cleanup_succeeds() {
    let temp = TempDir::new().expect("tempdir");
    let fake = fake_codex(&temp, "sleep 30");
    let home = temp.path().join("home");
    std::fs::create_dir_all(&home).expect("home");
    let mut session =
        spawn_codex_login(&launch(&fake, &home, temp.path(), Duration::from_secs(60)))
            .expect("spawn");

    let failed = session.cancel_with_cleanup(|_| Err("injected group cleanup failure".to_string()));
    assert_eq!(failed.state, CodexLoginState::Failed, "{failed:?}");
    assert_eq!(failed.finished_at, None);
    assert!(!session.is_finished());

    let recovered = session.cancel_with_cleanup(|_| Ok(()));
    assert_eq!(recovered.state, CodexLoginState::Cancelled, "{recovered:?}");
    assert!(session.is_finished());
}

#[cfg(unix)]
#[test]
fn timeout_is_not_terminal_until_group_cleanup_succeeds() {
    let temp = TempDir::new().expect("tempdir");
    let fake = fake_codex(&temp, "sleep 30");
    let home = temp.path().join("home");
    std::fs::create_dir_all(&home).expect("home");
    let mut session = spawn_codex_login(&launch(
        &fake,
        &home,
        temp.path(),
        Duration::from_millis(20),
    ))
    .expect("spawn");
    std::thread::sleep(Duration::from_millis(40));

    let failed = session.poll_with_cleanup(|_| Err("injected group cleanup failure".to_string()));
    assert_eq!(failed.state, CodexLoginState::Failed, "{failed:?}");
    assert_eq!(failed.finished_at, None);
    assert!(!session.is_finished());

    let recovered = session.poll_with_cleanup(|_| Ok(()));
    assert_eq!(recovered.state, CodexLoginState::TimedOut, "{recovered:?}");
    assert!(session.is_finished());
}

#[test]
fn callback_port_probe_detects_a_listener() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    assert!(
        callback_port_in_use(port),
        "a live listener must read as busy"
    );
    drop(listener);
    assert!(
        !callback_port_in_use(port),
        "a closed port must read as free"
    );
}

#[test]
fn a_second_login_is_refused_while_one_is_running() {
    assert_eq!(login_start_conflict(&[], "a"), None);
    let same = login_start_conflict(&["a"], "a").expect("same account");
    assert!(same.contains("already"), "{same}");
    let other = login_start_conflict(&["b"], "a").expect("other account");
    assert!(other.contains("1455"), "{other}");
}

#[test]
fn auth_url_from_output_picks_the_first_https_link() {
    let out = "Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL:\n\nhttps://auth.example/authorize?x=1&y=2\n";
    assert_eq!(
        auth_url_from_output(out).as_deref(),
        Some("https://auth.example/authorize?x=1&y=2")
    );
    assert_eq!(auth_url_from_output("no links here"), None);
}

#[cfg(unix)]
#[test]
fn restart_prunes_terminal_history_and_gets_a_new_generation() {
    let temp = TempDir::new().expect("tempdir");
    let fake = fake_codex(&temp, "sleep 30");
    let home = temp.path().join("home");
    std::fs::create_dir_all(&home).expect("home");
    let mut first = spawn_codex_login(&launch(&fake, &home, temp.path(), Duration::from_secs(60)))
        .expect("first spawn");
    let first_snapshot = first.cancel();
    let mut sessions = HashMap::from([("account".to_string(), first)]);
    assert!(retain_running_login_sessions(&mut sessions).is_empty());
    assert!(sessions.is_empty(), "terminal sessions are bounded history");

    let second = spawn_codex_login(&launch(&fake, &home, temp.path(), Duration::from_secs(60)))
        .expect("second spawn");
    let second_snapshot = second.snapshot();
    assert_ne!(
        first_snapshot.generation, second_snapshot.generation,
        "a delayed poll from the cancelled run must be distinguishable"
    );
    sessions.insert("account".to_string(), second);
    assert_eq!(sessions.len(), 1);
}
