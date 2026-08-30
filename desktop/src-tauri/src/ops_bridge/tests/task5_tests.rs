use serde::Deserialize;
use serde_json::json;

use super::{
    client::{OpsBridgeClient, OpsBridgeError},
    task5::{
        task5_response_within_limit, validate_connections, validate_repository_detail,
        validate_repository_snapshot, validate_research_detail, validate_research_snapshot,
        validate_safety_policy, validate_workflow_routing,
    },
    tests::{config, http_response, spawn_fake_server, write_token},
    types::{OpsDetailRequest, OpsPageRequest, OpsSelection},
};

const NOW: &str = "2026-08-30T00:00:00.123456789Z";
const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SOURCE: &str = "source:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[derive(Deserialize)]
struct PublicValueCorpus {
    safe: Vec<String>,
    #[serde(rename = "unsafe")]
    unsafe_values: Vec<String>,
}

fn connection() -> serde_json::Value {
    json!({
        "id":"connection:one","name":"Hub","kind":"hub","status":"ready",
        "updated_at":NOW,"observed_at":NOW,"source_alias":SOURCE,"locator_label":"Local Hub"
    })
}

fn workflow() -> serde_json::Value {
    json!({
        "status":"ready",
        "superpowers":{"status":"ready","version":"6.3.0","manifest_sha256":SHA,"observed_at":NOW},
        "routing":{"status":"ready","schema_version":1,"source_sha256":SHA,"observed_at":NOW,
          "controller":"codex","allowed_models":["gpt-5.4"],"allowed_efforts":["high"],
          "max_active_sessions":4,"fallback":"forbidden","approval_boundaries":["external_explicit"]},
        "plans":[{"id":"plan:one","title":"Task 5","phase":"implementation","status":"in_progress",
          "plan_sha256":SHA,"ledger_sha256":SHA,"evidence_count":1,"review_finding_count":0,"verification":"unverified"}],
        "routes":[{"id":"route:one","from":"planner","to":"implementer","model":"gpt-5.4",
          "effort":"high","enabled":true,"approval_boundary":"local_internal"}]
    })
}

fn safety() -> serde_json::Value {
    json!({
        "policy_version":1,"read_capabilities":["snapshot","events","artifact"],
        "session_controls":{"drafts":["message","internal_task"],"transitions":["submit","approve","risk_confirm","reject"]},
        "forbidden_actions":["external_delivery","provider_execution","teams_send","github_mutation","git_mutation",
          "automatic_research","push","merge","publish","deploy"],
        "approval_boundaries":[{"action":"provider_run","boundary":"forbidden","requires_expected_revision":true,
          "requires_risk_confirmation":true}],"control_session_ttl_seconds":120
    })
}

