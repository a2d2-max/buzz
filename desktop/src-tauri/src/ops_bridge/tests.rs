use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

use super::{
    client::{read_hub_token, validate_hub_endpoint, OpsBridgeClient, OpsBridgeConfig},
    types::{
        OpsDraftRequest, OpsSelection, OpsTransitionAction, OpsTransitionOrigin,
        OpsTransitionRequest, OPS_CONTRACT_VERSION,
    },
    watch::{OpsBridgeWatcher, ReconnectBackoff},
};

fn write_token(path: &Path, contents: &[u8], mode: u32) {
    std::fs::write(path, contents).expect("write fake token");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .expect("set fake token permissions");
    }
}

fn config(port: u16, token_file: &Path, max_response_bytes: usize) -> OpsBridgeConfig {
    OpsBridgeConfig {
        port,
        token_file: token_file.to_path_buf(),
        max_response_bytes,
    }
}

fn http_response(
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

async fn spawn_fake_server(
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
        "drafts": ["message", "internal_task", "provider_action"],
        "transitions": ["submit", "approve", "risk_confirm", "deliver", "reject"]
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
        "generated_at": "2026-08-28T00:00:00.000Z",
        "health": {"hub": "ready", "orca": "ready", "codex": "ready"},
        "room": {},
        "session_tree": [],
        "checklist": [],
        "decisions": []
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

#[tokio::test]
async fn ops_bridge_watcher_is_singleton_replays_last_id_and_emits_no_sse_data() {
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
        .expect("start watcher"));
    assert!(!watcher
        .start_with_emitter(client, Arc::new(|_| {}))
        .expect("second watcher call is idempotent"));

    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if events.lock().expect("read invalidations").len() >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("watcher delivered two invalidations");
    watcher.stop();
    server.await.expect("watch fake server exits");

    let events = events.lock().expect("read final invalidations");
    assert_eq!(events.len(), 2);
    assert_eq!(
        serde_json::to_value(&events[0]).expect("serialize first invalidation"),
        json!({"event_id": "41", "event_type": "approval"})
    );
    assert_eq!(
        serde_json::to_value(&events[1]).expect("serialize reload invalidation"),
        json!({"event_id": "42", "event_type": "snapshot.required", "full_reload": true})
    );
    drop(events);

    let requests = requests.lock().expect("read watch requests");
    assert_eq!(requests.len(), 2);
    assert!(!requests[0].to_ascii_lowercase().contains("last-event-id:"));
    assert!(requests[1]
        .to_ascii_lowercase()
        .contains("\r\nlast-event-id: 41\r\n"));
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
