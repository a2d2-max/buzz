use std::{
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Barrier, Mutex,
    },
    time::Duration,
};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

use super::{
    client::{read_hub_token, validate_hub_endpoint, OpsBridgeClient, OpsBridgeConfig},
    native_config, ops_bridge_create_draft, ops_bridge_stop_watch, ops_bridge_transition,
    types::{
        OpsBridgeSnapshot, OpsDraftRequest, OpsSelection, OpsSessionSource, OpsSyncAckRequest,
        OpsTransitionAction, OpsTransitionOrigin, OpsTransitionRequest, OPS_CONTRACT_VERSION,
    },
    watch::{OpsBridgeWatcher, ReconnectBackoff, WatchSyncState},
    OpsBridgeState,
};
use crate::app_state::{build_app_state, AppState};
use tauri::Manager;

static OPS_CONFIG_ENV_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn ops_bridge_discovers_the_installed_local_hub_without_manual_token_input() {
    let _guard = OPS_CONFIG_ENV_LOCK.lock().expect("lock ops config env");
    let temp = tempfile::tempdir().expect("temp launch agent root");
    let state_dir = temp.path().join("RAOU Ops Hub");
    std::fs::create_dir_all(&state_dir).expect("create fake hub state");
    let launch_agent = temp.path().join("kr.dlmarketing.unified-ops-hub.plist");
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>EnvironmentVariables</key><dict>
    <key>HUB_PORT</key><string>17331</string>
    <key>HUB_STATE_DIR</key><string>{}</string>
  </dict>
</dict></plist>"#,
        state_dir.display()
    );
    std::fs::write(&launch_agent, plist).expect("write fake launch agent");

    let variable_names = [
        "BUZZ_OPS_HUB_PORT",
        "BUZZ_OPS_HUB_TOKEN_FILE",
        "HUB_STATE_DIR",
        "BUZZ_OPS_HUB_LAUNCH_AGENT_FILE",
    ];
    let previous = variable_names.map(|name| (name, std::env::var_os(name)));
    for name in variable_names {
        std::env::remove_var(name);
    }
    std::env::set_var("BUZZ_OPS_HUB_LAUNCH_AGENT_FILE", &launch_agent);

    let config = native_config().expect("discover installed local hub");

    for (name, value) in previous {
        match value {
            Some(value) => std::env::set_var(name, value),
            None => std::env::remove_var(name),
        }
    }

    assert_eq!(config.port, 17_331);
    assert_eq!(config.token_file, state_dir.join("hub.token"));
}

pub(super) fn write_token(path: &Path, contents: &[u8], mode: u32) {
    std::fs::write(path, contents).expect("write fake token");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .expect("set fake token permissions");
    }
}

pub(super) fn config(port: u16, token_file: &Path, max_response_bytes: usize) -> OpsBridgeConfig {
    OpsBridgeConfig {
        port,
        token_file: token_file.to_path_buf(),
        max_response_bytes,
    }
}

pub(super) fn http_response(
    status: &str,
    content_type: &str,
    body: &[u8],
    extra: &[(&str, String)],
) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (name, value) in extra {
        response.push_str(name);
        response.push_str(": ");
        response.push_str(value);
        response.push_str("\r\n");
    }
    response.push_str("\r\n");
    let mut bytes = response.into_bytes();
    bytes.extend_from_slice(body);
    bytes
}

fn truncated_stream_response(body: &[u8]) -> Vec<u8> {
    let mut bytes = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len() + 100
    )
    .into_bytes();
    bytes.extend_from_slice(body);
    bytes
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut scratch = [0_u8; 4096];
    let mut header_end = None;
    let mut content_length = 0_usize;
    loop {
        let read = stream.read(&mut scratch).await.expect("read fake request");
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&scratch[..read]);
        assert!(bytes.len() <= 64 * 1024, "fake request exceeded test bound");
        if header_end.is_none() {
            header_end = bytes.windows(4).position(|window| window == b"\r\n\r\n");
            if let Some(position) = header_end {
                let headers = String::from_utf8_lossy(&bytes[..position]);
                content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
            }
        }
        if let Some(position) = header_end {
            if bytes.len() >= position + 4 + content_length {
                break;
            }
        }
    }
    String::from_utf8(bytes).expect("fake request is utf-8")
}

pub(super) async fn spawn_fake_server(
    responses: Vec<Vec<u8>>,
) -> (u16, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind fake loopback server");
    let port = listener.local_addr().expect("fake server address").port();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&requests);
    let task = tokio::spawn(async move {
        for response in responses {
            let (mut stream, _) = listener.accept().await.expect("accept fake request");
            let request = read_request(&mut stream).await;
            recorded.lock().expect("record fake request").push(request);
            stream
                .write_all(&response)
                .await
                .expect("write fake response");
        }
    });
    (port, requests, task)
}