#[test]
fn task5_rust_snapshot_and_detail_decoders_match_strict_zod_boundaries() {
    assert!(validate_connections(&json!([connection()])));
    let mut codex = connection();
    codex["id"] = json!("connection:codex");
    codex["kind"] = json!("codex");
    assert!(validate_connections(&json!([codex, connection()])));
    assert!(validate_workflow_routing(&workflow()));
    assert!(validate_safety_policy(&safety()));
    let mut partial_reads = safety();
    partial_reads["read_capabilities"] = json!(["snapshot", "artifact"]);
    assert!(validate_safety_policy(&partial_reads));
    let mut empty_reads = safety();
    empty_reads["read_capabilities"] = json!([]);
    assert!(validate_safety_policy(&empty_reads));

    for invalid in [
        json!([{ "id":"connection:one","name":"Hub","kind":"hub","status":"ready",
          "updated_at":NOW,"observed_at":NOW,"source_alias":SOURCE,"locator_label":"/Users/private/repo" }]),
        json!([{ "id":"connection:one","name":"Hub","kind":"future","status":"ready",
          "updated_at":NOW,"observed_at":NOW,"source_alias":SOURCE,"locator_label":"safe" }]),
        json!([{ "id":"connection:one","name":"Hub","kind":"hub","status":"ready",
          "updated_at":"2026-02-30T00:00:00Z","observed_at":NOW,"source_alias":SOURCE,"locator_label":"safe" }]),
    ] {
        assert!(!validate_connections(&invalid));
    }
    assert!(!validate_research_snapshot(&json!([{
        "id":"research:one","title":"Research","status":"complete","updated_at":null
    }])));
    assert!(!validate_repository_snapshot(&json!([{
        "id":"repository:one","name":"Buzz","branch":"main","clean":true,"ahead":null
    }])));
    let mut bad_workflow = workflow();
    bad_workflow["status"] = json!("partial");
    assert!(!validate_workflow_routing(&bad_workflow));
    let mut bad_safety = safety();
    bad_safety["forbidden_actions"] = json!([]);
    assert!(!validate_safety_policy(&bad_safety));

    let research = json!({
      "id":"research:one","title":"Release","status":"ready","release_version":1,"updated_at":NOW,
      "review_receipt_id":"receipt:one","reviewed_at":NOW,
      "markdown":{"artifact_id":"artifact:markdown","version":1,"representation":"markdown","sha256":SHA},
      "json":{"artifact_id":"artifact:json","version":1,"representation":"json","sha256":SHA}
    });
    assert!(validate_research_detail(&research));
    let mut wrong_slot = research.clone();
    wrong_slot["markdown"]["representation"] = json!("json");
    assert!(!validate_research_detail(&wrong_slot));

    let repository = json!({"id":"repository:one","comparison_sha":"cccccccccccccccccccccccccccccccccccccccc",
      "tracking_ref_observed_at":NOW,"evidence":[{"id":"evidence:one","command_alias":"test.unit",
      "status":"verified","observed_at":NOW,"artifact_id":"artifact:test","artifact_version":1}]});
    assert!(validate_repository_detail(&repository));
    let mut leaked = repository;
    leaked["root"] = json!("/private/repo");
    assert!(!validate_repository_detail(&leaked));

    let corpus: PublicValueCorpus = serde_json::from_str(include_str!(
        "../../../../src/features/ops-room/testing/fixtures/dormant-public-value-corpus.json"
    ))
    .expect("shared Task 3 public-value corpus");
    for locator in corpus.safe {
        let mut row = connection();
        row["locator_label"] = json!(locator);
        assert!(validate_connections(&json!([row])));
    }
    for locator in corpus.unsafe_values {
        let mut row = connection();
        row["locator_label"] = json!(locator);
        assert!(!validate_connections(&json!([row])));
    }
}

