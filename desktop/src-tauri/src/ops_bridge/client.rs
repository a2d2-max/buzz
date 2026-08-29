use std::{
    fs::OpenOptions,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

use futures_util::StreamExt;
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE, IF_MATCH},
    Method, Response, Url,
};
use serde::de::DeserializeOwned;
use zeroize::Zeroizing;

use super::types::{
    OpsBridgeCapabilities, OpsBridgeSnapshot, OpsDraftReceipt, OpsDraftRequest, OpsSelection,
    OpsTransitionReceipt, OpsTransitionRequest, OpsTransitionWireRequest, VersionedResponse,
    MAX_RESPONSE_BYTES, OPS_CONTRACT_VERSION,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_TOKEN_BYTES: usize = 4096;
const LAST_EVENT_ID: HeaderName = HeaderName::from_static("last-event-id");

/// Native-only configuration for the fixed loopback Ops hub.
#[derive(Debug, Clone)]
pub struct OpsBridgeConfig {
    /// Integer loopback port. Zero is always rejected.
    pub port: u16,
    /// Absolute path to the native bearer-token file.
    pub token_file: PathBuf,
    /// Per-response byte ceiling, never greater than [`MAX_RESPONSE_BYTES`].
    pub max_response_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpsBridgeError {
    ExternalActionDisabled,
    InvalidConfig,
    InvalidEndpoint,
    TokenUnavailable,
    TokenPermissions,
    TokenInvalid,
    ClientBuild,
    Transport,
    HttpStatus,
    ResponseContentType,
    ResponseTooLarge,
    ResponseInvalidJson,
    ContractMismatch,
    InvalidRequest,
    WatchState,
}

impl std::fmt::Display for OpsBridgeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let code = match self {
            Self::ExternalActionDisabled => "ops_bridge_external_action_disabled",
            Self::InvalidConfig => "ops_bridge_invalid_config",
            Self::InvalidEndpoint => "ops_bridge_invalid_endpoint",
            Self::TokenUnavailable => "ops_bridge_token_unavailable",
            Self::TokenPermissions => "ops_bridge_token_permissions",
            Self::TokenInvalid => "ops_bridge_token_invalid",
            Self::ClientBuild => "ops_bridge_client_unavailable",
            Self::Transport => "ops_bridge_disconnected",
            Self::HttpStatus => "ops_bridge_http_error",
            Self::ResponseContentType => "ops_bridge_invalid_content_type",
            Self::ResponseTooLarge => "ops_bridge_response_too_large",
            Self::ResponseInvalidJson => "ops_bridge_invalid_json",
            Self::ContractMismatch => "ops_bridge_contract_mismatch",
            Self::InvalidRequest => "ops_bridge_invalid_request",
            Self::WatchState => "ops_bridge_watch_state",
        };
        formatter.write_str(code)
    }
}

/// Strict native HTTP client. It never accepts a hostname, URL, method, or path
/// from the webview.
#[derive(Clone)]
pub(crate) struct OpsBridgeClient {
    config: OpsBridgeConfig,
    request_client: reqwest::Client,
    stream_client: reqwest::Client,
}

