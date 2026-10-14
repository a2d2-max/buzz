//! The client against the fake Cloud Storage and metadata server of
//! `buzz_gcp::fake` (127.0.0.1, no network).

use std::time::{Duration, Instant};

use buzz_gcp::fake::FakeGcs;
use buzz_gcp::gcs::{Gcs, GcsErrorKind, ObjectInfo, Write};
use buzz_gcp::token::{AccessToken, TokenError, TokenSource, Tokens};
use serde_json::json;

const BUCKET: &str = "bucket";
/// Largest object read in these tests.
const MAX: u64 = 1 << 20;

/// A fake with tokens from its metadata server lasting `expires_in` s.
async fn client(expires_in: u64) -> (Gcs, FakeGcs) {
    let fake = FakeGcs::start(expires_in).await;
    let tokens = Tokens::new(TokenSource::MetadataServer {
        base_url: fake.url().to_string(),
    })
    .expect("tokens");
    (
        Gcs::with_base_url(tokens, fake.url()).expect("client"),
        fake,
    )
}

fn kind<T: std::fmt::Debug>(
    result: Result<T, buzz_gcp::gcs::GcsError>,
) -> (GcsErrorKind, Option<u16>) {
    let error = result.expect_err("an error");
    (error.kind, error.status)
}

#[tokio::test]
async fn objects_round_trip() {
    let (gcs, fake) = client(3_600).await;
    let name = "test/dir/a.txt";
    let first = gcs
        .put(
            BUCKET,
            name,
            b"hello world".to_vec(),
            "text/plain",
            Write::IfAbsent,
        )
        .await
        .expect("put");
    assert_eq!(first.name, name);
    assert_eq!(first.size, 11);
    assert_eq!(first.updated_unix_ms, 1_791_781_200_123);
    assert_eq!(
        fake.objects(BUCKET)[name].content_type,
        "text/plain",
        "content type sent"
    );
    assert_eq!(
        gcs.get(BUCKET, name, MAX).await.expect("get"),
        "hello world"
    );
    assert_eq!(
        gcs.get_start(BUCKET, name, 5).await.expect("start"),
        "hello"
    );
    assert_eq!(
        gcs.get_start(BUCKET, name, 100).await.expect("start"),
        "hello world"
    );
    let calls = fake.storage_calls();
    assert!(gcs
        .get_start(BUCKET, name, 0)
        .await
        .expect("start")
        .is_empty());
    assert_eq!(fake.storage_calls(), calls, "no call for 0 bytes");

    // Writing only-if-absent over an existing object: 412, left alone.
    assert_eq!(
        kind(
            gcs.put(
                BUCKET,
                name,
                b"other".to_vec(),
                "text/plain",
                Write::IfAbsent
            )
            .await
        ),
        (GcsErrorKind::AlreadyExists, Some(412))
    );
    assert_eq!(
        gcs.get(BUCKET, name, MAX).await.expect("get"),
        "hello world"
    );
    let second = gcs
        .put(
            BUCKET,
            name,
            b"replaced".to_vec(),
            "text/plain",
            Write::Overwrite,
        )
        .await
        .expect("overwrite");
    assert!(second.generation > first.generation);

    // Five under test/, one elsewhere; pages of two are followed to the end.
    for n in 0..4 {
        gcs.put(
            BUCKET,
            &format!("test/{n}"),
            vec![n; 3],
            "application/octet-stream",
            Write::IfAbsent,
        )
        .await
        .expect("put");
    }
    gcs.put(
        BUCKET,
        "other/x",
        b"x".to_vec(),
        "text/plain",
        Write::IfAbsent,
    )
    .await
    .expect("put");
    // An empty object has no byte 0 (HTTP 416): its start is empty.
    gcs.put(BUCKET, "empty", Vec::new(), "text/plain", Write::IfAbsent)
        .await
        .expect("put");
    assert!(gcs
        .get_start(BUCKET, "empty", 36)
        .await
        .expect("start")
        .is_empty());

    let before = fake.list_calls();
    let listed = gcs.list(BUCKET, "test/").await.expect("list");
    assert_eq!(fake.list_calls() - before, 3, "3 pages");
    let names: Vec<_> = listed.iter().map(|o| o.name.as_str()).collect();
    assert_eq!(names, ["test/0", "test/1", "test/2", "test/3", name]);
    let a: &ObjectInfo = &listed[4];
    assert_eq!((a.size, a.generation), (8, second.generation));

    // Delete removes exactly that one name.
    gcs.delete(BUCKET, name).await.expect("delete");
    assert_eq!(
        kind(gcs.get(BUCKET, name, MAX).await),
        (GcsErrorKind::NotFound, Some(404))
    );
    assert_eq!(
        kind(gcs.delete(BUCKET, name).await),
        (GcsErrorKind::NotFound, Some(404))
    );
    assert_eq!(gcs.list(BUCKET, "test/").await.expect("list").len(), 4);
    assert_eq!(gcs.list(BUCKET, "other/").await.expect("list").len(), 1);
    assert!(gcs.list(BUCKET, "none/").await.expect("list").is_empty());
}

