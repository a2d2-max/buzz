use serde_json::json;

use super::{
    client::{OpsBridgeClient, OpsBridgeError},
    page_error,
    tests::{config, http_response, spawn_fake_server, write_token},
    types::OpsPageRequest,
};

#[tokio::test]
async fn ops_bridge_capabilities_require_collection_revision_for_paged_modules() {
    let missing = serde_json::to_vec(&json!({
        "contract_version": 1,
        "reads": ["snapshot", "events", "artifact"],
        "drafts": [],
        "transitions": [],
        "modules": [{"name": "timeline", "schema_version": 1, "paged": true}]
    }))
    .expect("serialize capabilities without collection revision");
    let unsafe_revision = serde_json::to_vec(&json!({
        "contract_version": 1,
        "reads": ["snapshot", "events", "artifact"],
        "drafts": [],
        "transitions": [],
        "modules": [{
            "name": "timeline",
            "schema_version": 1,
            "paged": true,
            "collection_revision": 9_007_199_254_740_992_u64
        }]
    }))
    .expect("serialize capabilities with unsafe collection revision");
    let additive_unpaged = serde_json::to_vec(&json!({
        "contract_version": 1,
        "reads": ["snapshot", "events", "artifact"],
        "drafts": [],
        "transitions": [],
        "modules": [{
            "name": "timeline",
            "schema_version": 1,
            "paged": false,
            "collection_revision": 8
        }]
    }))
    .expect("serialize additive unpaged collection revision");
    let (port, _, server) = spawn_fake_server(vec![
        http_response("200 OK", "application/json", &missing, &[]),
        http_response("200 OK", "application/json", &unsafe_revision, &[]),
        http_response("200 OK", "application/json", &additive_unpaged, &[]),
    ])
    .await;
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
    let client = OpsBridgeClient::new(config(port, &token, 4096)).expect("strict client");

    for reason in ["paged revision required", "JS-safe revision required"] {
        let isolated = client.capabilities().await.expect(reason);
        assert_eq!(
            serde_json::to_value(isolated).expect("serialize isolated capability")["modules"][0],
            json!({"name":"timeline"})
        );
    }
    assert_eq!(
        serde_json::to_value(
            client
                .capabilities()
                .await
                .expect("known malformed record reaches Zod")
        )
        .expect("serialize capabilities")["modules"][0]
            .clone(),
        json!({"name":"timeline"})
    );
    server.await.expect("fake server exits");
}

#[tokio::test]
async fn ops_bridge_capabilities_preserve_malformed_known_records_for_zod_isolation() {
    let malformed_known = serde_json::to_vec(&json!({
        "contract_version": 1,
        "reads": ["snapshot", "events", "artifact"],
        "drafts": [],
        "transitions": [],
        "modules": [{
            "name": "connections",
            "schema_version": 1,
            "paged": false,
            "collection_revision": 8,
            "private_path": "/Users/private/repo",
            "access_token": "ghp_abcdefghijk"
        }]
    }))
    .expect("serialize malformed known capability");
    let malformed_unknown = serde_json::to_vec(&json!({
        "contract_version": 1,
        "reads": ["snapshot", "events", "artifact"],
        "drafts": [],
        "transitions": [],
        "modules": [{
            "name": "future_unknown_module",
            "schema_version": 1,
            "paged": false,
            "collection_revision": 8
        }]
    }))
    .expect("serialize malformed unknown capability");
    let task5_known = serde_json::to_vec(&json!({
        "contract_version": 1,
        "reads": ["snapshot", "events", "artifact"],
        "drafts": [],
        "transitions": [],
        "modules": [
            {"name": "safety_policy", "schema_version": 1, "paged": false},
            {"name": "teams_activity", "schema_version": 1, "paged": true, "collection_revision": 9}
        ]
    }))
    .expect("serialize Task 5 known capabilities");
    let (port, _, server) = spawn_fake_server(vec![
        http_response("200 OK", "application/json", &malformed_known, &[]),
        http_response("200 OK", "application/json", &malformed_unknown, &[]),
        http_response("200 OK", "application/json", &task5_known, &[]),
    ])
    .await;
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
    let client = OpsBridgeClient::new(config(port, &token, 4096)).expect("strict client");

    let isolated = client
        .capabilities()
        .await
        .expect("known malformed record reaches Zod");
    assert_eq!(
        serde_json::to_value(isolated).expect("serialize isolated capabilities")["modules"][0],
        json!({"name": "connections"})
    );
    assert_eq!(
        client
            .capabilities()
            .await
            .expect_err("unknown malformed record is globally invalid"),
        OpsBridgeError::ContractMismatch
    );
    let known = client
        .capabilities()
        .await
        .expect("Task 5 known records survive native filtering");
    assert_eq!(
        serde_json::to_value(known).expect("serialize known capabilities")["modules"],
        json!([
            {"name": "safety_policy", "schema_version": 1, "paged": false},
            {"name": "teams_activity", "schema_version": 1, "paged": true, "collection_revision": 9}
        ])
    );
    server.await.expect("fake server exits");
}

