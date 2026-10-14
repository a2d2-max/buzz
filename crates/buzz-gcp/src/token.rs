//! Where access tokens come from, and keeping one fresh.
//!
//! One task refreshes a token that is due; the others keep using the old
//! one until it really expires, so a slow metadata server never holds up
//! every request.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;

/// The metadata server of GCE, GKE and Cloud Run.
pub const METADATA_URL: &str = "http://metadata.google.internal";
/// The metadata server's fixed address, tried when its name does not
/// resolve.
pub const METADATA_IP_URL: &str = "http://169.254.169.254";
/// A token is replaced this long before it expires.
pub const REFRESH_BEFORE: Duration = Duration::from_secs(5 * 60);
/// `gcloud` does not say how long its token lasts (it may hand out a cached
/// one close to expiry), so it is asked again after this long.
pub const GCLOUD_REUSE: Duration = Duration::from_secs(5 * 60);
/// `gcloud` gets this long to print a token before it is killed.
pub const GCLOUD_TIMEOUT: Duration = Duration::from_secs(60);

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
        /// Killed after this long, normally [`GCLOUD_TIMEOUT`].
        timeout: Duration,
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
            timeout: GCLOUD_TIMEOUT,
        }
    }

    /// A fixed token from the environment variable [`STATIC_TOKEN_ENV`]
    /// (tests), when it is set and not empty.
    pub fn static_from_env() -> Option<Self> {
        static_token(std::env::var(STATIC_TOKEN_ENV).ok())
    }
}

fn static_token(value: Option<String>) -> Option<TokenSource> {
    value
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
        .map(|token| TokenSource::Static(AccessToken(token)))
}

/// Environment variable holding a fixed token for tests.
pub const STATIC_TOKEN_ENV: &str = "BUZZ_GCP_ACCESS_TOKEN";

/// Why no token could be had. Never holds a token.
#[derive(Debug, thiserror::Error)]
pub enum TokenError {
    /// The metadata server failed or answered something unexpected.
    #[error("metadata server: {message}")]
    Metadata {
        /// What went wrong.
        message: String,
        /// Worth trying again later (no connection, timeout, 5xx).
        transient: bool,
    },
    /// `gcloud` failed or printed no token.
    #[error("gcloud: {message}")]
    Gcloud {
        /// What went wrong (its first line of stderr).
        message: String,
        /// Worth trying again later (it hung and was killed).
        transient: bool,
    },
    /// The HTTP client could not be built.
    #[error("http client: {0}")]
    Client(String),
}

impl TokenError {
    /// Worth trying again later: the source did not answer, not "no".
    /// Anything else (refused, no login, an answer that makes no sense) is
    /// an authentication failure.
    pub fn is_transient(&self) -> bool {
        match self {
            Self::Metadata { transient, .. } | Self::Gcloud { transient, .. } => *transient,
            Self::Client(_) => false,
        }
    }

    fn metadata(message: impl Into<String>, transient: bool) -> Self {
        Self::Metadata {
            message: message.into(),
            transient,
        }
    }

    fn gcloud(message: impl Into<String>, transient: bool) -> Self {
        Self::Gcloud {
            message: message.into(),
            transient,
        }
    }
}

#[derive(Deserialize)]
struct MetadataToken {
    access_token: String,
    expires_in: u64,
}

/// A token, when to fetch a new one, and when it stops working (`None`:
/// never, or not known).
#[derive(Debug, Clone)]
struct Current {
    token: AccessToken,
    refresh_at: Option<Instant>,
    expires_at: Option<Instant>,
}

/// A token source with its current token, replaced shortly before it
/// expires or when a server refuses it.
#[derive(Debug)]
pub struct Tokens {
    source: TokenSource,
    http: reqwest::Client,
    current: Mutex<Option<Current>>,
    refreshing: tokio::sync::Mutex<()>,
}

