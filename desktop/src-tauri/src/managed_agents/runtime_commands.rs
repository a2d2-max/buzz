use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager};

use super::{
    agent_readiness, append_log_marker, current_instance_id, find_managed_agent_mut,
    load_global_agent_config, load_managed_agents, load_personas, managed_agent_runtime_log_path,
    process_is_running, record_agent_command, resolve_effective_agent_env, save_managed_agents,
    spawn_agent_child, terminate_process, terminate_untracked_pair_runtime,
    write_agent_runtime_receipt, AgentReadiness, BackendKind, ManagedAgentPairRuntime,
    ManagedAgentRuntimeKey, ManagedAgentRuntimeLifecycle, ManagedAgentRuntimeReceipt,
    ManagedAgentRuntimeStatus,
};
use crate::app_state::AppState;

const STATUS_EVENT: &str = "managed-agent-runtime-status";

fn status_for(
    app: &AppHandle,
    record: &super::ManagedAgentRecord,
    key: &ManagedAgentRuntimeKey,
    runtime: Option<&ManagedAgentPairRuntime>,
    requested_relay_url: Option<String>,
) -> ManagedAgentRuntimeStatus {
    let personas = load_personas(app).unwrap_or_default();
    let global = load_global_agent_config(app).unwrap_or_default();
    status_for_with(
        app,
        record,
        key,
        runtime,
        requested_relay_url,
        StatusInputs {
            personas: &personas,
            global: &global,
        },
    )
}

/// Preloaded per-call-site inputs for [`status_for_with`], so multi-row
/// callers (list, reconcile) hit disk once instead of once per row.
struct StatusInputs<'a> {
    personas: &'a [super::AgentDefinition],
    global: &'a super::GlobalAgentConfig,
}

fn status_for_with(
    app: &AppHandle,
    record: &super::ManagedAgentRecord,
    key: &ManagedAgentRuntimeKey,
    runtime: Option<&ManagedAgentPairRuntime>,
    requested_relay_url: Option<String>,
    inputs: StatusInputs<'_>,
) -> ManagedAgentRuntimeStatus {
    let StatusInputs { personas, global } = inputs;
    let command = record_agent_command(record, personas);
    let metadata = super::known_acp_runtime(&command);
    let effective = resolve_effective_agent_env(
        record,
        personas,
        metadata,
        global,
        super::claude_accounts::claude_account_readiness_supplied(
            app,
            record.claude_account_id.as_deref(),
        ),
    );
    let local_setup = matches!(agent_readiness(&effective), AgentReadiness::Ready);
    ManagedAgentRuntimeStatus {
        pubkey: key.pubkey.clone(),
        relay_url: key.relay_url.clone(),
        requested_relay_url,
        local_setup,
        lifecycle: runtime
            .map(|runtime| runtime.lifecycle.clone())
            .unwrap_or(ManagedAgentRuntimeLifecycle::Stopped),
        pid: runtime.map(|runtime| runtime.child.id()),
        error: runtime.and_then(|runtime| runtime.error.clone()),
        error_code: None,
        log_path: managed_agent_runtime_log_path(app, key)
            .ok()
            .map(|path| path.display().to_string()),
    }
}

fn emit_status(app: &AppHandle, status: &ManagedAgentRuntimeStatus) {
    let _ = app.emit(STATUS_EVENT, status);
}

fn observer_lifecycle_key(
    outer_pubkey: &str,
    payload: &super::ManagedAgentRuntimeLifecycleObserverPayload,
) -> Result<ManagedAgentRuntimeKey, String> {
    if !outer_pubkey.eq_ignore_ascii_case(&payload.pubkey) {
        return Err("observer signer does not match lifecycle payload pubkey".into());
    }
    if matches!(
        payload.lifecycle,
        ManagedAgentRuntimeLifecycle::Starting | ManagedAgentRuntimeLifecycle::Stopped
    ) {
        return Err("observer cannot author starting or stopped lifecycle".into());
    }
    if payload.lifecycle == ManagedAgentRuntimeLifecycle::Failed && payload.error.is_none() {
        return Err("failed lifecycle requires an error".into());
    }
    if payload.lifecycle != ManagedAgentRuntimeLifecycle::Failed && payload.error.is_some() {
        return Err("lifecycle error is only valid for failed".into());
    }
    ManagedAgentRuntimeKey::new(payload.pubkey.clone(), &payload.relay_url)
}

#[tauri::command]
pub fn put_managed_agent_runtime_lifecycle(
    outer_pubkey: String,
    payload: super::ManagedAgentRuntimeLifecycleObserverPayload,
    app: AppHandle,
) -> Result<ManagedAgentRuntimeStatus, String> {
    let key = observer_lifecycle_key(&outer_pubkey, &payload)?;
    let state = app.state::<AppState>();
    let records = load_managed_agents(&app)?;
    let record = records
        .iter()
        .find(|record| record.pubkey.eq_ignore_ascii_case(&key.pubkey))
        .ok_or_else(|| format!("agent {} not found", key.pubkey))?;
    let mut runtimes = state
        .managed_agent_processes
        .lock()
        .map_err(|e| e.to_string())?;
    let runtime = runtimes
        .get_mut(&key)
        .ok_or_else(|| "lifecycle frame does not match a tracked runtime pair".to_string())?;
    if runtime.start_nonce != payload.start_nonce {
        return Err("lifecycle frame does not match the current harness generation".into());
    }
    if runtime
        .child
        .try_wait()
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Err("lifecycle frame arrived after process exit".into());
    }
    runtime.lifecycle = payload.lifecycle;
    runtime.error = payload.error;
    let status = status_for(&app, record, &key, Some(runtime), None);
    emit_status(&app, &status);
    Ok(status)
}