#[test]
fn ops_bridge_page_request_is_a_closed_exact_contract() {
    let valid = [
        json!({
            "module": "work_items",
            "scope": {"sort": "last_activity_at_desc"},
            "page_size": 100,
            "cursor": null
        }),
        json!({
            "module": "checklist_items",
            "scope": {"work_item": "work:one", "sort": "order_asc_then_id"},
            "page_size": 100,
            "cursor": null
        }),
        json!({
            "module": "search",
            "scope": {"q": "Café", "kind": "audit", "work": "work:one", "sort": "rank_desc_then_observed_at_desc"},
            "page_size": 100,
            "cursor": null
        }),
        json!({
            "module": "timeline",
            "scope": {"channel": null, "thread": null, "sort": "occurred_at_desc"},
            "page_size": 100,
            "cursor": null
        }),
        json!({
            "module": "artifacts",
            "scope": {"work_item": null, "representation": "preview", "sort": "created_at_desc"},
            "page_size": 200,
            "cursor": "opaque"
        }),
        json!({
            "module": "research",
            "scope": {"sort": "created_at_desc"},
            "page_size": 1,
            "cursor": null
        }),
        json!({
            "module": "repositories",
            "scope": {"project": null, "sort": "display_name_asc"},
            "page_size": 25,
            "cursor": null
        }),
    ];
    for value in valid {
        let request: OpsPageRequest = serde_json::from_value(value).expect("valid page request");
        request.validate().expect("bounded page request");
    }

    for value in [
        json!({
            "module": "timeline",
            "scope": {"channel": null, "thread": null, "sort": "oldest"},
            "page_size": 100,
            "cursor": null
        }),
        json!({
            "module": "timeline",
            "scope": {"channel": null, "thread": null, "sort": "occurred_at_desc", "extra": true},
            "page_size": 100,
            "cursor": null
        }),
        json!({
            "module": "approvals",
            "scope": {},
            "page_size": 100,
            "cursor": null
        }),
        json!({
            "module": "research",
            "scope": {"sort": "created_at_desc"},
            "page_size": 100,
            "cursor": null,
            "path": "/private"
        }),
        json!({
            "module": "timeline",
            "scope": {"thread": null, "sort": "occurred_at_desc"},
            "page_size": 100,
            "cursor": null
        }),
        json!({
            "module": "repositories",
            "scope": {"project": null, "sort": "display_name_asc"},
            "page_size": 100
        }),
    ] {
        assert!(serde_json::from_value::<OpsPageRequest>(value).is_err());
    }

    for value in [
        json!({
            "module": "research",
            "scope": {"sort": "created_at_desc"},
            "page_size": 0,
            "cursor": null
        }),
        json!({
            "module": "repositories",
            "scope": {"project": "\n", "sort": "display_name_asc"},
            "page_size": 201,
            "cursor": null
        }),
        json!({
            "module": "artifacts",
            "scope": {"work_item": null, "representation": null, "sort": "created_at_desc"},
            "page_size": 100,
            "cursor": ""
        }),
    ] {
        let request: OpsPageRequest = serde_json::from_value(value).expect("wire shape is exact");
        assert_eq!(request.validate(), Err(OpsBridgeError::InvalidRequest));
    }
}

#[test]
fn ops_bridge_page_command_emits_only_bounded_typed_errors() {
    assert_eq!(
        serde_json::to_value(page_error(OpsBridgeError::InvalidCursor)).unwrap(),
        json!({"error": "invalid_cursor"})
    );
    assert_eq!(
        serde_json::to_value(page_error(OpsBridgeError::StaleCursor)).unwrap(),
        json!({"error": "stale_cursor"})
    );
    assert_eq!(
        serde_json::to_value(page_error(OpsBridgeError::Transport)).unwrap(),
        json!("ops_bridge_disconnected")
    );
    for error in [
        OpsBridgeError::ResponseContentType,
        OpsBridgeError::ResponseTooLarge,
        OpsBridgeError::ResponseInvalidJson,
        OpsBridgeError::ContractMismatch,
    ] {
        assert_eq!(
            serde_json::to_value(page_error(error)).unwrap(),
            json!({"error": "contract_invalid"})
        );
    }
}

