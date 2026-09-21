//! In-memory client session for provider-issued NIP-FI assertions.
//!
//! Assertion acquisition is deliberately provider-neutral. The issuer-specific
//! browser/OIDC exchange is outside the NIP-FI relay protocol and is not
//! configured in the OSS app today. A future company adapter implements
//! [`CompanyIdentityAssertionProducer`], then hands its short-lived result to
//! [`acquire_and_install`]. The resulting assertion is never persisted or
//! exposed to the renderer; native WebSocket and HTTP transports consume it
//! only for the exact relay origin and Nostr key for which it was acquired.

use std::{future::Future, pin::Pin, sync::Arc, time::SystemTime};

use serde::Serialize;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

const CLIENT_ATTACHED_HEADER: &str = "Nostr-Federated-Identity";
// Becomes live with the deployment-selected assertion producer. Kept beside
// its constructor so a future adapter cannot bypass the native input bound.
#[allow(dead_code)]
const MAX_ASSERTION_BYTES: usize = 64 * 1024;

/// Exact input an issuer adapter receives after the app has selected a relay
/// and loaded its existing Nostr identity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CompanyIdentityAssertionRequest {
    /// Canonical HTTP(S) origin derived from the active relay URL.
    pub relay_origin: String,
    /// Existing A2D2/Nostr public key, lowercase hex.
    pub nostr_pubkey: String,
}

/// Short-lived assertion produced after company authentication and issuer-side
/// key binding. The compact JWS must contain the same `nostr_pubkey` and the
/// relay-configured audience; the relay remains the cryptographic authority.
pub(crate) struct ProducedCompanyIdentityAssertion {
    compact_jws: Zeroizing<String>,
    expires_at: SystemTime,
}

impl ProducedCompanyIdentityAssertion {
    #[allow(dead_code)]
    pub(crate) fn new(compact_jws: String, expires_at: SystemTime) -> Result<Self, String> {
        validate_assertion(&compact_jws)?;
        if expires_at <= SystemTime::now() {
            return Err("company identity assertion is already expired".to_string());
        }
        Ok(Self {
            compact_jws: Zeroizing::new(compact_jws),
            expires_at,
        })
    }
}

/// Provider-specific acquisition port. Implementations authenticate the
/// company account and return a dedicated NIP-FI assertion. They must not
/// persist or log the assertion, issuer subject, authorization code, or token.
pub(crate) trait CompanyIdentityAssertionProducer: Send + Sync {
    fn acquire<'a>(
        &'a self,
        request: CompanyIdentityAssertionRequest,
    ) -> Pin<Box<dyn Future<Output = Result<ProducedCompanyIdentityAssertion, String>> + Send + 'a>>;
}

struct ActiveSession {
    assertion: Zeroizing<String>,
    relay_origin: String,
    pubkey: String,
    expires_at: SystemTime,
    invalidated: CancellationToken,
}

struct SessionState {
    generation: u64,
    active: Option<ActiveSession>,
}

/// Process-memory-only NIP-FI session. Replacing or clearing it cancels every
/// WebSocket opened under the previous generation.
pub(crate) struct CompanyIdentitySession {
    inner: std::sync::Mutex<SessionState>,
}

impl Default for CompanyIdentitySession {
    fn default() -> Self {
        Self {
            inner: std::sync::Mutex::new(SessionState {
                generation: 0,
                active: None,
            }),
        }
    }
}

/// Header material scoped to one native request. Debug is intentionally not
/// implemented because it contains the confidential compact JWS.
pub(crate) struct ScopedCompanyIdentity {
    header_value: Zeroizing<String>,
    invalidated: CancellationToken,
}

