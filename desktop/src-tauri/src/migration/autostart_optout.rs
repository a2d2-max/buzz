//! One-time migration: opt every stored agent out of launch auto-start.
//!
//! # Why
//!
//! `start_on_app_launch` used to default to `true`, and auto-start fans one
//! live `buzz-acp` pair out per **(agent × community)**. On an owner machine
//! that product reached 26 agents × 3 communities = 79 live harness processes,
//! with the same agent answering from several relays at once. Flipping the
//! serde default to `false` fixes new and key-less records, but every record
//! already on disk carries an explicit `"start_on_app_launch": true` that the
//! new default cannot reach. This migration writes the opt-out into those
//! records once.
//!
//! # Run-once fence
//!
//! Idempotence here CANNOT come from the data's shape, the way
//! [`backfill`](super::backfill) gets it (a linked record is already done, so
//! re-running is a no-op). "Autostart is off" is a state the **user** is
//! allowed to leave: re-enabling an agent tomorrow must not be undone by the
//! next boot. So the fence is an explicit marker file,
//! `.autostart-optout-done`, written after a successful pass — including a
//! pass that found nothing to do (a fresh install whose store does not exist
//! yet must still be fenced, or the agents the user creates today get opted
//! out at tomorrow's launch).
//!
//! The marker is sited next to the **resolved** store, not next to the path we
//! were handed. Dev worktrees symlink `agents/managed-agents.json` into one
//! shared canonical data dir (`sync_shared_agent_data`), so a per-worktree
//! marker would let the second worktree re-run the opt-out over the shared
//! store and undo a re-enable the user made from the first.
//!
//! The pre-migration backup is a separate file with a separate job (recovery,
//! not fencing), taken create-if-absent exactly like `backfill`, and resolved
//! the same way.
//!
//! # Shape preservation
//!
//! Operates on `Vec<serde_json::Value>` (the [`pollen`](super::pollen) style)
//! rather than typed `ManagedAgentRecord`s: a typed round-trip would drop
//! unknown/future fields and rewrite every record. Only the one key is
//! touched, and only on keyed records — key-less definition rows come through
//! field-for-field identical. Not byte-identical: `serde_json` is built here
//! without `preserve_order`, so object keys come back sorted and whitespace
//! follows `to_vec_pretty`.

use std::path::Path;

/// Marker file whose presence means this migration already ran on this store.
/// Sited next to the RESOLVED store — see the module docs on shared dev stores.
const MARKER_FILE: &str = ".autostart-optout-done";

/// Create-if-absent pre-migration copy of `managed-agents.json`, `0o600`.
const BACKUP_FILE: &str = "managed-agents.json.pre-autostart-optout.bak";

/// Opt every stored agent out of launch auto-start, once.
///
/// Tauri wrapper around [`migrate_autostart_optout_in_dir`]; failures are
/// logged and never abort boot, matching the other boot migrations.
pub fn migrate_autostart_optout(app: &tauri::AppHandle) {
    let Ok(base_dir) = crate::managed_agents::managed_agents_base_dir(app) else {
        return;
    };
    match migrate_autostart_optout_in_dir(&base_dir) {
        Ok(0) => {}
        Ok(changed) => {
            eprintln!(
                "buzz-desktop: autostart-optout: {changed} agents opted out of launch auto-start"
            );
        }
        Err(e) => eprintln!("buzz-desktop: autostart-optout: {e}"),
    }
}

/// Core opt-out logic, decoupled from the Tauri `AppHandle` for testing.
///
/// Returns the number of records changed (`0` = nothing to do, or the marker
/// already fenced this store).
///
/// Contract:
/// - **Runs once.** Returns `Ok(0)` immediately when the marker exists, so an
///   agent the user re-enabled after the migration stays enabled.
/// - **Keyed records only.** A record with a non-empty `pubkey` gets an
///   explicit `"start_on_app_launch": false`. Key-less definition rows are
///   left untouched.
/// - **No pointless rewrite.** A record that already says `false` explicitly
///   is not counted and, if nothing else changed, the store file is not
///   rewritten at all.
/// - **Backup first.** The live write never happens unless the create-if-absent
///   `0o600` backup succeeded.
/// - **Permissions preserved.** The store is rewritten through
///   `atomic_write_json_restricted`, i.e. still `0o600`.
pub(super) fn migrate_autostart_optout_in_dir(base_dir: &Path) -> Result<usize, String> {
    let agents_path = base_dir.join("managed-agents.json");
    // Resolve through the symlink the same way the backup path does, so every
    // worktree sharing one canonical store shares one fence.
    let marker_path = crate::util::resolved_backup_path(&agents_path, MARKER_FILE);
    if marker_path.exists() {
        return Ok(0);
    }

    if !agents_path.exists() {
        // Fresh install: nothing to opt out, but the store must still be
        // fenced or the agents created before the next launch would be opted
        // out then.
        write_marker(&marker_path)?;
        return Ok(0);
    }

    let content = std::fs::read_to_string(&agents_path)
        .map_err(|e| format!("failed to read managed-agents.json: {e}"))?;
    let mut all: Vec<serde_json::Value> = serde_json::from_str(&content)
        .map_err(|e| format!("failed to parse managed-agents.json: {e}"))?;

    let mut changed = 0usize;
    for record in all.iter_mut() {
        let is_keyed = record
            .get("pubkey")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|pubkey| !pubkey.is_empty());
        if !is_keyed {
            continue;
        }
        // Already explicitly opted out: leave the bytes alone and do not count
        // it, so an all-`false` store reports 0 and skips the rewrite.
        if record.get("start_on_app_launch") == Some(&serde_json::Value::Bool(false)) {
            continue;
        }
        let Some(object) = record.as_object_mut() else {
            continue;
        };
        object.insert(
            "start_on_app_launch".to_string(),
            serde_json::Value::Bool(false),
        );
        changed += 1;
    }

    if changed > 0 {
        // Pre-migration backup, taken ONCE and never clobbered. Owner-only
        // from the initial open because `managed-agents.json` carries plaintext
        // agent nsecs when the keyring is unreachable — see
        // `create_restricted_backup_once` and `resolved_backup_path`.
        let bak_path = crate::util::resolved_backup_path(&agents_path, BACKUP_FILE);
        crate::util::create_restricted_backup_once(&bak_path, content.as_bytes())
            .map_err(|e| format!("failed to write pre-autostart-optout backup: {e}"))?;

        let payload = serde_json::to_vec_pretty(&all)
            .map_err(|e| format!("failed to serialize unified store: {e}"))?;
        crate::managed_agents::atomic_write_json_restricted(&agents_path, &payload)?;
    }

    // Fence LAST: a failure above leaves the marker absent so the next launch
    // retries, rather than recording a pass that never landed.
    write_marker(&marker_path)?;
    Ok(changed)
}

/// Write the run-once marker.
///
/// Content is a human-readable note, not a parsed format — only the file's
/// existence is load-bearing.
fn write_marker(path: &Path) -> Result<(), String> {
    std::fs::write(
        path,
        b"buzz-desktop: agents were opted out of launch auto-start once; \
          delete this file only to re-run that migration\n",
    )
    .map_err(|e| format!("failed to write {}: {e}", path.display()))
}

#[cfg(test)]
#[path = "autostart_optout_tests.rs"]
mod tests;
