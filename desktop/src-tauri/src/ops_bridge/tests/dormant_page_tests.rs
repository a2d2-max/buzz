use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    client::{OpsBridgeClient, OpsBridgeError},
    dormant::{
        self, DormantPageItem, OpsApprovalIndexV1, OpsAuditPageV1, OpsChecklistItemPageV1,
        OpsDecisionPageV1, OpsEvidencePageV1, OpsGlobalSessionV1, OpsSearchResultV1, OpsWorkItemV1,
    },
    page_error,
    tests::{config, http_response, spawn_fake_server, write_token},
    types::{OpsPageRequest, OpsPageV1},
};

const TIMESTAMP: &str = "2026-08-30T00:00:00.123456789Z";

#[derive(Deserialize)]
struct PublicValueCorpus {
    safe: Vec<String>,
    #[serde(rename = "unsafe")]
    unsafe_values: Vec<String>,
}

fn page(item: Value) -> Value {
    json!({
        "contract_version": 1,
        "revision": 3,
        "generated_at": TIMESTAMP,
        "items": [item],
        "next_cursor": null
    })
}

fn valid_cases() -> Vec<(&'static str, Value, Option<&'static str>)> {
    vec![
        (
            "work_items",
            page(json!({
                "id": "work:one", "project_id": "project:one", "title": "Work", "status": "active",
                "progress": 0.5, "last_activity_at": TIMESTAMP, "session_count": 1,
                "approval_count": 2, "artifact_count": 3
            })),
            None,
        ),
        (
            "sessions",
            page(json!({
                "id": "codex_direct:one", "source": "codex_direct", "parent_session_id": null,
                "work_item_id": null, "title": "Session", "activity": null,
                "health": "context_unavailable", "last_activity_at": null, "child_count": 10_000
            })),
            None,
        ),
        (
            "checklist_items",
            page(json!({
                "id": "checklist:one", "work_item_id": "work:one", "key": "key", "title": "Checklist",
                "order": 1_000_000, "origin": "agent_plan", "status": "in_progress",
                "evidence_ids": ["evidence:one"], "claimed_by_session_id": null, "claimed_at": null,
                "stage": null, "next_action": "Continue", "depends_on": ["checklist:zero"],
                "updated_at": TIMESTAMP, "revision": 1
            })),
            Some("work:one"),
        ),
        (
            "decisions",
            page(json!({
                "id": "decision:one", "work_item_id": null, "source": "checklist",
                "source_id": "checklist:one", "title": "Decision", "question": "Continue?",
                "options": ["Yes", "No"], "needed_input": null, "impact": "Bounded",
                "queue": "user_decision", "status": "open", "updated_at": TIMESTAMP, "revision": 1
            })),
            None,
        ),
        (
            "approval_index",
            page(json!({
                "id": "approval:one", "work_item_id": "work:one", "action_kind": "provider_interrupt",
                "status": "awaiting_risk_confirm", "hold_reason": null, "risk_class": ["session_stop"],
                "updated_at": TIMESTAMP, "revision": 1
            })),
            None,
        ),
        (
            "evidence",
            page(json!({
                "id": "evidence:one", "work_item_id": "work:one", "kind": "test_report",
                "status": "verified", "observed_at": TIMESTAMP, "artifact_id": "artifact:one",
                "artifact_version": 1
            })),
            None,
        ),
        (
            "audit",
            page(json!({
                "id": "audit:one", "work_item_id": null, "kind": "adapter.status",
                "summary": "Safe summary", "observed_at": TIMESTAMP
            })),
            None,
        ),
        (
            "search",
            page(json!({
                "id": "search:one", "kind": "research", "title": "Result", "snippet": "Safe excerpt",
                "observed_at": TIMESTAMP, "work_item_id": null
            })),
            None,
        ),
    ]
}

fn validate_typed<T>(value: Value) -> bool
where
    T: DeserializeOwned + DormantPageItem,
{
    serde_json::from_value::<OpsPageV1<T>>(value)
        .ok()
        .is_some_and(|decoded| dormant::validate_page(&decoded).is_ok())
}