impl ScopedCompanyIdentity {
    pub(crate) fn header_name(&self) -> &'static str {
        CLIENT_ATTACHED_HEADER
    }

    pub(crate) fn header_value(&self) -> &str {
        self.header_value.as_str()
    }

    pub(crate) fn invalidated(&self) -> CancellationToken {
        self.invalidated.clone()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompanyIdentityStatus {
    /// No company issuer adapter is configured in the current product build.
    provider: &'static str,
    /// `active` or `none`; no issuer, subject, relay, key, or token is exposed.
    session: &'static str,
}

impl CompanyIdentitySession {
    /// Install the output of a trusted native producer for the exact current
    /// relay and identity. This is crate-private so the renderer cannot supply
    /// or paste a raw assertion.
    pub(crate) fn install(
        self: &Arc<Self>,
        request: &CompanyIdentityAssertionRequest,
        produced: ProducedCompanyIdentityAssertion,
    ) -> Result<(), String> {
        let relay_origin = canonical_relay_origin(&request.relay_origin)?;
        validate_pubkey(&request.nostr_pubkey)?;

        let invalidated = CancellationToken::new();
        let generation = {
            let mut state = self.inner.lock().map_err(|error| error.to_string())?;
            if let Some(previous) = state.active.take() {
                previous.invalidated.cancel();
            }
            state.generation = state.generation.wrapping_add(1);
            let generation = state.generation;
            state.active = Some(ActiveSession {
                assertion: produced.compact_jws,
                relay_origin,
                pubkey: request.nostr_pubkey.clone(),
                expires_at: produced.expires_at,
                invalidated: invalidated.clone(),
            });
            generation
        };

        let this = Arc::clone(self);
        let expires_at = produced.expires_at;
        tauri::async_runtime::spawn(async move {
            let delay = expires_at
                .duration_since(SystemTime::now())
                .unwrap_or_default();
            tokio::time::sleep(delay).await;
            this.clear_generation(generation);
        });
        Ok(())
    }

    fn clear_generation(&self, generation: u64) {
        let Ok(mut state) = self.inner.lock() else {
            return;
        };
        if state.generation != generation {
            return;
        }
        if let Some(active) = state.active.take() {
            active.invalidated.cancel();
        }
        state.generation = state.generation.wrapping_add(1);
    }

    pub(crate) fn clear(&self) {
        let Ok(mut state) = self.inner.lock() else {
            return;
        };
        if let Some(active) = state.active.take() {
            active.invalidated.cancel();
        }
        state.generation = state.generation.wrapping_add(1);
    }

    /// Preserve the session only when a workspace apply keeps the exact relay
    /// origin and Nostr key. Any real community or identity switch clears and
    /// cancels the old generation before backend state is replaced.
    pub(crate) fn clear_if_scope_changes(&self, relay_url: &str, pubkey: &str) {
        let Ok(origin) = canonical_relay_origin(relay_url) else {
            self.clear();
            return;
        };
        let should_clear = self
            .inner
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .active
                    .as_ref()
                    .map(|active| active.relay_origin != origin || active.pubkey != pubkey)
            })
            .unwrap_or(false);
        if should_clear {
            self.clear();
        }
    }

    pub(crate) fn for_http_request(
        &self,
        target_url: &str,
        active_relay_url: &str,
        active_pubkey: &str,
    ) -> Result<Option<ScopedCompanyIdentity>, String> {
        self.for_request(target_url, active_relay_url, active_pubkey, false)
    }

    pub(crate) fn for_websocket_upgrade(
        &self,
        target_url: &str,
        active_relay_url: &str,
        active_pubkey: &str,
    ) -> Result<Option<ScopedCompanyIdentity>, String> {
        self.for_request(target_url, active_relay_url, active_pubkey, true)
    }

    fn for_request(
        &self,
        target_url: &str,
        active_relay_url: &str,
        active_pubkey: &str,
        websocket: bool,
    ) -> Result<Option<ScopedCompanyIdentity>, String> {
        let target = url::Url::parse(target_url).map_err(|_| "invalid relay URL".to_string())?;
        reject_url_credentials(&target)?;
        if websocket && (target.query().is_some() || target.fragment().is_some()) {
            return Err(
                "company-authenticated WebSocket URL cannot contain a query or fragment"
                    .to_string(),
            );
        }
        let target_origin = canonical_relay_origin(target.as_str())?;
        let active_origin = canonical_relay_origin(active_relay_url)?;

        let mut state = self.inner.lock().map_err(|error| error.to_string())?;
        if state
            .active
            .as_ref()
            .is_some_and(|active| active.expires_at <= SystemTime::now())
        {
            if let Some(expired) = state.active.take() {
                expired.invalidated.cancel();
            }
            state.generation = state.generation.wrapping_add(1);
        }
        let Some(active) = state.active.as_ref() else {
            return Ok(None);
        };
        if active.relay_origin != active_origin
            || active.relay_origin != target_origin
            || active.pubkey != active_pubkey
        {
            return Err(
                "company identity session does not match the active relay and identity".to_string(),
            );
        }
        Ok(Some(ScopedCompanyIdentity {
            header_value: Zeroizing::new(format!("Bearer {}", active.assertion.as_str())),
            invalidated: active.invalidated.clone(),
        }))
    }

    fn has_active_session(&self) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|state| {
                state
                    .active
                    .as_ref()
                    .map(|active| active.expires_at > SystemTime::now())
            })
            .unwrap_or(false)
    }
}