#[tokio::test]
async fn failures_are_sorted_into_kinds() {
    let (gcs, fake) = client(3_600).await;
    let reason = |status: u16, reason: &str| {
        (
            status,
            json!({"error": {"code": status, "message": "m", "errors": [{"reason": reason}]}}),
        )
    };
    let cases = [
        (reason(403, "forbidden"), GcsErrorKind::Permission),
        (reason(403, "rateLimitExceeded"), GcsErrorKind::RateLimited),
        (
            reason(403, "userRateLimitExceeded"),
            GcsErrorKind::RateLimited,
        ),
        (reason(403, "quotaExceeded"), GcsErrorKind::Quota),
        (reason(403, "dailyLimitExceeded"), GcsErrorKind::Quota),
        (reason(429, "rateLimitExceeded"), GcsErrorKind::RateLimited),
        (reason(503, "backendError"), GcsErrorKind::Transient),
        (reason(500, "internalError"), GcsErrorKind::Transient),
        (reason(408, "requestTimeout"), GcsErrorKind::Transient),
        (reason(400, "invalid"), GcsErrorKind::Other),
        (reason(404, "notFound"), GcsErrorKind::NotFound),
        (reason(412, "conditionNotMet"), GcsErrorKind::AlreadyExists),
    ];
    for ((status, body), expected) in cases {
        fake.fail_next(status, body);
        assert_eq!(
            kind(gcs.get(BUCKET, "x", MAX).await),
            (expected, Some(status)),
            "HTTP {status}"
        );
    }

    // Refused twice (the retry with a new token too): an auth failure.
    fake.refuse_next(2);
    assert_eq!(
        kind(gcs.get(BUCKET, "x", MAX).await),
        (GcsErrorKind::Auth, Some(401))
    );

    // Nothing listening: transient.
    let closed = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        format!("http://{}", listener.local_addr().expect("address"))
    };
    let unreachable = Gcs::with_base_url(
        Tokens::new(TokenSource::Static(AccessToken::new("t"))).expect("tokens"),
        &closed,
    )
    .expect("client");
    assert_eq!(
        kind(unreachable.get(BUCKET, "x", MAX).await),
        (GcsErrorKind::Transient, None)
    );
    // A metadata server that does not answer: worth another try.
    let no_token = Gcs::with_base_url(
        Tokens::new(TokenSource::MetadataServer { base_url: closed }).expect("tokens"),
        "http://127.0.0.1:9",
    )
    .expect("client");
    assert_eq!(
        kind(no_token.get(BUCKET, "x", MAX).await),
        (GcsErrorKind::Transient, None)
    );
}

