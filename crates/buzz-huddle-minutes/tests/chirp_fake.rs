//! Chirp 3 client against a fake Speech-to-Text server on 127.0.0.1 (no
//! network): the address, headers and body it sends, and how it reads
//! answers and errors.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use buzz_gcp::token::{AccessToken, TokenSource, Tokens};
use buzz_huddle_minutes::chirp::ChirpStt;
use buzz_huddle_minutes::stt::{SpeechToText, SttErrorKind, SttOutput, SttRequest};
use serde_json::{json, Value};

/// What one request looked like.
#[derive(Debug, Clone)]
struct Seen {
    path: String,
    authorization: Option<String>,
    user_project: Option<String>,
    body: Value,
}

#[derive(Default)]
struct Fake {
    seen: Mutex<Vec<Seen>>,
    answers: Mutex<VecDeque<(u16, Value)>>,
}

async fn recognize(
    State(fake): State<Arc<Fake>>,
    uri: Uri,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    fake.seen.lock().expect("lock").push(Seen {
        path: uri.path().to_string(),
        authorization: header("authorization"),
        user_project: header("x-goog-user-project"),
        body,
    });
    let (status, answer) = fake
        .answers
        .lock()
        .expect("lock")
        .pop_front()
        .unwrap_or((200, json!({"metadata": {"totalBilledDuration": "0s"}})));
    (StatusCode::from_u16(status).expect("status"), Json(answer)).into_response()
}

async fn start(fake: Arc<Fake>) -> String {
    let app = Router::new()
        .route(
            "/v2/projects/{project}/locations/{location}/recognizers/{rest}",
            post(recognize),
        )
        .with_state(fake);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("address");
    tokio::spawn(async move { axum::serve(listener, app).await.expect("serve") });
    format!("http://{address}")
}

fn request(pcm: &[f32]) -> SttRequest<'_> {
    SttRequest {
        speaker: "aa",
        start_ms: 0,
        end_ms: 1_000,
        pcm_16k: pcm,
        word_times: false,
    }
}

fn error(status: u16, grpc: &str, reason: Option<(&str, &str)>) -> (u16, Value) {
    let details: Vec<Value> = reason
        .map(|(reason, quota)| {
            json!({
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                "reason": reason,
                "domain": "googleapis.com",
                "metadata": {"quota_limit": quota, "service": "speech.googleapis.com"},
            })
        })
        .into_iter()
        .collect();
    (
        status,
        json!({"error": {"code": status, "message": "m", "status": grpc, "details": details}}),
    )
}

#[tokio::test]
async fn chirp_sends_one_recognize_request_and_reads_the_answer() {
    let fake = Arc::new(Fake::default());
    let url = start(fake.clone()).await;
    let tokens = Tokens::new(TokenSource::Static(AccessToken::new("tok"))).expect("tokens");
    let stt =
        ChirpStt::with_base_url(tokens, "a2d2-lab", Some("a2d2-lab".into()), &url).expect("stt");
    fake.answers.lock().expect("lock").push_back((
        200,
        json!({
            "results": [{"alternatives": [{"transcript": "회의를 시작할게요"}], "languageCode": "ko-kr"}],
            "metadata": {"totalBilledDuration": "2s"}
        }),
    ));
    let pcm = vec![0.25f32; 16_000];
    let output = stt.transcribe(request(&pcm)).await.expect("answer");
    assert_eq!(
        output,
        SttOutput {
            text: "회의를 시작할게요".into(),
            billed_seconds: 2,
            words: None,
        }
    );
    let seen = fake.seen.lock().expect("lock").clone();
    assert_eq!(seen.len(), 1, "one piece, one request");
    assert_eq!(
        seen[0].path,
        "/v2/projects/a2d2-lab/locations/us/recognizers/_:recognize"
    );
    assert_eq!(seen[0].authorization.as_deref(), Some("Bearer tok"));
    assert_eq!(seen[0].user_project.as_deref(), Some("a2d2-lab"));
    assert_eq!(seen[0].body["config"]["model"], "chirp_3");
    let content = seen[0].body["content"].as_str().expect("content");
    assert_eq!(content.len(), 16_000 * 2 / 3 * 4 + 4, "1 s of 16-bit audio");
}

