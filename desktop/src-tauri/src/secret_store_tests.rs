use super::*;

// Test-only constructor: pre-seed the cache without touching the OS keychain.
impl SecretStore {
    fn with_cache(service: &str, cache: Option<HashMap<String, String>>) -> Self {
        SecretStore {
            service: service.to_string(),
            backend: SecretBackend::Keyring,
            cache: Mutex::new(cache),
        }
    }
}

#[cfg(debug_assertions)]
#[test]
fn debug_default_backend_uses_service_namespaced_file() {
    let dir = std::path::Path::new("/tmp/buzz-test-data");

    match select_backend(None, Some(dir), "buzz-desktop-dev.slug") {
        SecretBackend::File(path) => {
            assert_eq!(
                path,
                dir.join("secrets.buzz-desktop-dev.slug.json"),
                "debug secrets must avoid the rebuild-sensitive OS keychain",
            );
        }
        SecretBackend::Keyring => panic!("debug secrets unexpectedly selected the keychain"),
    }
}

#[test]
fn probe_returns_present_when_key_in_cache() {
    let mut map = HashMap::new();
    map.insert("identity".to_string(), "nsec1test".to_string());
    let store = SecretStore::with_cache("buzz-test-cache-hit", Some(map));
    // Cache is warm and contains "identity" — probe must return Present
    // without touching the keychain.
    assert_eq!(store.probe("identity"), KeyringProbe::Present);
}

#[test]
fn load_returns_value_when_key_in_cache() {
    let mut map = HashMap::new();
    map.insert("identity".to_string(), "nsec1test".to_string());
    let store = SecretStore::with_cache("buzz-test-load-cache-hit", Some(map));
    // Cache is warm and contains "identity" — load must return the value
    // without touching the keychain.
    assert_eq!(
        store.load("identity").unwrap(),
        Some("nsec1test".to_string())
    );
}

// ── Cross-process race tests (require real OS keychain) ────────────────

#[ignore = "requires real OS keychain (run locally)"]
#[test]
fn test_stale_warm_cache_add_observes_prior_write() {
    // Simulates the cross-process race that stranded Will's agent keys.
    //
    // Setup: two SecretStore instances for the same service (= two
    // "processes" with separate caches). Process A warms its cache to
    // {k1}. Process B then writes {k1, k2}. Without the fix, A's next
    // mutate_blob would build from its stale {k1} cache and write
    // {k1, k3}, silently dropping k2. With the fix, A always re-reads
    // from the keychain inside the lock, so the result is {k1, k2, k3}.
    let svc = "buzz-test-race-stale-cache";

    // Clean state.
    let setup = SecretStore::keyring(svc);
    let _ = setup.delete("k1");
    let _ = setup.delete("k2");
    let _ = setup.delete("k3");

    // Process A: write k1, warming its cache.
    let store_a = SecretStore::keyring(svc);
    store_a.store("k1", "v1").unwrap();

    // Process B: write k2 (separate instance = separate cache).
    let store_b = SecretStore::keyring(svc);
    store_b.store("k2", "v2").unwrap();

    // Process A: write k3. With the fix, A re-reads inside the lock and
    // sees {k1, k2} before appending k3 — result must be {k1, k2, k3}.
    store_a.store("k3", "v3").unwrap();

    // Verify via a third reader (clean cache).
    let reader = SecretStore::keyring(svc);
    assert_eq!(
        reader.load("k1").unwrap(),
        Some("v1".to_string()),
        "k1 must survive"
    );
    assert_eq!(
        reader.load("k2").unwrap(),
        Some("v2".to_string()),
        "k2 must not be dropped"
    );
    assert_eq!(
        reader.load("k3").unwrap(),
        Some("v3".to_string()),
        "k3 must be written"
    );

    // Cleanup.
    let _ = reader.delete("k1");
    let _ = reader.delete("k2");
    let _ = reader.delete("k3");
}