#[tokio::test]
async fn tokens_are_kept_until_five_minutes_before_expiry() {
    // A one-hour token serves many calls.
    let (gcs, fake) = client(3_600).await;
    for _ in 0..3 {
        gcs.list(BUCKET, "").await.expect("list");
    }
    assert_eq!(fake.tokens_issued(), 1);

    // A token with less than five minutes left is replaced before use.
    let (gcs, fake) = client(299).await;
    for _ in 0..3 {
        gcs.list(BUCKET, "").await.expect("list");
    }
    assert_eq!(fake.tokens_issued(), 3);
}

#[tokio::test]
async fn a_refused_token_is_replaced_once() {
    let (gcs, fake) = client(3_600).await;
    gcs.list(BUCKET, "").await.expect("first token");
    fake.refuse_next(1);
    let before = fake.storage_calls();
    gcs.list(BUCKET, "").await.expect("second token");
    assert_eq!(fake.storage_calls() - before, 2);
    assert_eq!(fake.tokens_issued(), 2);
}

#[tokio::test]
async fn tokens_never_show_in_errors_or_debug_output() {
    const SECRET: &str = "ya29.very-secret-token";
    let fake = FakeGcs::start(3_600).await;
    let url = fake.url().to_string();
    let tokens = Tokens::new(TokenSource::Static(AccessToken::new(SECRET))).expect("tokens");
    assert_eq!(tokens.token().await.expect("token").secret(), SECRET);
    assert_eq!(
        format!("{:?}", AccessToken::new(SECRET)),
        "AccessToken(***)"
    );
    let gcs = Gcs::with_base_url(tokens, &url).expect("client");
    // The fake accepts another token: every call is refused.
    fake.accept_token("something-else");
    let error = gcs.get(BUCKET, "x", MAX).await.expect_err("refused");
    assert_eq!(error.kind, GcsErrorKind::Auth);
    for text in [format!("{error}"), format!("{error:?}"), format!("{gcs:?}")] {
        assert!(!text.contains(SECRET), "{text}");
    }
}

/// A stand-in `gcloud`: checks its arguments, counts its runs, prints or
/// fails as told.
fn fake_gcloud(dir: &std::path::Path, body: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join("gcloud");
    let script = format!(
        "#!/bin/sh\n[ \"$1 $2\" = \"auth print-access-token\" ] || exit 3\necho run >> \"{}\"\n{body}\n",
        dir.join("runs").display()
    );
    std::fs::write(&path, script).expect("script");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).expect("chmod");
    path
}

#[tokio::test]
async fn gcloud_tokens_are_read_and_kept_for_a_while() {
    let dir = tempfile::tempdir().expect("tempdir");
    let program = fake_gcloud(dir.path(), "echo '  ya29.from-gcloud  '");
    let tokens = Tokens::new(TokenSource::Gcloud {
        program,
        timeout: Duration::from_secs(10),
    })
    .expect("tokens");
    for _ in 0..2 {
        assert_eq!(
            tokens.token().await.expect("token").secret(),
            "ya29.from-gcloud"
        );
    }
    let runs = std::fs::read_to_string(dir.path().join("runs")).expect("runs");
    assert_eq!(runs.lines().count(), 1, "asked once");

    let dir = tempfile::tempdir().expect("tempdir");
    let program = fake_gcloud(
        dir.path(),
        "echo 'ERROR: (gcloud.auth.print-access-token) no active account' >&2\nexit 1",
    );
    let tokens = Tokens::new(TokenSource::Gcloud {
        program,
        timeout: Duration::from_secs(10),
    })
    .expect("tokens");
    match tokens.token().await {
        Err(TokenError::Gcloud {
            message,
            transient: false,
        }) => assert!(message.contains("no active account")),
        other => panic!("{other:?}"),
    }
}