/// Build a request for the active relay. When a company session is active the
/// request uses the dedicated no-redirect client before the confidential
/// header is attached. Without a session, existing request behavior is kept.
pub(crate) fn relay_request(
    state: &crate::app_state::AppState,
    method: reqwest::Method,
    target_url: &str,
) -> Result<reqwest::RequestBuilder, String> {
    let pubkey = state.signing_keys()?.public_key().to_hex();
    relay_request_for_pubkey(state, method, target_url, &pubkey)
}

/// Variant for requests whose NIP-98 proof is signed by an explicit key. An
/// active human company session cannot authorize a managed-agent key: the key
/// mismatch fails before the request is sent.
pub(crate) fn relay_request_for_pubkey(
    state: &crate::app_state::AppState,
    method: reqwest::Method,
    target_url: &str,
    proof_pubkey: &str,
) -> Result<reqwest::RequestBuilder, String> {
    let relay_url = crate::relay::relay_ws_url_with_override(state);
    relay_request_with_scope(
        &state.http_client,
        &state.company_identity_http_client,
        &state.company_identity,
        &relay_url,
        proof_pubkey,
        method,
        target_url,
    )
}

/// Lower-level form for background tasks that must own cloned transport state.
/// The session is still consulted at send time, so logout, identity/community
/// switches, and expiry cannot leave a captured assertion usable.
pub(crate) fn relay_request_with_scope(
    normal_client: &reqwest::Client,
    no_redirect_client: &reqwest::Client,
    session: &CompanyIdentitySession,
    active_relay_url: &str,
    active_pubkey: &str,
    method: reqwest::Method,
    target_url: &str,
) -> Result<reqwest::RequestBuilder, String> {
    let evidence = session.for_http_request(target_url, active_relay_url, active_pubkey)?;
    let client = if evidence.is_some() {
        no_redirect_client
    } else {
        normal_client
    };
    let mut request = client.request(method, target_url);
    if let Some(evidence) = evidence {
        request = request.header(evidence.header_name(), evidence.header_value());
    }
    Ok(request)
}

/// Attach the company assertion to a request already built with a no-redirect
/// client (the relay media fetch client). The caller must keep using that
/// client; this helper only adds the scoped header.
pub(crate) fn attach_to_no_redirect_request(
    state: &crate::app_state::AppState,
    target_url: &str,
    request: reqwest::RequestBuilder,
) -> Result<reqwest::RequestBuilder, String> {
    let relay_url = crate::relay::relay_ws_url_with_override(state);
    let pubkey = state.signing_keys()?.public_key().to_hex();
    let evidence = state
        .company_identity
        .for_http_request(target_url, &relay_url, &pubkey)?;
    Ok(match evidence {
        Some(evidence) => request.header(evidence.header_name(), evidence.header_value()),
        None => request,
    })
}

