//! Cloud Storage through the JSON API: list a prefix, read an object (whole
//! or its first bytes), write one (optionally only if it does not exist yet)
//! and delete one by its exact name.
//!
//! Nothing is retried here except once after HTTP 401 with a new token;
//! [`GcsErrorKind`] tells the caller whether trying again makes sense. A
//! write only-if-absent that finds the object already there with exactly
//! the bytes it was sending counts as done (the answer to an earlier send
//! was lost). Every request has an overall time limit.

use std::time::Duration;

use bytes::Bytes;
use reqwest::{header, StatusCode, Url};
use serde::Deserialize;

use crate::token::{AccessToken, Tokens};

/// The Cloud Storage endpoint.
pub const GCS_URL: &str = "https://storage.googleapis.com";
/// Longest a request may take, upload or download included.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
/// Largest JSON answer (a list page, an object resource) read.
const MAX_JSON: u64 = 16 * 1024 * 1024;

/// What kind of failure, so the caller can decide: try again later, stop
/// everything, or treat it as an answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GcsErrorKind {
    /// No token could be had, or the token was refused (HTTP 401).
    Auth,
    /// The account may not do this (HTTP 403).
    Permission,
    /// No such object or bucket (HTTP 404).
    NotFound,
    /// A precondition failed (HTTP 412): a write only-if-absent found the
    /// object already there, or a generation-matched delete found it
    /// written again.
    AlreadyExists,
    /// Too many requests for now (HTTP 429, or 403 `rateLimitExceeded` /
    /// `userRateLimitExceeded`): wait, then try again.
    RateLimited,
    /// A quota is used up (HTTP 403 `quotaExceeded` /
    /// `dailyLimitExceeded`): stop.
    Quota,
    /// Worth trying again later: HTTP 5xx or 408, a lost connection, a
    /// timeout.
    Transient,
    /// Anything else.
    Other,
}

/// A failed Cloud Storage call. Holds the HTTP status and Google's message,
/// never a token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GcsError {
    /// What kind of failure.
    pub kind: GcsErrorKind,
    /// HTTP status, when a server answered.
    pub status: Option<u16>,
    /// Google's message, or what went wrong on the way.
    pub message: String,
}

impl std::fmt::Display for GcsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(status) => write!(f, "{:?} (HTTP {status}): {}", self.kind, self.message),
            None => write!(f, "{:?}: {}", self.kind, self.message),
        }
    }
}

impl std::error::Error for GcsError {}

impl GcsError {
    fn new(kind: GcsErrorKind, status: Option<u16>, message: impl Into<String>) -> Self {
        Self {
            kind,
            status,
            message: message.into(),
        }
    }
}

/// One stored object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectInfo {
    /// Full object name.
    pub name: String,
    /// Size in bytes.
    pub size: u64,
    /// Generation: changes every time the object is written.
    pub generation: u64,
    /// Last write, UTC ms.
    pub updated_unix_ms: u64,
}

/// How a write treats an object that is already there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Write {
    /// Replace it.
    Overwrite,
    /// Leave it and fail with [`GcsErrorKind::AlreadyExists`]
    /// (`ifGenerationMatch=0`).
    IfAbsent,
}

/// Object resource as the JSON API sends it (numbers as strings).
#[derive(Deserialize)]
struct RawObject {
    name: String,
    size: String,
    generation: String,
    updated: String,
}