/// A generation-matched delete removes the object only while nobody wrote
/// it again.
#[tokio::test]
async fn a_generation_matched_delete_leaves_a_newer_object() {
    let (gcs, fake) = client(3_600).await;
    let old = gcs
        .put(
            BUCKET,
            "lease",
            b"a".to_vec(),
            "application/json",
            Write::IfAbsent,
        )
        .await
        .expect("put");
    let new = gcs
        .put(
            BUCKET,
            "lease",
            b"b".to_vec(),
            "application/json",
            Write::Overwrite,
        )
        .await
        .expect("put");
    assert_eq!(
        kind(
            gcs.delete_if_generation(BUCKET, "lease", old.generation)
                .await
        ),
        (GcsErrorKind::AlreadyExists, Some(412))
    );
    assert_eq!(
        gcs.get(BUCKET, "lease", MAX).await.expect("still there"),
        "b"
    );
    gcs.delete_if_generation(BUCKET, "lease", new.generation)
        .await
        .expect("delete");
    assert!(fake.objects(BUCKET).is_empty());
}

/// A token source that does not answer is worth another try; one that says
/// no is an authentication failure.
#[tokio::test]
async fn token_failures_are_transient_or_auth() {
    let (gcs, fake) = client(3_600).await;
    fake.fail_metadata_next(503);
    assert_eq!(
        kind(gcs.get(BUCKET, "x", MAX).await),
        (GcsErrorKind::Transient, None)
    );
    fake.fail_metadata_next(403);
    assert_eq!(
        kind(gcs.get(BUCKET, "x", MAX).await),
        (GcsErrorKind::Auth, None)
    );
    gcs.list(BUCKET, "").await.expect("a token at last");
}

/// A token due for refresh is fetched by one caller; the others keep the
/// old one (still valid) instead of waiting.
#[tokio::test]
async fn one_caller_refreshes_while_the_others_keep_the_old_token() {
    // 299 s: due for refresh at once, valid for almost five minutes.
    let fake = FakeGcs::start(299).await;
    let tokens = Tokens::new(TokenSource::MetadataServer {
        base_url: fake.url().to_string(),
    })
    .expect("tokens");
    assert_eq!(tokens.token().await.expect("first").secret(), "tok-1");
    let (a, b, c, d, e) = tokio::join!(
        tokens.token(),
        tokens.token(),
        tokens.token(),
        tokens.token(),
        tokens.token()
    );
    let mut got: Vec<String> = [a, b, c, d, e]
        .into_iter()
        .map(|token| token.expect("token").secret().to_string())
        .collect();
    got.sort();
    assert_eq!(got, ["tok-1", "tok-1", "tok-1", "tok-1", "tok-2"]);
    assert_eq!(fake.tokens_issued(), 2);
}

/// Forgetting a refused token does not throw away a newer one.
#[tokio::test]
async fn forget_drops_only_the_refused_token() {
    let fake = FakeGcs::start(3_600).await;
    let tokens = Tokens::new(TokenSource::MetadataServer {
        base_url: fake.url().to_string(),
    })
    .expect("tokens");
    let first = tokens.token().await.expect("first");
    tokens.forget(&first).await;
    let second = tokens.token().await.expect("second");
    assert_eq!(second.secret(), "tok-2");
    tokens.forget(&first).await;
    assert_eq!(tokens.token().await.expect("kept"), second);
    assert_eq!(fake.tokens_issued(), 2);
}

/// A gcloud that hangs is killed after its time limit; that is worth
/// another try.
#[tokio::test]
async fn a_hanging_gcloud_is_killed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let program = fake_gcloud(dir.path(), "sleep 30");
    let tokens = Tokens::new(TokenSource::Gcloud {
        program,
        timeout: Duration::from_millis(300),
    })
    .expect("tokens");
    let started = Instant::now();
    let error = tokens.token().await.expect_err("killed");
    assert!(error.is_transient(), "{error}");
    assert!(started.elapsed() < Duration::from_secs(5));
}