fn validate_case(module: &str, value: Value, scope: Option<&str>) -> bool {
    if value["contract_version"] != json!(1) {
        return false;
    }
    match module {
        "work_items" => validate_typed::<OpsWorkItemV1>(value),
        "sessions" => validate_typed::<OpsGlobalSessionV1>(value),
        "checklist_items" => serde_json::from_value::<OpsPageV1<OpsChecklistItemPageV1>>(value)
            .ok()
            .is_some_and(|decoded| {
                dormant::validate_page(&decoded).is_ok()
                    && scope.is_some_and(|work| {
                        dormant::validate_checklist_scope(&decoded, work).is_ok()
                    })
            }),
        "decisions" => validate_typed::<OpsDecisionPageV1>(value),
        "approval_index" => validate_typed::<OpsApprovalIndexV1>(value),
        "evidence" => validate_typed::<OpsEvidencePageV1>(value),
        "audit" => validate_typed::<OpsAuditPageV1>(value),
        "search" => validate_typed::<OpsSearchResultV1>(value),
        _ => false,
    }
}

#[test]
fn dormant_rust_decoders_are_closed_and_bounded_for_all_eight_dtos_and_envelopes() {
    for (module, valid, scope) in valid_cases() {
        assert!(validate_case(module, valid.clone(), scope), "{module}");

        let mut item_unknown = valid.clone();
        item_unknown["items"][0]["extra"] = json!(true);
        assert!(
            !validate_case(module, item_unknown, scope),
            "{module}: item exactness"
        );

        let mut envelope_unknown = valid.clone();
        envelope_unknown["extra"] = json!(true);
        assert!(
            !validate_case(module, envelope_unknown, scope),
            "{module}: envelope exactness"
        );
        let mut wrong_version = valid.clone();
        wrong_version["contract_version"] = json!(2);
        assert!(
            !validate_case(module, wrong_version, scope),
            "{module}: version"
        );

        let nullable_field = match module {
            "work_items" => "last_activity_at",
            "sessions" => "parent_session_id",
            "checklist_items" => "claimed_by_session_id",
            "decisions" => "work_item_id",
            "approval_index" => "hold_reason",
            "evidence" => "artifact_id",
            "audit" | "search" => "work_item_id",
            _ => unreachable!("closed Task 3 module table"),
        };
        let mut omitted_null = valid.clone();
        omitted_null["items"][0]
            .as_object_mut()
            .and_then(|item| item.remove(nullable_field));
        assert!(
            !validate_case(module, omitted_null, scope),
            "{module}: explicit null for {nullable_field}"
        );

        for (field, invalid) in match module {
            "work_items" => vec![
                ("status", json!("future")),
                ("progress", json!(2)),
                ("session_count", json!(10_001)),
            ],
            "sessions" => vec![
                ("health", json!("future")),
                ("id", json!("codex_direct:one:two")),
                ("child_count", json!(10_001)),
            ],
            "checklist_items" => vec![
                ("origin", json!("future")),
                ("evidence_ids", json!(["evidence:one", "evidence:one"])),
                ("revision", json!(0)),
            ],
            "decisions" => vec![
                ("queue", json!("future")),
                ("options", json!(["Yes", "Yes"])),
                ("revision", json!(0)),
            ],
            "approval_index" => vec![
                ("status", json!("future")),
                ("risk_class", json!(["session_stop", "session_stop"])),
                ("revision", json!(0)),
            ],
            "evidence" => vec![
                ("kind", json!("future")),
                ("artifact_version", Value::Null),
                ("status", json!("trusted")),
            ],
            "audit" => vec![
                ("kind", json!("Adapter Status")),
                ("summary", json!("")),
                ("observed_at", json!("2026-02-30T00:00:00Z")),
            ],
            "search" => vec![
                ("kind", json!("raw_message")),
                ("title", json!("")),
                ("work_item_id", json!(1)),
            ],
            _ => Vec::new(),
        } {
            let mut drift = valid.clone();
            drift["items"][0][field] = invalid;
            assert!(!validate_case(module, drift, scope), "{module}: {field}");
        }

        let mut too_many = valid.clone();
        too_many["items"] = Value::Array(vec![valid["items"][0].clone(); 201]);
        assert!(
            !validate_case(module, too_many, scope),
            "{module}: page cap"
        );
        for (field, invalid) in [
            ("revision", json!(9_007_199_254_740_992_u64)),
            ("generated_at", json!("2026-02-30T00:00:00Z")),
            ("next_cursor", json!("")),
            ("next_cursor", json!("x".repeat(4097))),
        ] {
            let mut drift = valid.clone();
            drift[field] = invalid;
            assert!(!validate_case(module, drift, scope), "{module}: {field}");
        }
    }
}