pub(crate) fn websocket_evidence(
    state: &crate::app_state::AppState,
    target_url: &str,
) -> Result<Option<ScopedCompanyIdentity>, String> {
    let relay_url = crate::relay::relay_ws_url_with_override(state);
    let pubkey = state.signing_keys()?.public_key().to_hex();
    state
        .company_identity
        .for_websocket_upgrade(target_url, &relay_url, &pubkey)
}

/// Run the configured issuer adapter and install its output into the native
/// transport session. No concrete adapter is selected until the deployment
/// supplies its company issuer/login/exchange contract.
#[allow(dead_code)]
pub(crate) async fn acquire_and_install(
    producer: &dyn CompanyIdentityAssertionProducer,
    session: &Arc<CompanyIdentitySession>,
    relay_url: &str,
    nostr_pubkey: &str,
) -> Result<(), String> {
    let request = CompanyIdentityAssertionRequest {
        relay_origin: canonical_relay_origin(relay_url)?,
        nostr_pubkey: nostr_pubkey.to_owned(),
    };
    validate_pubkey(&request.nostr_pubkey)?;
    let produced = producer.acquire(request.clone()).await?;
    session.install(&request, produced)
}

#[tauri::command]
pub(crate) fn get_company_identity_status(
    state: tauri::State<'_, crate::app_state::AppState>,
) -> CompanyIdentityStatus {
    CompanyIdentityStatus {
        provider: "unconfigured",
        session: if state.company_identity.has_active_session() {
            "active"
        } else {
            "none"
        },
    }
}

#[tauri::command]
pub(crate) fn clear_company_identity_session(state: tauri::State<'_, crate::app_state::AppState>) {
    state.company_identity.clear();
}

fn canonical_relay_origin(raw: &str) -> Result<String, String> {
    let mut parsed = url::Url::parse(raw).map_err(|_| "invalid relay URL".to_string())?;
    reject_url_credentials(&parsed)?;
    let target_scheme = match parsed.scheme() {
        "https" | "wss" => "https",
        "http" | "ws" => "http",
        _ => {
            return Err(
                "relay URL must use HTTPS/WSS (or HTTP/WS for local development)".to_string(),
            )
        }
    };
    parsed
        .set_scheme(target_scheme)
        .map_err(|_| "invalid relay URL scheme".to_string())?;
    Ok(parsed.origin().ascii_serialization())
}

fn reject_url_credentials(url: &url::Url) -> Result<(), String> {
    if !url.username().is_empty() || url.password().is_some() {
        return Err("relay URL cannot contain credentials".to_string());
    }
    Ok(())
}

fn validate_pubkey(pubkey: &str) -> Result<(), String> {
    if pubkey.len() != 64
        || !pubkey
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("company identity requires a lowercase 32-byte Nostr public key".to_string());
    }
    Ok(())
}

