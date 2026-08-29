use std::{
    fs,
    path::Path,
    sync::Arc,
    time::{Duration, SystemTime},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[cfg(unix)]
use super::artifacts::cleanup_crash_remnants_with_hook;

use super::{
    artifacts::{read_verified_artifact, ArtifactHandleStore},
    client::{OpsBridgeClient, OpsBridgeError},
    tests::{config, http_response, spawn_fake_server, write_token},
    types::{OpsArtifactHandleReadRequest, OpsArtifactReadRequest, OpsArtifactRepresentation},
};

const ARTIFACT_ID: &str = "artifact:0123456789abcdef0123456789abcdef";

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn manifest(bytes: &[u8]) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "contract_version": 1,
        "artifact_id": ARTIFACT_ID,
        "version": 1,
        "representation": "preview",
        "total_size": bytes.len(),
        "sha256": sha256(bytes),
        "mime": "text/plain",
        "visibility": "public_safe",
        "guest_readable": true,
        "provenance": {"classifier": "hub_guest_safe_v1"},
        "created_at": "2026-08-30T00:00:00.000Z"
    }))
    .unwrap()
}

fn chunk(bytes: &[u8], offset: usize, end: usize) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "contract_version": 1,
        "artifact_id": ARTIFACT_ID,
        "version": 1,
        "representation": "preview",
        "offset": offset,
        "next_offset": end,
        "total_size": bytes.len(),
        "sha256": sha256(bytes),
        "mime": "text/plain",
        "data_base64": STANDARD.encode(&bytes[offset..end]),
        "eof": end == bytes.len()
    }))
    .unwrap()
}

fn request() -> OpsArtifactReadRequest {
    OpsArtifactReadRequest {
        artifact_id: ARTIFACT_ID.to_owned(),
        version: 1,
        representation: OpsArtifactRepresentation::Preview,
    }
}

fn handle_root(parent: &Path) -> std::path::PathBuf {
    parent.join("app-cache")
}

#[test]
fn artifact_requests_are_exact_and_bounded() {
    let valid: OpsArtifactReadRequest = serde_json::from_value(json!({
        "artifact_id": ARTIFACT_ID,
        "version": 1,
        "representation": "preview"
    }))
    .unwrap();
    valid.validate().unwrap();

    for value in [
        json!({"artifact_id": "/tmp/report", "version": 1, "representation": "preview"}),
        json!({"artifact_id": ARTIFACT_ID, "version": 0, "representation": "preview"}),
        json!({"artifact_id": ARTIFACT_ID, "version": 1, "representation": "raw"}),
        json!({"artifact_id": ARTIFACT_ID, "version": 1, "representation": "preview", "path": "/tmp/report"}),
    ] {
        match serde_json::from_value::<OpsArtifactReadRequest>(value) {
            Ok(request) => assert_eq!(request.validate(), Err(OpsBridgeError::InvalidRequest)),
            Err(_) => {}
        }
    }

    for value in [
        json!({"handle": "/tmp/private", "offset": 0, "length": 1}),
        json!({"handle": "artifact-handle:01234567-89ab-4def-8123-456789abcdef", "offset": 0, "length": 0}),
        json!({"handle": "artifact-handle:01234567-89ab-4def-8123-456789abcdef", "offset": 0, "length": 262145}),
    ] {
        match serde_json::from_value::<OpsArtifactHandleReadRequest>(value) {
            Ok(request) => assert_eq!(request.validate(), Err(OpsBridgeError::InvalidRequest)),
            Err(_) => {}
        }
    }
}