#[test]
fn dormant_rust_requests_are_closed_and_exact_for_all_eight_modules() {
    let valid = [
        json!({"module":"work_items","scope":{"sort":"last_activity_at_desc"},"page_size":100,"cursor":null}),
        json!({"module":"sessions","scope":{"sort":"last_activity_at_desc"},"page_size":100,"cursor":null}),
        json!({"module":"checklist_items","scope":{"work_item":"work:one","sort":"order_asc_then_id"},"page_size":100,"cursor":null}),
        json!({"module":"decisions","scope":{"sort":"updated_at_desc"},"page_size":100,"cursor":null}),
        json!({"module":"approval_index","scope":{"sort":"updated_at_desc"},"page_size":100,"cursor":null}),
        json!({"module":"evidence","scope":{"sort":"observed_at_desc"},"page_size":100,"cursor":null}),
        json!({"module":"audit","scope":{"sort":"observed_at_desc"},"page_size":100,"cursor":null}),
        json!({"module":"search","scope":{"q":"Café","kind":"audit","work":"work:one","sort":"rank_desc_then_observed_at_desc"},"page_size":100,"cursor":null}),
    ];
    for value in valid {
        let request: OpsPageRequest = serde_json::from_value(value.clone()).expect("exact request");
        request.validate().expect("bounded request");

        let mut top_level_drift = value.clone();
        top_level_drift["extra"] = json!(true);
        assert!(serde_json::from_value::<OpsPageRequest>(top_level_drift).is_err());
        let mut scope_drift = value.clone();
        scope_drift["scope"]["extra"] = json!(true);
        assert!(serde_json::from_value::<OpsPageRequest>(scope_drift).is_err());
        let mut sort_drift = value.clone();
        sort_drift["scope"]["sort"] = json!("future_sort");
        assert!(serde_json::from_value::<OpsPageRequest>(sort_drift).is_err());

        for (field, invalid) in [
            ("page_size", json!(0)),
            ("page_size", json!(201)),
            ("cursor", json!("")),
            ("cursor", json!("x".repeat(4097))),
        ] {
            let mut drift = value.clone();
            drift[field] = invalid;
            let request: OpsPageRequest =
                serde_json::from_value(drift).expect("closed request shape");
            assert_eq!(request.validate(), Err(OpsBridgeError::InvalidRequest));
        }
    }

    for field in ["kind", "work"] {
        let mut null_drift = json!({
            "module":"search",
            "scope":{"q":"safe","kind":"audit","work":"work:one","sort":"rank_desc_then_observed_at_desc"},
            "page_size":100,
            "cursor":null
        });
        null_drift["scope"][field] = Value::Null;
        assert!(serde_json::from_value::<OpsPageRequest>(null_drift).is_err());
    }
}