impl Tokens {
    /// Tokens from `source`; nothing is fetched until the first use.
    pub fn new(source: TokenSource) -> Result<Self, TokenError> {
        let http = reqwest::Client::builder()
            // The metadata server is local; a proxy must never see its
            // tokens.
            .no_proxy()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| TokenError::Client(error.to_string()))?;
        Ok(Self {
            source,
            http,
            current: Mutex::new(None),
            refreshing: tokio::sync::Mutex::new(()),
        })
    }

    fn current(&self) -> std::sync::MutexGuard<'_, Option<Current>> {
        self.current
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The current token if it is not due for refresh, and the current
    /// token if it still works.
    fn check(&self) -> (Option<AccessToken>, Option<AccessToken>) {
        let now = Instant::now();
        match self.current().as_ref() {
            Some(current) => (
                current
                    .refresh_at
                    .is_none_or(|at| now < at)
                    .then(|| current.token.clone()),
                current
                    .expires_at
                    .is_none_or(|at| now < at)
                    .then(|| current.token.clone()),
            ),
            None => (None, None),
        }
    }

    /// A token good for at least a few more minutes, or — while another
    /// task fetches the next one — one that has not expired yet.
    pub async fn token(&self) -> Result<AccessToken, TokenError> {
        let (fresh, usable) = self.check();
        if let Some(token) = fresh {
            return Ok(token);
        }
        let _refreshing = match &usable {
            Some(token) => match self.refreshing.try_lock() {
                Ok(guard) => guard,
                Err(_) => return Ok(token.clone()),
            },
            None => self.refreshing.lock().await,
        };
        // Another task may have refreshed while this one waited.
        if let (Some(token), _) = self.check() {
            return Ok(token);
        }
        match self.fetch().await {
            Ok(current) => {
                let token = current.token.clone();
                *self.current() = Some(current);
                Ok(token)
            }
            // The old token works until it expires; the next call tries
            // again.
            Err(error) => usable.ok_or(error),
        }
    }

    /// `rejected` was refused by a server: drop it, so the next
    /// [`token`](Self::token) fetches a new one. A token fetched since is
    /// kept.
    pub async fn forget(&self, rejected: &AccessToken) {
        let mut current = self.current();
        if current.as_ref().is_some_and(|c| c.token == *rejected) {
            *current = None;
        }
    }

    async fn fetch(&self) -> Result<Current, TokenError> {
        match &self.source {
            TokenSource::Static(token) => Ok(Current {
                token: token.clone(),
                refresh_at: None,
                expires_at: None,
            }),
            TokenSource::MetadataServer { base_url } => {
                let base = base_url.trim_end_matches('/');
                match self.metadata_token(base).await {
                    // The name does not resolve (outside GCP DNS): the
                    // fixed address.
                    Err(TokenError::Metadata { message, .. })
                        if base == METADATA_URL && message.starts_with("connect") =>
                    {
                        self.metadata_token(METADATA_IP_URL).await
                    }
                    result => result,
                }
            }
            TokenSource::Gcloud { program, timeout } => {
                let run = tokio::process::Command::new(program)
                    .args(["auth", "print-access-token"])
                    .kill_on_drop(true)
                    .output();
                let output = match tokio::time::timeout(*timeout, run).await {
                    Ok(Ok(output)) => output,
                    Ok(Err(error)) => {
                        return Err(TokenError::gcloud(
                            format!("could not run {}: {error}", program.display()),
                            false,
                        ))
                    }
                    Err(_) => {
                        return Err(TokenError::gcloud(
                            format!("no answer in {} s, killed", timeout.as_secs()),
                            true,
                        ))
                    }
                };
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let first = stderr
                        .lines()
                        .map(str::trim)
                        .find(|line| !line.is_empty())
                        .unwrap_or("failed");
                    return Err(TokenError::gcloud(first, false));
                }
                let token = String::from_utf8(output.stdout)
                    .map_err(|_| TokenError::gcloud("printed something not text", false))?;
                let token = token.trim();
                if token.is_empty() || token.contains(char::is_whitespace) {
                    return Err(TokenError::gcloud("printed no token", false));
                }
                Ok(Current {
                    token: AccessToken(token.to_string()),
                    refresh_at: Some(Instant::now() + GCLOUD_REUSE),
                    // Not known; a refused token is dropped on 401.
                    expires_at: None,
                })
            }
        }
    }

    async fn metadata_token(&self, base: &str) -> Result<Current, TokenError> {
        let url = format!("{base}/computeMetadata/v1/instance/service-accounts/default/token");
        let response = self
            .http
            .get(url)
            .header("Metadata-Flavor", "Google")
            .send()
            .await
            .map_err(|error| {
                let what = if error.is_connect() {
                    "connect"
                } else if error.is_timeout() {
                    "timeout"
                } else {
                    "send"
                };
                TokenError::metadata(format!("{what}: {error}"), true)
            })?;
        let status = response.status();
        if !status.is_success() {
            let transient = status.is_server_error() || status.as_u16() == 429;
            return Err(TokenError::metadata(format!("HTTP {status}"), transient));
        }
        // Read as text first: a decode error must not echo the body.
        let body = response
            .text()
            .await
            .map_err(|error| TokenError::metadata(error.to_string(), true))?;
        let token: MetadataToken = serde_json::from_str(&body)
            .map_err(|_| TokenError::metadata("unexpected answer", false))?;
        let now = Instant::now();
        let lifetime = Duration::from_secs(token.expires_in);
        let at = |after: Duration| now.checked_add(after).unwrap_or(now);
        Ok(Current {
            token: AccessToken(token.access_token),
            refresh_at: Some(at(lifetime.saturating_sub(REFRESH_BEFORE))),
            expires_at: Some(at(lifetime)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_static_token_comes_from_a_set_variable_only() {
        assert!(static_token(None).is_none());
        assert!(static_token(Some("  ".into())).is_none());
        let source = static_token(Some(" ya29.test \n".into())).expect("source");
        let tokens = Tokens::new(source).expect("tokens");
        assert_eq!(tokens.token().await.expect("token").secret(), "ya29.test");
    }
}
