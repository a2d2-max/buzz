//! Corrupt-keyring recovery edge cases split from `app_state_tests.rs`.

use super::*;

#[test]
fn corrupt_keyring_marker_present_no_file_is_lost() {
    // I2: Present(corrupt) + migration marker + no identity.key → the prior
    // identity was migrated into the keyring and is now unrecoverable (corrupt
    // AND no file backup). Must enter Lost recovery, NOT generate a fresh key.
    let dir = tempfile::tempdir().unwrap();
    let legacy_path = dir.path().join("identity.key");
    write_migration_marker(&migration_marker_path(dir.path())).unwrap();
    assert!(!legacy_path.exists());

    let store = FakeIdentityStore::present_with("not-a-valid-nsec");
    let resolved = resolve_identity_with_store(&store, &legacy_path, dir.path()).unwrap();

    // Must enter Lost recovery — a prior identity existed and is now unrecoverable.
    assert_eq!(
        resolved.recovery,
        RecoveryState::Lost,
        "corrupt keyring + marker + no file must return Lost recovery, not a fresh key"
    );

    // No identity.key written — the ephemeral key is in-memory only.
    assert!(!legacy_path.exists());
}

#[test]
fn corrupt_keyring_no_marker_no_file_generates_fresh() {
    // I2 (counter-case): Present(corrupt) + NO marker + no identity.key →
    // genuine first launch with a corrupt keyring, no prior identity to
    // protect. generate_and_persist is still the correct last resort.
    let dir = tempfile::tempdir().unwrap();
    let legacy_path = dir.path().join("identity.key");
    assert!(!legacy_path.exists());
    assert!(!migration_marker_path(dir.path()).exists());

    let store = FakeIdentityStore::present_with("not-a-valid-nsec");
    let resolved = resolve_identity_with_store(&store, &legacy_path, dir.path()).unwrap();

    // No lost recovery — this is a fresh machine with no prior identity.
    assert_eq!(
        resolved.recovery,
        RecoveryState::None,
        "corrupt keyring + no marker + no file must generate a fresh key (no prior identity)"
    );

    // A fresh, valid key was stored (keyring or file).
    assert!(
        store.slot.borrow().contains_key(IDENTITY_KEY_NAME) || legacy_path.exists(),
        "a fresh key must be stored in the keyring or the file after generate_and_persist"
    );
}
