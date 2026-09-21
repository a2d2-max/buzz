//! In-app `codex login` for a `chatgpt` Codex account.
//!
//! The owner used to copy `CODEX_HOME=… codex login` into a terminal. That
//! path breaks on ordinary shell setups — a `codex` function or alias that
//! appends flags `codex login` rejects, smart quotes when the command is
//! retyped — so the app now runs the CLI itself, by absolute path, against
//! the account's own `CODEX_HOME`, and watches it. The browser half of the
//! sign-in (account choice, password, 2FA, consent) stays with the owner:
//! the CLI opens the browser and waits on its localhost callback.
//!
//! Bounds: one login at a time (the CLI's callback port is fixed), captured
//! output capped, a wall-clock timeout, and the child is killed on cancel,
//! timeout, or when the session is dropped. Secrets are never logged: the
//! only text that leaves this module is the first error line, scrubbed of
//! anything shaped like an OpenAI key.

use std::collections::HashMap;
use std::io::Read;
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::codex_accounts::{CODEX_HOME_ENV, OPENAI_API_KEY_ENV};

/// The localhost port `codex login` listens on for the browser callback.
/// Fixed by the CLI, so two logins cannot run at once — on this machine or
/// in a terminal the owner opened by hand.
pub(crate) const CODEX_LOGIN_CALLBACK_PORT: u16 = 1455;
/// How long the owner gets to finish the browser sign-in.
pub(crate) const DEFAULT_LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Cap on captured stdout/stderr, each.
const CAPTURE_LIMIT: usize = 64 * 1024;
const MESSAGE_MAX_CHARS: usize = 200;
const PORT_PROBE_TIMEOUT: Duration = Duration::from_millis(300);
const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

struct OutputDrain {
    receiver: mpsc::Receiver<Result<(), String>>,
    done: bool,
}