#[tokio::test]
async fn chirp_errors_come_back_sorted() {
    let fake = Arc::new(Fake::default());
    let url = start(fake.clone()).await;
    let tokens = Tokens::new(TokenSource::Static(AccessToken::new("tok"))).expect("tokens");
    let stt = ChirpStt::with_base_url(tokens, "a2d2-lab", None, &url).expect("stt");
    let cases = [
        (
            error(
                429,
                "RESOURCE_EXHAUSTED",
                Some((
                    "RATE_LIMIT_EXCEEDED",
                    "RecognizeRequestsPerMinutePerProject",
                )),
            ),
            SttErrorKind::RateLimited,
            "HTTP 429 RESOURCE_EXHAUSTED RATE_LIMIT_EXCEEDED",
        ),
        (
            error(
                429,
                "RESOURCE_EXHAUSTED",
                Some(("RATE_LIMIT_EXCEEDED", "RecognizeRequestsPerDayPerProject")),
            ),
            SttErrorKind::Quota,
            "HTTP 429 RESOURCE_EXHAUSTED RATE_LIMIT_EXCEEDED",
        ),
        (
            error(400, "INVALID_ARGUMENT", None),
            SttErrorKind::Rejected,
            "HTTP 400 INVALID_ARGUMENT",
        ),
        (
            error(
                403,
                "PERMISSION_DENIED",
                Some(("IAM_PERMISSION_DENIED", "")),
            ),
            SttErrorKind::Auth,
            "HTTP 403 PERMISSION_DENIED IAM_PERMISSION_DENIED",
        ),
        (
            error(503, "UNAVAILABLE", None),
            SttErrorKind::Transient,
            "HTTP 503 UNAVAILABLE",
        ),
    ];
    let pcm = vec![0.0f32; 1_600];
    for (answer, kind, code) in cases {
        fake.answers.lock().expect("lock").push_back(answer);
        let error = stt.transcribe(request(&pcm)).await.expect_err("error");
        assert_eq!((error.kind, error.code.as_str()), (kind, code));
    }
    // Nothing listening: transient.
    let closed = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        format!("http://{}", listener.local_addr().expect("address"))
    };
    let tokens = Tokens::new(TokenSource::Static(AccessToken::new("tok"))).expect("tokens");
    let unreachable = ChirpStt::with_base_url(tokens, "a2d2-lab", None, &closed).expect("stt");
    let error = unreachable
        .transcribe(request(&pcm))
        .await
        .expect_err("error");
    assert_eq!(error.kind, SttErrorKind::Transient);
}

#[tokio::test]
async fn a_refused_token_is_replaced_once_then_auth_stops() {
    let fake = Arc::new(Fake::default());
    let url = start(fake.clone()).await;
    // A metadata-like source that hands out a new token each time.
    let dir = tempfile::tempdir().expect("tempdir");
    let program = dir.path().join("gcloud");
    {
        use std::os::unix::fs::PermissionsExt;
        let counter = dir.path().join("n");
        std::fs::write(
            &program,
            format!(
                "#!/bin/sh\necho x >> \"{0}\"\necho tok-$(wc -l < \"{0}\" | tr -d ' ')\n",
                counter.display()
            ),
        )
        .expect("script");
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).expect("chmod");
    }
    let tokens = Tokens::new(TokenSource::Gcloud {
        program,
        timeout: std::time::Duration::from_secs(10),
    })
    .expect("tokens");
    let stt = ChirpStt::with_base_url(tokens, "a2d2-lab", None, &url).expect("stt");
    let unauthenticated = || error(401, "UNAUTHENTICATED", None);
    fake.answers.lock().expect("lock").extend([
        unauthenticated(),
        (200, json!({"metadata": {"totalBilledDuration": "1s"}})),
    ]);
    let pcm = vec![0.0f32; 1_600];
    stt.transcribe(request(&pcm))
        .await
        .expect("second token works");
    let tokens_sent: Vec<_> = fake
        .seen
        .lock()
        .expect("lock")
        .iter()
        .map(|seen| seen.authorization.clone().unwrap_or_default())
        .collect();
    assert_eq!(tokens_sent, ["Bearer tok-1", "Bearer tok-2"]);

    // Refused again with the new token too: stop.
    fake.answers
        .lock()
        .expect("lock")
        .extend([unauthenticated(), unauthenticated()]);
    let error = stt.transcribe(request(&pcm)).await.expect_err("refused");
    assert_eq!(error.kind, SttErrorKind::Auth);
    assert_eq!(fake.seen.lock().expect("lock").len(), 4);
}

/// A token source that does not answer is a transient failure (the piece is
/// retried); one that says no stops the run.
#[tokio::test]
async fn token_failures_are_transient_or_auth() {
    let metadata = buzz_gcp::fake::FakeGcs::start(3_600).await;
    let fake = Arc::new(Fake::default());
    let url = start(fake.clone()).await;
    let tokens = Tokens::new(TokenSource::MetadataServer {
        base_url: metadata.url().to_string(),
    })
    .expect("tokens");
    let stt = ChirpStt::with_base_url(tokens, "a2d2-lab", None, &url).expect("stt");
    let pcm = vec![0.0f32; 1_600];
    metadata.fail_metadata_next(503);
    let error = stt.transcribe(request(&pcm)).await.expect_err("no token");
    assert_eq!(error.kind, SttErrorKind::Transient);
    metadata.fail_metadata_next(403);
    let error = stt.transcribe(request(&pcm)).await.expect_err("refused");
    assert_eq!(error.kind, SttErrorKind::Auth);
    assert!(fake.seen.lock().expect("lock").is_empty(), "nothing sent");
}