#[test]
fn task5_rust_boundary_matrix_matches_frozen_limits_and_patterns() {
    let exact = "a".repeat(2 * 1024 * 1024 - 2);
    let over = "a".repeat(2 * 1024 * 1024 - 1);
    assert!(task5_response_within_limit(&json!(exact)));
    assert!(!task5_response_within_limit(&json!(over)));

    let base = workflow();
    let plan = base["plans"][0].clone();
    let route = base["routes"][0].clone();
    let plans = (0..64)
        .map(|index| {
            let mut row = plan.clone();
            row["id"] = json!(format!("plan:{index}"));
            row
        })
        .collect::<Vec<_>>();
    let routes = (0..64)
        .map(|index| {
            let mut row = route.clone();
            row["id"] = json!(format!("route:{index}"));
            row
        })
        .collect::<Vec<_>>();
    let tokens = (0..16)
        .map(|index| format!("model_{index}"))
        .collect::<Vec<_>>();
    let boundaries = (0..16)
        .map(|index| {
            json!({"action":format!("action_{index}"),"boundary":"forbidden",
              "requires_expected_revision":true,"requires_risk_confirmation":false})
        })
        .collect::<Vec<_>>();
    let mut workflow_max = workflow();
    workflow_max["plans"] = json!(plans);
    workflow_max["routes"] = json!(routes);
    workflow_max["routing"]["allowed_models"] = json!(tokens);
    workflow_max["routing"]["allowed_efforts"] = json!((0..16)
        .map(|index| format!("effort_{index}"))
        .collect::<Vec<_>>());
    workflow_max["routing"]["approval_boundaries"] = json!((0..16)
        .map(|index| format!("boundary_{index}"))
        .collect::<Vec<_>>());
    workflow_max["routing"]["max_active_sessions"] = json!(64);
    workflow_max["plans"][0]["evidence_count"] = json!(10_000);
    assert!(validate_workflow_routing(&workflow_max));

    let mut policy_max = safety();
    policy_max["approval_boundaries"] = json!(boundaries);
    assert!(validate_safety_policy(&policy_max));

    let evidence = (0..64)
        .map(|index| {
            json!({"id":format!("evidence:{index}"),"command_alias":"test.unit",
          "status":"verified","observed_at":NOW,"artifact_id":format!("artifact:{index}"),
          "artifact_version":9_007_199_254_740_991_u64})
        })
        .collect::<Vec<_>>();
    let repository_max = json!({"id":"repository:one","comparison_sha":"cccccccccccccccccccccccccccccccccccccccc",
      "tracking_ref_observed_at":NOW,"evidence":evidence});
    assert!(validate_repository_detail(&repository_max));

    let mut research_max = json!({
      "id":"research:one","title":"Release","status":"ready","release_version":9_007_199_254_740_991_u64,
      "updated_at":NOW,"review_receipt_id":"receipt:one","reviewed_at":NOW,
      "markdown":{"artifact_id":"artifact:markdown","version":9_007_199_254_740_991_u64,"representation":"markdown","sha256":SHA},
      "json":{"artifact_id":"artifact:json","version":1,"representation":"json","sha256":SHA}
    });
    assert!(validate_research_detail(&research_max));

    let mut invalid_cases = Vec::new();
    let mut plans_over = workflow_max.clone();
    plans_over["plans"].as_array_mut().unwrap().push({
        let mut row = plan.clone();
        row["id"] = json!("plan:64");
        row
    });
    invalid_cases.push((
        "plans over 64",
        plans_over,
        validate_workflow_routing as fn(&serde_json::Value) -> bool,
    ));
    let mut routes_over = workflow_max.clone();
    routes_over["routes"].as_array_mut().unwrap().push({
        let mut row = route.clone();
        row["id"] = json!("route:64");
        row
    });
    invalid_cases.push(("routes over 64", routes_over, validate_workflow_routing));
    let mut tokens_over = workflow();
    tokens_over["routing"]["allowed_models"] = json!((0..17)
        .map(|index| format!("model_{index}"))
        .collect::<Vec<_>>());
    invalid_cases.push((
        "routing tokens over 16",
        tokens_over,
        validate_workflow_routing,
    ));
    for field in ["allowed_efforts", "approval_boundaries"] {
        let mut value = workflow();
        value["routing"][field] = json!((0..17)
            .map(|index| format!("value_{index}"))
            .collect::<Vec<_>>());
        invalid_cases.push(("routing array over 16", value, validate_workflow_routing));
    }
    for limit in [0, 65] {
        let mut active = workflow();
        active["routing"]["max_active_sessions"] = json!(limit);
        invalid_cases.push(("active-session bound", active, validate_workflow_routing));
    }
    let mut count = workflow();
    count["plans"][0]["evidence_count"] = json!(10_001);
    invalid_cases.push(("count over 10000", count, validate_workflow_routing));
    let mut policy_over = policy_max.clone();
    policy_over["approval_boundaries"]
        .as_array_mut()
        .unwrap()
        .push(json!({
      "action":"action_16","boundary":"forbidden","requires_expected_revision":true,
      "requires_risk_confirmation":false}));
    invalid_cases.push((
        "policy boundaries over 16",
        policy_over,
        validate_safety_policy,
    ));
    let mut evidence_over = repository_max.clone();
    evidence_over["evidence"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"evidence:64","command_alias":"test.unit",
      "status":"verified","observed_at":NOW,"artifact_id":"artifact:64","artifact_version":1}));
    invalid_cases.push((
        "evidence over 64",
        evidence_over,
        validate_repository_detail,
    ));

    for (label, value, validate) in invalid_cases {
        assert!(!validate(&value), "{label}");
    }

    for invalid_hash in [format!("x{SHA}"), format!("{SHA}x"), SHA.to_uppercase()] {
        research_max["markdown"]["sha256"] = json!(invalid_hash);
        assert!(!validate_research_detail(&research_max));
    }
    for invalid_comparison in [
        "c".repeat(39),
        format!("x{}", "c".repeat(40)),
        format!("{}x", "c".repeat(40)),
        "c".repeat(63),
        "c".repeat(65),
        "C".repeat(40),
    ] {
        let mut value = repository_max.clone();
        value["comparison_sha"] = json!(invalid_comparison);
        assert!(!validate_repository_detail(&value));
    }
    let mut repository_sha64 = repository_max.clone();
    repository_sha64["comparison_sha"] = json!("c".repeat(64));
    assert!(validate_repository_detail(&repository_sha64));
    let mut unsafe_version = research_max;
    unsafe_version["markdown"]["sha256"] = json!(SHA);
    unsafe_version["release_version"] = json!(9_007_199_254_740_992_u64);
    assert!(!validate_research_detail(&unsafe_version));
    unsafe_version["release_version"] = json!(0);
    assert!(!validate_research_detail(&unsafe_version));
}