#[ignore = "requires real OS keychain (run locally)"]
#[test]
fn test_concurrent_adds_neither_key_dropped() {
    // Two sequential stores from distinct instances (simulating two
    // processes each adding one key) must both be durably visible.
    let svc = "buzz-test-race-concurrent-add";

    let setup = SecretStore::keyring(svc);
    let _ = setup.delete("agent_a");
    let _ = setup.delete("agent_b");

    let store1 = SecretStore::keyring(svc);
    store1.store("agent_a", "nsec1aaa").unwrap();

    let store2 = SecretStore::keyring(svc);
    store2.store("agent_b", "nsec1bbb").unwrap();

    let reader = SecretStore::keyring(svc);
    assert_eq!(
        reader.load("agent_a").unwrap(),
        Some("nsec1aaa".to_string()),
        "agent_a must not be dropped"
    );
    assert_eq!(
        reader.load("agent_b").unwrap(),
        Some("nsec1bbb".to_string()),
        "agent_b must not be dropped"
    );

    // Cleanup.
    let _ = reader.delete("agent_a");
    let _ = reader.delete("agent_b");
}

#[test]
fn test_blob_lockfile_path_is_in_tmp_with_uid() {
    // The lockfile must be at a deterministic per-user path under /tmp —
    // invariant to $TMPDIR — so both a GUI-launched DMG (env-stripped by
    // launchd) and a terminal-launched dev build resolve the same inode and
    // achieve mutual exclusion.
    let path = blob_lockfile_path("buzz-desktop");
    #[cfg(unix)]
    {
        let uid = unsafe { libc::getuid() };
        assert!(
            path.starts_with("/tmp"),
            "lockfile {path:?} must start with /tmp (not $TMPDIR)"
        );
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        assert!(
            name.contains(&uid.to_string()),
            "lockfile {path:?} must contain uid {uid}"
        );
        assert!(
            name.contains("buzz-keychain"),
            "lockfile name must contain 'buzz-keychain'"
        );
    }
    #[cfg(not(unix))]
    {
        assert!(
            path.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.contains("buzz-keychain")),
            "lockfile name must contain 'buzz-keychain'"
        );
    }
}

#[test]
fn test_blob_lock_acquire_and_release() {
    // Verify the advisory lock can be acquired and released without errors.
    // This exercises the real flock/mutex path on the current platform.
    let guard = acquire_blob_lock("buzz-test-lock-smoke");
    assert!(
        guard.is_ok(),
        "advisory lock acquire must succeed: {:?}",
        guard.err()
    );
    // Drop the guard — lock is released. A second acquire must succeed.
    drop(guard);
    let guard2 = acquire_blob_lock("buzz-test-lock-smoke");
    assert!(
        guard2.is_ok(),
        "advisory lock re-acquire after release must succeed: {:?}",
        guard2.err()
    );
}

#[ignore = "requires real OS keychain (run locally)"]
#[test]
fn mutate_blob_does_not_advance_cache_on_write_failure() {
    // Copy-on-write safety: if `write_blob_raw` fails (denied prompt,
    // transient outage, ACL rejection), the cache must stay at the last
    // known durable state. A subsequent `store()` for the same key/value
    // must NOT be skipped as a no-op — the equality check must compare
    // against the durable cache, not an unpersisted candidate.
    //
    // This is a real-keychain integration test. Run locally with:
    //   cargo test -p buzz-desktop -- --ignored mutate_blob_does_not_advance
    //
    // On a machine with a reachable keychain the `store()` call succeeds
    // (result.is_ok()) and the write-failure branch is skipped — the test
    // still passes. On a machine where the write is denied (e.g., user
    // clicks Deny in the macOS prompt) result.is_err() and the assertions
    // below verify the cache invariant. We verify that after an error:
    //   1. The cache is not advanced (the previously cached key is intact).
    //   2. The failed key is not present (the dirty candidate was discarded).
    let mut map = HashMap::new();
    map.insert("existing".to_string(), "durable_val".to_string());
    let store = SecretStore::with_cache("buzz-test-cow-write-fail", Some(map));

    // Attempt to add a new key — this calls write_blob_raw against the
    // real keychain; with copy-on-write the cache must remain at {existing}
    // if the write fails.
    let result = store.store("new_key", "new_val");

    if result.is_err() {
        // Write failed (e.g., user denied the keychain prompt): confirm
        // cache was not advanced — the existing key is still intact and
        // the new key was never committed to the in-memory state.
        assert_eq!(
            store.load("existing").unwrap(),
            Some("durable_val".to_string()),
            "cache must remain at last durable state after write failure"
        );
        // load("new_key") goes through the unchanged cache (no entry),
        // then attempts migrate_legacy_key which also fails on a denied
        // keychain, returning either Ok(None) or Err — either is correct
        // since the key was never durably stored.
        let after = store.load("new_key");
        assert!(
            matches!(after, Ok(None) | Err(_)),
            "a key whose write failed must not be visible via load: {after:?}"
        );
    }
    // If result.is_ok() the write succeeded — the cache-integrity invariant
    // does not apply to the success path; no assertion needed here.
}