impl OpsBridgeClient {
    pub(crate) fn new(config: OpsBridgeConfig) -> Result<Self, OpsBridgeError> {
        if config.port == 0
            || config.max_response_bytes == 0
            || config.max_response_bytes > MAX_RESPONSE_BYTES
        {
            return Err(OpsBridgeError::InvalidConfig);
        }
        validate_hub_endpoint(&format!("http://127.0.0.1:{}", config.port))?;
        let common = || {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .connect_timeout(CONNECT_TIMEOUT)
        };
        let request_client = common()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| OpsBridgeError::ClientBuild)?;
        // SSE connections are long-lived, so bound each silent read rather
        // than the total lifetime. Reqwest resets this watchdog after every
        // successful read, while a stalled peer enters watcher backoff.
        let stream_client = common()
            .read_timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|_| OpsBridgeError::ClientBuild)?;
        Ok(Self {
            config,
            request_client,
            stream_client,
        })
    }

    pub(crate) async fn capabilities(&self) -> Result<OpsBridgeCapabilities, OpsBridgeError> {
        let request =
            self.authenticated(&self.request_client, Method::GET, self.capabilities_url()?)?;
        self.execute_json(request).await
    }

    pub(crate) async fn snapshot(
        &self,
        selection: &OpsSelection,
    ) -> Result<OpsBridgeSnapshot, OpsBridgeError> {
        validate_optional_query(selection.channel.as_deref())?;
        validate_optional_query(selection.thread.as_deref())?;
        let mut url = self.snapshot_url()?;
        {
            let mut query = url.query_pairs_mut();
            if let Some(channel) = &selection.channel {
                query.append_pair("channel", channel);
            }
            if let Some(thread) = &selection.thread {
                query.append_pair("thread", thread);
            }
            if let Some(limit) = selection.limit {
                query.append_pair("limit", &limit.to_string());
            }
        }
        let request = self.authenticated(&self.request_client, Method::GET, url)?;
        self.execute_json(request).await
    }

    pub(crate) async fn create_draft(
        &self,
        request: &OpsDraftRequest,
    ) -> Result<OpsDraftReceipt, OpsBridgeError> {
        request
            .validate()
            .map_err(|_| OpsBridgeError::InvalidRequest)?;
        let idempotency_key = request
            .idempotency_key()
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let builder = self
            .authenticated(&self.request_client, Method::POST, self.drafts_url()?)?
            .header("Idempotency-Key", idempotency_key)
            .json(request);
        self.execute_json(builder).await
    }

    pub(crate) async fn transition(
        &self,
        request: &OpsTransitionRequest,
    ) -> Result<OpsTransitionReceipt, OpsBridgeError> {
        request.validate_initial_profile()?;
        let builder = self
            .authenticated(
                &self.request_client,
                Method::POST,
                self.transition_url(&request.approval_id)?,
            )?
            .header(IF_MATCH, request.expected_revision.to_string())
            .header("Idempotency-Key", uuid::Uuid::new_v4().to_string())
            .json(&OpsTransitionWireRequest::from(request));
        self.execute_json(builder).await
    }

    pub(crate) async fn event_stream(
        &self,
        last_event_id: Option<&str>,
    ) -> Result<Response, OpsBridgeError> {
        let mut builder =
            self.authenticated(&self.stream_client, Method::GET, self.events_url()?)?;
        if let Some(event_id) = last_event_id {
            if event_id.is_empty()
                || event_id.len() > 20
                || !event_id.bytes().all(|b| b.is_ascii_digit())
            {
                return Err(OpsBridgeError::InvalidRequest);
            }
            let value =
                HeaderValue::from_str(event_id).map_err(|_| OpsBridgeError::InvalidRequest)?;
            builder = builder.header(LAST_EVENT_ID, value);
        }
        let response = builder
            .send()
            .await
            .map_err(|_| OpsBridgeError::Transport)?;
        ensure_success(&response)?;
        if !is_event_stream(response.headers()) {
            return Err(OpsBridgeError::ResponseContentType);
        }
        Ok(response)
    }

    fn authenticated(
        &self,
        client: &reqwest::Client,
        method: Method,
        url: Url,
    ) -> Result<reqwest::RequestBuilder, OpsBridgeError> {
        let token = read_hub_token(&self.config.token_file)?;
        Ok(client.request(method, url).bearer_auth(token.as_str()))
    }

    async fn execute_json<T>(&self, request: reqwest::RequestBuilder) -> Result<T, OpsBridgeError>
    where
        T: DeserializeOwned + VersionedResponse,
    {
        let response = request
            .send()
            .await
            .map_err(|_| OpsBridgeError::Transport)?;
        ensure_success(&response)?;
        if !is_json(response.headers()) {
            return Err(OpsBridgeError::ResponseContentType);
        }
        if response
            .content_length()
            .is_some_and(|length| length > self.config.max_response_bytes as u64)
        {
            return Err(OpsBridgeError::ResponseTooLarge);
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| OpsBridgeError::Transport)?;
            if body.len().saturating_add(chunk.len()) > self.config.max_response_bytes {
                return Err(OpsBridgeError::ResponseTooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        let value: T =
            serde_json::from_slice(&body).map_err(|_| OpsBridgeError::ResponseInvalidJson)?;
        if value.contract_version() != OPS_CONTRACT_VERSION {
            return Err(OpsBridgeError::ContractMismatch);
        }
        Ok(value)
    }

    fn capabilities_url(&self) -> Result<Url, OpsBridgeError> {
        self.fixed_url(&["ops-bridge", "v1", "capabilities"])
    }

    fn snapshot_url(&self) -> Result<Url, OpsBridgeError> {
        self.fixed_url(&["ops-bridge", "v1", "snapshot"])
    }

    fn drafts_url(&self) -> Result<Url, OpsBridgeError> {
        self.fixed_url(&["ops-bridge", "v1", "drafts"])
    }

    fn events_url(&self) -> Result<Url, OpsBridgeError> {
        self.fixed_url(&["ops-bridge", "v1", "events"])
    }

    fn transition_url(&self, approval_id: &str) -> Result<Url, OpsBridgeError> {
        self.fixed_url(&["ops-bridge", "v1", "approvals", approval_id, "transition"])
    }

    fn fixed_url(&self, segments: &[&str]) -> Result<Url, OpsBridgeError> {
        let endpoint = format!("http://127.0.0.1:{}", self.config.port);
        validate_hub_endpoint(&endpoint)?;
        let mut url = Url::parse(&endpoint).map_err(|_| OpsBridgeError::InvalidEndpoint)?;
        let mut path = url
            .path_segments_mut()
            .map_err(|_| OpsBridgeError::InvalidEndpoint)?;
        path.clear();
        for segment in segments {
            path.push(segment);
        }
        drop(path);
        Ok(url)
    }
}

pub(crate) fn validate_hub_endpoint(endpoint: &str) -> Result<(), OpsBridgeError> {
    let url = Url::parse(endpoint).map_err(|_| OpsBridgeError::InvalidEndpoint)?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none_or(|port| port == 0)
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(OpsBridgeError::InvalidEndpoint);
    }
    Ok(())
}