async fn spawn_stalled_sse_then_recovery_server(
    recovery_response: Vec<u8>,
) -> (u16, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind stalled SSE server");
    let port = listener
        .local_addr()
        .expect("stalled SSE server address")
        .port();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&requests);
    let task = tokio::spawn(async move {
        let (mut stalled, _) = listener.accept().await.expect("accept stalled SSE request");
        let first = read_request(&mut stalled).await;
        recorded.lock().expect("record stalled request").push(first);
        stalled
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n",
            )
            .await
            .expect("write stalled SSE headers");
        stalled.flush().await.expect("flush stalled SSE headers");

        let (mut recovered, _) = listener
            .accept()
            .await
            .expect("accept recovery SSE request");
        let second = read_request(&mut recovered).await;
        recorded
            .lock()
            .expect("record recovery request")
            .push(second);
        recovered
            .write_all(&recovery_response)
            .await
            .expect("write recovery SSE response");
    });
    (port, requests, task)
}

fn request_body(request: &str) -> Value {
    let (_, body) = request
        .split_once("\r\n\r\n")
        .expect("fake request contains body separator");
    serde_json::from_str(body).expect("fake request body is json")
}

#[test]
fn ops_bridge_endpoint_accepts_only_fixed_http_loopback_with_nonzero_port() {
    assert!(validate_hub_endpoint("http://127.0.0.1:7331").is_ok());
    assert!(validate_hub_endpoint("http://localhost:7331").is_err());
    assert!(validate_hub_endpoint("https://127.0.0.1:7331").is_err());
    assert!(validate_hub_endpoint("http://127.0.0.1:0").is_err());
    assert!(validate_hub_endpoint("http://127.0.0.1").is_err());
    assert!(validate_hub_endpoint("http://user@127.0.0.1:7331").is_err());
    assert!(validate_hub_endpoint("http://127.0.0.1:7331/path").is_err());
}

#[test]
fn ops_bridge_token_file_fails_closed_on_permissions_symlink_and_empty_content() {
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &vec![b't'; 32], 0o600);
    assert!(read_hub_token(&token).is_ok());

    let world_readable = temp.path().join("world-readable.token");
    write_token(&world_readable, &vec![b't'; 32], 0o644);
    assert!(read_hub_token(&world_readable).is_err());

    let empty = temp.path().join("empty.token");
    write_token(&empty, b"\n", 0o600);
    assert!(read_hub_token(&empty).is_err());

    #[cfg(unix)]
    {
        let link = temp.path().join("linked.token");
        std::os::unix::fs::symlink(&token, &link).expect("create token symlink");
        assert!(read_hub_token(&link).is_err());
    }

    assert!(read_hub_token(Path::new("relative-hub.token")).is_err());
}

#[tokio::test]
async fn ops_bridge_client_accepts_a_bounded_version_one_json_response() {
    let body = serde_json::to_vec(&json!({
        "contract_version": OPS_CONTRACT_VERSION,
        "reads": ["snapshot", "events", "artifact"],
        "drafts": [],
        "transitions": [],
        "modules": [
            {"name": "timeline", "schema_version": 1, "paged": false},
            {"name": "future_module", "schema_version": 1, "paged": true, "collection_revision": 8}
        ],
        "private_extension": {"must_not_cross": true}
    }))
    .expect("serialize fake capabilities");
    let (port, requests, server) = spawn_fake_server(vec![http_response(
        "200 OK",
        "application/json",
        &body,
        &[],
    )])
    .await;
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &vec![b't'; 32], 0o600);

    let client = OpsBridgeClient::new(config(port, &token, 4096)).expect("strict client");
    let capabilities = client.capabilities().await.expect("version one response");
    assert_eq!(capabilities.contract_version, OPS_CONTRACT_VERSION);
    assert_eq!(capabilities.reads.len(), 3);
    assert!(capabilities.drafts.is_empty());
    assert!(capabilities.transitions.is_empty());
    let renderer_value = serde_json::to_value(&capabilities).expect("serialize capabilities");
    assert_eq!(renderer_value["modules"][0]["name"], "timeline");
    assert_eq!(renderer_value["modules"].as_array().map(Vec::len), Some(1));
    assert!(renderer_value.get("private_extension").is_none());
    server.await.expect("fake server exits");

    let requests = requests.lock().expect("read fake requests");
    assert_eq!(requests.len(), 1);
    let request = requests[0].to_ascii_lowercase();
    assert!(request.starts_with("get /ops-bridge/v1/capabilities http/1.1\r\n"));
    assert!(request.contains("\r\nauthorization: bearer "));
}