#[tokio::test]
async fn task5_native_client_uses_fixed_teams_and_detail_routes() {
    let teams = serde_json::to_vec(&json!({
        "contract_version":1,"revision":4,"generated_at":NOW,"items":[],"next_cursor":null
    }))
    .expect("serialize Teams page");
    let research = serde_json::to_vec(&json!({
      "id":"research:one","title":"Release","status":"ready","release_version":1,"updated_at":NOW,
      "review_receipt_id":"receipt:one","reviewed_at":NOW,
      "markdown":{"artifact_id":"artifact:markdown","version":1,"representation":"markdown","sha256":SHA},
      "json":{"artifact_id":"artifact:json","version":1,"representation":"json","sha256":SHA}
    })).expect("serialize research detail");
    let unavailable =
        serde_json::to_vec(&json!({"error":"unavailable"})).expect("serialize unavailable");
    let malformed_unavailable = serde_json::to_vec(&json!({
        "error":"unavailable","detail":"must not cross"
    }))
    .expect("serialize malformed unavailable");
    let mismatched_research = serde_json::to_vec(&json!({
      "id":"research:other","title":"Release","status":"ready","release_version":1,"updated_at":NOW,
      "review_receipt_id":"receipt:one","reviewed_at":NOW,
      "markdown":{"artifact_id":"artifact:markdown","version":1,"representation":"markdown","sha256":SHA},
      "json":{"artifact_id":"artifact:json","version":1,"representation":"json","sha256":SHA}
    }))
    .expect("serialize mismatched research detail");
    let mismatched_repository = serde_json::to_vec(&json!({
      "id":"repository:other","comparison_sha":"cccccccccccccccccccccccccccccccccccccccc",
      "tracking_ref_observed_at":NOW,"evidence":[]
    }))
    .expect("serialize mismatched repository detail");
    let (port, requests, server) = spawn_fake_server(vec![
        http_response("200 OK", "application/json", &teams, &[]),
        http_response("200 OK", "application/json", &research, &[]),
        http_response(
            "503 Service Unavailable",
            "application/json",
            &unavailable,
            &[],
        ),
        http_response(
            "503 Service Unavailable",
            "application/json",
            &malformed_unavailable,
            &[],
        ),
        http_response("200 OK", "application/json", &mismatched_research, &[]),
        http_response("200 OK", "application/json", &mismatched_repository, &[]),
    ])
    .await;
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
    let client =
        OpsBridgeClient::new(config(port, &token, 2 * 1024 * 1024)).expect("strict client");

    let teams_request: OpsPageRequest = serde_json::from_value(json!({
      "module":"teams_activity","scope":{"connection":"connection:one","sort":"observed_at_desc"},
      "page_size":100,"cursor":null
    }))
    .expect("typed Teams request");
    client.page(&teams_request).await.expect("Teams page");
    client
        .research_detail(&OpsDetailRequest {
            id: "research:one".into(),
        })
        .await
        .expect("research detail");
    assert_eq!(
        client
            .repository_detail(&OpsDetailRequest {
                id: "repository:one".into()
            })
            .await
            .expect_err("local unavailable"),
        OpsBridgeError::Unavailable
    );
    assert_eq!(
        client
            .repository_detail(&OpsDetailRequest {
                id: "repository:two".into()
            })
            .await
            .expect_err("malformed unavailable is contract drift"),
        OpsBridgeError::ContractMismatch
    );
    assert_eq!(
        client
            .research_detail(&OpsDetailRequest {
                id: "research:requested".into()
            })
            .await
            .expect_err("research response id is request-bound"),
        OpsBridgeError::ContractMismatch
    );
    assert_eq!(
        client
            .repository_detail(&OpsDetailRequest {
                id: "repository:requested".into()
            })
            .await
            .expect_err("repository response id is request-bound"),
        OpsBridgeError::ContractMismatch
    );
    let observed = requests.lock().expect("request capture lock").clone();
    assert!(observed[0].starts_with("GET /ops-bridge/v1/teams-activity?connection=connection%3Aone&sort=observed_at_desc&page_size=100"));
    assert!(observed[1].starts_with("GET /ops-bridge/v1/research/research:one "));
    assert!(observed[2].starts_with("GET /ops-bridge/v1/repositories/repository:one "));
    assert!(observed[3].starts_with("GET /ops-bridge/v1/repositories/repository:two "));
    assert!(observed[4].starts_with("GET /ops-bridge/v1/research/research:requested "));
    assert!(observed[5].starts_with("GET /ops-bridge/v1/repositories/repository:requested "));
    server.await.expect("fake server exits");
}