impl RawObject {
    fn parse(self) -> Result<ObjectInfo, GcsError> {
        let bad = |what: &str| GcsError::new(GcsErrorKind::Other, None, format!("bad {what}"));
        let updated = chrono::DateTime::parse_from_rfc3339(&self.updated)
            .map_err(|_| bad("updated"))?
            .timestamp_millis();
        Ok(ObjectInfo {
            size: self.size.parse().map_err(|_| bad("size"))?,
            generation: self.generation.parse().map_err(|_| bad("generation"))?,
            updated_unix_ms: u64::try_from(updated).map_err(|_| bad("updated"))?,
            name: self.name,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Listing {
    #[serde(default)]
    items: Vec<RawObject>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FolderListing {
    #[serde(default)]
    prefixes: Vec<String>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Deserialize)]
struct ErrorBody {
    message: Option<String>,
    #[serde(default)]
    errors: Vec<ErrorItem>,
}

#[derive(Deserialize)]
struct ErrorItem {
    reason: Option<String>,
}

/// Reasons of an HTTP 403 that mean "not so fast", not a missing permission.
const RATE_REASONS: [&str; 2] = ["rateLimitExceeded", "userRateLimitExceeded"];
/// Reasons of an HTTP 403 that mean a quota is used up.
const QUOTA_REASONS: [&str; 2] = ["quotaExceeded", "dailyLimitExceeded"];

/// A Cloud Storage client.
#[derive(Debug)]
pub struct Gcs {
    http: reqwest::Client,
    tokens: Tokens,
    base: Url,
    request_timeout: Duration,
}

impl Gcs {
    /// A client for the real Cloud Storage.
    pub fn new(tokens: Tokens) -> Result<Self, GcsError> {
        Self::with_base_url(tokens, GCS_URL)
    }

    /// A client for a server at `base_url` (tests).
    pub fn with_base_url(tokens: Tokens, base_url: &str) -> Result<Self, GcsError> {
        let other = |message: String| GcsError::new(GcsErrorKind::Other, None, message);
        let base = Url::parse(base_url).map_err(|error| other(format!("base URL: {error}")))?;
        if base.cannot_be_a_base() {
            return Err(other("base URL cannot hold a path".to_string()));
        }
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(120))
            .build()
            .map_err(|error| other(format!("http client: {error}")))?;
        Ok(Self {
            http,
            tokens,
            base,
            request_timeout: REQUEST_TIMEOUT,
        })
    }

    /// The same with another overall time limit per request (tests).
    pub fn with_request_timeout(mut self, timeout: Duration) -> Self {
        self.request_timeout = timeout;
        self
    }

    /// `base` + the path `segments`, each percent-encoded on its own (an
    /// object name's `/` becomes `%2F`, as the JSON API wants).
    fn url(&self, segments: &[&str]) -> Url {
        let mut url = self.base.clone();
        if let Ok(mut path) = url.path_segments_mut() {
            path.pop_if_empty().extend(segments);
        }
        url
    }

    /// Send with a token; after HTTP 401, once more with a new token.
    async fn send(
        &self,
        build: impl Fn(&reqwest::Client) -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, GcsError> {
        let (response, token) = self.attempt(&build).await?;
        if response.status() != StatusCode::UNAUTHORIZED {
            return Ok(response);
        }
        self.tokens.forget(&token).await;
        Ok(self.attempt(&build).await?.0)
    }

    async fn attempt(
        &self,
        build: &impl Fn(&reqwest::Client) -> reqwest::RequestBuilder,
    ) -> Result<(reqwest::Response, AccessToken), GcsError> {
        let token = self.tokens.token().await.map_err(|error| {
            // A token source that did not answer is worth another try; one
            // that said no is not.
            let kind = if error.is_transient() {
                GcsErrorKind::Transient
            } else {
                GcsErrorKind::Auth
            };
            GcsError::new(kind, None, error.to_string())
        })?;
        let response = build(&self.http)
            .bearer_auth(token.secret())
            .timeout(self.request_timeout)
            .send()
            .await
            .map_err(transport)?;
        Ok((response, token))
    }

    /// The "folders" right under `prefix` (which should end with `/`): each
    /// distinct `prefix` + next name part + `/` (JSON API `delimiter=/`),
    /// following page tokens to the end. Objects themselves are not listed.
    pub async fn list_folders(&self, bucket: &str, prefix: &str) -> Result<Vec<String>, GcsError> {
        let mut folders = Vec::new();
        let mut page: Option<String> = None;
        loop {
            let mut url = self.url(&["storage", "v1", "b", bucket, "o"]);
            {
                let mut query = url.query_pairs_mut();
                query.append_pair("prefix", prefix);
                query.append_pair("delimiter", "/");
                query.append_pair("fields", "prefixes,nextPageToken");
                if let Some(page) = &page {
                    query.append_pair("pageToken", page);
                }
            }
            let response = success(self.send(|http| http.get(url.clone())).await?).await?;
            let listing: FolderListing = read_json(response).await?;
            folders.extend(listing.prefixes);
            match listing.next_page_token {
                Some(next) if !next.is_empty() => {
                    if page.as_deref() == Some(next.as_str()) {
                        return Err(GcsError::new(
                            GcsErrorKind::Other,
                            None,
                            "the same page token twice",
                        ));
                    }
                    page = Some(next);
                }
                _ => {
                    folders.sort();
                    folders.dedup();
                    return Ok(folders);
                }
            }
        }
    }

    /// Every object whose name starts with `prefix`, following page tokens
    /// to the end.
    pub async fn list(&self, bucket: &str, prefix: &str) -> Result<Vec<ObjectInfo>, GcsError> {
        let mut objects = Vec::new();
        let mut page: Option<String> = None;
        loop {
            let mut url = self.url(&["storage", "v1", "b", bucket, "o"]);
            {
                let mut query = url.query_pairs_mut();
                query.append_pair("prefix", prefix);
                query.append_pair(
                    "fields",
                    "items(name,size,generation,updated),nextPageToken",
                );
                if let Some(page) = &page {
                    query.append_pair("pageToken", page);
                }
            }
            let response = success(self.send(|http| http.get(url.clone())).await?).await?;
            let listing: Listing = read_json(response).await?;
            for object in listing.items {
                objects.push(object.parse()?);
            }
            match listing.next_page_token {
                Some(next) if !next.is_empty() => {
                    if page.as_deref() == Some(next.as_str()) {
                        return Err(GcsError::new(
                            GcsErrorKind::Other,
                            None,
                            "the same page token twice",
                        ));
                    }
                    page = Some(next);
                }
                _ => return Ok(objects),
            }
        }
    }

    /// The whole object; fails with [`GcsErrorKind::Other`] when it is
    /// larger than `max_len` bytes.
    pub async fn get(&self, bucket: &str, name: &str, max_len: u64) -> Result<Bytes, GcsError> {
        let url = self.media_url(bucket, name);
        let response = success(self.send(|http| http.get(url.clone())).await?).await?;
        read_limited(response, max_len).await
    }

    /// The object as it was at `generation` (fails with
    /// [`GcsErrorKind::NotFound`] once it was written again), at most
    /// `max_len` bytes.
    pub async fn get_generation(
        &self,
        bucket: &str,
        name: &str,
        generation: u64,
        max_len: u64,
    ) -> Result<Bytes, GcsError> {
        let mut url = self.media_url(bucket, name);
        url.query_pairs_mut()
            .append_pair("generation", &generation.to_string());
        let response = success(self.send(|http| http.get(url.clone())).await?).await?;
        read_limited(response, max_len).await
    }

    /// What is stored under `name` (size, generation, last write).
    pub async fn stat(&self, bucket: &str, name: &str) -> Result<ObjectInfo, GcsError> {
        let url = self.url(&["storage", "v1", "b", bucket, "o", name]);
        let response = success(self.send(|http| http.get(url.clone())).await?).await?;
        let object: RawObject = read_json(response).await?;
        object.parse()
    }

    /// The first `len` bytes of the object (fewer when it is shorter).
    pub async fn get_start(&self, bucket: &str, name: &str, len: u64) -> Result<Bytes, GcsError> {
        if len == 0 {
            return Ok(Bytes::new());
        }
        let url = self.media_url(bucket, name);
        let range = format!("bytes=0-{}", len - 1);
        let response = self
            .send(|http| http.get(url.clone()).header(header::RANGE, &range))
            .await?;
        // An empty object has no byte 0.
        if response.status() == StatusCode::RANGE_NOT_SATISFIABLE {
            return Ok(Bytes::new());
        }
        // A server that ignores Range sends everything: stop at `len`.
        read_prefix(success(response).await?, len).await
    }

    fn media_url(&self, bucket: &str, name: &str) -> Url {
        let mut url = self.url(&["storage", "v1", "b", bucket, "o", name]);
        url.query_pairs_mut().append_pair("alt", "media");
        url
    }

    /// Write `body` as `name`. With [`Write::IfAbsent`] an existing object
    /// is left alone and the call fails with
    /// [`GcsErrorKind::AlreadyExists`] — unless it holds exactly `body`
    /// (an earlier send got through but its answer was lost): then it
    /// counts as written.
    pub async fn put(
        &self,
        bucket: &str,
        name: &str,
        body: impl Into<Bytes>,
        content_type: &str,
        write: Write,
    ) -> Result<ObjectInfo, GcsError> {
        let body: Bytes = body.into();
        let mut url = self.url(&["upload", "storage", "v1", "b", bucket, "o"]);
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("uploadType", "media");
            query.append_pair("name", name);
            if write == Write::IfAbsent {
                query.append_pair("ifGenerationMatch", "0");
            }
        }
        let response = self
            .send(|http| {
                http.post(url.clone())
                    .header(header::CONTENT_TYPE, content_type)
                    .body(body.clone())
            })
            .await?;
        match success(response).await {
            Ok(response) => {
                let object: RawObject = read_json(response).await?;
                object.parse()
            }
            Err(error) if error.kind == GcsErrorKind::AlreadyExists && write == Write::IfAbsent => {
                match self.holding(bucket, name, &body).await {
                    Some(object) => Ok(object),
                    None => Err(error),
                }
            }
            Err(error) => Err(error),
        }
    }

    /// The object under `name`, when it holds exactly `body`.
    async fn holding(&self, bucket: &str, name: &str, body: &Bytes) -> Option<ObjectInfo> {
        let object = self.stat(bucket, name).await.ok()?;
        if object.size != body.len() as u64 {
            return None;
        }
        let stored = self
            .get_generation(bucket, name, object.generation, object.size)
            .await
            .ok()?;
        (stored == *body).then_some(object)
    }

    /// Delete the one object called exactly `name`.
    pub async fn delete(&self, bucket: &str, name: &str) -> Result<(), GcsError> {
        let url = self.url(&["storage", "v1", "b", bucket, "o", name]);
        success(self.send(|http| http.delete(url.clone())).await?).await?;
        Ok(())
    }

    /// Delete the one object called exactly `name`, only while it is still
    /// at `generation`; otherwise fail with [`GcsErrorKind::AlreadyExists`]
    /// (HTTP 412: it was written again since).
    pub async fn delete_if_generation(
        &self,
        bucket: &str,
        name: &str,
        generation: u64,
    ) -> Result<(), GcsError> {
        let mut url = self.url(&["storage", "v1", "b", bucket, "o", name]);
        url.query_pairs_mut()
            .append_pair("ifGenerationMatch", &generation.to_string());
        success(self.send(|http| http.delete(url.clone())).await?).await?;
        Ok(())
    }
}

/// The response if it succeeded, else its error.
async fn success(response: reqwest::Response) -> Result<reqwest::Response, GcsError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.text().await.unwrap_or_default();
    let (message, reasons) = match serde_json::from_str::<ErrorEnvelope>(&body) {
        Ok(envelope) => (
            envelope.error.message,
            envelope
                .error
                .errors
                .into_iter()
                .filter_map(|item| item.reason)
                .collect(),
        ),
        Err(_) => (None, Vec::new()),
    };
    let any = |list: &[&str]| reasons.iter().any(|reason| list.contains(&reason.as_str()));
    let kind = match status.as_u16() {
        401 => GcsErrorKind::Auth,
        403 if any(&RATE_REASONS) => GcsErrorKind::RateLimited,
        403 if any(&QUOTA_REASONS) => GcsErrorKind::Quota,
        403 => GcsErrorKind::Permission,
        404 => GcsErrorKind::NotFound,
        412 => GcsErrorKind::AlreadyExists,
        429 => GcsErrorKind::RateLimited,
        408 | 500..=599 => GcsErrorKind::Transient,
        _ => GcsErrorKind::Other,
    };
    let message = message.unwrap_or_else(|| {
        status
            .canonical_reason()
            .unwrap_or("no message")
            .to_string()
    });
    Err(GcsError::new(
        kind,
        Some(status.as_u16()),
        message.chars().take(300).collect::<String>(),
    ))
}

fn transport(error: reqwest::Error) -> GcsError {
    GcsError::new(GcsErrorKind::Transient, None, error.to_string())
}

/// The body, or [`GcsErrorKind::Other`] as soon as it passes `max_len`.
async fn read_limited(mut response: reqwest::Response, max_len: u64) -> Result<Bytes, GcsError> {
    let too_large = || {
        GcsError::new(
            GcsErrorKind::Other,
            None,
            format!("object larger than {max_len} bytes"),
        )
    };
    if response.content_length().is_some_and(|len| len > max_len) {
        return Err(too_large());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(transport)? {
        if (body.len() + chunk.len()) as u64 > max_len {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(body))
}

/// The first `len` bytes of the body; the rest is not read.
async fn read_prefix(mut response: reqwest::Response, len: u64) -> Result<Bytes, GcsError> {
    let len = usize::try_from(len).unwrap_or(usize::MAX);
    let mut body = Vec::new();
    while body.len() < len {
        let Some(chunk) = response.chunk().await.map_err(transport)? else {
            break;
        };
        let take = chunk.len().min(len - body.len());
        body.extend_from_slice(&chunk[..take]);
    }
    Ok(Bytes::from(body))
}

async fn read_json<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, GcsError> {
    let bytes = read_limited(response, MAX_JSON).await?;
    serde_json::from_slice(&bytes)
        .map_err(|error| GcsError::new(GcsErrorKind::Other, None, format!("bad answer: {error}")))
}
