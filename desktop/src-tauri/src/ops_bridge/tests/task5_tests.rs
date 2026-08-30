use serde::Deserialize;
use serde_json::json;

use super::{
    client::{OpsBridgeClient, OpsBridgeError},
    task5::{
        validate_connections, validate_repository_detail, validate_repository_snapshot,
        validate_research_detail, validate_research_snapshot, validate_safety_policy,
        validate_workflow_routing,
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
    let observed = requests.lock().expect("request capture lock").clone();
    assert!(observed[0].starts_with("GET /ops-bridge/v1/teams-activity?connection=connection%3Aone&sort=observed_at_desc&page_size=100"));
    assert!(observed[1].starts_with("GET /ops-bridge/v1/research/research:one "));
    assert!(observed[2].starts_with("GET /ops-bridge/v1/repositories/repository:one "));
    assert!(observed[3].starts_with("GET /ops-bridge/v1/repositories/repository:two "));
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