enum DrainWaitError {
    Pending(String),
    Failed(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CodexLoginState {
    Running,
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
}

/// What the UI sees. Never carries CLI output beyond one scrubbed error line
/// and the public sign-in URL the CLI printed for browsers that did not open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct CodexLoginSnapshot {
    pub generation: String,
    pub state: CodexLoginState,
    pub message: Option<String>,
    pub auth_url: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

/// Everything a login spawn needs, resolved by the caller (no `AppHandle`).
pub(crate) struct CodexLoginLaunch {
    /// Absolute path of the Codex CLI — never a bare name, so no shell
    /// function or alias can get in between.
    pub binary: PathBuf,
    /// The account's `CODEX_HOME`.
    pub home_dir: PathBuf,
    pub cwd: PathBuf,
    pub path_env: Option<String>,
    pub timeout: Duration,
}

/// The same bounded browser-login lifecycle for a Claude config-directory
/// account. The provider-specific command/env is configured before the shared
/// process ownership seam takes over.
pub(crate) struct ClaudeLoginLaunch {
    pub binary: PathBuf,
    pub config_dir: PathBuf,
    pub cwd: PathBuf,
    pub path_env: Option<String>,
    pub timeout: Duration,
}

/// A running or finished `codex login` child.
pub(crate) struct CodexLoginSession {
    child: Child,
    generation: String,
    started: Instant,
    started_at: String,
    timeout: Duration,
    stdout: Arc<Mutex<Vec<u8>>>,
    stderr: Arc<Mutex<Vec<u8>>>,
    stdout_drain: OutputDrain,
    stderr_drain: OutputDrain,
    outcome: Option<(CodexLoginState, String)>,
    terminal_message: Option<String>,
    cleanup_pending: Option<(CodexLoginState, String)>,
}

/// Start `<binary> login` for the account: `CODEX_HOME` set to the account
/// home, any ambient `OPENAI_API_KEY` removed so it cannot sign in a
/// different identity, stdin closed, output captured (bounded).
pub(crate) fn spawn_codex_login(launch: &CodexLoginLaunch) -> Result<CodexLoginSession, String> {
    let mut command = Command::new(&launch.binary);
    command
        .arg("login")
        .env(CODEX_HOME_ENV, &launch.home_dir)
        .env_remove(OPENAI_API_KEY_ENV)
        .current_dir(&launch.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = &launch.path_env {
        command.env("PATH", path);
    }
    spawn_browser_login(command, launch.timeout, "`codex login`")
}

pub(crate) fn spawn_claude_login(launch: &ClaudeLoginLaunch) -> Result<CodexLoginSession, String> {
    let mut command = Command::new(&launch.binary);
    super::claude_accounts::configure_claude_login_command(&mut command, &launch.config_dir);
    command
        .current_dir(&launch.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = &launch.path_env {
        command.env("PATH", path);
    }
    spawn_browser_login(command, launch.timeout, "Claude login")
}

fn spawn_browser_login(
    mut command: Command,
    timeout: Duration,
    label: &str,
) -> Result<CodexLoginSession, String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        command.process_group(0);
    }
    crate::util::configure_no_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start {label}: {error}"))?;
    let (stdout, stdout_drain) = drain_bounded(child.stdout.take(), "stdout");
    let (stderr, stderr_drain) = drain_bounded(child.stderr.take(), "stderr");
    Ok(CodexLoginSession {
        child,
        generation: uuid::Uuid::new_v4().to_string(),
        started: Instant::now(),
        started_at: crate::util::now_iso(),
        timeout,
        stdout,
        stderr,
        stdout_drain,
        stderr_drain,
        outcome: None,
        terminal_message: None,
        cleanup_pending: None,
    })
}

/// Read a pipe to EOF on a background thread, keeping at most
/// `CAPTURE_LIMIT` bytes but always draining so the child never blocks on a
/// full pipe.
fn drain_bounded(
    pipe: Option<impl Read + Send + 'static>,
    label: &'static str,
) -> (Arc<Mutex<Vec<u8>>>, OutputDrain) {
    let buffer = Arc::new(Mutex::new(Vec::new()));
    let (done_tx, done_rx) = mpsc::sync_channel(1);
    if let Some(mut pipe) = pipe {
        let sink = Arc::clone(&buffer);
        std::thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            let result = loop {
                match pipe.read(&mut chunk) {
                    Ok(0) => break Ok(()),
                    Err(error) => break Err(format!("failed to drain login {label}: {error}")),
                    Ok(read) => {
                        let mut buffer = sink.lock().unwrap_or_else(|e| e.into_inner());
                        let room = CAPTURE_LIMIT.saturating_sub(buffer.len());
                        buffer.extend_from_slice(&chunk[..read.min(room)]);
                    }
                }
            };
            let _ = done_tx.send(result);
        });
    } else {
        let _ = done_tx.send(Ok(()));
    }
    (
        buffer,
        OutputDrain {
            receiver: done_rx,
            done: false,
        },
    )
}

impl CodexLoginSession {
    /// Observe the child: reap it if it exited, kill it if the timeout
    /// passed, and report the current state. Terminal states are stable.
    pub(crate) fn poll(&mut self) -> CodexLoginSnapshot {
        self.poll_with_cleanup(super::runtime::kill_owned_process_group)
    }

    fn poll_with_cleanup(
        &mut self,
        mut cleanup: impl FnMut(u32) -> Result<(), String>,
    ) -> CodexLoginSnapshot {
        if self.outcome.is_none() {
            if let Some((state, _)) = self.cleanup_pending.clone() {
                self.finish_after_cleanup(state, &mut cleanup);
            } else {
                match self.child.try_wait() {
                    Ok(Some(status)) => {
                        let state = if status.success() {
                            CodexLoginState::Succeeded
                        } else {
                            CodexLoginState::Failed
                        };
                        self.finish_after_cleanup(state, &mut cleanup);
                    }
                    Ok(None) if self.started.elapsed() >= self.timeout => {
                        self.kill_and_finish(CodexLoginState::TimedOut, &mut cleanup);
                    }
                    Ok(None) => {}
                    Err(_) => {
                        self.kill_and_finish(CodexLoginState::Failed, &mut cleanup);
                    }
                }
            }
        }
        self.snapshot()
    }

    /// Stop a running login. A no-op on a finished one.
    pub(crate) fn cancel(&mut self) -> CodexLoginSnapshot {
        self.cancel_with_cleanup(super::runtime::kill_owned_process_group)
    }

