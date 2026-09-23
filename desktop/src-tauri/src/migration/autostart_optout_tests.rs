//! Tests for the one-time launch auto-start opt-out migration.
//!
//! Every row drives the production core `migrate_autostart_optout_in_dir`
//! against a real temp store, so a guard removed from that function fails
//! here rather than passing against a test-only shim.

use super::{migrate_autostart_optout_in_dir, BACKUP_FILE, MARKER_FILE};
use crate::managed_agents::ManagedAgentRecord;
use crate::migration::test_support::{read_agents_json, write_agents_json};
use std::path::{Path, PathBuf};

fn base(dir: &Path) -> PathBuf {
    dir.join("agents")
}

fn store(dir: &Path) -> PathBuf {
    base(dir).join("managed-agents.json")
}

/// The marker as production sites it: next to the RESOLVED store.
fn marker(dir: &Path) -> PathBuf {
    crate::util::resolved_backup_path(&store(dir), MARKER_FILE)
}

/// A keyed agent record. `autostart` is written as an explicit key when
/// `Some`, and omitted entirely when `None` (the pre-flip legacy shape that
/// used to inherit `true`).
fn agent_json(name: &str, pubkey: &str, autostart: Option<bool>) -> serde_json::Value {
    let mut record = serde_json::json!({
        "name": name,
        "pubkey": pubkey,
        "relay_url": "ws://localhost:3000",
        "acp_command": "buzz-acp",
        "agent_command": "goose",
        "agent_args": [],
        "mcp_command": "",
        "turn_timeout_seconds": 320,
        "parallelism": 4,
        "system_prompt": "P",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "last_started_at": null,
        "last_stopped_at": null,
        "last_exit_code": null,
        "last_error": null,
        // A field this migration has never heard of: it must survive the
        // Value-level rewrite untouched (a typed round-trip would drop it).
        "some_future_field": { "nested": [1, 2, 3] }
    });
    if let Some(value) = autostart {
        record["start_on_app_launch"] = serde_json::json!(value);
    }
    record
}

/// A key-less definition row: `pubkey` is empty, so it carries no runtime and
/// must not gain a `start_on_app_launch` key.
fn definition_json(slug: &str) -> serde_json::Value {
    serde_json::json!({
        "name": "Definition",
        "pubkey": "",
        "slug": slug,
        "relay_url": "ws://localhost:3000",
        "acp_command": "buzz-acp",
        "agent_command": "goose",
        "agent_args": [],
        "mcp_command": "",
        "turn_timeout_seconds": 320,
        "parallelism": 4,
        "system_prompt": "P",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "last_started_at": null,
        "last_stopped_at": null,
        "last_exit_code": null,
        "last_error": null
    })
}

fn autostart_of(record: &serde_json::Value) -> Option<bool> {
    record
        .get("start_on_app_launch")
        .and_then(serde_json::Value::as_bool)
}

fn find<'a>(records: &'a [serde_json::Value], name: &str) -> &'a serde_json::Value {
    records
        .iter()
        .find(|record| record.get("name").and_then(serde_json::Value::as_str) == Some(name))
        .expect("record present")
}

#[test]
fn keyed_records_become_explicit_false_and_definitions_are_untouched() {
    let dir = tempfile::tempdir().unwrap();
    write_agents_json(
        dir.path(),
        &serde_json::json!([
            agent_json("ExplicitTrue", &"a".repeat(64), Some(true)),
            agent_json("Absent", &"b".repeat(64), None),
            agent_json("ExplicitFalse", &"c".repeat(64), Some(false)),
            definition_json("some-definition"),
        ]),
    );

    let changed = migrate_autostart_optout_in_dir(&base(dir.path())).unwrap();
    assert_eq!(
        changed, 2,
        "only the explicit-true and the key-absent record change"
    );

    let records = read_agents_json(dir.path());
    assert_eq!(records.len(), 4, "no record added or removed");
    assert_eq!(autostart_of(find(&records, "ExplicitTrue")), Some(false));
    assert_eq!(
        autostart_of(find(&records, "Absent")),
        Some(false),
        "a key-less record gains an EXPLICIT false, not just the new serde default"
    );
    assert_eq!(autostart_of(find(&records, "ExplicitFalse")), Some(false));
    assert!(
        find(&records, "Definition")
            .get("start_on_app_launch")
            .is_none(),
        "a key-less definition row must not gain a runtime field"
    );

    // Unknown/future fields survive the Value-level rewrite.
    assert_eq!(
        find(&records, "ExplicitTrue").get("some_future_field"),
        Some(&serde_json::json!({ "nested": [1, 2, 3] }))
    );

    // And the store still parses as the real typed store.
    let typed: Vec<ManagedAgentRecord> =
        serde_json::from_str(&std::fs::read_to_string(store(dir.path())).unwrap()).unwrap();
    assert!(
        typed
            .iter()
            .filter(|record| !record.pubkey.is_empty())
            .all(|record| !record.start_on_app_launch),
        "no keyed record is left auto-starting"
    );
}

