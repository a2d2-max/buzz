use super::{
    bestie_assignment::recover_pending_assignment_cleanup, find_managed_agent_mut,
    kill_stale_tracked_processes, load_managed_agents, load_personas, managed_agents_base_dir,
    save_managed_agents, spawn_agent_child, sync_managed_agent_processes, BackendKind,
    ManagedAgentProcess,
};
use crate::app_state::AppState;
use crate::util;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

/// Outcome of a Phase B spawn attempt for one restore candidate.
///
/// `Skipped` covers the case where a concurrently-running startup reconcile
/// already spawned and tracked this exact pair during the Phase A window (the
/// transition lock is only held from Phase B onward). Restore must then leave
/// that live child alone rather than terminate-and-respawn it — mirroring the
/// live-child guard in `start_pair` (`runtime_commands.rs`). Without this,
/// restore would kill reconcile's lazy child by its receipt and replace it with
/// an eager one, flipping the pair's laziness on a startup race.
enum SpawnOutcome {
    /// Boxed: the spawned process carries its full spawn-config snapshot, so an
    /// inline variant would make every `Skipped`/`Failed` outcome pay for it.
    Spawned(super::ManagedAgentRuntimeKey, Box<ManagedAgentProcess>),
    Skipped,
    Failed(String),
}
type AgentSpawnResult = (String, SpawnOutcome);

/// Claim one slot from launch restore's shared Phase B budget.
///
/// Phase B spawns in parallel and does NOT insert into the runtimes map until
/// Phase C, so `enforce_runtime_cap` — which reads that map — returns the same
/// answer to every thread in the batch. Without this atomic claim, N threads
/// each see "one slot free" and N children start. `fetch_update` returning
/// `None` at zero is what makes the claim saturate instead of wrapping.
///
/// Returns `true` when a slot was taken.
pub(super) fn claim_spawn_slot(budget: &std::sync::atomic::AtomicUsize) -> bool {
    budget
        .fetch_update(
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
            |remaining| remaining.checked_sub(1),
        )
        .is_ok()
}

