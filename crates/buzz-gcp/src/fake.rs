//! A fake Cloud Storage and metadata server on 127.0.0.1, for tests (feature
//! `fake`). It routes on the encoded path, like the real one, so an object
//! name whose `/` is not sent as `%2F` is not found.
//!
//! Supported: list (prefix, pages of [`PAGE`]), read (object resource, or
//! the bytes whole or a `Range` from byte 0, optionally at a `generation`),
//! upload (`uploadType=media`, `ifGenerationMatch=0`), delete (optionally
//! `ifGenerationMatch=<generation>`), the metadata token endpoint. Storage calls must carry the last token handed out (or the one
//! set with [`FakeGcs::accept_token`]).

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

/// Objects per list page.
pub const PAGE: usize = 2;

/// `updated` of every object.
pub const UPDATED: &str = "2026-10-12T05:00:00.123Z";

/// One stored object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stored {
    /// The bytes.
    pub bytes: Vec<u8>,
    /// Generation.
    pub generation: u64,
    /// Content type sent with the upload.
    pub content_type: String,
}

#[derive(Default)]
struct Inner {
    objects: Mutex<BTreeMap<(String, String), Stored>>,
    generations: AtomicU64,
    issued: AtomicUsize,
    expires_in: AtomicU64,
    valid: Mutex<String>,
    refuse: AtomicUsize,
    fail: Mutex<VecDeque<(u16, Value)>>,
    metadata_fail: Mutex<VecDeque<u16>>,
    storage_calls: AtomicUsize,
    list_calls: AtomicUsize,
    media_reads: AtomicUsize,
}

/// Handle to a running fake.
#[derive(Clone)]
pub struct FakeGcs {
    inner: Arc<Inner>,
    url: String,
}

impl FakeGcs {
    /// Start a fake whose metadata tokens last `expires_in` seconds.
    pub async fn start(expires_in: u64) -> Self {
        let inner = Arc::new(Inner::default());
        inner.expires_in.store(expires_in, Ordering::Relaxed);
        let app = Router::new()
            .route(
                "/computeMetadata/v1/instance/service-accounts/default/token",
                get(metadata_token),
            )
            .route("/storage/v1/b/{bucket}/o", get(list))
            .route("/storage/v1/b/{bucket}/o/{name}", get(read).delete(delete))
            .route("/upload/storage/v1/b/{bucket}/o", post(upload))
            .with_state(inner.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind 127.0.0.1");
        let address = listener.local_addr().expect("address");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            inner,
            url: format!("http://{address}"),
        }
    }

    /// Base URL, for the storage client and the metadata token source.
    pub fn url(&self) -> &str {
        &self.url
    }

    /// Accept this token on storage calls (instead of the last metadata
    /// token).
    pub fn accept_token(&self, token: &str) {
        token.clone_into(&mut self.inner.valid.lock().expect("lock"));
    }

    /// Answer the next `n` storage calls with 401.
    pub fn refuse_next(&self, n: usize) {
        self.inner.refuse.store(n, Ordering::Relaxed);
    }

    /// Answer the next storage call with `status` and `body`.
    pub fn fail_next(&self, status: u16, body: Value) {
        self.inner
            .fail
            .lock()
            .expect("lock")
            .push_back((status, body));
    }

    /// Answer the next metadata token request with `status`.
    pub fn fail_metadata_next(&self, status: u16) {
        self.inner
            .metadata_fail
            .lock()
            .expect("lock")
            .push_back(status);
    }

    /// Metadata tokens handed out so far.
    pub fn tokens_issued(&self) -> usize {
        self.inner.issued.load(Ordering::Relaxed)
    }

    /// Storage calls so far.
    pub fn storage_calls(&self) -> usize {
        self.inner.storage_calls.load(Ordering::Relaxed)
    }

    /// List calls (pages) answered so far.
    pub fn list_calls(&self) -> usize {
        self.inner.list_calls.load(Ordering::Relaxed)
    }

    /// Object bodies read (`alt=media`) so far.
    pub fn media_reads(&self) -> usize {
        self.inner.media_reads.load(Ordering::Relaxed)
    }

