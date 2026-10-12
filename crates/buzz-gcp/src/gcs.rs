//! Cloud Storage through the JSON API: list a prefix, read an object (whole
//! or its first bytes), write one (optionally only if it does not exist yet)
//! and delete one by its exact name.
//!
//! Nothing is retried here except once after HTTP 401 with a new token;
//! [`GcsErrorKind`] tells the caller whether trying again makes sense.

use std::time::Duration;

use bytes::Bytes;
use reqwest::{header, StatusCode, Url};
use serde::Deserialize;

use crate::token::Tokens;

/// The Cloud Storage endpoint.
pub const GCS_URL: &str = "https://storage.googleapis.com";

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
    /// A write only-if-absent found the object already there (HTTP 412).
    AlreadyExists,
    /// A rate or quota limit (HTTP 429, or 403 with a rate or quota reason).
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

/// Reasons of an HTTP 403 that mean a limit, not a missing permission.
const LIMIT_REASONS: [&str; 4] = [
    "rateLimitExceeded",
    "userRateLimitExceeded",
    "quotaExceeded",
    "dailyLimitExceeded",
];

/// A Cloud Storage client.
#[derive(Debug)]
pub struct Gcs {
    http: reqwest::Client,
    tokens: Tokens,
    base: Url,
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
        Ok(Self { http, tokens, base })
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
        let response = self.attempt(&build).await?;
        if response.status() != StatusCode::UNAUTHORIZED {
            return Ok(response);
        }
        self.tokens.forget().await;
        self.attempt(&build).await
    }

    async fn attempt(
        &self,
        build: &impl Fn(&reqwest::Client) -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, GcsError> {
        let token = self
            .tokens
            .token()
            .await
            .map_err(|error| GcsError::new(GcsErrorKind::Auth, None, error.to_string()))?;
        build(&self.http)
            .bearer_auth(token.secret())
            .send()
            .await
            .map_err(|error| GcsError::new(GcsErrorKind::Transient, None, error.to_string()))
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

    /// The whole object.
    pub async fn get(&self, bucket: &str, name: &str) -> Result<Bytes, GcsError> {
        let url = self.media_url(bucket, name);
        let response = success(self.send(|http| http.get(url.clone())).await?).await?;
        read_bytes(response).await
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
        let mut bytes = read_bytes(success(response).await?).await?;
        // A server that ignores Range sends everything.
        bytes.truncate(usize::try_from(len).unwrap_or(usize::MAX));
        Ok(bytes)
    }

    fn media_url(&self, bucket: &str, name: &str) -> Url {
        let mut url = self.url(&["storage", "v1", "b", bucket, "o", name]);
        url.query_pairs_mut().append_pair("alt", "media");
        url
    }

    /// Write `body` as `name`. With [`Write::IfAbsent`] an existing object
    /// is left alone and the call fails with
    /// [`GcsErrorKind::AlreadyExists`].
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
        let object: RawObject = read_json(success(response).await?).await?;
        object.parse()
    }

    /// Delete the one object called exactly `name`.
    pub async fn delete(&self, bucket: &str, name: &str) -> Result<(), GcsError> {
        let url = self.url(&["storage", "v1", "b", bucket, "o", name]);
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
    let limit = reasons
        .iter()
        .any(|reason| LIMIT_REASONS.contains(&reason.as_str()));
    let kind = match status.as_u16() {
        401 => GcsErrorKind::Auth,
        403 if limit => GcsErrorKind::Quota,
        403 => GcsErrorKind::Permission,
        404 => GcsErrorKind::NotFound,
        412 => GcsErrorKind::AlreadyExists,
        429 => GcsErrorKind::Quota,
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

async fn read_bytes(response: reqwest::Response) -> Result<Bytes, GcsError> {
    response
        .bytes()
        .await
        .map_err(|error| GcsError::new(GcsErrorKind::Transient, None, error.to_string()))
}

async fn read_json<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, GcsError> {
    let bytes = read_bytes(response).await?;
    serde_json::from_slice(&bytes)
        .map_err(|error| GcsError::new(GcsErrorKind::Other, None, format!("bad answer: {error}")))
}