#[tokio::test]
async fn artifact_client_uses_fixed_routes_and_exact_queries() {
    let bytes = b"immutable";
    let responses = vec![
        http_response("200 OK", "application/json", &manifest(bytes), &[]),
        http_response(
            "200 OK",
            "application/json",
            &chunk(bytes, 0, bytes.len()),
            &[],
        ),
    ];
    let (port, requests, server) = spawn_fake_server(responses).await;
    let temp = tempfile::tempdir().unwrap();
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
    let client = OpsBridgeClient::new(config(port, &token, 2 * 1024 * 1024)).unwrap();

    client.artifact_manifest(&request()).await.unwrap();
    client.artifact_chunk(&request(), 0, 786_432).await.unwrap();
    server.await.unwrap();
    let requests = requests.lock().unwrap();
    assert!(requests[0].starts_with(&format!(
        "GET /ops-bridge/v1/artifacts/{ARTIFACT_ID}/versions/1/preview/manifest HTTP/1.1"
    )));
    assert!(requests[1].starts_with(&format!(
        "GET /ops-bridge/v1/artifacts/{ARTIFACT_ID}/versions/1/preview/content?offset=0&length=786432 HTTP/1.1"
    )));
    assert!(requests
        .iter()
        .all(|wire| !wire.contains("/tmp/") && wire.contains("authorization: Bearer")));
}

#[tokio::test]
async fn artifact_client_preserves_only_exact_status_code_pairs() {
    let cases = [
        (
            "400 Bad Request",
            "invalid_artifact_request",
            OpsBridgeError::InvalidArtifactRequest,
        ),
        (
            "403 Forbidden",
            "artifact_read_denied",
            OpsBridgeError::ArtifactReadDenied,
        ),
        (
            "404 Not Found",
            "artifact_not_found",
            OpsBridgeError::ArtifactNotFound,
        ),
        (
            "404 Not Found",
            "artifact_version_not_found",
            OpsBridgeError::ArtifactVersionNotFound,
        ),
        (
            "409 Conflict",
            "artifact_integrity_mismatch",
            OpsBridgeError::ArtifactIntegrityMismatch,
        ),
        (
            "413 Payload Too Large",
            "artifact_too_large",
            OpsBridgeError::ArtifactTooLarge,
        ),
        (
            "415 Unsupported Media Type",
            "artifact_media_unsupported",
            OpsBridgeError::ArtifactMediaUnsupported,
        ),
    ];
    let mut responses = Vec::new();
    for (status, code, _) in &cases {
        responses.push(http_response(
            status,
            "application/json",
            json!({"error": code}).to_string().as_bytes(),
            &[],
        ));
    }
    responses.push(http_response(
        "400 Bad Request",
        "application/json",
        br#"{"error":"artifact_read_denied"}"#,
        &[],
    ));
    responses.push(http_response(
        "403 Forbidden",
        "application/json",
        br#"{"error":"artifact_read_denied","detail":"private"}"#,
        &[],
    ));
    let (port, _, server) = spawn_fake_server(responses).await;
    let temp = tempfile::tempdir().unwrap();
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
    let client = OpsBridgeClient::new(config(port, &token, 4096)).unwrap();
    for (_, _, expected) in cases {
        assert_eq!(
            client.artifact_manifest(&request()).await.unwrap_err(),
            expected
        );
    }
    assert_eq!(
        client.artifact_manifest(&request()).await.unwrap_err(),
        OpsBridgeError::HttpStatus
    );
    assert_eq!(
        client.artifact_manifest(&request()).await.unwrap_err(),
        OpsBridgeError::HttpStatus
    );
    server.await.unwrap();
}

#[tokio::test]
async fn invalid_artifact_input_performs_zero_http_requests() {
    let (port, requests, server) = spawn_fake_server(vec![]).await;
    let temp = tempfile::tempdir().unwrap();
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
    let client = OpsBridgeClient::new(config(port, &token, 4096)).unwrap();
    let invalid = OpsArtifactReadRequest {
        artifact_id: "/tmp/private".into(),
        version: 1,
        representation: OpsArtifactRepresentation::Preview,
    };
    assert_eq!(
        client.artifact_manifest(&invalid).await.unwrap_err(),
        OpsBridgeError::InvalidRequest
    );
    server.await.unwrap();
    assert!(requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn zero_byte_artifact_fetches_no_chunk_and_exact_one_mib_stays_inline() {
    let empty = b"";
    let (port, requests, server) = spawn_fake_server(vec![http_response(
        "200 OK",
        "application/json",
        &manifest(empty),
        &[],
    )])
    .await;
    let temp = tempfile::tempdir().unwrap();
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
    let client = Arc::new(OpsBridgeClient::new(config(port, &token, 4096)).unwrap());
    let store = Arc::new(ArtifactHandleStore::initialize(handle_root(temp.path())).unwrap());
    let result = read_verified_artifact(client, Arc::clone(&store), request())
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(result).unwrap()["text"], "");
    server.await.unwrap();
    assert_eq!(requests.lock().unwrap().len(), 1);

    let bytes = vec![b'x'; 1024 * 1024];
    let (port, _, server) = spawn_fake_server(vec![
        http_response("200 OK", "application/json", &manifest(&bytes), &[]),
        http_response(
            "200 OK",
            "application/json",
            &chunk(&bytes, 0, 786_432),
            &[],
        ),
        http_response(
            "200 OK",
            "application/json",
            &chunk(&bytes, 786_432, bytes.len()),
            &[],
        ),
    ])
    .await;
    let client = Arc::new(OpsBridgeClient::new(config(port, &token, 2 * 1024 * 1024)).unwrap());
    let result = read_verified_artifact(client, store, request())
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(result).unwrap()["kind"], "inline_text");
    server.await.unwrap();
}