#[test]
fn second_run_is_a_no_op_and_does_not_rewrite_the_store() {
    let dir = tempfile::tempdir().unwrap();
    write_agents_json(
        dir.path(),
        &serde_json::json!([agent_json("Solo", &"e".repeat(64), Some(true))]),
    );

    assert_eq!(
        migrate_autostart_optout_in_dir(&base(dir.path())).unwrap(),
        1
    );
    let after_first = std::fs::read_to_string(store(dir.path())).unwrap();
    let mtime_first = std::fs::metadata(store(dir.path()))
        .unwrap()
        .modified()
        .unwrap();

    assert_eq!(
        migrate_autostart_optout_in_dir(&base(dir.path())).unwrap(),
        0,
        "second run changes nothing"
    );
    assert_eq!(
        std::fs::read_to_string(store(dir.path())).unwrap(),
        after_first,
        "store content untouched by the re-run"
    );
    assert_eq!(
        std::fs::metadata(store(dir.path()))
            .unwrap()
            .modified()
            .unwrap(),
        mtime_first,
        "store file was not rewritten at all on the re-run"
    );
}

#[test]
fn a_user_who_re_enables_autostart_is_not_undone_on_the_next_boot() {
    // The reason this migration is fenced by a marker instead of by the data's
    // shape: "autostart off" is a state the USER may leave. Deleting the
    // marker check turns this row RED.
    let dir = tempfile::tempdir().unwrap();
    let pubkey = "d".repeat(64);
    write_agents_json(
        dir.path(),
        &serde_json::json!([agent_json("Solo", &pubkey, Some(true))]),
    );
    assert_eq!(
        migrate_autostart_optout_in_dir(&base(dir.path())).unwrap(),
        1
    );

    // The user turns auto-start back on for this agent.
    let mut records = read_agents_json(dir.path());
    records[0]["start_on_app_launch"] = serde_json::json!(true);
    write_agents_json(dir.path(), &serde_json::Value::Array(records));

    assert_eq!(
        migrate_autostart_optout_in_dir(&base(dir.path())).unwrap(),
        0,
        "the next boot must not re-run the opt-out"
    );
    assert_eq!(
        autostart_of(&read_agents_json(dir.path())[0]),
        Some(true),
        "the user's re-enable survives the next boot"
    );
}

#[test]
fn a_store_that_does_not_exist_yet_is_still_fenced() {
    // A fresh install has no `managed-agents.json` at first boot. Without a
    // marker written on that pass, the agents the user creates afterwards
    // would be opted out at the NEXT launch.
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(base(dir.path())).unwrap();

    assert_eq!(
        migrate_autostart_optout_in_dir(&base(dir.path())).unwrap(),
        0
    );
    assert!(marker(dir.path()).exists());

    // The user now creates an auto-starting agent.
    write_agents_json(
        dir.path(),
        &serde_json::json!([agent_json("Fresh", &"f".repeat(64), Some(true))]),
    );
    assert_eq!(
        migrate_autostart_optout_in_dir(&base(dir.path())).unwrap(),
        0
    );
    assert_eq!(
        autostart_of(&read_agents_json(dir.path())[0]),
        Some(true),
        "an agent created after the fence must keep its own setting"
    );
}

#[test]
fn nothing_to_change_takes_no_backup_but_still_fences() {
    let dir = tempfile::tempdir().unwrap();
    write_agents_json(
        dir.path(),
        &serde_json::json!([
            agent_json("AlreadyOff", &"1".repeat(64), Some(false)),
            definition_json("def"),
        ]),
    );

    assert_eq!(
        migrate_autostart_optout_in_dir(&base(dir.path())).unwrap(),
        0
    );
    assert!(
        !base(dir.path()).join(BACKUP_FILE).exists(),
        "no work, no backup"
    );
    assert!(
        marker(dir.path()).exists(),
        "a no-op pass still fences the store"
    );
}