#[tokio::test]
async fn ops_bridge_pages_use_only_fixed_module_routes_and_exact_queries() {
    let page = serde_json::to_vec(&json!({
        "contract_version": 1,
        "revision": 8,
        "generated_at": "2026-08-30T00:00:00.000Z",
        "items": [],
        "next_cursor": null
    }))
    .expect("serialize page");
    let responses = (0..4)
        .map(|_| http_response("200 OK", "application/json", &page, &[]))
        .collect();
    let (port, requests, server) = spawn_fake_server(responses).await;
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
    let client = OpsBridgeClient::new(config(port, &token, 4096)).expect("strict client");

    let request_values = [
        json!({
            "module": "timeline",
            "scope": {"channel": "all", "thread": null, "sort": "occurred_at_desc"},
            "page_size": 100,
            "cursor": "cursor-one"
        }),
        json!({
            "module": "artifacts",
            "scope": {"work_item": "work-one", "representation": "rendered", "sort": "created_at_desc"},
            "page_size": 25,
            "cursor": null
        }),
        json!({
            "module": "research",
            "scope": {"sort": "created_at_desc"},
            "page_size": 50,
            "cursor": null
        }),
        json!({
            "module": "repositories",
            "scope": {"project": "buzz", "sort": "display_name_asc"},
            "page_size": 10,
            "cursor": null
        }),
    ];
    for value in request_values {
        let request = serde_json::from_value(value).expect("typed page request");
        client.page(&request).await.expect("fixed page request");
    }
    server.await.expect("page server exits");

    let requests = requests.lock().expect("read page requests");
    let expected = [
        (
            "/ops-bridge/v1/timeline",
            vec![
                ("channel", "all"),
                ("sort", "occurred_at_desc"),
                ("page_size", "100"),
                ("cursor", "cursor-one"),
            ],
        ),
        (
            "/ops-bridge/v1/artifacts",
            vec![
                ("work_item", "work-one"),
                ("representation", "rendered"),
                ("sort", "created_at_desc"),
                ("page_size", "25"),
            ],
        ),
        (
            "/ops-bridge/v1/research",
            vec![("sort", "created_at_desc"), ("page_size", "50")],
        ),
        (
            "/ops-bridge/v1/repositories",
            vec![
                ("project", "buzz"),
                ("sort", "display_name_asc"),
                ("page_size", "10"),
            ],
        ),
    ];
    for (request, (path, query)) in requests.iter().zip(expected) {
        let target = request
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap();
        let parsed = url::Url::parse(&format!("http://127.0.0.1:{port}{target}"))
            .expect("parse page target");
        assert_eq!(parsed.path(), path);
        assert_eq!(
            parsed.query_pairs().collect::<Vec<_>>(),
            query
                .into_iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect::<Vec<_>>()
        );
    }
}

#[tokio::test]
async fn ops_bridge_page_maps_only_exact_cursor_errors_and_rejects_contract_drift() {
    let invalid_cursor = serde_json::to_vec(&json!({"error": "invalid_cursor"})).unwrap();
    let stale_cursor = serde_json::to_vec(&json!({"error": "stale_cursor"})).unwrap();
    let mismatched = serde_json::to_vec(&json!({"error": "stale_cursor", "extra": true})).unwrap();
    let drift = serde_json::to_vec(&json!({
        "contract_version": 1,
        "revision": 8,
        "generated_at": "2026-08-30T00:00:00.000Z",
        "items": [],
        "next_cursor": null,
        "extra": true
    }))
    .unwrap();
    let unsafe_revision = serde_json::to_vec(&json!({
        "contract_version": 1,
        "revision": 9_007_199_254_740_992_u64,
        "generated_at": "2026-08-30T00:00:00.000Z",
        "items": [],
        "next_cursor": null
    }))
    .unwrap();
    let (port, _, server) = spawn_fake_server(vec![
        http_response("400 Bad Request", "application/json", &invalid_cursor, &[]),
        http_response("409 Conflict", "application/json", &stale_cursor, &[]),
        http_response("409 Conflict", "application/json", &mismatched, &[]),
        http_response("200 OK", "application/json", &drift, &[]),
        http_response("200 OK", "application/json", &unsafe_revision, &[]),
    ])
    .await;
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
    let client = OpsBridgeClient::new(config(port, &token, 4096)).expect("strict client");
    let request: OpsPageRequest = serde_json::from_value(json!({
        "module": "timeline",
        "scope": {"channel": null, "thread": null, "sort": "occurred_at_desc"},
        "page_size": 100,
        "cursor": null
    }))
    .unwrap();

    assert_eq!(
        client.page(&request).await.unwrap_err(),
        OpsBridgeError::InvalidCursor
    );
    assert_eq!(
        client.page(&request).await.unwrap_err(),
        OpsBridgeError::StaleCursor
    );
    assert_eq!(
        client.page(&request).await.unwrap_err(),
        OpsBridgeError::HttpStatus
    );
    assert_eq!(
        client.page(&request).await.unwrap_err(),
        OpsBridgeError::ResponseInvalidJson
    );
    assert_eq!(
        client.page(&request).await.unwrap_err(),
        OpsBridgeError::ContractMismatch
    );
    server.await.expect("page server exits");
}