#[test]
fn dormant_rust_public_values_match_the_frozen_security_timestamp_and_session_contract() {
    assert!(dormant::module_name("future_unknown_module"));
    for name in ["", "1bad", "bad-name", &"a".repeat(65)] {
        assert!(!dormant::module_name(name), "{name}");
    }
    let corpus: PublicValueCorpus = serde_json::from_str(include_str!(
        "../../../../src/features/ops-room/testing/fixtures/dormant-public-value-corpus.json"
    ))
    .expect("shared public-value corpus");
    let (_, valid_work, _) = &valid_cases()[0];
    for value in &corpus.unsafe_values {
        let mut drift = valid_work.clone();
        drift["items"][0]["title"] = json!(value);
        assert!(
            !validate_case("work_items", drift, None),
            "DTO accepted {value:?}"
        );
        assert!(!dormant::search_query(value), "query accepted {value:?}");
    }
    for value in &corpus.safe {
        let mut accepted = valid_work.clone();
        accepted["items"][0]["title"] = json!(value);
        assert!(validate_case("work_items", accepted, None), "{value}");
    }
    assert!(serde_json::from_str::<String>(r#""bad\uD800""#).is_err());

    for value in ["2026-08-30T00:00:00Z", "2024-02-29T23:59:59.123456789Z"] {
        let mut accepted = valid_work.clone();
        accepted["items"][0]["last_activity_at"] = json!(value);
        assert!(validate_case("work_items", accepted, None), "{value}");
    }
    for value in [
        "2026-02-30T00:00:00Z",
        "2026-08-30T00:00:60Z",
        "2026-08-30T00:00:00+00:00",
        "2026-08-30T00:00:00.Z",
        "２０２６-08-30T00:00:00Z",
    ] {
        let mut drift = valid_work.clone();
        drift["items"][0]["last_activity_at"] = json!(value);
        assert!(!validate_case("work_items", drift, None), "{value}");
    }
    for value in [
        "0000-01-01T00:00:00Z",
        "0001-01-01T00:00:00Z",
        "0099-12-31T23:59:59.123456789Z",
    ] {
        let mut accepted = valid_work.clone();
        accepted["items"][0]["last_activity_at"] = json!(value);
        assert!(validate_case("work_items", accepted, None), "{value}");
    }
    assert!(!dormant::search_query("bad\u{fffd}query"));

    let (_, valid_session, _) = &valid_cases()[1];
    for id in ["codex_direct:", "codex_direct:one:two", "codex_direct:-one"] {
        let mut drift = valid_session.clone();
        drift["items"][0]["id"] = json!(id);
        assert!(!validate_case("sessions", drift, None), "{id}");
    }
}

#[tokio::test]
async fn dormant_native_requests_use_all_eight_fixed_routes_and_exact_queries() {
    let empty = serde_json::to_vec(&json!({
        "contract_version": 1, "revision": 3, "generated_at": TIMESTAMP,
        "items": [], "next_cursor": null
    }))
    .expect("serialize page");
    let (port, requests, server) = spawn_fake_server(
        (0..8)
            .map(|_| http_response("200 OK", "application/json", &empty, &[]))
            .collect(),
    )
    .await;
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
    let client = OpsBridgeClient::new(config(port, &token, 4096)).expect("strict client");
    let request_values = [
        json!({"module":"work_items","scope":{"sort":"last_activity_at_desc"},"page_size":1,"cursor":null}),
        json!({"module":"sessions","scope":{"sort":"last_activity_at_desc"},"page_size":2,"cursor":"c2"}),
        json!({"module":"checklist_items","scope":{"work_item":"work:one","sort":"order_asc_then_id"},"page_size":3,"cursor":null}),
        json!({"module":"decisions","scope":{"sort":"updated_at_desc"},"page_size":4,"cursor":null}),
        json!({"module":"approval_index","scope":{"sort":"updated_at_desc"},"page_size":5,"cursor":null}),
        json!({"module":"evidence","scope":{"sort":"observed_at_desc"},"page_size":6,"cursor":null}),
        json!({"module":"audit","scope":{"sort":"observed_at_desc"},"page_size":7,"cursor":null}),
        json!({"module":"search","scope":{"q":"Café","kind":"audit","work":"work:one","sort":"rank_desc_then_observed_at_desc"},"page_size":8,"cursor":"c8"}),
    ];
    for value in request_values {
        let request: OpsPageRequest = serde_json::from_value(value).expect("typed request");
        client.page(&request).await.expect("fixed request");
    }
    server.await.expect("fake server exits");
    let requests = requests.lock().expect("read requests");
    let expected = [
        ("/ops-bridge/v1/work-items", "sort=last_activity_at_desc&page_size=1"),
        ("/ops-bridge/v1/sessions", "sort=last_activity_at_desc&page_size=2&cursor=c2"),
        ("/ops-bridge/v1/checklist-items", "work_item=work%3Aone&sort=order_asc_then_id&page_size=3"),
        ("/ops-bridge/v1/decisions", "sort=updated_at_desc&page_size=4"),
        ("/ops-bridge/v1/approvals", "sort=updated_at_desc&page_size=5"),
        ("/ops-bridge/v1/evidence", "sort=observed_at_desc&page_size=6"),
        ("/ops-bridge/v1/audit", "sort=observed_at_desc&page_size=7"),
        ("/ops-bridge/v1/search", "q=Caf%C3%A9&kind=audit&work=work%3Aone&sort=rank_desc_then_observed_at_desc&page_size=8&cursor=c8"),
    ];
    for (request, (path, query)) in requests.iter().zip(expected) {
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1));
        let expected_target = [path, query].join("?");
        assert_eq!(target, Some(expected_target.as_str()));
    }
}