#[test]
fn availability_error_discriminator() {
    assert!(is_keyring_availability_error("dbus connection failed"));
    assert!(is_keyring_availability_error(
        "org.freedesktop.secrets not provided"
    ));
    assert!(is_keyring_availability_error("No Secret Service"));
    assert!(is_keyring_availability_error(
        "Platform secure storage failure"
    ));
    // A plain "not found" is per-entry, not an availability failure.
    assert!(!is_keyring_availability_error("entry not found"));
}

#[cfg(target_os = "macos")]
#[test]
fn dpk_error_discriminators() {
    // errSecMissingEntitlement = -34018 signals unsigned dev build.
    let e = SFError::from_code(-34018);
    assert!(is_dpk_unavailable(&e));
    assert!(!is_not_found(&e));
    // errSecItemNotFound = -25300 is not a DPK-unavailable error.
    let e = SFError::from_code(-25300);
    assert!(is_not_found(&e));
    assert!(!is_dpk_unavailable(&e));
}

// Integration tests that exercise the real OS keychain. Skipped in CI
// (unsigned builds lack keychain entitlements); run locally with:
//   cargo test -p buzz-desktop -- --ignored blob_
//
// Each test uses a unique service name to avoid cross-test pollution.

#[ignore = "requires real OS keychain (run locally)"]
#[test]
fn blob_stores_and_retrieves_multiple_keys() {
    let store = SecretStore::keyring("buzz-test-blob-multi");
    store.store("key_a", "val_a").unwrap();
    store.store("key_b", "val_b").unwrap();
    assert_eq!(store.load("key_a").unwrap(), Some("val_a".to_string()));
    assert_eq!(store.load("key_b").unwrap(), Some("val_b".to_string()));
    assert_eq!(store.load("key_c").unwrap(), None);
    // Cleanup.
    let _ = store.delete("key_a");
    let _ = store.delete("key_b");
}

#[ignore = "requires real OS keychain (run locally)"]
#[test]
fn blob_probe_present_absent_unreachable() {
    let store = SecretStore::keyring("buzz-test-blob-probe");
    // No blob yet — key absent, backend reachable.
    assert_eq!(store.probe("identity"), KeyringProbe::ReachableButEmpty);
    store.store("identity", "nsec1test").unwrap();
    // Key now present.
    assert_eq!(store.probe("identity"), KeyringProbe::Present);
    // Different key — blob exists but key absent.
    assert_eq!(store.probe("other"), KeyringProbe::ReachableButEmpty);
    // Cleanup.
    let _ = store.delete("identity");
}

#[ignore = "requires real OS keychain (run locally)"]
#[test]
fn blob_delete_removes_key_not_others() {
    let store = SecretStore::keyring("buzz-test-blob-delete");
    store.store("keep", "keep_val").unwrap();
    store.store("remove", "remove_val").unwrap();
    store.delete("remove").unwrap();
    assert_eq!(store.load("keep").unwrap(), Some("keep_val".to_string()));
    assert_eq!(store.load("remove").unwrap(), None);
    // Cleanup.
    let _ = store.delete("keep");
}

#[ignore = "requires real OS keychain (run locally)"]
#[test]
fn blob_migration_from_per_key_entry() {
    let svc = "buzz-test-blob-migration";
    let key = "identity";
    let value = "nsec1migrationtest";

    // Seed a per-key entry (old format) — no blob exists.
    let entry = keyring_entry(svc, key).unwrap();
    entry.set_password(value).unwrap();

    // Fresh store — no blob in the keychain yet.
    let store = SecretStore::keyring(svc);

    // probe should find the legacy key.
    assert_eq!(store.probe(key), KeyringProbe::Present);

    // load should migrate it into the blob and return the value.
    assert_eq!(store.load(key).unwrap(), Some(value.to_string()));

    // Old per-key entry should be cleaned up.
    let entry = keyring_entry(svc, key).unwrap();
    assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));

    // Key is now in the blob — probe confirms.
    let store2 = SecretStore::keyring(svc);
    assert_eq!(store2.probe(key), KeyringProbe::Present);
    assert_eq!(store2.load(key).unwrap(), Some(value.to_string()));

    // Cleanup.
    let _ = store2.delete(key);
}

// ── Debug file backend (no OS keychain; CI-runnable) ───────────────────