#[tokio::test]
async fn artifact_verifier_rejects_unknown_keys_noncanonical_base64_and_zero_progress() {
    let bytes = b"abc";
    let mut extra_manifest: Value = serde_json::from_slice(&manifest(bytes)).unwrap();
    extra_manifest["storage_ref"] = json!("private");
    let mut bad_base64: Value = serde_json::from_slice(&chunk(bytes, 0, 3)).unwrap();
    bad_base64["data_base64"] = json!("YWJj=");
    let mut zero_progress: Value = serde_json::from_slice(&chunk(bytes, 0, 3)).unwrap();
    zero_progress["next_offset"] = json!(0);
    zero_progress["data_base64"] = json!("");
    zero_progress["eof"] = json!(false);
    for (manifest_body, chunk_body, expected) in [
        (
            serde_json::to_vec(&extra_manifest).unwrap(),
            None,
            OpsBridgeError::ResponseInvalidJson,
        ),
        (
            manifest(bytes),
            Some(serde_json::to_vec(&bad_base64).unwrap()),
            OpsBridgeError::ArtifactIntegrityMismatch,
        ),
        (
            manifest(bytes),
            Some(serde_json::to_vec(&zero_progress).unwrap()),
            OpsBridgeError::ArtifactIntegrityMismatch,
        ),
    ] {
        let mut responses = vec![http_response(
            "200 OK",
            "application/json",
            &manifest_body,
            &[],
        )];
        if let Some(body) = chunk_body {
            responses.push(http_response("200 OK", "application/json", &body, &[]));
        }
        let (port, _, server) = spawn_fake_server(responses).await;
        let temp = tempfile::tempdir().unwrap();
        let token = temp.path().join("hub.token");
        write_token(&token, &[b't'; 32], 0o600);
        let client = Arc::new(OpsBridgeClient::new(config(port, &token, 4096)).unwrap());
        let store = Arc::new(ArtifactHandleStore::initialize(handle_root(temp.path())).unwrap());
        assert_eq!(
            read_verified_artifact(client, store, request())
                .await
                .unwrap_err(),
            expected
        );
        server.await.unwrap();
    }
}