#[tokio::test]
async fn dormant_native_maps_only_exact_unavailable_bodies_for_all_eight_routes() {
    let unavailable = serde_json::to_vec(&json!({"error":"unavailable"})).expect("serialize error");
    let (port, _, server) = spawn_fake_server(
        (0..8)
            .map(|_| {
                http_response(
                    "503 Service Unavailable",
                    "application/json",
                    &unavailable,
                    &[],
                )
            })
            .collect(),
    )
    .await;
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
    let client = OpsBridgeClient::new(config(port, &token, 4096)).expect("strict client");
    let requests = [
        json!({"module":"work_items","scope":{"sort":"last_activity_at_desc"},"page_size":100,"cursor":null}),
        json!({"module":"sessions","scope":{"sort":"last_activity_at_desc"},"page_size":100,"cursor":null}),
        json!({"module":"checklist_items","scope":{"work_item":"work:one","sort":"order_asc_then_id"},"page_size":100,"cursor":null}),
        json!({"module":"decisions","scope":{"sort":"updated_at_desc"},"page_size":100,"cursor":null}),
        json!({"module":"approval_index","scope":{"sort":"updated_at_desc"},"page_size":100,"cursor":null}),
        json!({"module":"evidence","scope":{"sort":"observed_at_desc"},"page_size":100,"cursor":null}),
        json!({"module":"audit","scope":{"sort":"observed_at_desc"},"page_size":100,"cursor":null}),
        json!({"module":"search","scope":{"q":"safe","sort":"rank_desc_then_observed_at_desc"},"page_size":100,"cursor":null}),
    ];
    for value in requests {
        let request = serde_json::from_value(value).expect("typed request");
        assert_eq!(
            client.page(&request).await.expect_err("route is dormant"),
            OpsBridgeError::Unavailable
        );
        assert_eq!(
            serde_json::to_value(page_error(OpsBridgeError::Unavailable)).expect("serialize error"),
            json!({"error":"unavailable"})
        );
    }
    server.await.expect("fake server exits");
}

#[tokio::test]
async fn dormant_native_rejects_non_exact_unavailable_error_bodies() {
    let body = serde_json::to_vec(&json!({"error":"unavailable","extra":true}))
        .expect("serialize invalid error");
    let (port, _, server) = spawn_fake_server(vec![http_response(
        "503 Service Unavailable",
        "application/json",
        &body,
        &[],
    )])
    .await;
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
    let client = OpsBridgeClient::new(config(port, &token, 4096)).expect("strict client");
    let request = serde_json::from_value(json!({
        "module":"work_items", "scope":{"sort":"last_activity_at_desc"},
        "page_size":100, "cursor":null
    }))
    .expect("typed request");
    assert_eq!(
        client
            .page(&request)
            .await
            .expect_err("extra error field rejected"),
        OpsBridgeError::ContractMismatch
    );
    server.await.expect("fake server exits");
}

#[tokio::test]
async fn dormant_invalid_public_scopes_fail_before_token_or_http_construction() {
    let missing_token = std::path::Path::new("/definitely/missing/buzz-ops-token");
    let client = OpsBridgeClient::new(config(7331, missing_token, 4096)).expect("strict client");
    for value in [
        json!({"module":"checklist_items","scope":{"work_item":"/private/work","sort":"order_asc_then_id"},"page_size":100,"cursor":null}),
        json!({"module":"search","scope":{"q":"ghp_abcdefghijk","sort":"rank_desc_then_observed_at_desc"},"page_size":100,"cursor":null}),
        json!({"module":"search","scope":{"q":"safe","work":"../secret","sort":"rank_desc_then_observed_at_desc"},"page_size":100,"cursor":null}),
    ] {
        let request: OpsPageRequest = serde_json::from_value(value).expect("closed request");
        assert_eq!(
            client
                .page(&request)
                .await
                .expect_err("scope rejected before token read"),
            OpsBridgeError::InvalidRequest
        );
    }
}