#[tokio::test]
async fn ops_bridge_snapshot_constructs_only_the_typed_query_fields() {
    let body = serde_json::to_vec(&json!({
        "contract_version": 1,
        "revision": 7,
        "event_sequence": "12",
        "generated_at": "2026-08-28T00:00:00.000Z",
        "health": {"hub": "ready", "orca": "ready", "codex": "ready"},
        "room": {},
        "session_tree": [{
            "id": "claude_code:public-session",
            "source": "claude_code",
            "parent_session_id": null,
            "work_item_id": null,
            "title": "Claude Code session",
            "activity": null,
            "health": "ready",
            "last_activity_at": null,
            "child_ids": []
        }],
        "checklist": [],
        "decisions": [],
        "timeline": [{"id": "event:one", "body": "renderer validates me"}],
        "approvals": [],
        "artifacts": [],
        "connections": [],
        "workflow_routing": {"default_provider": "codex"},
        "research": [{"id": "research:one", "title": "Local evidence"}],
        "repositories": [{"id": "repo:one", "status": "clean"}],
        "private_extension": {"must_not_cross": true}
    }))
    .expect("serialize fake snapshot");
    let (port, requests, server) = spawn_fake_server(vec![http_response(
        "200 OK",
        "application/json",
        &body,
        &[],
    )])
    .await;
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &vec![b't'; 32], 0o600);
    let client = OpsBridgeClient::new(config(port, &token, 4096)).expect("strict client");

    let snapshot = client
        .snapshot(&OpsSelection {
            channel: Some("ops / local".to_owned()),
            thread: Some("thread?one".to_owned()),
            limit: Some(25),
        })
        .await
        .expect("typed fake snapshot");
    assert_eq!(snapshot.revision, 7);
    assert_eq!(snapshot.event_sequence.as_deref(), Some("12"));
    assert!(matches!(
        snapshot.session_tree[0].source,
        OpsSessionSource::ClaudeCode
    ));
    let renderer_value = serde_json::to_value(&snapshot).expect("serialize snapshot");
    assert_eq!(renderer_value["timeline"][0]["id"], "event:one");
    assert!(renderer_value["workflow_routing"].is_null());
    assert_eq!(
        renderer_value["repositories"],
        serde_json::json!([{"contract_invalid":true}])
    );
    assert!(renderer_value.get("private_extension").is_none());
    server.await.expect("snapshot fake server exits");

    let requests = requests.lock().expect("read snapshot request");
    let target = requests[0]
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .expect("snapshot request target");
    let parsed = url::Url::parse(&format!("http://127.0.0.1:{port}{target}"))
        .expect("parse snapshot target");
    assert_eq!(parsed.path(), "/ops-bridge/v1/snapshot");
    assert_eq!(
        parsed.query_pairs().collect::<Vec<_>>(),
        vec![
            ("channel".into(), "ops / local".into()),
            ("thread".into(), "thread?one".into()),
            ("limit".into(), "25".into()),
        ]
    );
}