#[cfg(unix)]
#[test]
fn backup_is_created_once_owner_only_and_never_clobbered() {
    // `managed-agents.json` carries plaintext agent nsecs when the keyring is
    // unreachable, so its verbatim copy is owner-only from the initial open
    // rather than via a post-write chmod that would leave a umask window.
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let mut record = agent_json("Solo", &"e".repeat(64), Some(true));
    record["private_key_nsec"] = serde_json::json!("nsec1exampleplaintextkey");
    write_agents_json(dir.path(), &serde_json::json!([record]));
    let pristine = std::fs::read_to_string(store(dir.path())).unwrap();

    assert_eq!(
        migrate_autostart_optout_in_dir(&base(dir.path())).unwrap(),
        1
    );

    let bak = base(dir.path()).join(BACKUP_FILE);
    let mode = std::fs::metadata(&bak).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "backup of an inline nsec must be owner-only");
    assert_eq!(
        std::fs::read_to_string(&bak).unwrap(),
        pristine,
        "backup is the PRE-migration state"
    );
    assert!(
        pristine.contains("nsec1exampleplaintextkey"),
        "the fixture really did carry an inline key"
    );

    // Re-running after deleting the marker (the documented recovery path) must
    // not clobber the pristine backup with a half-migrated snapshot.
    std::fs::remove_file(marker(dir.path())).unwrap();
    assert_eq!(
        migrate_autostart_optout_in_dir(&base(dir.path())).unwrap(),
        0
    );
    assert_eq!(
        std::fs::read_to_string(&bak).unwrap(),
        pristine,
        "backup never clobbered"
    );
}

#[cfg(unix)]
#[test]
fn rewritten_store_stays_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    write_agents_json(
        dir.path(),
        &serde_json::json!([agent_json("Solo", &"e".repeat(64), Some(true))]),
    );

    assert_eq!(
        migrate_autostart_optout_in_dir(&base(dir.path())).unwrap(),
        1
    );

    let mode = std::fs::metadata(store(dir.path()))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600, "the store keeps its restricted mode");
}

#[cfg(unix)]
#[test]
fn a_worktree_symlinked_onto_a_shared_store_shares_one_fence() {
    // `sync_shared_agent_data` symlinks each dev worktree's
    // `agents/managed-agents.json` at one canonical shared file. A marker
    // resolved against the worktree path instead of the shared file would let
    // worktree B re-run the opt-out over the store worktree A already migrated
    // — undoing a re-enable the user made in between. Replacing
    // `resolved_backup_path` with `base_dir.join(MARKER_FILE)` turns this RED.
    let temp = tempfile::tempdir().unwrap();
    let shared = temp.path().join("shared");
    let worktree = temp.path().join("worktree");
    std::fs::create_dir_all(base(&shared)).unwrap();
    std::fs::create_dir_all(base(&worktree)).unwrap();
    write_agents_json(
        &shared,
        &serde_json::json!([agent_json("Solo", &"a".repeat(64), Some(true))]),
    );
    std::os::unix::fs::symlink(store(&shared), store(&worktree)).unwrap();

    // Worktree A migrates the shared store.
    assert_eq!(migrate_autostart_optout_in_dir(&base(&shared)).unwrap(), 1);
    // The user re-enables auto-start afterwards.
    let mut records = read_agents_json(&shared);
    records[0]["start_on_app_launch"] = serde_json::json!(true);
    write_agents_json(&shared, &serde_json::Value::Array(records));

    // Worktree B boots against the SAME store through its symlink.
    assert_eq!(
        migrate_autostart_optout_in_dir(&base(&worktree)).unwrap(),
        0,
        "the shared store is already fenced; the second worktree must not re-run"
    );
    assert_eq!(
        autostart_of(&read_agents_json(&shared)[0]),
        Some(true),
        "the user's re-enable survives a second worktree's boot"
    );
    assert!(
        !base(&worktree).join(MARKER_FILE).exists(),
        "the marker belongs next to the resolved store, not the symlink"
    );
}