#[cfg(debug_assertions)]
mod file_backend {
    use super::*;

    // Test-only constructor: file backend at an explicit path, bypassing
    // the process-global FILE_BACKEND_DIR.
    impl SecretStore {
        fn file_at(service: &str, path: std::path::PathBuf) -> Self {
            SecretStore {
                service: service.to_string(),
                backend: SecretBackend::File(path),
                cache: Mutex::new(None),
            }
        }
    }

    fn tmp_store(service: &str) -> (tempfile::TempDir, SecretStore) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(format!("secrets.{service}.json"));
        let store = SecretStore::file_at(service, path);
        (dir, store)
    }

    #[test]
    fn select_backend_env_escape_hatch_forces_keyring() {
        let dir = std::path::Path::new("/tmp/buzz-test-data");
        assert!(matches!(
            select_backend(Some("1"), Some(dir), "buzz-desktop-dev"),
            SecretBackend::Keyring
        ));
        // Any value other than "1" does not opt back into the keychain.
        assert!(matches!(
            select_backend(Some("0"), Some(dir), "buzz-desktop-dev"),
            SecretBackend::File(_)
        ));
    }

    #[test]
    fn select_backend_without_dir_falls_back_to_keyring() {
        assert!(matches!(
            select_backend(None, None, "buzz-desktop-dev"),
            SecretBackend::Keyring
        ));
    }

    #[test]
    fn is_file_backed_reflects_backend() {
        let (_dir, store) = tmp_store("buzz-test-file-backed");
        assert!(store.is_file_backed());
        assert!(!SecretStore::keyring("buzz-test-file-backed").is_file_backed());
    }

    #[test]
    fn file_roundtrip_store_load_delete() {
        let (_dir, store) = tmp_store("buzz-test-file-roundtrip");
        store.store("identity", "nsec1aaa").unwrap();
        store.store("agent:abc", "nsec1bbb").unwrap();
        assert_eq!(
            store.load("identity").unwrap(),
            Some("nsec1aaa".to_string())
        );
        assert_eq!(
            store.load("agent:abc").unwrap(),
            Some("nsec1bbb".to_string())
        );
        store.delete("agent:abc").unwrap();
        assert_eq!(store.load("agent:abc").unwrap(), None);
        assert_eq!(
            store.load("identity").unwrap(),
            Some("nsec1aaa".to_string())
        );
    }

    #[test]
    fn missing_key_probe_and_load_never_consult_legacy_keychain() {
        // A fresh (empty) file store must report reachable-but-empty and
        // Ok(None) without falling through to the legacy keychain
        // migration paths — file mode never touches the OS keychain.
        let (_dir, store) = tmp_store("buzz-test-file-no-legacy");
        assert_eq!(store.probe("identity"), KeyringProbe::ReachableButEmpty);
        assert_eq!(store.load("identity").unwrap(), None);
        // Same when a blob exists but the key is absent.
        store.store("other", "v").unwrap();
        assert_eq!(store.probe("identity"), KeyringProbe::ReachableButEmpty);
        assert_eq!(store.load("identity").unwrap(), None);
        assert_eq!(store.probe("other"), KeyringProbe::Present);
    }

    #[cfg(unix)]
    #[test]
    fn file_is_created_0o600() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, store) = tmp_store("buzz-test-file-perms");
        store.store("identity", "nsec1aaa").unwrap();
        let path = dir.path().join("secrets.buzz-test-file-perms.json");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "secrets file must be 0o600");
    }

    #[cfg(unix)]
    #[test]
    fn preexisting_world_readable_final_is_repaired_before_load() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, store) = tmp_store("buzz-test-file-repair-final");
        let path = dir.path().join("secrets.buzz-test-file-repair-final.json");
        std::fs::write(&path, br#"{"identity":"nsec1aaa"}"#).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        assert_eq!(
            store.load("identity").unwrap(),
            Some("nsec1aaa".to_string())
        );
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "an existing final secrets file must be repaired before parsing"
        );
    }

    #[cfg(unix)]
    #[test]
    fn preexisting_world_readable_tmp_cannot_become_world_readable_final() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, store) = tmp_store("buzz-test-file-repair-tmp");
        let final_path = dir.path().join("secrets.buzz-test-file-repair-tmp.json");
        let tmp_path = dir
            .path()
            .join("secrets.buzz-test-file-repair-tmp.json.tmp");
        std::fs::write(&tmp_path, b"stale").unwrap();
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o644)).unwrap();

        store.store("identity", "nsec1aaa").unwrap();

        assert!(
            !tmp_path.exists(),
            "successful rename must consume the temp file"
        );
        let mode = std::fs::metadata(&final_path).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "a pre-existing permissive temp file must not weaken the final file"
        );
    }

    #[test]
    fn write_is_atomic_leaves_no_tmp_residue() {
        let (dir, store) = tmp_store("buzz-test-file-atomic");
        store.store("identity", "nsec1aaa").unwrap();
        store.store("agent:abc", "nsec1bbb").unwrap();
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            vec!["secrets.buzz-test-file-atomic.json".to_string()],
            "only the final secrets file may remain: {names:?}"
        );
    }

    #[test]
    fn corrupt_file_fails_closed_and_is_preserved() {
        let (dir, store) = tmp_store("buzz-test-file-corrupt");
        let path = dir.path().join("secrets.buzz-test-file-corrupt.json");
        std::fs::write(&path, b"not json").unwrap();
        assert!(store.load("identity").is_err());
        assert_eq!(store.probe("identity"), KeyringProbe::Unreachable);
        // A store() must not clobber the corrupt file — the fresh read
        // inside mutate_blob fails first.
        assert!(store.store("identity", "nsec1aaa").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"not json");
    }

    #[test]
    fn two_stores_same_path_observe_each_others_writes() {
        // CI-runnable port of the cross-process stale-cache race test:
        // two instances (= two processes with separate caches) on one
        // file must never drop each other's keys.
        let dir = tempfile::tempdir().unwrap();
        let svc = "buzz-test-file-race";
        let path = dir.path().join(format!("secrets.{svc}.json"));
        let store_a = SecretStore::file_at(svc, path.clone());
        store_a.store("k1", "v1").unwrap(); // warms A's cache
        let store_b = SecretStore::file_at(svc, path.clone());
        store_b.store("k2", "v2").unwrap();
        store_a.store("k3", "v3").unwrap(); // must re-read, not drop k2
        let reader = SecretStore::file_at(svc, path);
        for (k, v) in [("k1", "v1"), ("k2", "v2"), ("k3", "v3")] {
            assert_eq!(
                reader.load(k).unwrap(),
                Some(v.to_string()),
                "{k} must survive"
            );
        }
    }

    #[test]
    fn delete_all_removes_file_and_verifies_wiped() {
        let (dir, store) = tmp_store("buzz-test-file-wipe");
        store.store("identity", "nsec1aaa").unwrap();
        assert!(!store.verify_fully_wiped());
        store.delete_all_with_legacy_cleanup().unwrap();
        let path = dir.path().join("secrets.buzz-test-file-wipe.json");
        assert!(!path.exists(), "secrets file must be deleted");
        assert!(store.verify_fully_wiped());
        // Idempotent on an already-absent file.
        store.delete_all_with_legacy_cleanup().unwrap();
        assert_eq!(store.load("identity").unwrap(), None);
    }
}