#[tokio::test]
async fn ops_bridge_client_rejects_redirect_without_following_it() {
    let destination = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind redirect destination");
    let destination_port = destination
        .local_addr()
        .expect("redirect destination address")
        .port();
    let location = format!("http://127.0.0.1:{destination_port}/captured");
    let (port, _, server) = spawn_fake_server(vec![http_response(
        "302 Found",
        "text/plain",
        b"redirect",
        &[("Location", location)],
    )])
    .await;
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &vec![b't'; 32], 0o600);
    let client = OpsBridgeClient::new(config(port, &token, 4096)).expect("strict client");

    assert!(client.capabilities().await.is_err());
    server.await.expect("redirect server exits");
    assert!(
        tokio::time::timeout(Duration::from_millis(300), destination.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn ops_bridge_client_rejects_contract_drift_oversize_and_non_json() {
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &vec![b't'; 32], 0o600);

    let version_two = serde_json::to_vec(&json!({
        "contract_version": 2,
        "reads": ["snapshot", "events", "artifact"],
        "drafts": ["message", "internal_task", "provider_action"],
        "transitions": ["submit", "approve", "risk_confirm", "deliver", "reject"]
    }))
    .expect("serialize version drift");
    let oversized = serde_json::to_vec(&json!({
        "contract_version": 1,
        "reads": ["snapshot", "events", "artifact"],
        "drafts": ["message", "internal_task", "provider_action"],
        "transitions": ["submit", "approve", "risk_confirm", "deliver", "reject"],
        "padding": "x".repeat(256)
    }))
    .expect("serialize oversized response");
    let responses = vec![
        http_response("200 OK", "application/json", &version_two, &[]),
        http_response("200 OK", "application/json", &oversized, &[]),
        http_response("200 OK", "text/plain", b"not json", &[]),
    ];
    let (port, _, server) = spawn_fake_server(responses).await;

    let strict = OpsBridgeClient::new(config(port, &token, 4096)).expect("strict client");
    assert!(strict.capabilities().await.is_err());
    let tiny = OpsBridgeClient::new(config(port, &token, 128)).expect("tiny client");
    assert!(tiny.capabilities().await.is_err());
    assert!(strict.capabilities().await.is_err());
    server.await.expect("invalid response server exits");
}

#[tokio::test]
async fn ops_bridge_mutations_use_only_fixed_draft_and_transition_routes() {
    let receipt = serde_json::to_vec(&json!({
        "contract_version": 1,
        "approval": {"id": "apr_1", "revision": 3, "status": "pending_approval"}
    }))
    .expect("serialize fake receipt");
    let responses = vec![
        http_response("200 OK", "application/json", &receipt, &[]),
        http_response("200 OK", "application/json", &receipt, &[]),
    ];
    let (port, requests, server) = spawn_fake_server(responses).await;
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &vec![b't'; 32], 0o600);
    let client = OpsBridgeClient::new(config(port, &token, 4096)).expect("strict client");

    let draft = OpsDraftRequest::Message {
        work_item_id: "work_1".to_owned(),
        target_session_id: "sess_1".to_owned(),
        text: "review this locally".to_owned(),
    };
    client.create_draft(&draft).await.expect("local fake draft");
    let transition = OpsTransitionRequest {
        approval_id: "apr_1".to_owned(),
        action: OpsTransitionAction::Approve,
        expected_revision: 3,
        origin: OpsTransitionOrigin::VisualControl,
        targets: None,
    };
    client
        .transition(&transition)
        .await
        .expect("local fake transition");
    server.await.expect("mutation fake server exits");

    let requests = requests.lock().expect("read mutation requests");
    assert_eq!(requests.len(), 2);
    assert!(requests[0].starts_with("POST /ops-bridge/v1/drafts HTTP/1.1\r\n"));
    assert!(requests[1].starts_with("POST /ops-bridge/v1/approvals/apr_1/transition HTTP/1.1\r\n"));
    for request in requests.iter() {
        let lower = request.to_ascii_lowercase();
        assert!(lower.contains("\r\nauthorization: bearer "));
        assert!(lower.contains("\r\nidempotency-key: "));
    }
    assert!(requests[1]
        .to_ascii_lowercase()
        .contains("\r\nif-match: 3\r\n"));
    assert_eq!(
        request_body(&requests[0]),
        json!({
            "kind": "message",
            "work_item_id": "work_1",
            "target_session_id": "sess_1",
            "text": "review this locally"
        })
    );
    assert_eq!(
        request_body(&requests[1]),
        json!({
            "action": "approve",
            "expected_revision": 3,
            "origin": "visual_control"
        })
    );
    let actual_external_sends = requests
        .iter()
        .filter(|request| {
            let first_line = request.lines().next().unwrap_or_default();
            first_line.contains("/deliver")
                || first_line.contains("/execute")
                || first_line.contains("/terminal")
        })
        .count();
    assert_eq!(actual_external_sends, 0);
}

fn command_app(
    client: Result<Arc<OpsBridgeClient>, super::client::OpsBridgeError>,
    lost: bool,
    locked: bool,
) -> tauri::App<tauri::test::MockRuntime> {
    let state = build_app_state();
    state.identity_lost.store(lost, Ordering::Release);
    state.keyring_locked.store(locked, Ordering::Release);
    tauri::test::mock_builder()
        .manage(state)
        .manage(OpsBridgeState {
            client,
            watcher: OpsBridgeWatcher::default(),
        })
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app builds")
}

fn draft_request() -> OpsDraftRequest {
    OpsDraftRequest::Message {
        work_item_id: "work_1".to_owned(),
        target_session_id: "sess_1".to_owned(),
        text: "local draft".to_owned(),
    }
}

fn transition_request() -> OpsTransitionRequest {
    OpsTransitionRequest {
        approval_id: "apr_1".to_owned(),
        action: OpsTransitionAction::Approve,
        expected_revision: 3,
        origin: OpsTransitionOrigin::VisualControl,
        targets: None,
    }
}

fn deliver_request() -> OpsTransitionRequest {
    OpsTransitionRequest {
        approval_id: "apr_1".to_owned(),
        action: OpsTransitionAction::Deliver,
        expected_revision: 3,
        origin: OpsTransitionOrigin::VisualControl,
        targets: None,
    }
}