    /// Every object of `bucket`, by name.
    pub fn objects(&self, bucket: &str) -> BTreeMap<String, Stored> {
        self.inner
            .objects
            .lock()
            .expect("lock")
            .iter()
            .filter(|((b, _), _)| b == bucket)
            .map(|((_, name), stored)| (name.clone(), stored.clone()))
            .collect()
    }

    /// Put an object directly (no call counted).
    pub fn insert(&self, bucket: &str, name: &str, bytes: Vec<u8>) -> u64 {
        let generation = self.inner.generations.fetch_add(1, Ordering::Relaxed) + 1;
        self.inner.objects.lock().expect("lock").insert(
            (bucket.to_string(), name.to_string()),
            Stored {
                bytes,
                generation,
                content_type: "application/octet-stream".to_string(),
            },
        );
        generation
    }
}

impl Inner {
    /// The 401 / injected answer for a storage call, if any.
    fn gate(&self, headers: &HeaderMap) -> Option<Response> {
        self.storage_calls.fetch_add(1, Ordering::Relaxed);
        if let Some((status, body)) = self.fail.lock().expect("lock").pop_front() {
            let status = StatusCode::from_u16(status).expect("status");
            return Some((status, Json(body)).into_response());
        }
        let expected = format!("Bearer {}", self.valid.lock().expect("lock"));
        let given = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok());
        let refused = self
            .refuse
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_sub(1))
            .is_ok();
        if refused || given != Some(expected.as_str()) {
            return Some(error(401, "Invalid Credentials"));
        }
        None
    }
}

fn error(status: u16, message: &str) -> Response {
    (
        StatusCode::from_u16(status).expect("status"),
        Json(json!({"error": {"code": status, "message": message}})),
    )
        .into_response()
}

fn resource(bucket: &str, name: &str, stored: &Stored) -> Value {
    json!({
        "bucket": bucket,
        "name": name,
        "size": stored.bytes.len().to_string(),
        "generation": stored.generation.to_string(),
        "contentType": stored.content_type,
        "updated": UPDATED,
    })
}

async fn metadata_token(State(fake): State<Arc<Inner>>, headers: HeaderMap) -> Response {
    if headers.get("metadata-flavor").map(|v| v.as_bytes()) != Some(b"Google") {
        return StatusCode::FORBIDDEN.into_response();
    }
    if let Some(status) = fake.metadata_fail.lock().expect("lock").pop_front() {
        return StatusCode::from_u16(status)
            .expect("status")
            .into_response();
    }
    let n = fake.issued.fetch_add(1, Ordering::Relaxed) + 1;
    let token = format!("tok-{n}");
    fake.valid.lock().expect("lock").clone_from(&token);
    Json(json!({
        "access_token": token,
        "expires_in": fake.expires_in.load(Ordering::Relaxed),
        "token_type": "Bearer",
    }))
    .into_response()
}

async fn list(
    State(fake): State<Arc<Inner>>,
    Path(bucket): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Some(answer) = fake.gate(&headers) {
        return answer;
    }
    fake.list_calls.fetch_add(1, Ordering::Relaxed);
    let prefix = query.get("prefix").cloned().unwrap_or_default();
    if query.get("delimiter").map(String::as_str) == Some("/") {
        return list_folders(&fake, &bucket, &prefix, &query);
    }
    let start: usize = query
        .get("pageToken")
        .and_then(|token| token.parse().ok())
        .unwrap_or(0);
    let objects = fake.objects.lock().expect("lock");
    let matching: Vec<_> = objects
        .iter()
        .filter(|((b, name), _)| *b == bucket && name.starts_with(&prefix))
        .collect();
    let items: Vec<_> = matching
        .iter()
        .skip(start)
        .take(PAGE)
        .map(|((b, name), stored)| resource(b, name, stored))
        .collect();
    let mut body = json!({ "kind": "storage#objects" });
    if !items.is_empty() {
        body["items"] = json!(items);
    }
    if start + PAGE < matching.len() {
        body["nextPageToken"] = json!((start + PAGE).to_string());
    }
    Json(body).into_response()
}