pub(crate) fn read_hub_token(path: &Path) -> Result<Zeroizing<String>, OpsBridgeError> {
    if !path.is_absolute() {
        return Err(OpsBridgeError::TokenUnavailable);
    }
    let link_metadata =
        std::fs::symlink_metadata(path).map_err(|_| OpsBridgeError::TokenUnavailable)?;
    if link_metadata.file_type().is_symlink() {
        return Err(OpsBridgeError::TokenPermissions);
    }

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|_| OpsBridgeError::TokenUnavailable)?;
    let metadata = file
        .metadata()
        .map_err(|_| OpsBridgeError::TokenUnavailable)?;
    if !metadata.is_file() {
        return Err(OpsBridgeError::TokenPermissions);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = metadata.permissions().mode();
        if mode & 0o077 != 0 || mode & 0o400 == 0 {
            return Err(OpsBridgeError::TokenPermissions);
        }
    }

    let mut bytes = Vec::new();
    file.take((MAX_TOKEN_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| OpsBridgeError::TokenUnavailable)?;
    if bytes.len() > MAX_TOKEN_BYTES {
        return Err(OpsBridgeError::TokenInvalid);
    }
    let text = Zeroizing::new(String::from_utf8(bytes).map_err(|_| OpsBridgeError::TokenInvalid)?);
    let token = text.trim();
    if token.is_empty()
        || token.len() > MAX_TOKEN_BYTES
        || token.chars().any(char::is_whitespace)
        || HeaderValue::from_str(token).is_err()
    {
        return Err(OpsBridgeError::TokenInvalid);
    }
    Ok(Zeroizing::new(token.to_owned()))
}

fn ensure_success(response: &Response) -> Result<(), OpsBridgeError> {
    if response.status().is_success() {
        Ok(())
    } else {
        // Redirects are deliberately surfaced as a generic status error. The
        // Location header and upstream body never cross the native boundary.
        Err(OpsBridgeError::HttpStatus)
    }
}

fn is_json(headers: &HeaderMap) -> bool {
    let Some(value) = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let media_type = value.split(';').next().unwrap_or_default().trim();
    media_type.eq_ignore_ascii_case("application/json")
        || media_type.to_ascii_lowercase().ends_with("+json")
}

fn is_event_stream(headers: &HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("text/event-stream"))
}

fn validate_optional_query(value: Option<&str>) -> Result<(), OpsBridgeError> {
    match value {
        Some(value)
            if value.trim().is_empty()
                || value.len() > 256
                || value.chars().any(char::is_control) =>
        {
            Err(OpsBridgeError::InvalidRequest)
        }
        _ => Ok(()),
    }
}