#[allow(dead_code)]
fn validate_assertion(assertion: &str) -> Result<(), String> {
    if assertion.is_empty()
        || assertion.len() > MAX_ASSERTION_BYTES
        || assertion.contains(',')
        || assertion.bytes().any(|byte| byte.is_ascii_whitespace())
    {
        return Err("company identity assertion is malformed".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn test_session() -> Arc<CompanyIdentitySession> {
        let session = Arc::new(CompanyIdentitySession::default());
        let request = CompanyIdentityAssertionRequest {
            relay_origin: "wss://relay.example".to_string(),
            nostr_pubkey: "11".repeat(32),
        };
        session
            .install(
                &request,
                ProducedCompanyIdentityAssertion::new(
                    "one.two.three".to_string(),
                    SystemTime::now() + std::time::Duration::from_secs(60),
                )
                .unwrap(),
            )
            .unwrap();
        session
    }

    #[tokio::test]
    async fn exact_origin_and_pubkey_receive_header() {
        let session = test_session();
        let evidence = session
            .for_http_request(
                "https://relay.example/query?limit=1",
                "wss://relay.example",
                &"11".repeat(32),
            )
            .unwrap()
            .expect("active evidence");
        assert_eq!(evidence.header_name(), CLIENT_ATTACHED_HEADER);
        assert_eq!(evidence.header_value(), "Bearer one.two.three");
    }

    #[tokio::test]
    async fn other_origin_key_and_websocket_query_fail_closed() {
        let session = test_session();
        assert!(session
            .for_http_request(
                "https://media.example/file",
                "wss://relay.example",
                &"11".repeat(32),
            )
            .is_err());
        assert!(session
            .for_http_request(
                "https://relay.example/query",
                "wss://relay.example",
                &"22".repeat(32),
            )
            .is_err());
        assert!(session
            .for_websocket_upgrade(
                "wss://relay.example/?assertion=forbidden",
                "wss://relay.example",
                &"11".repeat(32),
            )
            .is_err());
    }

    #[tokio::test]
    async fn replacement_clear_and_expiry_cancel_bound_connections() {
        let session = test_session();
        let first = session
            .for_websocket_upgrade(
                "wss://relay.example",
                "wss://relay.example",
                &"11".repeat(32),
            )
            .unwrap()
            .unwrap();
        assert!(!first.invalidated().is_cancelled());
        session.clear();
        assert!(first.invalidated().is_cancelled());
        assert!(session
            .for_http_request(
                "https://relay.example/query",
                "wss://relay.example",
                &"11".repeat(32),
            )
            .unwrap()
            .is_none());

        let request = CompanyIdentityAssertionRequest {
            relay_origin: "wss://relay.example".to_string(),
            nostr_pubkey: "11".repeat(32),
        };
        session
            .install(
                &request,
                ProducedCompanyIdentityAssertion::new(
                    "fresh.token.value".to_string(),
                    SystemTime::now() + std::time::Duration::from_millis(10),
                )
                .unwrap(),
            )
            .unwrap();
        let expiring = session
            .for_websocket_upgrade(
                "wss://relay.example",
                "wss://relay.example",
                &"11".repeat(32),
            )
            .unwrap()
            .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            expiring.invalidated().cancelled(),
        )
        .await
        .expect("expiry cancels the bound connection");
    }

    #[tokio::test]
    async fn production_http_request_does_not_follow_cross_origin_redirect() {
        let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_url = format!("http://{}/stolen", target.local_addr().unwrap());
        let target_hit = Arc::new(AtomicBool::new(false));
        let target_hit_task = Arc::clone(&target_hit);
        let target_task = tokio::spawn(async move {
            if tokio::time::timeout(std::time::Duration::from_millis(500), target.accept())
                .await
                .is_ok()
            {
                target_hit_task.store(true, Ordering::SeqCst);
            }
        });

        let source = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let source_addr = source.local_addr().unwrap();
        let source_task = tokio::spawn(async move {
            let (mut stream, _) = source.accept().await.unwrap();
            let mut request = vec![0; 8192];
            let read = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]).to_ascii_lowercase();
            let response = format!(
                "HTTP/1.1 302 Found\r\nLocation: {target_url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            request
        });

        let state = crate::app_state::build_app_state();
        let pubkey = state.signing_keys().unwrap().public_key().to_hex();
        *state.relay_url_override.lock().unwrap() = Some(format!("ws://{source_addr}"));
        let request = CompanyIdentityAssertionRequest {
            relay_origin: format!("ws://{source_addr}"),
            nostr_pubkey: pubkey,
        };
        state
            .company_identity
            .install(
                &request,
                ProducedCompanyIdentityAssertion::new(
                    "redirect.test.assertion".to_string(),
                    SystemTime::now() + std::time::Duration::from_secs(60),
                )
                .unwrap(),
            )
            .unwrap();

        let response = relay_request(
            &state,
            reqwest::Method::GET,
            &format!("http://{source_addr}/query"),
        )
        .unwrap()
        .send()
        .await
        .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        let source_request = source_task.await.unwrap();
        assert!(source_request.contains("nostr-federated-identity: bearer redirect.test.assertion"));
        target_task.await.unwrap();
        assert!(!target_hit.load(Ordering::SeqCst));
    }
}
