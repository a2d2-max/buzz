use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::json;
use tokio::{io::AsyncWriteExt, net::TcpListener};

use super::super::{client::OpsBridgeClient, types::OpsSyncAckRequest, watch::OpsBridgeWatcher};
use super::{config, http_response, read_request, spawn_fake_server, write_token};

fn truncated_stream_response(body: &[u8]) -> Vec<u8> {
    let mut bytes = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len() + 100
    )
    .into_bytes();
    bytes.extend_from_slice(body);
    bytes
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

#[tokio::test]
async fn ops_bridge_watcher_reconnects_after_post_header_sse_stall() {
    let recovered_event = b"id: 1\nevent: health\ndata: {}\n\n";
    let recovery_response = http_response("200 OK", "text/event-stream", recovered_event, &[]);
    let (port, requests, server) = spawn_stalled_sse_then_recovery_server(recovery_response).await;
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
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
    write_token(&token, &[b't'; 32], 0o600);
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