#[ignore = "requires real OS keychain (run locally)"]
#[test]
fn delete_all_with_legacy_cleanup_removes_per_key_identity() {
    let svc = "buzz-test-delete-all-legacy";
    let key = "identity";
    let value = "nsec1legacytest";

    // Seed a legacy per-key entry (old format, pre-blob migration).
    let entry = keyring_entry(svc, key).unwrap();
    entry.set_password(value).unwrap();

    // Also seed a blob with a different key to exercise the full path.
    let store = SecretStore::keyring(svc);
    store.store("agent:abc123", "nsec1agent").unwrap();

    // Legacy per-key identity should be discoverable via probe.
    let store2 = SecretStore::keyring(svc);
    assert_eq!(store2.probe(key), KeyringProbe::Present);

    // Wipe everything via the sign-out path.
    store2.delete_all_with_legacy_cleanup().unwrap();

    // Fresh store — neither the blob nor the per-key entry should remain.
    let store3 = SecretStore::keyring(svc);
    assert_eq!(
        store3.probe(key),
        KeyringProbe::ReachableButEmpty,
        "per-key identity must not survive delete_all_with_legacy_cleanup"
    );
    assert_eq!(
        store3.load(key).unwrap(),
        None,
        "load must not resurrect the legacy per-key identity"
    );
    // Agent key should also be gone.
    assert_eq!(store3.load("agent:abc123").unwrap(), None);
}