#[tokio::test]
async fn task5_malformed_teams_error_responses_are_contract_invalid() {
    let unavailable =
        serde_json::to_vec(&json!({"error":"unavailable"})).expect("serialize unavailable");
    let malformed = serde_json::to_vec(&json!({
        "error":"unavailable","detail":"must not cross"
    }))
    .expect("serialize malformed unavailable");
    let stale =
        serde_json::to_vec(&json!({"error":"stale_cursor"})).expect("serialize stale cursor");
    let (port, _, server) = spawn_fake_server(vec![
        http_response(
            "503 Service Unavailable",
            "application/json",
            &malformed,
            &[],
        ),
        http_response("503 Service Unavailable", "text/plain", &unavailable, &[]),
        http_response(
            "503 Service Unavailable",
            "application/json",
            b"not-json",
            &[],
        ),
        http_response("400 Bad Request", "application/json", &unavailable, &[]),
        http_response("503 Service Unavailable", "application/json", &stale, &[]),
    ])
    .await;
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
    let client = OpsBridgeClient::new(config(port, &token, 4096)).expect("strict client");
    let request: OpsPageRequest = serde_json::from_value(json!({
      "module":"teams_activity","scope":{"connection":"connection:one","sort":"observed_at_desc"},
      "page_size":100,"cursor":null
    }))
    .expect("typed Teams request");

    for _ in 0..5 {
        assert_eq!(
            client.page(&request).await.expect_err("contract drift"),
            OpsBridgeError::ContractMismatch
        );
    }
    server.await.expect("fake server exits");
}

#[tokio::test]
async fn task5_native_snapshot_rejects_unsafe_revision() {
    let body = serde_json::to_vec(&json!({
      "contract_version":1,"revision":9_007_199_254_740_992_u64,"generated_at":NOW,
      "health":{"hub":"ready","orca":"ready","codex":"ready"},
      "room":{},"session_tree":[],"checklist":[],"decisions":[]
    }))
    .expect("serialize unsafe snapshot revision");
    let (port, _, server) = spawn_fake_server(vec![http_response(
        "200 OK",
        "application/json",
        &body,
        &[],
    )])
    .await;
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
    let client = OpsBridgeClient::new(config(port, &token, 4096)).expect("strict client");

    assert_eq!(
        client
            .snapshot(&OpsSelection::default())
            .await
            .expect_err("unsafe snapshot revision"),
        OpsBridgeError::ContractMismatch
    );
    server.await.expect("fake server exits");
}

#[tokio::test]
async fn task5_native_snapshot_sanitizes_only_the_malformed_module_before_zod() {
    let body = serde_json::to_vec(&json!({
      "contract_version":1,"revision":1,"generated_at":NOW,
      "health":{"hub":"ready","orca":"ready","codex":"ready"},
      "room":{},"session_tree":[],"checklist":[],"decisions":[],
      "connections":[{"id":"connection:one","name":"Hub","kind":"hub","status":"ready",
        "updated_at":NOW,"observed_at":NOW,"source_alias":SOURCE,"locator_label":"/Users/private/repo"}],
      "workflow_routing":workflow()
    })).expect("serialize snapshot");
    let (port, _, server) = spawn_fake_server(vec![http_response(
        "200 OK",
        "application/json",
        &body,
        &[],
    )])
    .await;
    let temp = tempfile::tempdir().expect("temp token directory");
    let token = temp.path().join("hub.token");
    write_token(&token, &[b't'; 32], 0o600);
    let client =
        OpsBridgeClient::new(config(port, &token, 2 * 1024 * 1024)).expect("strict client");
    let snapshot = client
        .snapshot(&OpsSelection::default())
        .await
        .expect("core snapshot preserved");
    let wire = serde_json::to_value(snapshot).expect("serialize sanitized snapshot");
    assert_eq!(wire["connections"], json!([{"contract_invalid":true}]));
    assert_eq!(wire["workflow_routing"]["status"], json!("ready"));
    assert!(!wire.to_string().contains("/Users/private/repo"));
    server.await.expect("fake server exits");
}