/// A `delimiter=/` listing: entries (folders and objects right under the
/// prefix) in name order, pages of [`PAGE`] entries; only folders are
/// returned.
fn list_folders(
    fake: &Inner,
    bucket: &str,
    prefix: &str,
    query: &HashMap<String, String>,
) -> Response {
    let start: usize = query
        .get("pageToken")
        .and_then(|token| token.parse().ok())
        .unwrap_or(0);
    let objects = fake.objects.lock().expect("lock");
    let mut entries: Vec<String> = objects
        .keys()
        .filter(|(b, name)| b == bucket && name.starts_with(prefix))
        .map(|(_, name)| match name[prefix.len()..].find('/') {
            Some(cut) => name[..prefix.len() + cut + 1].to_string(),
            None => name.clone(),
        })
        .collect();
    entries.dedup();
    let page: Vec<&String> = entries.iter().skip(start).take(PAGE).collect();
    let prefixes: Vec<&String> = page.iter().copied().filter(|e| e.ends_with('/')).collect();
    let mut body = json!({ "kind": "storage#objects" });
    if !prefixes.is_empty() {
        body["prefixes"] = json!(prefixes);
    }
    if start + PAGE < entries.len() {
        body["nextPageToken"] = json!((start + PAGE).to_string());
    }
    Json(body).into_response()
}

async fn read(
    State(fake): State<Arc<Inner>>,
    Path((bucket, name)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Some(answer) = fake.gate(&headers) {
        return answer;
    }
    let objects = fake.objects.lock().expect("lock");
    let Some(stored) = objects.get(&(bucket.clone(), name.clone())) else {
        return error(404, "No such object");
    };
    if query
        .get("generation")
        .is_some_and(|generation| generation.parse::<u64>().ok() != Some(stored.generation))
    {
        return error(404, "No such object generation");
    }
    if query.get("alt").map(String::as_str) != Some("media") {
        return Json(resource(&bucket, &name, stored)).into_response();
    }
    fake.media_reads.fetch_add(1, Ordering::Relaxed);
    let Some(range) = headers.get("range") else {
        return stored.bytes.clone().into_response();
    };
    let Some(last) = range
        .to_str()
        .ok()
        .and_then(|range| range.strip_prefix("bytes=0-"))
        .and_then(|last| last.parse::<usize>().ok())
    else {
        return error(400, "unsupported range");
    };
    if stored.bytes.is_empty() {
        return StatusCode::RANGE_NOT_SATISFIABLE.into_response();
    }
    let end = (last + 1).min(stored.bytes.len());
    (StatusCode::PARTIAL_CONTENT, stored.bytes[..end].to_vec()).into_response()
}

async fn delete(
    State(fake): State<Arc<Inner>>,
    Path((bucket, name)): Path<(String, String)>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Some(answer) = fake.gate(&headers) {
        return answer;
    }
    let mut objects = fake.objects.lock().expect("lock");
    let key = (bucket, name);
    let Some(stored) = objects.get(&key) else {
        return error(404, "No such object");
    };
    if let Some(generation) = query.get("ifGenerationMatch") {
        if generation.parse::<u64>().ok() != Some(stored.generation) {
            return error(412, "Precondition Failed");
        }
    }
    objects.remove(&key);
    StatusCode::NO_CONTENT.into_response()
}

async fn upload(
    State(fake): State<Arc<Inner>>,
    Path(bucket): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Some(answer) = fake.gate(&headers) {
        return answer;
    }
    if query.get("uploadType").map(String::as_str) != Some("media") {
        return error(400, "uploadType must be media");
    }
    let Some(name) = query.get("name").cloned() else {
        return error(400, "no name");
    };
    let mut objects = fake.objects.lock().expect("lock");
    let key = (bucket.clone(), name.clone());
    if query.get("ifGenerationMatch").map(String::as_str) == Some("0") && objects.contains_key(&key)
    {
        return error(
            412,
            "At least one of the pre-conditions you specified did not hold.",
        );
    }
    let generation = fake.generations.fetch_add(1, Ordering::Relaxed) + 1;
    let content_type = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let stored = Stored {
        bytes: body.to_vec(),
        generation,
        content_type,
    };
    let answer = resource(&bucket, &name, &stored);
    objects.insert(key, stored);
    Json(answer).into_response()
}