#[tokio::test]
async fn manifest_over_sixteen_mib_is_rejected_before_content_fetch() {
    let bytes = b"x";
    let mut too_large: Value = serde_json::from_slice(&manifest(bytes)).unwrap();
    too_large["total_size"] = json!(16 * 1024 * 1024 + 1);
    let (port, requests, server) = spawn_fake_server(vec![http_response(
        "200 OK",
        "application/json",
        &serde_json::to_vec(&too_large).unwrap(),
        &[],
    )])
    .await;
    let temp = tempfile::tempdir().unwrap();
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
    let client = Arc::new(OpsBridgeClient::new(config(port, &token, 4096)).unwrap());
    let store = Arc::new(ArtifactHandleStore::initialize(handle_root(temp.path())).unwrap());
    assert_eq!(
        read_verified_artifact(client, store, request())
            .await
            .unwrap_err(),
        OpsBridgeError::ArtifactTooLarge
    );
    server.await.unwrap();
    assert_eq!(requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn artifact_verifier_returns_exact_inline_utf8_and_handles_larger_text() {
    let inline = "한글 artifact".as_bytes();
    let (port, _, server) = spawn_fake_server(vec![
        http_response("200 OK", "application/json", &manifest(inline), &[]),
        http_response(
            "200 OK",
            "application/json",
            &chunk(inline, 0, inline.len()),
            &[],
        ),
    ])
    .await;
    let temp = tempfile::tempdir().unwrap();
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
    let client = Arc::new(OpsBridgeClient::new(config(port, &token, 2 * 1024 * 1024)).unwrap());
    let store = Arc::new(ArtifactHandleStore::initialize(handle_root(temp.path())).unwrap());
    let result = read_verified_artifact(client, Arc::clone(&store), request())
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(result).unwrap()["text"],
        "한글 artifact"
    );
    server.await.unwrap();

    let large = vec![b'x'; 1024 * 1024 + 1];
    let responses = vec![
        http_response("200 OK", "application/json", &manifest(&large), &[]),
        http_response(
            "200 OK",
            "application/json",
            &chunk(&large, 0, 786_432),
            &[],
        ),
        http_response(
            "200 OK",
            "application/json",
            &chunk(&large, 786_432, large.len()),
            &[],
        ),
    ];
    let (port, _, server) = spawn_fake_server(responses).await;
    let client = Arc::new(OpsBridgeClient::new(config(port, &token, 2 * 1024 * 1024)).unwrap());
    let result = read_verified_artifact(client, Arc::clone(&store), request())
        .await
        .unwrap();
    let wire = serde_json::to_value(result).unwrap();
    assert_eq!(wire["kind"], "opaque_handle");
    assert!(wire.get("path").is_none());
    assert!(wire["handle"]
        .as_str()
        .unwrap()
        .starts_with("artifact-handle:"));
    server.await.unwrap();
}

#[tokio::test]
async fn artifact_verifier_rejects_chunk_drift_and_digest_mismatch() {
    let bytes = b"immutable";
    let mut drift: Value = serde_json::from_slice(&chunk(bytes, 0, bytes.len())).unwrap();
    drift["artifact_id"] = json!("artifact:fedcba9876543210fedcba9876543210");
    let (port, _, server) = spawn_fake_server(vec![
        http_response("200 OK", "application/json", &manifest(bytes), &[]),
        http_response(
            "200 OK",
            "application/json",
            &serde_json::to_vec(&drift).unwrap(),
            &[],
        ),
    ])
    .await;
    let temp = tempfile::tempdir().unwrap();
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
    let client = Arc::new(OpsBridgeClient::new(config(port, &token, 4096)).unwrap());
    let store = Arc::new(ArtifactHandleStore::initialize(handle_root(temp.path())).unwrap());
    assert_eq!(
        read_verified_artifact(client, store, request())
            .await
            .unwrap_err(),
        OpsBridgeError::ArtifactIntegrityMismatch
    );
    server.await.unwrap();

    let mut bad_manifest: Value = serde_json::from_slice(&manifest(bytes)).unwrap();
    bad_manifest["sha256"] = json!("f".repeat(64));
    let (port, _, server) = spawn_fake_server(vec![
        http_response(
            "200 OK",
            "application/json",
            &serde_json::to_vec(&bad_manifest).unwrap(),
            &[],
        ),
        http_response(
            "200 OK",
            "application/json",
            &chunk(bytes, 0, bytes.len()),
            &[],
        ),
    ])
    .await;
    let client = Arc::new(OpsBridgeClient::new(config(port, &token, 4096)).unwrap());
    let store = Arc::new(ArtifactHandleStore::initialize(handle_root(temp.path())).unwrap());
    assert_eq!(
        read_verified_artifact(client, store, request())
            .await
            .unwrap_err(),
        OpsBridgeError::ArtifactIntegrityMismatch
    );
    server.await.unwrap();
}

#[test]
fn handle_store_enforces_permissions_chunks_release_and_expiry() {
    let temp = tempfile::tempdir().unwrap();
    let cache = handle_root(temp.path());
    let root = cache.join("ops-artifact-handles-v1");
    let store = ArtifactHandleStore::initialize(cache).unwrap();
    let now = SystemTime::now();
    let created = store.store_at(b"abcdef", "text/plain", now).unwrap();
    let handle = created.handle().to_owned();
    assert!(!serde_json::to_string(&created)
        .unwrap()
        .contains(root.to_string_lossy().as_ref()));
    let chunk = store
        .read_at(&handle, 1, 3, now + Duration::from_secs(1))
        .unwrap();
    assert_eq!(STANDARD.decode(chunk.data_base64()).unwrap(), b"bcd");
    assert!(!chunk.eof());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(root.join(".buzz-ops-artifact-handles-v1"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(store.handle_file_security(&handle), (0o600, true));
        assert_eq!(
            fs::read_dir(&root)
                .unwrap()
                .filter_map(Result::ok)
                .filter(
                    |entry| entry.path().extension().and_then(|value| value.to_str())
                        == Some("bin")
                )
                .count(),
            0
        );
    }
    assert!(store.release(&handle).unwrap());
    assert!(!store.release(&handle).unwrap());

    let expired = store.store_at(b"expired", "text/plain", now).unwrap();
    assert_eq!(
        store
            .read_at(expired.handle(), 0, 1, now + Duration::from_secs(901))
            .unwrap_err(),
        OpsBridgeError::InvalidArtifactRequest
    );
    assert_eq!(
        fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(
                |entry| entry.path().extension().and_then(|value| value.to_str()) == Some("bin")
            )
            .count(),
        0
    );
}

#[test]
fn handle_store_enforces_count_and_aggregate_quotas_atomically() {
    let temp = tempfile::tempdir().unwrap();
    let store = ArtifactHandleStore::initialize(handle_root(temp.path())).unwrap();
    let now = SystemTime::now();
    let one = vec![0_u8; 2 * 1024 * 1024];
    for _ in 0..32 {
        store.store_at(&one, "text/plain", now).unwrap();
    }
    assert_eq!(
        store.store_at(b"x", "text/plain", now).unwrap_err(),
        OpsBridgeError::ArtifactTooLarge
    );
    assert_eq!(store.live_handle_count(), 32);
    assert_eq!(store.live_bytes(), 64 * 1024 * 1024);

    let aggregate_temp = tempfile::tempdir().unwrap();
    let aggregate = ArtifactHandleStore::initialize(handle_root(aggregate_temp.path())).unwrap();
    let sixteen = vec![0_u8; 16 * 1024 * 1024];
    for _ in 0..4 {
        aggregate.store_at(&sixteen, "text/plain", now).unwrap();
    }
    assert_eq!(
        aggregate.store_at(b"x", "text/plain", now).unwrap_err(),
        OpsBridgeError::ArtifactTooLarge
    );
    assert_eq!(aggregate.live_handle_count(), 4);
    assert_eq!(aggregate.live_bytes(), 64 * 1024 * 1024);
}

#[tokio::test]
async fn same_artifact_writer_is_serialized_and_cancel_safe() {
    let temp = tempfile::tempdir().unwrap();
    let store = Arc::new(ArtifactHandleStore::initialize(handle_root(temp.path())).unwrap());
    let first = store.lock_writer(&request()).await;
    let blocked =
        tokio::time::timeout(Duration::from_millis(20), store.lock_writer(&request())).await;
    assert!(blocked.is_err());
    drop(first);
    tokio::time::timeout(Duration::from_secs(1), store.lock_writer(&request()))
        .await
        .unwrap();
    assert_eq!(store.live_handle_count(), 0);
    let in_flight = store.lock_writer(&request()).await;
    store.shutdown_cleanup().unwrap();
    drop(in_flight);
    assert_eq!(
        store
            .store_at(b"late", "text/plain", SystemTime::now())
            .unwrap_err(),
        OpsBridgeError::ArtifactHandleStore
    );
}

#[test]
fn handle_store_refuses_unmarked_symlinked_and_runtime_tampered_roots() {
    let temp = tempfile::tempdir().unwrap();
    let cache = handle_root(temp.path());
    fs::create_dir(&cache).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&cache, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let root = cache.join("ops-artifact-handles-v1");
    fs::create_dir(&root).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    }
    fs::write(root.join("foreign"), b"keep").unwrap();
    assert!(ArtifactHandleStore::initialize(cache.clone()).is_err());
    assert!(root.join("foreign").exists());
    fs::remove_dir_all(&root).unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(temp.path(), &root).unwrap();
        assert!(ArtifactHandleStore::initialize(cache.clone()).is_err());
        fs::remove_file(&root).unwrap();
    }
    let store = ArtifactHandleStore::initialize(cache).unwrap();
    fs::write(root.join(".buzz-ops-artifact-handles-v1"), b"tampered\n").unwrap();
    assert_eq!(
        store
            .store_at(b"x", "text/plain", SystemTime::now())
            .unwrap_err(),
        OpsBridgeError::ArtifactHandleStore
    );
    fs::write(
        root.join(".buzz-ops-artifact-handles-v1"),
        b"buzz-ops-artifact-handles-v1\n",
    )
    .unwrap();
    let moved = temp.path().join("moved-owned-root");
    fs::rename(&root, &moved).unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&moved, &root).unwrap();
        assert_eq!(
            store
                .store_at(b"x", "text/plain", SystemTime::now())
                .unwrap_err(),
            OpsBridgeError::ArtifactHandleStore
        );
        assert!(moved.join(".buzz-ops-artifact-handles-v1").exists());
    }
}