/// Hand a claimed slot back after a spawn that never started a process, so one
/// failed agent does not refuse a later one that would have fit.
pub(super) fn release_spawn_slot(budget: &std::sync::atomic::AtomicUsize) {
    budget.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

/// Pick the auto-start agents launch restore should respawn, bounded by the
/// live-runtime cap.
///
/// An agent is a candidate when it is a local auto-start agent whose pair is
/// neither tracked-and-alive in this process (`live_pubkeys`) nor still
/// running under its recorded `runtime_pid` from a previous launch
/// (`pid_is_running`) — both of those are already serving and must not be
/// terminate-and-respawned.
///
/// The cap then truncates the list to `cap - live_count` agents. Restore runs
/// before any user interaction, so an over-budget launch would otherwise fill
/// the whole ceiling with whatever order the store happened to be in and leave
/// nothing for the pairs the user actually asks for. Order is the store order,
/// so the choice is stable across relaunches rather than random.
///
/// Pure (no `AppHandle`, no locks) so the cap arithmetic is unit-testable;
/// liveness is injected by the caller.
fn plan_restore_candidates(
    records: &[super::ManagedAgentRecord],
    live_pubkeys: &std::collections::HashSet<String>,
    pid_is_running: &dyn Fn(u32) -> bool,
    live_count: usize,
    cap: usize,
) -> Vec<super::ManagedAgentRecord> {
    // `saturating_sub`: a cap already met (or exceeded) restores nothing
    // instead of underflowing into an unbounded budget.
    let budget = cap.saturating_sub(live_count);
    if budget == 0 {
        return Vec::new();
    }
    records
        .iter()
        .filter(|record| record.start_on_app_launch && record.backend == BackendKind::Local)
        .filter(|record| !live_pubkeys.contains(&record.pubkey))
        .filter(|record| !record.runtime_pid.is_some_and(pid_is_running))
        .take(budget)
        .cloned()
        .collect()
}

/// Backfill the pinned persona snapshot for pre-existing agents created before
/// the record became the spawn source of truth. Runs once at launch, before
/// `restore_managed_agents_on_launch` spawns anything, so no agent boots from an
/// empty snapshot.
///
/// Only records with a `persona_id` but no `persona_source_version` are touched.
/// Records that already have a `persona_source_version` — including those whose
/// `model`/`provider` were clobbered by the old unconditional snapshot code before
/// this fix — are skipped here; they self-heal on the next manual start via the
/// start-path re-snapshot in `start_local_agent_with_preflight`.
/// If the linked persona is gone, we log loudly and leave the record untouched —
/// it stays orphaned and `spawn_agent_child` refuses to start it (see
/// `effective_config::resolve_effective_config`'s `OrphanedInstance` arm).
pub fn backfill_persona_snapshots(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _store_guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|error| error.to_string())?;

    let mut records = load_managed_agents(app)?;
    let needs_backfill = records
        .iter()
        .any(|r| r.persona_id.is_some() && r.persona_source_version.is_none());
    if !needs_backfill {
        return Ok(());
    }

    let personas = load_personas(app)?;
    let mut changed = false;
    for record in records.iter_mut() {
        let Some(persona_id) = record.persona_id.clone() else {
            continue;
        };
        if record.persona_source_version.is_some() {
            continue;
        }
        let Some(persona) = personas.iter().find(|p| p.id == persona_id) else {
            eprintln!(
                "buzz-desktop: persona-snapshot backfill: agent {} links persona {persona_id} which no longer exists; leaving it orphaned — spawn will refuse it",
                record.pubkey
            );
            continue;
        };
        // Layer precedence at read time: persona env < agent env. When the
        // persona leaves model/provider blank, the record's own configured
        // values are preserved — a blank persona must not clobber a
        // user-configured agent. See `apply_persona_snapshot`.
        super::persona_events::apply_persona_snapshot(record, persona);
        record.updated_at = util::now_iso();
        changed = true;
    }

    if changed {
        save_managed_agents(app, &records)?;
    }
    Ok(())
}

