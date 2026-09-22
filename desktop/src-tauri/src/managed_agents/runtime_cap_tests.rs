//! Production-seam regressions for the live-runtime cap.
//!
//! Every row that asks "is this pair live?" stands a REAL running child
//! process up first. Liveness is decided by polling the child (`try_wait`), so
//! a fixture holding a fake or already-exited process would make all of these
//! pass vacuously — hence `live_pair_runtime_fixture`.
//!
//! Deletion proofs:
//! - widen `enforce_runtime_cap` to admit a new pair at the ceiling →
//!   `enforce_runtime_cap_refuses_a_new_pair_at_the_ceiling` RED
//! - narrow it to refuse an already-live pair →
//!   `enforce_runtime_cap_always_admits_a_pair_that_is_already_live` RED
//! - count map length instead of polling children →
//!   `a_dead_but_unreaped_child_does_not_occupy_a_slot` RED
//! - restore the `runtime_pid` restart fallback, or go back to the
//!   liveness-blind `managed_agent_runtime_keys` →
//!   `an_agent_with_a_stale_pid_*` / `live_runtime_keys_for_skips_dead_pairs_*` RED
//! - drop restore Phase B's atomic slot claim →
//!   `the_batch_budget_admits_exactly_its_slots_under_contention` RED
//! - resolve the cap to `0` on a fresh install →
//!   `configured_cap_falls_back_to_the_default_*` RED
//!
//! The `error_code` stamp on a refused reconcile row is covered by
//! `runtime_commands::tests::cap_skipped_row_*`, next to the builder.

use super::runtime_commands::{
    configured_runtime_cap, enforce_runtime_cap, live_runtime_keys, live_runtime_keys_for,
    remaining_runtime_slots, runtime_cap_error,
};
use super::{
    live_pair_runtime_fixture, GlobalAgentConfig, ManagedAgentPairRuntime, ManagedAgentRuntimeKey,
};
use std::collections::HashMap;

fn key(index: usize, relay: &str) -> ManagedAgentRuntimeKey {
    ManagedAgentRuntimeKey::new(format!("{:064x}", index + 1), relay).unwrap()
}

/// A runtimes map holding `count` genuinely live pairs.
fn live_map(count: usize) -> HashMap<ManagedAgentRuntimeKey, ManagedAgentPairRuntime> {
    (0..count)
        .map(|index| (key(index, "wss://one.example"), live_pair_runtime_fixture()))
        .collect()
}

fn kill_all(runtimes: &mut HashMap<ManagedAgentRuntimeKey, ManagedAgentPairRuntime>) {
    for runtime in runtimes.values_mut() {
        let _ = runtime.child.kill();
        let _ = runtime.child.wait();
    }
}

#[test]
fn enforce_runtime_cap_refuses_a_new_pair_at_the_ceiling() {
    let mut runtimes = live_map(3);
    let fresh = key(99, "wss://one.example");

    let error = enforce_runtime_cap(&mut runtimes, &fresh, 3)
        .expect_err("a new pair at the ceiling must be refused");
    assert_eq!(error, runtime_cap_error(3, 3));
    assert!(
        enforce_runtime_cap(&mut runtimes, &fresh, 4).is_ok(),
        "one slot free"
    );

    kill_all(&mut runtimes);
}

#[test]
fn enforce_runtime_cap_always_admits_a_pair_that_is_already_live() {
    // Restarting a live pair swaps a slot for itself and cannot grow the live
    // set. Refusing it would make the cap a trap: at the ceiling the user could
    // not even restart what is already running.
    let mut runtimes = live_map(3);
    let existing = key(0, "wss://one.example");

    assert!(enforce_runtime_cap(&mut runtimes, &existing, 3).is_ok());
    assert!(enforce_runtime_cap(&mut runtimes, &existing, 1).is_ok());

    kill_all(&mut runtimes);
}

#[test]
fn a_dead_but_unreaped_child_does_not_occupy_a_slot() {
    // `runtimes` keeps entries until `sync_managed_agent_processes` reaps them.
    // Counting map length instead of polling each child would charge the cap
    // for processes that already exited and refuse spawns the machine affords.
    let mut runtimes = live_map(2);
    let doomed = key(0, "wss://one.example");
    {
        let runtime = runtimes.get_mut(&doomed).unwrap();
        runtime.child.kill().unwrap();
        runtime.child.wait().unwrap();
    }

    assert_eq!(
        live_runtime_keys(&mut runtimes).len(),
        1,
        "one really alive"
    );
    assert_eq!(remaining_runtime_slots(&mut runtimes, 2), (1, 1));
    assert!(enforce_runtime_cap(&mut runtimes, &key(99, "wss://one.example"), 2).is_ok());

    kill_all(&mut runtimes);
}

#[test]
fn live_runtime_keys_for_skips_dead_pairs_of_the_same_agent() {
    // The restart paths (inbound access change, local access edit) use this to
    // decide "which pairs were running, restart those". The liveness-blind
    // `managed_agent_runtime_keys` would hand back the dead pair and
    // cold-start it.
    let agent = format!("{:064x}", 1);
    let alive = ManagedAgentRuntimeKey::new(agent.clone(), "wss://alive.example").unwrap();
    let dead = ManagedAgentRuntimeKey::new(agent.clone(), "wss://dead.example").unwrap();
    let mut runtimes: HashMap<_, _> = [
        (alive.clone(), live_pair_runtime_fixture()),
        (dead.clone(), live_pair_runtime_fixture()),
    ]
    .into_iter()
    .collect();
    {
        let runtime = runtimes.get_mut(&dead).unwrap();
        runtime.child.kill().unwrap();
        runtime.child.wait().unwrap();
    }

    let blind = super::managed_agent_runtime_keys(&runtimes, &agent);
    assert_eq!(blind.len(), 2, "the liveness-blind helper returns both");

    let live = live_runtime_keys_for(&mut runtimes, &agent);
    assert_eq!(live, vec![alive], "only the pair that is really running");

    kill_all(&mut runtimes);
}