#[tokio::test]
async fn ops_bridge_delivery_is_disabled_before_identity_and_client_access() {
    for (lost, locked) in [(true, false), (false, true), (false, false)] {
        let app = command_app(
            Err(super::client::OpsBridgeError::InvalidConfig),
            lost,
            locked,
        );
        let error = ops_bridge_transition(
            deliver_request(),
            app.state::<OpsBridgeState>(),
            app.state::<AppState>(),
        )
        .await
        .expect_err("deliver is disabled before identity and client lookup");

        assert_eq!(error, "ops_bridge_external_action_disabled");
    }
}

#[tokio::test]
async fn ops_bridge_client_disables_delivery_before_token_access() {
    let temp = tempfile::tempdir().expect("temp token directory");
    let missing_token = temp.path().join("missing.token");
    let client = OpsBridgeClient::new(config(7331, &missing_token, 4096)).expect("strict client");

    let error = client
        .transition(&deliver_request())
        .await
        .expect_err("deliver is disabled before token lookup");

    assert_eq!(error, super::client::OpsBridgeError::ExternalActionDisabled);
}

#[tokio::test]
async fn ops_bridge_client_disables_delivery_before_http_accept() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind fake delivery listener");
    let port = listener.local_addr().expect("fake listener address").port();
    let accepts = Arc::new(AtomicUsize::new(0));
    let recorded_accepts = Arc::clone(&accepts);
    let server = tokio::spawn(async move {
        if let Ok(Ok((mut stream, _))) =
            tokio::time::timeout(Duration::from_millis(300), listener.accept()).await
        {
            recorded_accepts.fetch_add(1, Ordering::AcqRel);
            let _ = read_request(&mut stream).await;
            let receipt = serde_json::to_vec(&json!({
                "contract_version": 1,
                "approval": {"id": "apr_1", "revision": 3, "status": "delivered"}
            }))
            .expect("serialize fake delivery receipt");
            stream
                .write_all(&http_response("200 OK", "application/json", &receipt, &[]))
                .await
                .expect("write fake delivery response");
        }
    });
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
    let client = OpsBridgeClient::new(config(port, &token, 4096)).expect("strict client");

    let error = client
        .transition(&deliver_request())
        .await
        .expect_err("deliver is disabled before HTTP");
    server.await.expect("fake delivery listener exits");

    assert_eq!(error, super::client::OpsBridgeError::ExternalActionDisabled);
    assert_eq!(accepts.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn ops_bridge_mutations_reject_lost_and_locked_identity_before_client_access() {
    for (lost, locked) in [(true, false), (false, true)] {
        let app = command_app(
            Err(super::client::OpsBridgeError::InvalidConfig),
            lost,
            locked,
        );
        let draft_error = ops_bridge_create_draft(
            draft_request(),
            app.state::<OpsBridgeState>(),
            app.state::<AppState>(),
        )
        .await
        .expect_err("recovery must reject Ops draft");
        let transition_error = ops_bridge_transition(
            transition_request(),
            app.state::<OpsBridgeState>(),
            app.state::<AppState>(),
        )
        .await
        .expect_err("recovery must reject Ops transition");

        assert!(draft_error.contains("recovery mode"));
        assert!(transition_error.contains("recovery mode"));
    }
}

#[tokio::test]
async fn ops_bridge_mutation_allows_normal_identity() {
    let receipt = serde_json::to_vec(&json!({
        "contract_version": 1,
        "approval": {"id": "apr_1", "revision": 3, "status": "pending_approval"}
    }))
    .expect("serialize fake receipt");
    let (port, _, server) = spawn_fake_server(vec![http_response(
        "200 OK",
        "application/json",
        &receipt,
        &[],
    )])
    .await;
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
    let client = OpsBridgeClient::new(config(port, &token, 4096)).expect("strict client");
    let app = command_app(Ok(Arc::new(client)), false, false);

    let result = ops_bridge_create_draft(
        draft_request(),
        app.state::<OpsBridgeState>(),
        app.state::<AppState>(),
    )
    .await;

    assert!(result.is_ok());
    server.await.expect("fake server exits");
}

#[test]
fn ops_bridge_backoff_is_bounded_at_five_seconds() {
    let mut backoff = ReconnectBackoff::default();
    assert_eq!(backoff.next_delay(), Duration::from_millis(250));
    assert_eq!(backoff.next_delay(), Duration::from_millis(500));
    assert_eq!(backoff.next_delay(), Duration::from_secs(1));
    assert_eq!(backoff.next_delay(), Duration::from_secs(2));
    assert_eq!(backoff.next_delay(), Duration::from_secs(5));
    assert_eq!(backoff.next_delay(), Duration::from_secs(5));
}

#[test]
fn ops_bridge_sync_suspends_initial_and_reconnect_events_until_matching_ack() {
    let mut sync = WatchSyncState::default();
    let initial = sync.begin_connection();
    assert_eq!(initial.connection_generation, 1);
    assert!(initial.sync_required);
    assert_eq!(initial.reason.as_deref(), Some("initial"));
    assert!(sync.observe("1", "health").expect("queue event").is_empty());

    let (ack, drained) = sync.ack(1, "0").expect("ack initial sync");
    assert!(ack.accepted);
    assert_eq!(drained.len(), 1);
    assert_eq!(drained[0].event_id.as_deref(), Some("1"));
    assert_eq!(sync.last_event_id().as_deref(), Some("1"));

    let reconnect = sync.begin_connection();
    assert_eq!(reconnect.connection_generation, 2);
    assert_eq!(reconnect.reason.as_deref(), Some("reconnect"));
    assert!(sync
        .observe("2", "approval")
        .expect("queue event")
        .is_empty());
    let (stale, stale_events) = sync.ack(1, "2").expect("reject stale ack safely");
    assert!(!stale.accepted);
    assert!(stale_events.is_empty());
    assert_eq!(sync.last_event_id().as_deref(), Some("1"));

    let (ack, drained) = sync.ack(2, "1").expect("ack reconnect sync");
    assert!(ack.accepted);
    assert_eq!(drained[0].event_id.as_deref(), Some("2"));
}

#[test]
fn ops_bridge_sync_ignores_duplicates_and_forces_refetch_on_forward_gap() {
    let mut sync = WatchSyncState::default();
    let generation = sync.begin_connection().connection_generation;
    sync.ack(generation, "10").expect("seed canonical anchor");

    assert!(sync
        .observe("10", "health")
        .expect("ignore duplicate")
        .is_empty());
    assert!(sync
        .observe("9", "health")
        .expect("ignore old event")
        .is_empty());
    let live = sync.observe("11", "health").expect("emit contiguous event");
    assert_eq!(live[0].event_id.as_deref(), Some("11"));

    let gap = sync.observe("13", "approval").expect("convert gap to sync");
    assert_eq!(gap.len(), 1);
    assert!(gap[0].sync_required);
    assert_eq!(gap[0].reason.as_deref(), Some("gap"));
    assert!(gap[0].connection_generation > generation);
    assert_eq!(sync.last_event_id().as_deref(), Some("11"));
}

#[test]
fn ops_bridge_sync_control_resets_stale_100_and_keeps_event_12() {
    let mut sync = WatchSyncState::default();
    let initial = sync.begin_connection().connection_generation;
    sync.ack(initial, "100").expect("seed stale anchor");

    let reconnect = sync.begin_connection();
    assert_eq!(reconnect.anchor_sequence.as_deref(), Some("100"));
    let control = sync
        .observe("11", "snapshot.required")
        .expect("accept targeted reset control");
    assert_eq!(
        control[0].connection_generation,
        reconnect.connection_generation
    );
    assert_eq!(control[0].anchor_sequence.as_deref(), Some("11"));
    assert_eq!(control[0].reason.as_deref(), Some("control"));
    assert!(sync
        .observe("12", "health")
        .expect("queue post-reset event")
        .is_empty());

    let (_, drained) = sync
        .ack(reconnect.connection_generation, "11")
        .expect("ack refetched watermark");
    assert_eq!(drained.len(), 1);
    assert_eq!(drained[0].event_id.as_deref(), Some("12"));
    assert_eq!(sync.last_event_id().as_deref(), Some("12"));
}

#[test]
fn ops_bridge_sync_queue_is_bounded_and_reset_invalidates_old_generation() {
    let mut sync = WatchSyncState::default();
    let generation = sync.begin_connection().connection_generation;
    for sequence in 1..=256 {
        assert!(sync
            .observe(&sequence.to_string(), "health")
            .expect("bounded queued event")
            .is_empty());
    }
    let overflow = sync.observe("257", "health").expect("overflow enters sync");
    assert_eq!(overflow.len(), 1);
    assert_eq!(overflow[0].reason.as_deref(), Some("queue_overflow"));
    assert!(overflow[0].connection_generation > generation);

    let overflow_generation = overflow[0].connection_generation;
    sync.reset();
    let (stale, _) = sync
        .ack(overflow_generation, "257")
        .expect("stopped community rejects old ack immediately");
    assert!(!stale.accepted);
    let after_reset = sync.begin_connection();
    assert!(after_reset.connection_generation > overflow_generation);
}

#[tokio::test]
async fn ops_bridge_stop_watch_command_is_idempotent() {
    let app = command_app(
        Err(super::client::OpsBridgeError::InvalidConfig),
        false,
        false,
    );
    ops_bridge_stop_watch(app.state::<OpsBridgeState>())
        .await
        .expect("first stop");
    ops_bridge_stop_watch(app.state::<OpsBridgeState>())
        .await
        .expect("idempotent second stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ops_bridge_stop_waits_for_active_task_quiescence_before_reset() {
    let response = http_response(
        "200 OK",
        "text/event-stream",
        b"id: 1\nevent: health\ndata: {}\n\n",
        &[],
    );
    let (port, _requests, server) = spawn_fake_server(vec![response]).await;
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &vec![b't'; 32], 0o600);
    let client = Arc::new(OpsBridgeClient::new(config(port, &token, 4096)).expect("strict client"));
    let watcher = Arc::new(OpsBridgeWatcher::default());
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let emissions = Arc::new(AtomicUsize::new(0));
    let emitter_entered = Arc::clone(&entered);
    let emitter_release = Arc::clone(&release);
    let captured = Arc::clone(&emissions);

    assert!(watcher
        .start_with_emitter(
            client,
            Arc::new(move |_| {
                captured.fetch_add(1, Ordering::SeqCst);
                emitter_entered.wait();
                emitter_release.wait();
            }),
        )
        .await
        .expect("start active watcher"));
    tokio::task::spawn_blocking(move || entered.wait())
        .await
        .expect("observe active emitter");

    let stopping_watcher = Arc::clone(&watcher);
    let stopping = tokio::spawn(async move { stopping_watcher.stop_async().await });
    tokio::time::sleep(Duration::from_millis(25)).await;
    assert!(!stopping.is_finished(), "stop must await the active task");

    tokio::task::spawn_blocking(move || release.wait())
        .await
        .expect("release active emitter");
    stopping
        .await
        .expect("join stop task")
        .expect("stop active watcher");
    let stopped_status = watcher.sync_status().expect("read stopped state");
    let stopped_emissions = emissions.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        watcher.sync_status().expect("read quiescent state"),
        stopped_status
    );
    assert_eq!(emissions.load(Ordering::SeqCst), stopped_emissions);
    server.await.expect("fake server exits");
}