#[test]
fn handle_store_startup_and_shutdown_touch_only_owned_regular_entries() {
    let temp = tempfile::tempdir().unwrap();
    let cache = handle_root(temp.path());
    let root = cache.join("ops-artifact-handles-v1");
    let store = ArtifactHandleStore::initialize(cache.clone()).unwrap();
    let created = store
        .store_at(b"crash remnant", "text/plain", SystemTime::now())
        .unwrap();
    drop(store);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let remnant = root.join(".buzz-artifact-live-abcdefghijklmnop.tmp");
        fs::write(&remnant, b"interrupted before unlink").unwrap();
        fs::set_permissions(&remnant, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let restarted = ArtifactHandleStore::initialize(cache).unwrap();
    assert_eq!(restarted.live_handle_count(), 0);
    assert_eq!(
        fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(
                |entry| entry.path().extension().and_then(|value| value.to_str()) == Some("bin")
            )
            .count(),
        0
    );
    let _ = created;

    fs::write(root.join("foreign-file"), b"foreign").unwrap();
    assert_eq!(
        restarted.shutdown_cleanup().unwrap_err(),
        OpsBridgeError::ArtifactHandleStore
    );
    assert!(root.join("foreign-file").exists());
}

#[cfg(unix)]
#[test]
fn startup_cleanup_refuses_root_swap_before_anchored_delete() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let cache = handle_root(temp.path());
    drop(ArtifactHandleStore::initialize(cache.clone()).unwrap());
    let root = fs::canonicalize(cache)
        .unwrap()
        .join("ops-artifact-handles-v1");
    let remnant_name = ".buzz-artifact-live-abcdefghijklmnop.tmp";
    let remnant = root.join(remnant_name);
    fs::write(&remnant, b"owned crash remnant").unwrap();
    fs::set_permissions(&remnant, fs::Permissions::from_mode(0o600)).unwrap();

    let moved = temp.path().join("moved-owned-root");
    let result = cleanup_crash_remnants_with_hook(&root, || {
        fs::rename(&root, &moved).unwrap();
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let marker = root.join(".buzz-ops-artifact-handles-v1");
        fs::write(&marker, b"buzz-ops-artifact-handles-v1\n").unwrap();
        fs::set_permissions(&marker, fs::Permissions::from_mode(0o600)).unwrap();
        let replacement = root.join(remnant_name);
        fs::write(&replacement, b"replacement").unwrap();
        fs::set_permissions(&replacement, fs::Permissions::from_mode(0o600)).unwrap();
    });

    assert_eq!(result.unwrap_err(), OpsBridgeError::ArtifactHandleStore);
    assert!(moved.join(remnant_name).exists());
    assert!(root.join(remnant_name).exists());
}