#[test]
fn remaining_slots_saturate_when_the_cap_is_below_the_live_count() {
    let mut runtimes = live_map(3);
    assert_eq!(remaining_runtime_slots(&mut runtimes, 1), (3, 0));
    assert_eq!(remaining_runtime_slots(&mut runtimes, 3), (3, 0));
    assert_eq!(remaining_runtime_slots(&mut runtimes, 10), (3, 7));
    kill_all(&mut runtimes);
}

#[test]
fn configured_cap_falls_back_to_the_default_when_no_config_is_written() {
    // `configured_runtime_cap` is what every enforcement site reads. A missing
    // or unreadable `global-agent-config.json` must not resolve to 0 — that
    // would refuse every spawn on a fresh install.
    let _guard = crate::managed_agents::lock_path_mutex();
    let temp = tempfile::tempdir().unwrap();
    let _home = crate::managed_agents::test_env::scoped_home(temp.path());

    let app = tauri::test::mock_builder()
        .manage(crate::app_state::build_app_state())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app builds headless");

    assert_eq!(
        configured_runtime_cap(app.handle()),
        super::DEFAULT_MAX_LIVE_RUNTIMES
    );

    // And a written cap is honoured.
    let dir = crate::managed_agents::managed_agents_base_dir(app.handle()).unwrap();
    std::fs::write(
        dir.join("global-agent-config.json"),
        serde_json::to_vec_pretty(&GlobalAgentConfig {
            max_live_runtimes: 3,
            ..Default::default()
        })
        .unwrap(),
    )
    .unwrap();
    assert_eq!(configured_runtime_cap(app.handle()), 3);
}

// ── The paths the cap must bind, and how each is bound ──────────────────────
//
// `start_pair` and `start_managed_agent_process` both take a concrete
// `AppHandle` (= `AppHandle<Wry>`), and Tauri's test harness only produces an
// `App<MockRuntime>`, so neither can be CALLED from a unit test without making
// their whole spawn chain generic. They are bound instead by a compile-time
// proof, the same idiom this crate already uses for `EffortApplied`:
//
//   `spawn_agent_child` takes `RuntimeCapChecked` BY VALUE, and the only way
//   to obtain one is `enforce_runtime_cap`. Deleting the gate from either
//   caller — or adding a fourth spawn path that skips it — does not compile.
//
// So: the gate's behaviour is covered by the rows above, its presence at every
// spawn site is covered by the type system, and the rows below cover the two
// pieces the token cannot express (the batch budget, and the refusal row).

#[test]
fn an_agent_with_a_stale_pid_and_no_live_pair_has_nothing_to_restart() {
    // H2/D mirror at the seam both access-policy paths now use. The record's
    // `runtime_pid` is a stale scalar from a previous launch; the ONLY thing
    // that ever turned it into a restart target was the fallback both
    // `inbound.rs` and `agent_models_update.rs` used to carry. With no live
    // pair there is nothing to restart, so an access edit cannot cold-start an
    // agent the user opted out of.
    let agent = format!("{:064x}", 7);
    let mut runtimes: HashMap<ManagedAgentRuntimeKey, ManagedAgentPairRuntime> = HashMap::new();
    // Another agent IS live, so an empty result is about this agent, not an
    // empty map.
    runtimes.insert(key(1, "wss://other.example"), live_pair_runtime_fixture());

    assert!(
        live_runtime_keys_for(&mut runtimes, &agent).is_empty(),
        "no live pair for this agent means no relay to restart"
    );
    assert!(super::managed_agent_runtime_keys(&runtimes, &agent).is_empty());

    kill_all(&mut runtimes);
}

#[test]
fn the_batch_budget_admits_exactly_its_slots_under_contention() {
    // Restore Phase B spawns in parallel and does not insert into the runtimes
    // map until Phase C, so `enforce_runtime_cap` returns the same answer to
    // every thread in the batch. Without the atomic claim, N threads each see
    // "a slot is free" and N children start. Removing `claim_spawn_slot` from
    // Phase B leaves it unused — which `-D warnings` rejects — and deleting
    // the saturation (`checked_sub`) turns this row RED.
    use std::sync::atomic::{AtomicUsize, Ordering};

    for (slots, threads) in [(0usize, 8usize), (1, 8), (3, 8), (8, 8), (12, 8)] {
        let budget = AtomicUsize::new(slots);
        let granted = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..threads {
                scope.spawn(|| {
                    if super::restore::claim_spawn_slot(&budget) {
                        granted.fetch_add(1, Ordering::SeqCst);
                    }
                });
            }
        });
        assert_eq!(
            granted.load(Ordering::SeqCst),
            slots.min(threads),
            "slots={slots} threads={threads}"
        );
        assert_eq!(budget.load(Ordering::SeqCst), slots.saturating_sub(threads));
    }
}

#[test]
fn a_released_slot_is_reusable() {
    // A spawn that failed never filled its slot; handing it back keeps one bad
    // agent from refusing a later one that would have fit.
    use std::sync::atomic::{AtomicUsize, Ordering};
    let budget = AtomicUsize::new(1);
    assert!(super::restore::claim_spawn_slot(&budget));
    assert!(!super::restore::claim_spawn_slot(&budget));
    super::restore::release_spawn_slot(&budget);
    assert_eq!(budget.load(Ordering::SeqCst), 1);
    assert!(super::restore::claim_spawn_slot(&budget));
}