    fn cancel_with_cleanup(
        &mut self,
        mut cleanup: impl FnMut(u32) -> Result<(), String>,
    ) -> CodexLoginSnapshot {
        if self.outcome.is_none() {
            let state = self
                .cleanup_pending
                .as_ref()
                .map(|(state, _)| *state)
                .unwrap_or(CodexLoginState::Cancelled);
            self.kill_and_finish(state, &mut cleanup);
        }
        self.snapshot()
    }

    pub(crate) fn is_finished(&self) -> bool {
        self.outcome.is_some()
    }

    pub(crate) fn snapshot(&self) -> CodexLoginSnapshot {
        let (state, finished_at) = match &self.outcome {
            Some((state, at)) => (*state, Some(at.clone())),
            None if self.cleanup_pending.is_some() => (CodexLoginState::Failed, None),
            None => (CodexLoginState::Running, None),
        };
        let message = match (&self.cleanup_pending, state) {
            (Some((_, error)), _) => Some(error.clone()),
            (None, CodexLoginState::Failed) => self
                .terminal_message
                .clone()
                .or_else(|| Some(failure_message(&self.stderr_text(), &self.stdout_text()))),
            (None, CodexLoginState::TimedOut) => Some(format!(
                "no sign-in within {}s — start again when you are ready",
                self.timeout.as_secs()
            )),
            _ => None,
        };
        CodexLoginSnapshot {
            generation: self.generation.clone(),
            state,
            message,
            auth_url: auth_url_from_output(&self.stdout_text()),
            started_at: self.started_at.clone(),
            finished_at,
        }
    }

    /// Captured stdout so far (bounded). Test seam for the env contract.
    pub(crate) fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout.lock().unwrap_or_else(|e| e.into_inner())).into_owned()
    }

    fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr.lock().unwrap_or_else(|e| e.into_inner())).into_owned()
    }

    fn kill_and_finish(
        &mut self,
        state: CodexLoginState,
        cleanup: &mut impl FnMut(u32) -> Result<(), String>,
    ) {
        let cleanup_result = cleanup(self.child.id());
        let _ = self.child.kill();
        let wait_result = self.child.wait();
        match cleanup_result.and(
            wait_result.map(|_| ()).map_err(|error| {
                format!("failed to reap login process {}: {error}", self.child.id())
            }),
        ) {
            Ok(()) => self.finish_after_output_drain(state),
            Err(error) => self.record_cleanup_pending(state, error),
        }
    }

    fn finish_after_cleanup(
        &mut self,
        state: CodexLoginState,
        cleanup: &mut impl FnMut(u32) -> Result<(), String>,
    ) {
        match cleanup(self.child.id()) {
            Ok(()) => self.finish_after_output_drain(state),
            Err(error) => self.record_cleanup_pending(state, error),
        }
    }

    fn finish_after_output_drain(&mut self, state: CodexLoginState) {
        match self.wait_for_output_drain() {
            Ok(()) => self.finish(state),
            Err(DrainWaitError::Pending(error)) => self.record_cleanup_pending(state, error),
            Err(DrainWaitError::Failed(error)) => self.finish_failed(error),
        }
    }

    fn finish_failed(&mut self, error: String) {
        let mut message = error;
        if message.chars().count() > MESSAGE_MAX_CHARS {
            message = message.chars().take(MESSAGE_MAX_CHARS).collect();
            message.push('…');
        }
        self.terminal_message = Some(message);
        self.finish(CodexLoginState::Failed);
    }

    fn wait_for_output_drain(&mut self) -> Result<(), DrainWaitError> {
        let deadline = Instant::now() + OUTPUT_DRAIN_TIMEOUT;
        wait_for_drain(&mut self.stdout_drain, "stdout", deadline)?;
        wait_for_drain(&mut self.stderr_drain, "stderr", deadline)
    }

    fn record_cleanup_pending(&mut self, state: CodexLoginState, error: String) {
        let mut message = format!(
            "Couldn't fully stop the sign-in process. Retry stopping sign-in before starting another one: {error}"
        );
        if message.chars().count() > MESSAGE_MAX_CHARS {
            message = message.chars().take(MESSAGE_MAX_CHARS).collect();
            message.push('…');
        }
        self.cleanup_pending = Some((state, message));
    }

    fn finish(&mut self, state: CodexLoginState) {
        self.cleanup_pending = None;
        self.outcome = Some((state, crate::util::now_iso()));
    }
}