#[tokio::test]
async fn dormant_rust_capabilities_are_exact_additive_duplicate_safe_and_future_filtered() {
    let payloads = [
        json!({
            "contract_version": 1, "reads": ["snapshot", "events", "artifact"],
            "drafts": [], "transitions": [], "future_top_level": {"ignored": true},
            "modules": [{"name":"future_unknown_module","schema_version":1,"paged":true,"collection_revision":0}]
        }),
        json!({
            "contract_version": 1, "reads": ["snapshot", "events", "artifact"],
            "drafts": [], "transitions": [],
            "modules": [{"name":"work_items","schema_version":1,"paged":true,"collection_revision":0,"extra":true}]
        }),
        json!({
            "contract_version": 1, "reads": ["snapshot", "events", "artifact"],
            "drafts": [], "transitions": [],
            "modules": [{"name":"work_items","schema_version":2,"paged":true,"collection_revision":0}]
        }),
        json!({
            "contract_version": 1, "reads": ["snapshot", "events", "artifact"],
            "drafts": [], "transitions": [],
            "modules": [{"name":"WorkItems","schema_version":1,"paged":true,"collection_revision":0}]
        }),
        json!({
            "contract_version": 1, "reads": ["snapshot", "events", "artifact"],
            "drafts": [], "transitions": [],
            "modules": [
                {"name":"work_items","schema_version":1,"paged":true,"collection_revision":0},
                {"name":"work_items","schema_version":1,"paged":true,"collection_revision":0}
            ]
        }),
    ];
    let responses = payloads
        .iter()
        .map(|payload| {
            let body = serde_json::to_vec(payload).expect("serialize capabilities");
            http_response("200 OK", "application/json", &body, &[])
        })
        .collect();
    let (port, _, server) = spawn_fake_server(responses).await;
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
    let client = OpsBridgeClient::new(config(port, &token, 4096)).expect("strict client");

    assert!(client
        .capabilities()
        .await
        .expect("future module is valid")
        .modules
        .is_some_and(|modules| modules.is_empty()));
    for reason in ["record is closed", "schema"] {
        let isolated = client.capabilities().await.expect(reason);
        assert_eq!(
            serde_json::to_value(isolated).expect("serialize isolated capability")["modules"][0],
            json!({"name":"work_items"})
        );
    }
    for reason in ["name", "duplicate"] {
        assert_eq!(
            client.capabilities().await.expect_err(reason),
            OpsBridgeError::ContractMismatch
        );
    }
    server.await.expect("fake server exits");
}

#[tokio::test]
async fn dormant_rust_capabilities_distinguish_optional_omission_from_explicit_null() {
    let payloads = [
        json!({
            "contract_version":1,"reads":["snapshot","events","artifact"],
            "drafts":[],"transitions":[]
        }),
        json!({
            "contract_version":1,"reads":["snapshot","events","artifact"],
            "drafts":[],"transitions":[],"modules":null
        }),
        json!({
            "contract_version":1,"reads":["snapshot","events","artifact"],
            "drafts":[],"transitions":[],
            "modules":[{"name":"timeline","schema_version":1,"paged":false}]
        }),
        json!({
            "contract_version":1,"reads":["snapshot","events","artifact"],
            "drafts":[],"transitions":[],
            "modules":[{"name":"timeline","schema_version":1,"paged":false,"collection_revision":null}]
        }),
    ];
    let responses = payloads
        .iter()
        .map(|payload| {
            let body = serde_json::to_vec(payload).expect("serialize capability case");
            http_response("200 OK", "application/json", &body, &[])
        })
        .collect();
    let (port, _, server) = spawn_fake_server(responses).await;
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
    let client = OpsBridgeClient::new(config(port, &token, 4096)).expect("strict client");

    assert!(client
        .capabilities()
        .await
        .expect("modules omitted")
        .modules
        .is_none());
    assert_eq!(
        client
            .capabilities()
            .await
            .expect_err("modules null rejected"),
        OpsBridgeError::ResponseInvalidJson
    );
    assert!(client
        .capabilities()
        .await
        .expect("revision omitted")
        .modules
        .is_some());
    assert_eq!(
        serde_json::to_value(
            client
                .capabilities()
                .await
                .expect("known null revision reaches Zod")
        )
        .expect("serialize isolated null revision")["modules"][0],
        json!({"name":"timeline"})
    );
    server.await.expect("fake server exits");
}