/// Restore managed agents that were running before the app was closed.
///
/// Split into three phases to minimise lock contention with the frontend:
///   A (under lock): sync process state, cleanup, collect agents to start
///   B (no locks):   resolve commands and spawn processes in parallel
///   C (re-lock):    write back PIDs and status to records on disk
pub async fn restore_managed_agents_on_launch(
    app: &tauri::AppHandle,
    shutdown_started: &AtomicBool,
) -> Result<(), String> {
    if shutdown_started.load(Ordering::SeqCst) {
        return Ok(());
    }

    let state = app.state::<AppState>();

    // ── Phase A (under lock): housekeeping + collect agents to restore ──
    let mut agents_to_start: Vec<super::ManagedAgentRecord>;
    {
        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;

        if shutdown_started.load(Ordering::SeqCst) {
            return Ok(());
        }

        let mut records = load_managed_agents(app)?;
        recover_pending_assignment_cleanup(&managed_agents_base_dir(app)?, |pending_pubkey| {
            records
                .iter()
                .any(|record| record.pubkey.eq_ignore_ascii_case(pending_pubkey))
        })?;
        let mut runtimes = state
            .managed_agent_processes
            .lock()
            .map_err(|error| error.to_string())?;
        let (mut changed, _exited) = sync_managed_agent_processes(
            &mut records,
            &mut runtimes,
            &super::current_instance_id(app),
        );
        changed |=
            kill_stale_tracked_processes(&mut records, &runtimes, &super::current_instance_id(app));

        let tracked_pids: Vec<u32> = runtimes
            .values()
            .map(|runtime| runtime.child.id())
            .chain(
                super::read_all_agent_runtime_receipts(app)
                    .into_iter()
                    .filter_map(|(path, receipt)| {
                        super::valid_agent_runtime_receipt(
                            &path,
                            &receipt,
                            &super::current_instance_id(app),
                        )
                        .then_some(receipt.pid)
                    }),
            )
            .collect();
        super::sweep_orphaned_agent_processes(app, &tracked_pids);

        // System-wide sweep: enumerate all user processes and kill any known
        // agent binaries not tracked by this session. Catches orphans whose
        // PID files were already cleaned up (e.g. agent workers in their own
        // process group whose parent harness exited).
        super::sweep_system_agent_processes(&super::current_instance_id(app), &tracked_pids);

        // Dead-instance reaping: find agents belonging to Buzz instances
        // whose desktop process is no longer running and reap them.
        super::reap_dead_instance_agents(&super::current_instance_id(app), &tracked_pids);

        // Exact-path sweep: kill any buzz-acp process whose executable path
        // matches this bundle's harness binary but is not in the tracked set.
        // Complements the env-var sweep above — catches orphans that predate
        // BUZZ_MANAGED_AGENT injection or lost their PID-file receipt.
        //
        // TODO: the three sweeps above each walk the PID table independently.
        // A future consolidation should collect a single shared process snapshot
        // at the top of this block and thread it through all sweep functions,
        // replacing the three separate kernel enumerations.
        super::sweep_untracked_bundle_harnesses(&tracked_pids);

        // Pairs already alive in this process' runtime map. They keep running
        // and are not restored again, but they DO occupy cap slots — counted
        // as PAIRS (one agent can hold several), while the skip test is per
        // agent, matching the one-pair-per-agent shape restore spawns.
        let live_keys = super::runtime_commands::live_runtime_keys(&mut runtimes);
        let live_pubkeys: std::collections::HashSet<String> =
            live_keys.iter().map(|key| key.pubkey.clone()).collect();
        let cap = super::load_global_agent_config(app)
            .unwrap_or_default()
            .effective_max_live_runtimes();
        agents_to_start = plan_restore_candidates(
            &records,
            &live_pubkeys,
            &|pid| super::process_is_running(pid),
            live_keys.len(),
            cap,
        );

        // Re-snapshot persona config for agents about to be restored, matching
        // the interactive spawn path so auto-start agents also pick up the
        // current persona on app launch.
        let personas_for_snapshot = super::load_personas(app).unwrap_or_default();
        for record in records.iter_mut() {
            if !agents_to_start.iter().any(|r| r.pubkey == record.pubkey) {
                continue;
            }
            let Some(persona_id) = record.persona_id.clone() else {
                continue;
            };
            let Some(persona) = personas_for_snapshot.iter().find(|p| p.id == persona_id) else {
                // Orphaned: no current persona to re-snapshot from. Leave the
                // record as-is — `spawn_agent_child` (Phase B below) refuses to
                // spawn it and Phase C persists the refusal to `last_error`.
                continue;
            };
            super::persona_events::apply_persona_snapshot(record, persona);
            record.updated_at = util::now_iso();
            changed = true;
        }
        // Re-collect to_start from the updated records so Phase B spawns the refreshed config.
        agents_to_start = records
            .iter()
            .filter(|r| agents_to_start.iter().any(|s| s.pubkey == r.pubkey))
            .cloned()
            .collect();

        if changed {
            save_managed_agents(app, &records)?;
        }
    }

    if agents_to_start.is_empty() {
        return Ok(());
    }

    // Snapshot the workspace owner pubkey once for the legacy auth_tag fallback.
    // Read outside the per-agent spawn loop so all parallel spawns see the same
    // value and we don't lock `state.keys` repeatedly.
    let owner_hex: Option<String> = state
        .keys
        .lock()
        .map_err(|e| e.to_string())
        .ok()
        .map(|k| k.public_key().to_hex());

    #[cfg(feature = "mesh-llm")]
    let agents_to_start = {
        // Preflight against the same resolution spawn uses — `resolve_effective_config`
        // (definition → global fallback). A linked instance's own `provider`/`model`/
        // `relay_mesh` bytes never contribute. See `start_local_agent_with_preflight`
        // in `commands/agents.rs` for the identical rationale on the interactive path.
        let personas = load_personas(app).unwrap_or_default();
        let global = super::load_global_agent_config(app).unwrap_or_default();
        let mut mesh_preflight_failures = std::collections::HashSet::new();
        for record in &agents_to_start {
            let mesh_model_id = super::effective_config::resolve_effective_relay_mesh_model_id(
                record, &personas, &global,
            );
            if mesh_model_id.is_none() {
                continue;
            }
            // Auto-start after relaunch: re-resolve a live bootstrap target and
            // dial it. Skip (with an actionable error) only when no live target
            // serves this model right now.
            if let Err(error) =
                crate::commands::ensure_relay_mesh_for_record(app, mesh_model_id.as_deref(), false)
                    .await
            {
                persist_restore_error(app, &state, &record.pubkey, error)?;
                mesh_preflight_failures.insert(record.pubkey.clone());
            }
        }
        agents_to_start
            .into_iter()
            .filter(|record| !mesh_preflight_failures.contains(&record.pubkey))
            .collect::<Vec<_>>()
    };
    if agents_to_start.is_empty() {
        return Ok(());
    }

    // Serialize spawning and runtime registration with shutdown cleanup. The
    // shutdown flag is rechecked after taking the lock so shutdown either
    // prevents this transition or waits until every child is tracked and can
    // be terminated.
    let restore_transition = state
        .managed_agent_runtime_transition
        .lock()
        .map_err(|error| error.to_string())?;
    if shutdown_started.load(Ordering::SeqCst) {
        return Ok(());
    }

    // ── Phase B (transition lock held): resolve commands and spawn in parallel ──
    //
    // Phase A already budgeted `agents_to_start` against the cap, but Phase B
    // bypasses `start_pair` and its cap check, and a concurrent startup
    // reconcile can have filled slots during the Phase A → B window. Re-read
    // the cap and the live count now (under the transition lock) and hand the
    // spawn threads a shared budget: each thread claims a slot before spawning
    // or reports the refusal, so N parallel threads cannot each believe they
    // hold the last slot.
    let cap = super::runtime_commands::configured_runtime_cap(app);
    let (live_now, remaining) = {
        let mut runtimes = state
            .managed_agent_processes
            .lock()
            .map_err(|error| error.to_string())?;
        super::runtime_commands::remaining_runtime_slots(&mut runtimes, cap)
    };
    let spawn_budget = std::sync::atomic::AtomicUsize::new(remaining);
    let budget = &spawn_budget;

    let spawn_results: Vec<AgentSpawnResult> = std::thread::scope(|scope| {
        let owner_hex_ref = owner_hex.as_deref();
        let handles: Vec<_> = agents_to_start
            .iter()
            .filter(|_| !shutdown_started.load(Ordering::SeqCst))
            .map(|record| {
                let handle = scope.spawn(move || {
                    let workspace_relay =
                        crate::relay::relay_ws_url_with_override(&app.state::<AppState>());
                    let relay_url = crate::relay::effective_agent_relay_url(
                        &record.relay_url,
                        &workspace_relay,
                    );
                    let outcome =
                        match super::ManagedAgentRuntimeKey::new(record.pubkey.clone(), &relay_url)
                        {
                            Ok(key) => {
                                // F2: if a concurrent startup reconcile already
                                // tracked a live child for this exact pair during
                                // the Phase A window, leave it alone. Mirrors the
                                // live-child guard in `start_pair`.
                                // One lock acquisition answers both questions:
                                // is this exact pair already live (leave it
                                // alone), and does the cap still admit a new
                                // one? The cap re-check matters because a
                                // concurrent startup reconcile can fill slots
                                // during the Phase A → B window.
                                let (already_live, cap_refusal) = match app
                                    .state::<AppState>()
                                    .managed_agent_processes
                                    .lock()
                                {
                                    Ok(mut runtimes) => {
                                        let already_live = runtimes
                                            .get_mut(&key)
                                            .map(|runtime| {
                                                runtime.child.try_wait().ok().flatten().is_none()
                                            })
                                            .unwrap_or(false);
                                        let refusal = super::runtime_commands::enforce_runtime_cap(
                                            &mut runtimes,
                                            &key,
                                            cap,
                                        );
                                        (already_live, refusal)
                                    }
                                    Err(error) => (false, Err(error.to_string())),
                                };
                                if already_live {
                                    SpawnOutcome::Skipped
                                } else {
                                    match cap_refusal.and_then(|cap_checked| {
                                        // `enforce_runtime_cap` reads the live
                                        // map, which does not grow until Phase
                                        // C — so WITHIN this batch the shared
                                        // atomic is what stops N parallel
                                        // threads from each believing they
                                        // hold the last slot. Both are needed.
                                        claim_spawn_slot(budget).then_some(cap_checked).ok_or_else(
                                            || {
                                                super::runtime_commands::runtime_cap_error(
                                                    live_now, cap,
                                                )
                                            },
                                        )
                                    }) {
                                        // Refusal (either gate) is persisted to
                                        // `last_error` by Phase C.
                                        Err(refusal) => SpawnOutcome::Failed(refusal),
                                        Ok(cap_checked) => {
                                            match super::terminate_untracked_pair_runtime(app, &key)
                                                .and_then(|()| {
                                                    // F1: restore spawns lazy, matching
                                                    // reconcile and manual start. Eager on
                                                    // restore buys nothing — a crashed
                                                    // mid-turn session is not resumed by an
                                                    // eager child — and silently reintroduces
                                                    // N idle brains on every launch.
                                                    spawn_agent_child(
                                                        app,
                                                        record,
                                                        &key.relay_url,
                                                        true,
                                                        owner_hex_ref,
                                                        None,
                                                        cap_checked,
                                                    )
                                                }) {
                                                Ok(process) => {
                                                    SpawnOutcome::Spawned(key, Box::new(process))
                                                }
                                                Err(error) => {
                                                    // The slot claimed above was never
                                                    // filled — hand it back so one
                                                    // failed spawn does not refuse a
                                                    // later agent that would fit.
                                                    release_spawn_slot(budget);
                                                    SpawnOutcome::Failed(error)
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            Err(error) => SpawnOutcome::Failed(error),
                        };
                    (record.pubkey.clone(), outcome)
                });
                handle
            })
            .collect();

        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });

    if spawn_results.is_empty() {
        return Ok(());
    }

    // ── Phase C (re-acquire lock): write back PIDs and status to records ──
    let _store_guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|error| error.to_string())?;
    let mut records = load_managed_agents(app)?;
    let mut runtimes = state
        .managed_agent_processes
        .lock()
        .map_err(|error| error.to_string())?;

    let mut successfully_spawned: Vec<(String, String)> = Vec::new();

    for (pubkey, outcome) in spawn_results {
        match outcome {
            // Skipped means a concurrent reconcile already owns a live child for
            // this pair; leave its runtime and record state untouched.
            SpawnOutcome::Skipped => continue,
            SpawnOutcome::Spawned(key, mut process) => {
                let Ok(record) = find_managed_agent_mut(&mut records, &pubkey) else {
                    continue;
                };
                let now = util::now_iso();
                let receipt = super::ManagedAgentRuntimeReceipt {
                    key: key.clone(),
                    pid: process.child.id(),
                    desktop_instance_id: super::current_instance_id(app),
                    started_at: now.clone(),
                };
                if let Err(error) = super::write_agent_runtime_receipt(app, &receipt) {
                    let _ = super::terminate_process(process.child.id());
                    let _ = process.child.wait();
                    record.updated_at = now;
                    record.last_error = Some(error);
                    continue;
                }
                record.updated_at = now.clone();
                record.runtime_pid = None;
                record.last_started_at = Some(now);
                record.last_stopped_at = None;
                record.last_exit_code = None;
                record.last_error = None;
                runtimes.insert(
                    key.clone(),
                    super::ManagedAgentPairRuntime::starting(*process),
                );
                // Carry the spawn key's relay into profile reconciliation so
                // the background task queries/publishes on the relay this
                // spawn was actually keyed to — not whatever workspace is
                // active when the task eventually executes.
                successfully_spawned.push((pubkey, key.relay_url.clone()));
            }
            SpawnOutcome::Failed(error) => {
                let Ok(record) = find_managed_agent_mut(&mut records, &pubkey) else {
                    continue;
                };
                record.updated_at = util::now_iso();
                record.last_error = Some(error);
            }
        }
    }

    // Collect profile reconciliation data for successfully spawned agents before
    // releasing the lock. This mirrors the fire-and-forget pattern in
    // start_managed_agent — ensuring boot-restored agents get the same profile
    // self-healing as UI-started agents.
    let reconcile_personas = super::load_personas(app).unwrap_or_default();
    let reconcile_items: Vec<(String, crate::commands::ProfileReconcileData)> =
        successfully_spawned
            .iter()
            .filter_map(|(pubkey, spawn_relay)| {
                let record = records.iter().find(|r| r.pubkey == *pubkey)?;
                // Resolve the effective harness for the avatar-fallback
                // derivation (the snapshot may be empty/stale for an inherited
                // harness). Mirrors the UI start path.
                let effective_command =
                    crate::managed_agents::record_agent_command(record, &reconcile_personas);
                Some((
                    pubkey.clone(),
                    crate::commands::ProfileReconcileData {
                        private_key_nsec: record.private_key_nsec.clone(),
                        name: record.name.clone(),
                        relay_url: record.relay_url.clone(),
                        // Pin the relay this spawn was keyed to (see the
                        // successfully_spawned push above) so the deferred
                        // task cannot resolve a post-switch workspace.
                        target_relay_url: Some(spawn_relay.clone()),
                        avatar_url: record.avatar_url.clone(),
                        auth_tag: record.auth_tag.clone(),
                        pubkey: record.pubkey.clone(),
                        agent_command: effective_command,
                        persona_id: record.persona_id.clone(),
                        about: crate::managed_agents::record_effective_description(
                            record,
                            &reconcile_personas,
                        ),
                    },
                ))
            })
            .collect();

    save_managed_agents(app, &records)?;
    drop(runtimes);
    drop(_store_guard);
    drop(restore_transition);

    // ── Profile reconciliation (fire-and-forget) ────────────────────────────
    // Spawn background tasks to ensure each restored agent's kind:0 profile is
    // published on the relay. Same pattern as the UI start path.
    for (pubkey, data) in reconcile_items {
        let reconcile_app = app.clone();
        tauri::async_runtime::spawn(async move {
            let state = reconcile_app.state::<AppState>();
            if let Err(e) =
                crate::commands::reconcile_agent_profile(&state, &reconcile_app, &pubkey, &data)
                    .await
            {
                eprintln!("buzz-desktop: profile reconciliation failed for agent {pubkey}: {e}");
            }
        });
    }

    Ok(())
}

fn profile_reconcile_completed(outcome: crate::commands::ProfileReconcileOutcome) -> bool {
    outcome == crate::commands::ProfileReconcileOutcome::Reconciled
}

pub(crate) fn spawn_pending_profile_reconciliations(app: &tauri::AppHandle, workspace_relay: &str) {
    let state = app.state::<AppState>();
    if !state
        .managed_agent_profile_reconcile_enabled()
        .load(Ordering::Acquire)
    {
        return;
    }
    let items = match crate::commands::load_pending_profile_reconciliations(app, workspace_relay) {
        Ok(items) => items,
        Err(error) => {
            eprintln!("buzz-desktop: failed to load pending profile reconciliations: {error}");
            return;
        }
    };

    for (pubkey, data) in items {
        let reconcile_app = app.clone();
        let relay_url = data
            .target_relay_url
            .clone()
            .unwrap_or_else(|| data.relay_url.clone());
        tauri::async_runtime::spawn(async move {
            let state = reconcile_app.state::<AppState>();
            match crate::commands::reconcile_agent_profile(&state, &reconcile_app, &pubkey, &data)
                .await
            {
                Ok(outcome) if profile_reconcile_completed(outcome) => {
                    if let Err(error) = crate::commands::mark_profile_reconciled(
                        &reconcile_app,
                        &pubkey,
                        &relay_url,
                    ) {
                        eprintln!(
                            "buzz-desktop: failed to record profile reconciliation for agent {pubkey}: {error}"
                        );
                    }
                }
                Ok(_) => {}
                Err(error) => eprintln!(
                    "buzz-desktop: profile reconciliation failed for agent {pubkey}: {error}"
                ),
            }
        });
    }
}

#[cfg(test)]
mod restore_candidate_tests {
    use super::plan_restore_candidates;
    use std::collections::HashSet;

    fn record(index: usize, autostart: bool) -> super::super::ManagedAgentRecord {
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
        record.start_on_app_launch = autostart;
        record
    }

    fn never_running(_pid: u32) -> bool {
        false
    }

    #[test]
    fn restore_never_exceeds_the_remaining_cap_budget() {
        // Launch restore runs before the user can ask for anything, so an
        // unbounded restore would fill the whole ceiling with store order.
        let records: Vec<_> = (0..26).map(|i| record(i, true)).collect();

        let picked = plan_restore_candidates(&records, &HashSet::new(), &never_running, 0, 8);
        assert_eq!(picked.len(), 8);
        // Stable, not random: the first 8 in store order.
        assert_eq!(picked[0].pubkey, records[0].pubkey);
        assert_eq!(picked[7].pubkey, records[7].pubkey);
    }

    #[test]
    fn live_pairs_spend_the_budget_and_are_not_restored_again() {
        let records: Vec<_> = (0..26).map(|i| record(i, true)).collect();
        let live: HashSet<String> = records[..3]
            .iter()
            .map(|record| record.pubkey.clone())
            .collect();

        let picked = plan_restore_candidates(&records, &live, &never_running, live.len(), 8);

        assert_eq!(picked.len(), 5, "cap 8 minus the 3 already live");
        assert!(
            picked.iter().all(|record| !live.contains(&record.pubkey)),
            "a live pair is never terminate-and-respawned"
        );
    }

    #[test]
    fn a_met_or_exceeded_cap_restores_nothing() {
        let records: Vec<_> = (0..26).map(|i| record(i, true)).collect();
        assert!(
            plan_restore_candidates(&records, &HashSet::new(), &never_running, 8, 8).is_empty()
        );
        // cap < live_count: saturating, never a panic or an unbounded budget.
        assert!(
            plan_restore_candidates(&records, &HashSet::new(), &never_running, 9, 8).is_empty()
        );
    }

    #[test]
    fn manual_start_agents_and_still_running_pids_are_left_alone() {
        let mut records = vec![record(0, false), record(1, true), record(2, true)];
        records[2].runtime_pid = Some(4242);

        let picked = plan_restore_candidates(&records, &HashSet::new(), &|pid| pid == 4242, 0, 8);

        assert_eq!(picked.len(), 1);
        assert_eq!(picked[0].pubkey, records[1].pubkey);
    }
}

#[cfg(test)]
mod profile_reconcile_tests {
    use super::profile_reconcile_completed;
    use crate::commands::ProfileReconcileOutcome;

    #[test]
    fn skipped_reconciliation_never_retires_pending_work() {
        assert!(profile_reconcile_completed(
            ProfileReconcileOutcome::Reconciled
        ));
        assert!(!profile_reconcile_completed(
            ProfileReconcileOutcome::SkippedDisabled
        ));
    }
}

#[cfg(feature = "mesh-llm")]
fn persist_restore_error(
    app: &tauri::AppHandle,
    state: &AppState,
    pubkey: &str,
    error: String,
) -> Result<(), String> {
    let _store_guard = state
        .managed_agents_store_lock
        .lock()
        .map_err(|error| error.to_string())?;
    let mut records = load_managed_agents(app)?;
    let record = find_managed_agent_mut(&mut records, pubkey)?;
    record.updated_at = util::now_iso();
    record.last_error = Some(error);
    save_managed_agents(app, &records)
}