#[test]
fn ops_bridge_sync_rejects_malformed_and_overflowing_decimal_ids() {
    let mut sync = WatchSyncState::default();
    sync.begin_connection();
    for invalid in ["", "01", "+1", "1.0", "18446744073709551616"] {
        assert!(sync.observe(invalid, "health").is_err());
    }
}

#[test]
fn ops_bridge_snapshot_watermark_is_optional_but_strict_decimal_when_present() {
    let base = json!({
        "contract_version": 1,
        "revision": 1,
        "generated_at": "2026-08-30T00:00:00.000Z",
        "health": {"hub": "ready", "orca": "ready", "codex": "ready"},
        "room": {},
        "session_tree": [],
        "checklist": [],
        "decisions": []
    });
    assert!(serde_json::from_value::<OpsBridgeSnapshot>(base.clone()).is_ok());

    let mut valid = base.clone();
    valid["event_sequence"] = json!("12");
    assert_eq!(
        serde_json::from_value::<OpsBridgeSnapshot>(valid)
            .expect("strict decimal watermark")
            .event_sequence
            .as_deref(),
        Some("12")
    );

    for invalid in [json!(null), json!(12), json!(""), json!("01"), json!("+1")] {
        let mut snapshot = base.clone();
        snapshot["event_sequence"] = invalid;
        assert!(serde_json::from_value::<OpsBridgeSnapshot>(snapshot).is_err());
    }
}

