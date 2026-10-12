//! Where access tokens come from, and keeping one fresh.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio::sync::Mutex;

/// The metadata server of GCE, GKE and Cloud Run.
pub const METADATA_URL: &str = "http://metadata.google.internal";
/// A token is replaced this long before it expires.
pub const REFRESH_BEFORE: Duration = Duration::from_secs(5 * 60);
/// `gcloud` does not say how long its token lasts (it may hand out a cached
/// one close to expiry), so it is asked again after this long.
pub const GCLOUD_REUSE: Duration = Duration::from_secs(5 * 60);

/// An OAuth access token. Prints as `***`, so it cannot leak into a log by
/// way of `{:?}`.
#[derive(Clone, PartialEq, Eq)]
pub struct AccessToken(String);

impl AccessToken {
    /// Wrap a token.
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The token itself, for an `Authorization` header and nothing else.
    pub fn secret(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for AccessToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AccessToken(***)")
    }
}

/// Where tokens come from.
#[derive(Debug, Clone)]
pub enum TokenSource {
    /// The metadata server: the service account the workload runs as.
    MetadataServer {
        /// Base URL, normally [`METADATA_URL`].
        base_url: String,
    },
    /// `gcloud auth print-access-token` on a developer machine: whatever
    /// account is active in gcloud. Never switches accounts.
    Gcloud {
        /// The gcloud program, normally `gcloud`.
        program: PathBuf,
    },
    /// A fixed token (tests).
    Static(AccessToken),
}

impl TokenSource {
    /// The metadata server at its usual address.
    pub fn metadata_server() -> Self {
        Self::MetadataServer {
            base_url: METADATA_URL.to_string(),
        }
    }

    /// `gcloud` from `PATH`.
    pub fn gcloud() -> Self {
        Self::Gcloud {
            program: PathBuf::from("gcloud"),
        }
    }
}

/// Why no token could be had. Never holds a token.
#[derive(Debug, thiserror::Error)]
pub enum TokenError {
    /// The metadata server failed or answered something unexpected.
    #[error("metadata server: {0}")]
    Metadata(String),
    /// `gcloud` failed or printed no token.
    #[error("gcloud: {0}")]
    Gcloud(String),
    /// The HTTP client could not be built.
    #[error("http client: {0}")]
    Client(String),
}

#[derive(Deserialize)]
struct MetadataToken {
    access_token: String,
    expires_in: u64,
}

/// A token and when to fetch a new one (`None`: never).
type Current = Option<(AccessToken, Option<Instant>)>;

/// A token source with its current token, replaced shortly before it
/// expires or when a server refuses it.
#[derive(Debug)]
pub struct Tokens {
    source: TokenSource,
    http: reqwest::Client,
    current: Mutex<Current>,
}

impl Tokens {
    /// Tokens from `source`; nothing is fetched until the first use.
    pub fn new(source: TokenSource) -> Result<Self, TokenError> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| TokenError::Client(error.to_string()))?;
        Ok(Self {
            source,
            http,
            current: Mutex::new(None),
        })
    }

    /// A token good for at least a few more minutes.
    pub async fn token(&self) -> Result<AccessToken, TokenError> {
        let mut current = self.current.lock().await;
        if let Some((token, refresh_at)) = current.as_ref() {
            if refresh_at.is_none_or(|at| Instant::now() < at) {
                return Ok(token.clone());
            }
        }
        let (token, refresh_at) = self.fetch().await?;
        *current = Some((token.clone(), refresh_at));
        Ok(token)
    }

    /// Drop the current token (a server refused it); the next
    /// [`token`](Self::token) fetches a new one.
    pub async fn forget(&self) {
        *self.current.lock().await = None;
    }

    async fn fetch(&self) -> Result<(AccessToken, Option<Instant>), TokenError> {
        match &self.source {
            TokenSource::Static(token) => Ok((token.clone(), None)),
            TokenSource::MetadataServer { base_url } => {
                let url = format!(
                    "{}/computeMetadata/v1/instance/service-accounts/default/token",
                    base_url.trim_end_matches('/')
                );
                let response = self
                    .http
                    .get(url)
                    .header("Metadata-Flavor", "Google")
                    .send()
                    .await
                    .map_err(|error| TokenError::Metadata(error.to_string()))?;
                let status = response.status();
                if !status.is_success() {
                    return Err(TokenError::Metadata(format!("HTTP {status}")));
                }
                // Read as text first: a decode error must not echo the body.
                let body = response
                    .text()
                    .await
                    .map_err(|error| TokenError::Metadata(error.to_string()))?;
                let token: MetadataToken = serde_json::from_str(&body)
                    .map_err(|_| TokenError::Metadata("unexpected answer".to_string()))?;
                let now = Instant::now();
                let keep = Duration::from_secs(token.expires_in).saturating_sub(REFRESH_BEFORE);
                let refresh_at = now.checked_add(keep).unwrap_or(now);
                Ok((AccessToken(token.access_token), Some(refresh_at)))
            }
            TokenSource::Gcloud { program } => {
                let output = tokio::process::Command::new(program)
                    .args(["auth", "print-access-token"])
                    .output()
                    .await
                    .map_err(|error| {
                        TokenError::Gcloud(format!("could not run {}: {error}", program.display()))
                    })?;
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let first = stderr
                        .lines()
                        .map(str::trim)
                        .find(|line| !line.is_empty())
                        .unwrap_or("failed");
                    return Err(TokenError::Gcloud(first.to_string()));
                }
                let token = String::from_utf8(output.stdout)
                    .map_err(|_| TokenError::Gcloud("printed something not text".to_string()))?;
                let token = token.trim();
                if token.is_empty() || token.contains(char::is_whitespace) {
                    return Err(TokenError::Gcloud("printed no token".to_string()));
                }
                Ok((
                    AccessToken(token.to_string()),
                    Some(Instant::now() + GCLOUD_REUSE),
                ))
            }
        }
    }
}