fn wait_for_drain(
    drain: &mut OutputDrain,
    label: &str,
    deadline: Instant,
) -> Result<(), DrainWaitError> {
    if drain.done {
        return Ok(());
    }
    let remaining = deadline.saturating_duration_since(Instant::now());
    match drain.receiver.recv_timeout(remaining) {
        Ok(Ok(())) => {
            drain.done = true;
            Ok(())
        }
        Ok(Err(error)) => Err(DrainWaitError::Failed(error)),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(DrainWaitError::Pending(format!(
            "timed out after {}ms draining login {label}",
            OUTPUT_DRAIN_TIMEOUT.as_millis()
        ))),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(DrainWaitError::Failed(format!(
            "login {label} collector stopped before completion"
        ))),
    }
}

impl Drop for CodexLoginSession {
    /// A session that goes away while still running takes its child with it
    /// — no orphaned login server holding the callback port.
    fn drop(&mut self) {
        if !self.is_finished() {
            self.kill_and_finish(
                CodexLoginState::Cancelled,
                &mut super::runtime::kill_owned_process_group,
            );
        }
    }
}

/// Why a new login must not start now, if any. `running` lists account ids
/// whose login is still in flight.
pub(crate) fn login_start_conflict(running: &[&str], id: &str) -> Option<String> {
    if running.contains(&id) {
        return Some(
            "a login for this account is already running — finish it in the browser or cancel it"
                .to_string(),
        );
    }
    if !running.is_empty() {
        return Some(format!(
            "another Codex account is signing in right now; Codex can only run one login at a time (it listens on localhost:{CODEX_LOGIN_CALLBACK_PORT})"
        ));
    }
    None
}

/// Drop terminal history before a new start and return the remaining running
/// account ids. Codex owns one fixed callback port, so a successful start can
/// leave at most one session in memory; the account file's size cannot grow
/// this registry without bound.
pub(crate) fn retain_running_login_sessions(
    sessions: &mut HashMap<String, CodexLoginSession>,
) -> Vec<String> {
    sessions.retain(|_, session| {
        session.poll();
        !session.is_finished()
    });
    sessions.keys().cloned().collect()
}

/// True when something already listens on the CLI's callback port — a login
/// started by hand in a terminal, or by another app instance.
pub(crate) fn callback_port_in_use(port: u16) -> bool {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    TcpStream::connect_timeout(&address, PORT_PROBE_TIMEOUT).is_ok()
}

/// The first `https://` link the CLI printed (it prints the sign-in URL for
/// browsers that did not open). Trailing punctuation is not part of it.
pub(crate) fn auth_url_from_output(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .find(|word| word.starts_with("https://"))
        .map(|word| word.trim_end_matches(['.', ',', ')', ']', ';']).to_string())
}

/// First non-empty line of stderr (else stdout), scrubbed and capped.
fn failure_message(stderr: &str, stdout: &str) -> String {
    let line = [stderr, stdout]
        .iter()
        .flat_map(|text| text.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Codex CLI exited with an error and no output");
    let scrubbed = scrub_openai_secrets(line);
    let mut out: String = scrubbed.chars().take(MESSAGE_MAX_CHARS).collect();
    if scrubbed.chars().count() > MESSAGE_MAX_CHARS {
        out.push('…');
    }
    out
}

/// Cut every OpenAI-shaped secret (`sk-…`) out of the text, including ones
/// glued to a prefix like `key=sk-…`. Each hit is replaced from `sk-` to the
/// end of that word.
pub(crate) fn scrub_openai_secrets(text: &str) -> String {
    text.split(' ')
        .map(|word| match word.find("sk-") {
            Some(index) => format!("{}…", &word[..index]),
            None => word.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
#[path = "codex_login_tests.rs"]
mod tests;