// Keep disk, process, and mutex work off the main thread so opening members cannot stall the UI.
#[tauri::command]
pub async fn list_managed_agent_runtimes(
    app: AppHandle,
) -> Result<Vec<ManagedAgentRuntimeStatus>, String> {
    tokio::task::spawn_blocking(move || {
        // This command is polled whenever the members sidebar opens and refetched
        // on every status event — load the per-row status inputs once, outside
        // the locks, instead of hitting disk per row while holding them.
        let personas = load_personas(&app).unwrap_or_default();
        let global = load_global_agent_config(&app).unwrap_or_default();
        let state = app.state::<AppState>();
        let _transition = state
            .managed_agent_runtime_transition
            .lock()
            .map_err(|e| e.to_string())?;
        let _store = state
            .managed_agents_store_lock
            .lock()
            .map_err(|e| e.to_string())?;
        let mut records = load_managed_agents(&app)?;
        let mut runtimes = state
            .managed_agent_processes
            .lock()
            .map_err(|e| e.to_string())?;
        let exited_keys: Vec<_> = runtimes
            .iter_mut()
            .filter_map(|(key, runtime)| match runtime.child.try_wait() {
                Ok(Some(_)) | Err(_) => Some(key.clone()),
                Ok(None) => None,
            })
            .collect();
        let records_changed = !exited_keys.is_empty();
        let mut statuses = Vec::new();
        for key in exited_keys {
            runtimes.remove(&key);
            super::remove_agent_runtime_receipt(&app, &key);
            state.clear_agent_session_cache(&key);
            if let Some(record) = records
                .iter_mut()
                .find(|record| record.pubkey.eq_ignore_ascii_case(&key.pubkey))
            {
                record.updated_at = crate::util::now_iso();
                record.last_stopped_at = Some(record.updated_at.clone());
                let status = status_for_with(
                    &app,
                    record,
                    &key,
                    None,
                    None,
                    StatusInputs {
                        personas: &personas,
                        global: &global,
                    },
                );
                emit_status(&app, &status);
                statuses.push(status);
            }
        }
        statuses.extend(runtimes.iter().filter_map(|(key, runtime)| {
            let record = records
                .iter()
                .find(|record| record.pubkey.eq_ignore_ascii_case(&key.pubkey))?;
            Some(status_for_with(
                &app,
                record,
                key,
                Some(runtime),
                None,
                StatusInputs {
                    personas: &personas,
                    global: &global,
                },
            ))
        }));
        drop(runtimes);
        // Records are only mutated above when a runtime exited — skip the store
        // rewrite on the common nothing-changed poll.
        if records_changed {
            save_managed_agents(&app, &records)?;
        }
        Ok(statuses)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

pub(crate) fn start_managed_agent_runtime_pair_lazy(
    pubkey: String,
    relay_url: String,
    app: AppHandle,
) -> Result<ManagedAgentRuntimeStatus, String> {
    start_pair(pubkey, relay_url, true, None, app)
}

#[tauri::command]
pub fn start_managed_agent_runtime(
    pubkey: String,
    relay_url: String,
    app: AppHandle,
) -> Result<ManagedAgentRuntimeStatus, String> {
    start_managed_agent_runtime_pair_lazy(pubkey, relay_url, app)
}

fn start_pair(
    pubkey: String,
    relay_url: String,
    lazy: bool,
    expected_updated_at: Option<&str>,
    app: AppHandle,
) -> Result<ManagedAgentRuntimeStatus, String> {
    let state = app.state::<AppState>();
    let _transition = state
        .managed_agent_runtime_transition
        .lock()
        .map_err(|e| e.to_string())?;
    if state.shutdown_started.load(Ordering::Acquire) {
        return Err("desktop shutdown has started".into());
    }
    let _store = state
        .managed_agents_store_lock
        .lock()
        .map_err(|e| e.to_string())?;
    let mut records = load_managed_agents(&app)?;
    let record = find_managed_agent_mut(&mut records, &pubkey)?;
    if record.backend != BackendKind::Local {
        return Err("managed runtime pairs require a local agent".into());
    }
    if expected_updated_at.is_some_and(|expected| record.updated_at != expected) {
        return Err("managed agent changed while runtime reconciliation was in flight".into());
    }
    let key = ManagedAgentRuntimeKey::new(pubkey, &relay_url)?;
    // Read outside the runtimes lock — it is a disk hit.
    let cap = configured_runtime_cap(&app);
    let mut runtimes = state
        .managed_agent_processes
        .lock()
        .map_err(|e| e.to_string())?;

    // The cap. `plan_reconcile_jobs` budgets the auto-start fan-out, but
    // `start_pair` is also reached from @mention wake, channel attach, the
    // members sidebar, Settings, and the inbound access-policy restart — none
    // of which consult the planner. The token is consumed by `spawn_agent_child`
    // below, so this check cannot be dropped without a compile error.
    let cap_checked = enforce_runtime_cap(&mut runtimes, &key, cap)?;

    if runtimes
        .get_mut(&key)
        .is_some_and(|runtime| runtime.child.try_wait().ok().flatten().is_none())
    {
        let status = status_for(&app, record, &key, runtimes.get(&key), None);
        return Ok(status);
    }
    runtimes.remove(&key);
    terminate_untracked_pair_runtime(&app, &key)?;

    let owner = state
        .keys
        .lock()
        .ok()
        .map(|keys| keys.public_key().to_hex());
    let mut process = spawn_agent_child(
        &app,
        record,
        &key.relay_url,
        lazy,
        owner.as_deref(),
        None,
        cap_checked,
    )?;
    let now = crate::util::now_iso();
    let receipt = ManagedAgentRuntimeReceipt {
        key: key.clone(),
        pid: process.child.id(),
        desktop_instance_id: current_instance_id(&app),
        started_at: now.clone(),
    };
    if let Err(error) = write_agent_runtime_receipt(&app, &receipt) {
        let _ = terminate_process(process.child.id());
        let _ = process.child.wait();
        return Err(error);
    }
    record.runtime_pid = None;
    record.updated_at = now.clone();
    record.last_started_at = Some(now);
    record.last_stopped_at = None;
    record.last_error = None;
    runtimes.insert(key.clone(), ManagedAgentPairRuntime::starting(process));
    let status = status_for(&app, record, &key, runtimes.get(&key), None);
    drop(runtimes);
    save_managed_agents(&app, &records)?;
    emit_status(&app, &status);
    Ok(status)
}

#[tauri::command]
pub fn stop_managed_agent_runtime(
    pubkey: String,
    relay_url: String,
    app: AppHandle,
) -> Result<ManagedAgentRuntimeStatus, String> {
    let state = app.state::<AppState>();
    let _transition = state
        .managed_agent_runtime_transition
        .lock()
        .map_err(|e| e.to_string())?;
    let _store = state
        .managed_agents_store_lock
        .lock()
        .map_err(|e| e.to_string())?;
    let mut records = load_managed_agents(&app)?;
    let record = find_managed_agent_mut(&mut records, &pubkey)?;
    let key = ManagedAgentRuntimeKey::new(pubkey, &relay_url)?;
    let mut runtimes = state
        .managed_agent_processes
        .lock()
        .map_err(|e| e.to_string())?;
    if let Some(mut runtime) = runtimes.remove(&key) {
        let stop_result = if process_is_running(runtime.child.id()) {
            terminate_process(runtime.child.id())
        } else {
            Ok(())
        }
        .and_then(|()| runtime.child.wait().map_err(|e| e.to_string()));
        match stop_result {
            Ok(status) => {
                record.last_exit_code = status.code();
                let _ = append_log_marker(&runtime.log_path, "=== stopped pair runtime ===");
            }
            Err(error) => {
                // Keep failed teardown visible/manageable instead of
                // orphaning it: the child stays tracked and the receipt
                // stays on disk until a stop actually succeeds.
                runtimes.insert(key, runtime);
                return Err(error);
            }
        }
    } else {
        // No runtime is tracked at this key, but a valid prior-session
        // receipt may still point at a live child (e.g. the crash-recovery
        // window for a non-auto-start agent). Terminate that orphan before
        // erasing its receipt — otherwise this "stop" leaves the harness
        // running yet deletes the one artifact sweeps and
        // terminate_untracked_pair_runtime use to find it, and a follow-up
        // start would spawn a duplicate harness for the same pair. On
        // failure the receipt stays on disk (terminate_untracked_pair_runtime
        // only removes it after the child exits), mirroring the tracked
        // path's keep-until-success invariant.
        terminate_untracked_pair_runtime(&app, &key)?;
    }
    super::remove_agent_runtime_receipt(&app, &key);
    state.clear_agent_session_cache(&key);
    record.runtime_pid = None;
    record.updated_at = crate::util::now_iso();
    record.last_stopped_at = Some(record.updated_at.clone());
    let status = status_for(&app, record, &key, None, None);
    drop(runtimes);
    save_managed_agents(&app, &records)?;
    emit_status(&app, &status);
    Ok(status)
}

#[tauri::command]
pub fn restart_managed_agent_runtime(
    pubkey: String,
    relay_url: String,
    app: AppHandle,
) -> Result<ManagedAgentRuntimeStatus, String> {
    stop_managed_agent_runtime(pubkey.clone(), relay_url.clone(), app.clone())?;
    start_pair(pubkey, relay_url, true, None, app)
}

/// Probe whether this agent can operate on `requested_relay_url`.
///
/// Runs a bounded authenticated query with the agent's own keys (NIP-42 +
/// NIP-OA auth tag). Auth success is the spawn-eligibility signal: NIP-29
/// membership (kind 39002) cannot exist before the agent's harness first
/// connects to a relay, so gating on membership *presence* could never
/// bootstrap a pair on a newly configured community — it only rediscovered
/// pairs that had already run. A rejected or timed-out probe surfaces as a
/// Failed status row instead of a silent skip.
async fn probe_agent_relay_access(
    state: &AppState,
    record: super::ManagedAgentRecord,
    requested_relay_url: String,
) -> Result<(super::ManagedAgentRecord, ManagedAgentRuntimeKey, String), String> {
    let key = ManagedAgentRuntimeKey::new(record.pubkey.clone(), &requested_relay_url)?;
    let keys = nostr::Keys::parse(record.private_key_nsec.trim())
        .map_err(|error| format!("invalid managed-agent key: {error}"))?;
    let api_base = crate::relay::relay_http_base_url(&key.relay_url);
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        crate::relay::query_relay_at_with_keys(
            state,
            &api_base,
            &[serde_json::json!({"kinds": [39002], "#p": [record.pubkey]})],
            &keys,
            record.auth_tag.as_deref(),
        ),
    )
    .await
    .map_err(|_| "relay access probe timed out".to_string())??;
    Ok((record, key, requested_relay_url))
}

/// Build the `Failed` status row for a probe failure whose requested relay URL
/// cannot even form a pair key (so there is no canonical `relay_url` to key on).
/// The raw requested URL stands in for both the identity and the requested
/// field so the batch still degrades this one community to a visible row
/// instead of aborting every other community's row.
fn unkeyable_failed_status(
    record: &super::ManagedAgentRecord,
    requested: String,
    error: String,
    personas: &[super::AgentDefinition],
    global: &super::GlobalAgentConfig,
    named_claude_account_ready: bool,
) -> ManagedAgentRuntimeStatus {
    let command = record_agent_command(record, personas);
    let metadata = super::known_acp_runtime(&command);
    let effective = resolve_effective_agent_env(
        record,
        personas,
        metadata,
        global,
        named_claude_account_ready,
    );
    ManagedAgentRuntimeStatus {
        pubkey: record.pubkey.clone(),
        relay_url: requested.clone(),
        requested_relay_url: Some(requested),
        local_setup: matches!(agent_readiness(&effective), AgentReadiness::Ready),
        lifecycle: ManagedAgentRuntimeLifecycle::Failed,
        pid: None,
        error: Some(error),
        error_code: None,
        log_path: None,
    }
}

/// The error surfaced on a pair the live-runtime cap refused.
///
/// `live` is the number of pairs running at the moment of the refusal, `cap`
/// is `GlobalAgentConfig::max_live_runtimes`. Shared by the reconcile planner,
/// [`start_pair`], [`super::start_managed_agent_process`] and launch restore so
/// the user reads one sentence no matter which path refused the spawn.
///
/// The way out names the file, not a settings field: there is no UI control
/// for the cap yet, and pointing at a screen that does not exist strands the
/// user (`AGENTS.md` Review-Proven Rule 6).
pub(crate) fn runtime_cap_error(live: usize, cap: usize) -> String {
    format!(
        "runtime cap reached ({live} of {cap} live) — stop another agent, or \
         raise max_live_runtimes in agents/global-agent-config.json"
    )
}

/// Keys of the pair runtimes whose child process is still alive.
///
/// `runtimes` can hold entries for children that have already exited but not
/// yet been reaped by `sync_managed_agent_processes`; counting map length
/// instead of polling each child would charge the cap for dead processes and
/// refuse spawns the machine can afford.
pub(crate) fn live_runtime_keys(
    runtimes: &mut std::collections::HashMap<ManagedAgentRuntimeKey, ManagedAgentPairRuntime>,
) -> std::collections::HashSet<ManagedAgentRuntimeKey> {
    runtimes
        .iter_mut()
        .filter_map(|(key, runtime)| {
            runtime
                .child
                .try_wait()
                .ok()
                .flatten()
                .is_none()
                .then(|| key.clone())
        })
        .collect()
}

/// Live pair keys belonging to one agent.
///
/// The liveness-blind [`super::managed_agent_runtime_keys`] also returns keys
/// whose child has already exited, so a caller that uses it to decide "which
/// pairs were running, restart those" can resurrect a dead agent. Restart
/// paths use this instead.
pub(crate) fn live_runtime_keys_for(
    runtimes: &mut std::collections::HashMap<ManagedAgentRuntimeKey, ManagedAgentPairRuntime>,
    pubkey: &str,
) -> Vec<ManagedAgentRuntimeKey> {
    let mut keys: Vec<_> = live_runtime_keys(runtimes)
        .into_iter()
        .filter(|key| key.pubkey.eq_ignore_ascii_case(pubkey))
        .collect();
    // HashSet iteration order is not stable; sort so a restart batch (and the
    // error string that lists it) is reproducible.
    keys.sort_by(|left, right| left.relay_url.cmp(&right.relay_url));
    keys
}

/// `(live pair count, how many more pairs may start)` under `cap`.
///
/// The single definition of the cap arithmetic. `saturating_sub` is
/// load-bearing: a cap lowered below the number of pairs already running must
/// yield zero remaining slots, not underflow into an unbounded budget.
pub(crate) fn remaining_runtime_slots(
    runtimes: &mut std::collections::HashMap<ManagedAgentRuntimeKey, ManagedAgentPairRuntime>,
    cap: usize,
) -> (usize, usize) {
    let live = live_runtime_keys(runtimes).len();
    (live, cap.saturating_sub(live))
}

/// Proof that [`enforce_runtime_cap`] admitted this spawn.
///
/// `super::spawn_agent_child` consumes one by value, so a harness cannot be
/// started without passing the gate first. That is what makes the cap bind
/// paths the reconcile planner never sees — the Start button, channel attach,
/// create-with-spawn, the auto-restart policy, the huddle add-agent dialog and
/// launch restore. A fourth spawn path is a compile error until it calls the
/// gate. (Same idiom as `EffortApplied` / `spawn_with_effort_proof`.)
#[must_use]
#[derive(Debug)]
pub(crate) struct RuntimeCapChecked(());

/// Refuse `key` when the live set is already at `cap`.
///
/// The one gate every spawn path calls — [`start_pair`],
/// [`super::start_managed_agent_process`] and launch restore Phase B. Checked
/// with the runtimes map in hand, before any process, receipt or store write,
/// so a refusal never leaves a half-started pair behind.
///
/// Restarting an already-tracked LIVE pair is always allowed: it replaces one
/// slot with itself and cannot grow the live set. Refusing it would make the
/// cap a trap — at the ceiling the user could not even restart what is already
/// running (`AGENTS.md` Review-Proven Rule 6).
pub(crate) fn enforce_runtime_cap(
    runtimes: &mut std::collections::HashMap<ManagedAgentRuntimeKey, ManagedAgentPairRuntime>,
    key: &ManagedAgentRuntimeKey,
    cap: usize,
) -> Result<RuntimeCapChecked, String> {
    let live = live_runtime_keys(runtimes);
    if live.contains(key) || live.len() < cap {
        return Ok(RuntimeCapChecked(()));
    }
    Err(runtime_cap_error(live.len(), cap))
}

/// Read the live-runtime cap from the global agent config.
///
/// Every enforcement site resolves the cap through here, so an unreadable or
/// absent config falls back to [`super::DEFAULT_MAX_LIVE_RUNTIMES`] rather than
/// to a `0` that would refuse everything.
pub(crate) fn configured_runtime_cap<R: tauri::Runtime>(app: &AppHandle<R>) -> usize {
    load_global_agent_config(app)
        .unwrap_or_default()
        .effective_max_live_runtimes()
}

/// One (agent, community) pair the reconcile planner decided to start.
#[derive(Debug, Clone)]
pub(crate) struct PlannedPair {
    /// The agent record to start.
    pub record: super::ManagedAgentRecord,
    /// The community's relay URL exactly as requested (un-normalized); the
    /// probe and `start_pair` canonicalize it.
    pub requested_relay_url: String,
    /// `true` when a live runtime already exists for this exact pair. Such a
    /// job re-reports the running pair's status and spawns nothing, so it does
    /// NOT consume a slot from the cap budget.
    pub already_live: bool,
}

/// One (agent, community) pair the cap refused.
#[derive(Debug, Clone)]
pub(crate) struct SkippedPair {
    pub record: super::ManagedAgentRecord,
    pub requested_relay_url: String,
    /// Pairs live at the moment THIS pair was refused — the pre-batch live
    /// count plus the slots this same plan already handed out. Reporting the
    /// pre-batch snapshot instead would tell the user "0 of 8 live" on 70
    /// consecutive refusals.
    pub live_count: usize,
}

/// What [`plan_reconcile_jobs`] decided for one reconcile call.
#[derive(Debug, Default)]
pub(crate) struct ReconcilePlan {
    /// Pairs to probe and start.
    pub jobs: Vec<PlannedPair>,
    /// Pairs the cap refused. Each one becomes a `Failed` status row so the
    /// refusal is visible in the UI instead of looking like a silent skip.
    pub skipped: Vec<SkippedPair>,
}

impl ReconcilePlan {
    /// How many jobs will actually spawn a new pair — i.e. consume a slot.
    pub fn new_pair_count(&self) -> usize {
        self.jobs.iter().filter(|job| !job.already_live).count()
    }
}

/// Decide which (auto-start agent × community) pairs reconcile may start under
/// the live-runtime cap.
///
/// Auto-start fans out as a *product*: N local agents with
/// `start_on_app_launch` × M configured communities. Unbounded, that is what
/// put 79 `buzz-acp` processes on one machine and let a single agent answer
/// from several relays at once. The planner never plans more than
/// `cap - live.len()` NEW pairs; everything past the budget is reported in
/// `skipped` rather than dropped.
///
/// **Order is agent-major** — agent 1 in every community, then agent 2, and so
/// on. Community-major would spend the whole budget on the first community and
/// leave every other community with no warm pair at all; agent-major degrades
/// by dropping the tail of the agent list instead, which is the dimension the
/// user can actually see and reorder.
///
/// **Communities are deduplicated by canonical relay key** before planning:
/// `ws://localhost:3000` and `ws://127.0.0.1:3000` are the same pair once
/// `ManagedAgentRuntimeKey` normalizes them, and charging two slots for one
/// process would shrink the real ceiling. A URL that cannot be normalized
/// keeps its raw string as its identity so it still reaches the probe and
/// fails loudly there.
///
/// A pair that is already live is planned anyway and does not spend budget —
/// `start_pair` short-circuits on a live child and returns its existing
/// status, so replanning it starts no process. Counting it against the cap
/// would shrink the effective ceiling every time reconcile re-ran.
///
/// Pure: no disk, no locks, no process work — `live` is the caller's snapshot
/// of live runtime keys (see [`live_runtime_keys`]), so `live.len()` is the
/// `live_count` the cap arithmetic starts from.
pub(crate) fn plan_reconcile_jobs(
    records: &[super::ManagedAgentRecord],
    communities: &[super::ManagedAgentCommunityTarget],
    live: &std::collections::HashSet<ManagedAgentRuntimeKey>,
    cap: usize,
) -> ReconcilePlan {
    let targets = dedupe_communities(communities);
    let live_before = live.len();
    let mut budget = cap.saturating_sub(live_before);
    let mut consumed = 0usize;
    let mut plan = ReconcilePlan::default();
    // Agent-major: the legacy per-record relay pin is deliberately ignored here
    // — see `effective_agent_relay_url`. Every local auto-start agent fans out
    // to every configured community.
    for record in records
        .iter()
        .filter(|record| record.start_on_app_launch && record.backend == BackendKind::Local)
    {
        for requested in &targets {
            // An unkeyable relay URL cannot match a live key; it falls through
            // as a new pair and fails loudly in the probe, as before.
            let already_live = ManagedAgentRuntimeKey::new(record.pubkey.clone(), requested)
                .is_ok_and(|key| live.contains(&key));
            if !already_live {
                if budget == 0 {
                    plan.skipped.push(SkippedPair {
                        record: record.clone(),
                        requested_relay_url: requested.clone(),
                        live_count: live_before + consumed,
                    });
                    continue;
                }
                budget -= 1;
                consumed += 1;
            }
            plan.jobs.push(PlannedPair {
                record: record.clone(),
                requested_relay_url: requested.clone(),
                already_live,
            });
        }
    }
    plan
}

/// Collapse community targets that resolve to the same pair identity, keeping
/// the first requested spelling of each.
///
/// Uses the same canonicalization `ManagedAgentRuntimeKey::new` applies
/// (`normalize_relay_url`), so "distinct" here means exactly "would produce a
/// distinct runtime key". An un-normalizable URL is its own identity.
fn dedupe_communities(communities: &[super::ManagedAgentCommunityTarget]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut targets = Vec::new();
    for community in communities {
        let identity = buzz_core_pkg::relay::normalize_relay_url(&community.relay_url)
            .unwrap_or_else(|_| community.relay_url.clone());
        if seen.insert(identity) {
            targets.push(community.relay_url.clone());
        }
    }
    targets
}

/// The `Failed` status row for a pair the cap refused.
///
/// A refusal is reported, never silently dropped: without a row the agent just
/// never appears and the user has nothing to act on. `log_path` is `None`
/// because no process ever started, so there is no log to open.
///
/// `error_code` is the load-bearing part. The frontend reconcile retry ladder
/// (`classifyReconcileResult`) treats a `failed` lifecycle as a transient relay
/// fault and re-attempts on a 5s/30s/2m ladder; a cap refusal is a steady
/// state, so without the discriminator the ladder would re-emit these rows
/// forever.
fn cap_skipped_status(
    skip: &SkippedPair,
    cap: usize,
    personas: &[super::AgentDefinition],
    global: &super::GlobalAgentConfig,
    named_claude_account_ready: bool,
) -> ManagedAgentRuntimeStatus {
    let command = record_agent_command(&skip.record, personas);
    let metadata = super::known_acp_runtime(&command);
    let effective = resolve_effective_agent_env(
        &skip.record,
        personas,
        metadata,
        global,
        named_claude_account_ready,
    );
    // An un-normalizable requested URL stands in for its own canonical form,
    // matching `unkeyable_failed_status`: one bad community still gets a row.
    let relay_url =
        ManagedAgentRuntimeKey::new(skip.record.pubkey.clone(), &skip.requested_relay_url)
            .map(|key| key.relay_url)
            .unwrap_or_else(|_| skip.requested_relay_url.clone());
    ManagedAgentRuntimeStatus {
        pubkey: skip.record.pubkey.clone(),
        relay_url,
        requested_relay_url: Some(skip.requested_relay_url.clone()),
        local_setup: matches!(agent_readiness(&effective), AgentReadiness::Ready),
        lifecycle: ManagedAgentRuntimeLifecycle::Failed,
        pid: None,
        error: Some(runtime_cap_error(skip.live_count, cap)),
        error_code: Some(super::RUNTIME_CAP_ERROR_CODE),
        log_path: None,
    }
}

/// Spawn a lazy harness pair for every eligible (agent, community) pair.
///
/// Eligibility is deliberately gated on `start_on_app_launch`: auto-start is
/// the *proactive fan-out* policy — "keep this agent warm in every community" —
/// not a correctness prerequisite. A manual-start agent still works on demand
/// everywhere: attaching it to a channel ensures its pair, an @mention wakes a
/// pair, the members sidebar and Settings controls start pairs, and restore
/// preserves running pairs across relaunch. Fanning out warm-socket pairs for
/// agents the user chose *not* to auto-start would contradict that choice, so
/// reconcile leaves them alone until something explicitly asks for them.
///
/// The fan-out is additionally bounded by `GlobalAgentConfig::max_live_runtimes`
/// — see [`plan_reconcile_jobs`]. Pairs past the budget are reported as
/// `Failed` rows carrying [`runtime_cap_error`], never dropped silently.
#[tauri::command]
pub async fn reconcile_managed_agent_runtimes(
    communities: Vec<super::ManagedAgentCommunityTarget>,
    app: AppHandle,
) -> Result<Vec<ManagedAgentRuntimeStatus>, String> {
    use futures_util::{stream, StreamExt};

    let records = load_managed_agents(&app)?;
    let cap = configured_runtime_cap(&app);
    // Scoped so the std guard is dropped before the first `.await` below.
    let live = {
        let state = app.state::<AppState>();
        let mut runtimes = state
            .managed_agent_processes
            .lock()
            .map_err(|e| e.to_string())?;
        live_runtime_keys(&mut runtimes)
    };
    let live_count = live.len();
    let plan = plan_reconcile_jobs(&records, &communities, &live, cap);
    if !plan.skipped.is_empty() {
        tracing::warn!(
            "managed-agent reconcile: live-runtime cap {cap} reached ({live_count} live) — \
             planning {} new pair(s), refusing {}",
            plan.new_pair_count(),
            plan.skipped.len()
        );
    }
    let skipped = plan.skipped;
    let jobs: Vec<_> = plan
        .jobs
        .into_iter()
        .map(|job| (job.record, job.requested_relay_url))
        .collect();
    let probes: Vec<_> = stream::iter(jobs)
        .map(|(record, requested)| {
            let state = app.state::<AppState>();
            async move {
                let fallback_record = record.clone();
                let fallback_requested = requested.clone();
                probe_agent_relay_access(&state, record, requested)
                    .await
                    .map_err(|error| (fallback_record, fallback_requested, error))
            }
        })
        .buffer_unordered(6)
        .collect()
        .await;

    // start_pair does blocking work (std mutexes, process spawn, receipt
    // writes, and up-to-2s exit polling in terminate_untracked_pair_runtime),
    // so run the post-probe start loop off the async workers, matching the
    // restart flows.
    tokio::task::spawn_blocking(move || {
        let personas = load_personas(&app).unwrap_or_default();
        let global = load_global_agent_config(&app).unwrap_or_default();
        let mut rows = Vec::new();

        // Cap refusals first: they never touched the relay, so they carry no
        // probe result. Each one becomes a visible `Failed` row AND is emitted
        // on the live status channel, so the running UI shows the refusal on
        // the same surface it shows every other pair error.
        for skip in skipped {
            tracing::warn!(
                "managed-agent reconcile: pair {}@{} refused — {}",
                skip.record.pubkey,
                skip.requested_relay_url,
                runtime_cap_error(skip.live_count, cap)
            );
            let status = cap_skipped_status(
                &skip,
                cap,
                &personas,
                &global,
                super::claude_accounts::claude_account_readiness_supplied(
                    &app,
                    skip.record.claude_account_id.as_deref(),
                ),
            );
            emit_status(&app, &status);
            rows.push(status);
        }

        for probe in probes {
            match probe {
                Ok((record, key, requested)) => {
                    match start_pair(
                        record.pubkey.clone(),
                        key.relay_url.clone(),
                        true,
                        Some(&record.updated_at),
                        app.clone(),
                    ) {
                        Ok(mut status) => {
                            status.requested_relay_url = Some(requested);
                            rows.push(status);
                        }
                        Err(error) => {
                            let mut status = status_for_with(
                                &app,
                                &record,
                                &key,
                                None,
                                Some(requested),
                                StatusInputs {
                                    personas: &personas,
                                    global: &global,
                                },
                            );
                            status.lifecycle = ManagedAgentRuntimeLifecycle::Failed;
                            status.error = Some(error);
                            rows.push(status);
                        }
                    }
                }
                Err((record, requested, error)) => {
                    // Per-community degradation: a relay URL that cannot even
                    // form a pair key gets a Failed row (with the raw
                    // requested URL) like any other probe failure, instead of
                    // aborting every other community's row.
                    let status =
                        match ManagedAgentRuntimeKey::new(record.pubkey.clone(), &requested) {
                            Ok(key) => {
                                let mut status = status_for_with(
                                    &app,
                                    &record,
                                    &key,
                                    None,
                                    Some(requested),
                                    StatusInputs {
                                        personas: &personas,
                                        global: &global,
                                    },
                                );
                                status.lifecycle = ManagedAgentRuntimeLifecycle::Failed;
                                status.error = Some(error);
                                status
                            }
                            Err(_) => unkeyable_failed_status(
                                &record,
                                requested,
                                error,
                                &personas,
                                &global,
                                super::claude_accounts::claude_account_readiness_supplied(
                                    &app,
                                    record.claude_account_id.as_deref(),
                                ),
                            ),
                        };
                    rows.push(status);
                }
            }
        }
        rows
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_managed_agent_runtimes_returns_a_future() {
        fn assert_async_command<F, Fut>(_command: F)
        where
            F: Fn(AppHandle) -> Fut,
            Fut: std::future::Future<Output = Result<Vec<ManagedAgentRuntimeStatus>, String>>,
        {
        }

        assert_async_command(list_managed_agent_runtimes);
    }

    fn payload(
        relay_url: &str,
        lifecycle: ManagedAgentRuntimeLifecycle,
        error: Option<&str>,
    ) -> super::super::ManagedAgentRuntimeLifecycleObserverPayload {
        super::super::ManagedAgentRuntimeLifecycleObserverPayload {
            pubkey: "aa".repeat(32),
            relay_url: relay_url.into(),
            start_nonce: "test-generation".into(),
            lifecycle,
            error: error.map(str::to_owned),
        }
    }

    // ── live-runtime cap: plan_reconcile_jobs ────────────────────────────────

    /// A local agent keyed by index, auto-start on unless told otherwise.
    fn autostart_record(index: usize) -> super::super::ManagedAgentRecord {
        let mut record: super::super::ManagedAgentRecord = serde_json::from_str(&format!(
            r#"{{
                "pubkey": "{:064x}",
                "name": "agent-{index}",
                "relay_url": "",
                "acp_command": "buzz-acp",
                "agent_command": "goose",
                "agent_args": [],
                "mcp_command": "",
                "turn_timeout_seconds": 320,
                "system_prompt": "",
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z"
            }}"#,
            index + 1
        ))
        .unwrap();
        record.start_on_app_launch = true;
        record
    }

    fn communities(relay_urls: &[&str]) -> Vec<super::super::ManagedAgentCommunityTarget> {
        relay_urls
            .iter()
            .map(|relay_url| super::super::ManagedAgentCommunityTarget {
                relay_url: (*relay_url).to_string(),
            })
            .collect()
    }

    const THREE_COMMUNITIES: [&str; 3] = [
        "wss://one.example",
        "wss://two.example",
        "wss://three.example",
    ];

    fn live_set(
        pairs: &[(&super::super::ManagedAgentRecord, &str)],
    ) -> std::collections::HashSet<ManagedAgentRuntimeKey> {
        pairs
            .iter()
            .map(|(record, relay)| {
                ManagedAgentRuntimeKey::new(record.pubkey.clone(), relay).unwrap()
            })
            .collect()
    }

    #[test]
    fn cap_bounds_the_agent_times_community_fan_out() {
        // The shape that produced 79 live processes on an owner machine:
        // 26 auto-start agents × 3 communities = 78 pairs. Under a cap of 8
        // the planner may start 8 and must REPORT the other 70 rather than
        // drop them.
        let records: Vec<_> = (0..26).map(autostart_record).collect();
        let cap = 8;
        let live = std::collections::HashSet::new();

        let plan = plan_reconcile_jobs(&records, &communities(&THREE_COMMUNITIES), &live, cap);

        assert_eq!(plan.jobs.len(), cap - live.len());
        assert!(plan.jobs.len() <= cap - live.len());
        assert_eq!(plan.new_pair_count(), cap);
        assert_eq!(
            plan.skipped.len(),
            26 * 3 - cap,
            "every refusal is reported"
        );
        assert!(
            plan.jobs.iter().all(|job| !job.already_live),
            "nothing was live, so every job is a new pair"
        );
    }

    #[test]
    fn live_pairs_are_planned_without_spending_budget() {
        // Re-running reconcile must not shrink the effective ceiling: a pair
        // that is already live is replanned (start_pair short-circuits on it
        // and spawns nothing) but does not consume a slot. Counting it twice
        // would starve the cap a little more on every refresh.
        let records: Vec<_> = (0..26).map(autostart_record).collect();
        let cap = 8;
        let live = live_set(&[
            (&records[0], THREE_COMMUNITIES[0]),
            (&records[0], THREE_COMMUNITIES[1]),
            (&records[1], THREE_COMMUNITIES[0]),
        ]);

        let plan = plan_reconcile_jobs(&records, &communities(&THREE_COMMUNITIES), &live, cap);

        assert_eq!(
            plan.new_pair_count(),
            cap - live.len(),
            "only the remaining budget is spent on new pairs"
        );
        assert_eq!(
            plan.jobs.len(),
            (cap - live.len()) + live.len(),
            "the live pairs are planned too, over and above the new-pair budget"
        );
        assert_eq!(
            plan.jobs.iter().filter(|job| job.already_live).count(),
            live.len(),
            "each live pair is planned exactly once"
        );
        assert_eq!(plan.jobs.len() + plan.skipped.len(), 26 * 3);
    }

    #[test]
    fn plan_respects_every_live_count_and_cap_edge() {
        // (live_count, cap, expected new pairs). 26 × 3 = 78 pairs available,
        // so the budget is always the binding constraint here.
        let cases: [(usize, usize, usize); 7] = [
            (0, 1, 1),
            (0, 8, 8),
            (3, 8, 5),
            (8, 8, 0),    // cap == live_count → zero new pairs
            (9, 8, 0),    // cap < live_count → zero new pairs, no underflow
            (78, 8, 0),   // far below the live count
            (0, 200, 78), // cap above the available pairs → everything planned
        ];
        let records: Vec<_> = (0..26).map(autostart_record).collect();
        let targets = communities(&THREE_COMMUNITIES);

        for (live_count, cap, expected_new) in cases {
            // Synthesize `live_count` live pairs that are NOT among the
            // planned ones, so the count is the only thing under test.
            let live: std::collections::HashSet<_> = (0..live_count)
                .map(|i| {
                    ManagedAgentRuntimeKey::new(
                        format!("{:064x}", 0xF000 + i),
                        "wss://elsewhere.example",
                    )
                    .unwrap()
                })
                .collect();
            assert_eq!(live.len(), live_count);

            let plan = plan_reconcile_jobs(&records, &targets, &live, cap);

            assert_eq!(
                plan.new_pair_count(),
                expected_new,
                "live_count={live_count} cap={cap}"
            );
            assert!(
                plan.new_pair_count() <= cap.saturating_sub(live_count),
                "live_count={live_count} cap={cap}: budget exceeded"
            );
            assert_eq!(
                plan.jobs.len() + plan.skipped.len(),
                26 * 3,
                "live_count={live_count} cap={cap}: every pair is accounted for"
            );
        }
    }

    #[test]
    fn plan_still_excludes_manual_start_and_non_local_agents() {
        // The cap is an ADDITIONAL bound — it must not widen eligibility.
        let mut records: Vec<_> = (0..3).map(autostart_record).collect();
        records[1].start_on_app_launch = false;
        records[2].backend = super::super::BackendKind::Provider {
            id: "blox".to_string(),
            config: serde_json::json!({}),
        };

        let plan = plan_reconcile_jobs(
            &records,
            &communities(&THREE_COMMUNITIES),
            &std::collections::HashSet::new(),
            100,
        );

        assert_eq!(plan.jobs.len(), 3, "only agent 0, once per community");
        assert!(plan.skipped.is_empty());
        assert!(plan
            .jobs
            .iter()
            .all(|job| job.record.pubkey == records[0].pubkey));
    }

    #[test]
    fn cap_error_names_the_numbers_and_a_way_out_that_exists() {
        let error = runtime_cap_error(8, 8);
        assert!(error.contains("8 of 8 live"), "got: {error}");
        assert!(error.contains("stop another agent"), "got: {error}");
        // There is no settings field for the cap. The message must name the
        // file the user can actually edit, not a screen that does not exist.
        assert!(
            error.contains("max_live_runtimes in agents/global-agent-config.json"),
            "got: {error}"
        );
        assert!(
            !error.contains("agent settings"),
            "must not point at a control that does not exist: {error}"
        );
    }

    #[test]
    fn every_refusal_reports_the_live_count_at_its_own_moment() {
        // The pre-batch snapshot would tell the user "0 of 8 live" on all 70
        // consecutive refusals, which reads as a bug rather than a ceiling.
        let records: Vec<_> = (0..26).map(autostart_record).collect();
        let cap = 8;

        let plan = plan_reconcile_jobs(
            &records,
            &communities(&THREE_COMMUNITIES),
            &std::collections::HashSet::new(),
            cap,
        );

        assert!(!plan.skipped.is_empty());
        for skip in &plan.skipped {
            assert_eq!(
                skip.live_count, cap,
                "by the time anything is refused the budget is spent, so the \
                 live count is the cap itself"
            );
        }
        assert!(runtime_cap_error(plan.skipped[0].live_count, cap).contains("8 of 8 live"));
    }

    #[test]
    fn a_cap_below_the_live_count_reports_the_real_overage() {
        let records: Vec<_> = (0..2).map(autostart_record).collect();
        let live: std::collections::HashSet<_> = (0..9)
            .map(|i| {
                ManagedAgentRuntimeKey::new(
                    format!("{:064x}", 0xF000 + i),
                    "wss://elsewhere.example",
                )
                .unwrap()
            })
            .collect();

        let plan = plan_reconcile_jobs(&records, &communities(&THREE_COMMUNITIES), &live, 8);

        assert_eq!(plan.new_pair_count(), 0);
        assert!(
            plan.skipped.iter().all(|skip| skip.live_count == 9),
            "nothing was consumed, so the live count stands"
        );
        assert!(runtime_cap_error(plan.skipped[0].live_count, 8).contains("9 of 8 live"));
    }

    #[test]
    fn budget_is_spread_agent_major_so_every_community_gets_warm_pairs() {
        // Community-major spends the whole budget on the first community and
        // leaves the others with nothing. Agent-major degrades by dropping the
        // tail of the agent list instead — the dimension the user can see.
        let records: Vec<_> = (0..26).map(autostart_record).collect();
        let targets = communities(&THREE_COMMUNITIES);

        let plan = plan_reconcile_jobs(&records, &targets, &std::collections::HashSet::new(), 4);

        assert_eq!(plan.jobs.len(), 4);
        for relay in THREE_COMMUNITIES {
            assert!(
                plan.jobs.iter().any(|job| job.requested_relay_url == relay),
                "community {relay} got no warm pair"
            );
        }
        // Agent 0 is complete before agent 1 starts.
        assert_eq!(
            plan.jobs
                .iter()
                .filter(|job| job.record.pubkey == records[0].pubkey)
                .count(),
            3
        );
        assert_eq!(
            plan.jobs
                .iter()
                .filter(|job| job.record.pubkey == records[1].pubkey)
                .count(),
            1
        );
    }

    #[test]
    fn communities_that_canonicalize_to_one_relay_consume_one_slot() {
        // `ManagedAgentRuntimeKey` normalizes loopback hosts, so these three
        // spellings are ONE pair. Charging three slots for one process would
        // silently shrink the real ceiling.
        let records: Vec<_> = (0..1).map(autostart_record).collect();
        let duplicates = communities(&[
            "ws://localhost:3000",
            "ws://127.0.0.1:3000",
            "ws://LOCALHOST:3000/",
        ]);

        let plan = plan_reconcile_jobs(&records, &duplicates, &std::collections::HashSet::new(), 8);

        assert_eq!(plan.jobs.len(), 1, "one pair, not three");
        assert_eq!(
            plan.jobs[0].requested_relay_url, "ws://localhost:3000",
            "the first requested spelling is the one carried forward"
        );
        assert!(plan.skipped.is_empty());
    }

    #[test]
    fn genuinely_distinct_communities_are_not_collapsed() {
        let records: Vec<_> = (0..1).map(autostart_record).collect();
        let plan = plan_reconcile_jobs(
            &records,
            &communities(&THREE_COMMUNITIES),
            &std::collections::HashSet::new(),
            8,
        );
        assert_eq!(plan.jobs.len(), 3);
    }

    #[test]
    fn cap_skipped_row_is_a_failed_row_carrying_the_cap_error_code() {
        // The frontend retry ladder re-attempts any `failed` reconcile row on a
        // 5s/30s/2m schedule. A cap refusal is a STEADY state, so without the
        // discriminator the ladder would re-emit these rows forever. Dropping
        // `error_code` here turns this row RED.
        let record = autostart_record(0);
        let skip = SkippedPair {
            record: record.clone(),
            requested_relay_url: "ws://localhost:3000".to_string(),
            live_count: 8,
        };

        let status = cap_skipped_status(
            &skip,
            8,
            &[],
            &super::super::GlobalAgentConfig::default(),
            false,
        );

        assert!(matches!(
            status.lifecycle,
            ManagedAgentRuntimeLifecycle::Failed
        ));
        assert_eq!(
            status.error_code,
            Some(super::super::RUNTIME_CAP_ERROR_CODE)
        );
        assert_eq!(
            status.error.as_deref(),
            Some(runtime_cap_error(8, 8).as_str())
        );
        assert_eq!(status.pubkey, record.pubkey);
        assert_eq!(
            status.requested_relay_url.as_deref(),
            Some("ws://localhost:3000")
        );
        assert_eq!(
            status.relay_url, "ws://127.0.0.1:3000",
            "the row is keyed by the canonical pair identity"
        );
        assert_eq!(status.pid, None);
        assert_eq!(
            status.log_path, None,
            "no process started, so there is no log to offer"
        );
    }

    #[test]
    fn an_unkeyable_community_still_produces_a_cap_row() {
        // One bad relay URL must not cost the user every other row.
        let skip = SkippedPair {
            record: autostart_record(0),
            requested_relay_url: "not a url".to_string(),
            live_count: 8,
        };
        let status = cap_skipped_status(
            &skip,
            8,
            &[],
            &super::super::GlobalAgentConfig::default(),
            false,
        );
        assert_eq!(status.relay_url, "not a url");
        assert_eq!(
            status.error_code,
            Some(super::super::RUNTIME_CAP_ERROR_CODE)
        );
    }

    fn record_with_relay(relay_url: &str) -> super::super::ManagedAgentRecord {
        serde_json::from_str(&format!(
            r#"{{
                "pubkey": "{}",
                "name": "pin-test",
                "relay_url": "{relay_url}",
                "acp_command": "buzz-acp",
                "agent_command": "goose",
                "agent_args": [],
                "mcp_command": "",
                "turn_timeout_seconds": 320,
                "system_prompt": "",
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z"
            }}"#,
            "aa".repeat(32)
        ))
        .unwrap()
    }

    #[test]
    fn legacy_relay_pin_is_ignored_for_fan_out() {
        // Zero-touch cutover (#2122): a record carrying a creation-era
        // `relay_url` pin must fan out exactly like an unpinned one — the
        // stored field is parsed but never consulted. See
        // `effective_agent_relay_url`.
        let unpinned = record_with_relay("");
        let pinned = record_with_relay("wss://one.example");
        for record in [&unpinned, &pinned] {
            assert_eq!(
                crate::relay::effective_agent_relay_url(&record.relay_url, "wss://two.example"),
                "wss://two.example"
            );
        }
    }

    #[test]
    fn unkeyable_relay_degrades_to_failed_row() {
        // A requested URL that cannot form a pair key must still yield a
        // Failed row keyed by the raw requested string, so one bad community
        // never aborts the rest of the reconcile batch.
        let record = record_with_relay("");
        let status = unkeyable_failed_status(
            &record,
            "not a url".to_string(),
            "relay access probe timed out".to_string(),
            &[],
            &super::super::GlobalAgentConfig::default(),
            false,
        );
        assert!(matches!(
            status.lifecycle,
            ManagedAgentRuntimeLifecycle::Failed
        ));
        assert_eq!(status.relay_url, "not a url");
        assert_eq!(status.requested_relay_url.as_deref(), Some("not a url"));
        assert_eq!(status.pubkey, record.pubkey);
        assert_eq!(
            status.error.as_deref(),
            Some("relay access probe timed out")
        );
        assert!(status.pid.is_none());
    }

    #[test]
    fn runtime_key_rejects_non_hex_pubkeys() {
        assert!(ManagedAgentRuntimeKey::new("../not-a-key", "wss://relay.example").is_err());
        assert!(ManagedAgentRuntimeKey::new("gg".repeat(32), "wss://relay.example").is_err());
    }

    #[test]
    fn runtime_key_canonicalizes_hex_pubkeys() {
        let key = ManagedAgentRuntimeKey::new("AA".repeat(32), "wss://relay.example").unwrap();
        assert_eq!(key.pubkey, "aa".repeat(32));
    }

    #[test]
    fn observer_lifecycle_key_preserves_exact_canonical_pair() {
        let first = payload(
            "WSS://Relay.Example:443/",
            ManagedAgentRuntimeLifecycle::Ready,
            None,
        );
        let key = observer_lifecycle_key(&first.pubkey, &first).unwrap();
        assert_eq!(key.pubkey, first.pubkey);
        assert_eq!(key.relay_url, "wss://relay.example");

        let other = payload(
            "wss://other.example",
            ManagedAgentRuntimeLifecycle::Ready,
            None,
        );
        assert_ne!(key, observer_lifecycle_key(&other.pubkey, &other).unwrap());
    }

    #[test]
    fn observer_lifecycle_rejects_cross_agent_and_desktop_states() {
        let ready = payload(
            "wss://relay.example",
            ManagedAgentRuntimeLifecycle::Ready,
            None,
        );
        assert!(observer_lifecycle_key(&"bb".repeat(32), &ready).is_err());

        let stopped = payload(
            "wss://relay.example",
            ManagedAgentRuntimeLifecycle::Stopped,
            None,
        );
        assert!(observer_lifecycle_key(&stopped.pubkey, &stopped).is_err());
    }

    #[test]
    fn observer_lifecycle_enforces_failed_error_contract() {
        let failed = payload(
            "wss://relay.example",
            ManagedAgentRuntimeLifecycle::Failed,
            None,
        );
        assert!(observer_lifecycle_key(&failed.pubkey, &failed).is_err());

        let ready_with_error = payload(
            "wss://relay.example",
            ManagedAgentRuntimeLifecycle::Ready,
            Some("unexpected"),
        );
        assert!(observer_lifecycle_key(&ready_with_error.pubkey, &ready_with_error).is_err());
    }
}