/// A server that takes a request and never answers hits the overall time
/// limit.
#[tokio::test]
async fn a_request_that_hangs_times_out() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let url = format!("http://{}", listener.local_addr().expect("address"));
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((socket, _)) = listener.accept().await {
            held.push(socket);
        }
    });
    let gcs = Gcs::with_base_url(
        Tokens::new(TokenSource::Static(AccessToken::new("t"))).expect("tokens"),
        &url,
    )
    .expect("client")
    .with_request_timeout(Duration::from_millis(300));
    let started = Instant::now();
    assert_eq!(
        kind(gcs.get(BUCKET, "x", MAX).await),
        (GcsErrorKind::Transient, None)
    );
    assert!(started.elapsed() < Duration::from_secs(5));
}

/// A read stops at its size limit.
#[tokio::test]
async fn reads_stop_at_their_size_limit() {
    let (gcs, _fake) = client(3_600).await;
    gcs.put(
        BUCKET,
        "eleven",
        b"hello world".to_vec(),
        "text/plain",
        Write::IfAbsent,
    )
    .await
    .expect("put");
    assert_eq!(
        kind(gcs.get(BUCKET, "eleven", 5).await),
        (GcsErrorKind::Other, None)
    );
    assert_eq!(
        gcs.get(BUCKET, "eleven", 11).await.expect("fits"),
        "hello world"
    );
}

/// Writing only-if-absent the very bytes already stored counts as done (an
/// earlier send whose answer was lost); other bytes are refused.
#[tokio::test]
async fn the_same_bytes_written_again_only_if_absent_count_as_done() {
    let (gcs, fake) = client(3_600).await;
    let first = gcs
        .put(
            BUCKET,
            "chunk",
            b"abc".to_vec(),
            "application/octet-stream",
            Write::IfAbsent,
        )
        .await
        .expect("put");
    let again = gcs
        .put(
            BUCKET,
            "chunk",
            b"abc".to_vec(),
            "application/octet-stream",
            Write::IfAbsent,
        )
        .await
        .expect("same bytes: done");
    assert_eq!(again.generation, first.generation, "not written twice");
    assert_eq!(fake.objects(BUCKET)["chunk"].generation, first.generation);
    assert_eq!(
        kind(
            gcs.put(
                BUCKET,
                "chunk",
                b"abd".to_vec(),
                "application/octet-stream",
                Write::IfAbsent
            )
            .await
        ),
        (GcsErrorKind::AlreadyExists, Some(412))
    );
}

/// Folders right under a prefix, over several pages; objects are not
/// listed as folders.
#[tokio::test]
async fn folders_under_a_prefix_are_listed_once_each() {
    let (gcs, _fake) = client(3_600).await;
    for name in [
        "huddles/c1/ch1/s1/chunk-000000.bhr",
        "huddles/c1/ch1/s1/chunk-000001.bhr",
        "huddles/c1/ch2/s2/chunk-000000.bhr",
        "huddles/c2/ch3/s3/chunk-000000.bhr",
        "huddles/c3/ch4/s4/chunk-000000.bhr",
        "huddles/loose.txt",
        "other/c9/x",
    ] {
        gcs.put(BUCKET, name, b"x".to_vec(), "text/plain", Write::IfAbsent)
            .await
            .expect("put");
    }
    assert_eq!(
        gcs.list_folders(BUCKET, "huddles/")
            .await
            .expect("communities"),
        // Pages of two entries: c1, c2 | c3, loose.txt.
        ["huddles/c1/", "huddles/c2/", "huddles/c3/"]
    );
    assert_eq!(
        gcs.list_folders(BUCKET, "huddles/c1/")
            .await
            .expect("channels"),
        ["huddles/c1/ch1/", "huddles/c1/ch2/"]
    );
    assert!(gcs
        .list_folders(BUCKET, "huddles/c1/ch1/s1/")
        .await
        .expect("no folders")
        .is_empty());
}