#[tokio::test]
async fn ops_bridge_watcher_reconnects_after_post_header_sse_stall() {
    let recovered_event = b"id: 1\nevent: health\ndata: {}\n\n";
    let recovery_response = http_response("200 OK", "text/event-stream", recovered_event, &[]);
    let (port, requests, server) = spawn_stalled_sse_then_recovery_server(recovery_response).await;
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &vec![b't'; 32], 0o600);
    let client = Arc::new(OpsBridgeClient::new(config(port, &token, 4096)).expect("strict client"));
    let watcher = OpsBridgeWatcher::default();
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&events);

    assert!(watcher
        .start_with_emitter(
            client,
            Arc::new(move |event| {
                captured.lock().expect("record recovery event").push(event);
            })
        )
        .await
        .expect("start stalled watcher"));

    tokio::time::timeout(Duration::from_secs(7), async {
        loop {
            if requests.lock().expect("read stalled requests").len() >= 2
                && !events.lock().expect("read recovery events").is_empty()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("stalled SSE watcher must reconnect after the read timeout and backoff");
    let ack_events = Arc::clone(&events);
    let ack = watcher
        .ack_sync_with_emitter(
            &OpsSyncAckRequest {
                generation: 2,
                applied_sequence: "0".to_owned(),
            },
            Arc::new(move |event| {
                ack_events
                    .lock()
                    .expect("record drained recovery event")
                    .push(event);
            }),
        )
        .await
        .expect("ack recovered connection");
    assert!(ack.accepted);
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if events
                .lock()
                .expect("read acknowledged events")
                .iter()
                .any(|event| event.event_id.as_deref() == Some("1"))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("acknowledged recovery event is emitted");
    watcher.stop_async().await.expect("stop stalled watcher");
    server.await.expect("stalled SSE fake server exits");

    assert_eq!(
        requests.lock().expect("read final stalled requests").len(),
        2
    );
    assert_eq!(
        serde_json::to_value(
            events
                .lock()
                .expect("read final recovery events")
                .iter()
                .find(|event| event.event_id.as_deref() == Some("1"))
                .expect("recovery invalidation"),
        )
        .expect("serialize recovery invalidation"),
        json!({"event_id": "1", "event_type": "health", "connection_generation": 2})
    );
}

#[tokio::test]
async fn ops_bridge_watcher_reconnect_before_ack_forces_sync_and_emits_no_sse_data() {
    let first = b"id: 41\nevent: approval\ndata: {\"private\":\"ignored\"}\n\n";
    let second = b"id: 42\nevent: snapshot.required\ndata: {\"reason\":\"too_old\"}\n\n";
    let responses = vec![
        truncated_stream_response(first),
        http_response("200 OK", "text/event-stream", second, &[]),
    ];
    let (port, requests, server) = spawn_fake_server(responses).await;
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &vec![b't'; 32], 0o600);
    let client = Arc::new(OpsBridgeClient::new(config(port, &token, 4096)).expect("strict client"));
    let watcher = OpsBridgeWatcher::default();
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&events);

    assert!(watcher
        .start_with_emitter(
            client.clone(),
            Arc::new(move |event| {
                captured.lock().expect("record invalidation").push(event);
            })
        )
        .await
        .expect("start watcher"));
    assert!(!watcher
        .start_with_emitter(client, Arc::new(|_| {}))
        .await
        .expect("second watcher call is idempotent"));

    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if events.lock().expect("read invalidations").len() >= 3 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("watcher delivered reconnect and control synchronization events");
    let ack_events = Arc::clone(&events);
    let ack = watcher
        .ack_sync_with_emitter(
            &OpsSyncAckRequest {
                generation: 2,
                applied_sequence: "42".to_owned(),
            },
            Arc::new(move |event| {
                ack_events
                    .lock()
                    .expect("record drained control event")
                    .push(event);
            }),
        )
        .await
        .expect("ack targeted control refetch");
    assert!(ack.accepted);
    watcher.stop_async().await.expect("stop watcher");
    server.await.expect("watch fake server exits");

    let events = events.lock().expect("read final invalidations");
    assert_eq!(events.len(), 3);
    assert_eq!(
        serde_json::to_value(&events[0]).expect("serialize first invalidation"),
        json!({
            "connection_generation": 1,
            "sync_required": true,
            "full_reload": true,
            "reason": "initial"
        })
    );
    assert_eq!(
        serde_json::to_value(&events[1]).expect("serialize reload invalidation"),
        json!({
            "connection_generation": 2,
            "sync_required": true,
            "full_reload": true,
            "reason": "reconnect"
        })
    );
    assert_eq!(
        serde_json::to_value(&events[2]).expect("serialize control invalidation"),
        json!({
            "connection_generation": 2,
            "sync_required": true,
            "anchor_sequence": "42",
            "full_reload": true,
            "reason": "control"
        })
    );
    assert!(serde_json::to_string(&*events)
        .expect("serialize sanitized events")
        .find("private")
        .is_none());
    drop(events);

    let requests = requests.lock().expect("read watch requests");
    assert_eq!(requests.len(), 2);
    assert!(!requests[0].to_ascii_lowercase().contains("last-event-id:"));
    assert!(!requests[1].to_ascii_lowercase().contains("last-event-id:"));
    assert_eq!(
        requests
            .iter()
            .filter(|request| {
                let expected = ["GET /ops-bridge/v1/", "events HTTP/1.1\r\n"].concat();
                !request.starts_with(&expected)
            })
            .count(),
        0
    );
}
