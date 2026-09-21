//! Provider-neutral company identity enforcement for relay ingress.
//!
//! NIP-FI proves that a trusted company issuer currently associates an
//! issuer-qualified account with a Nostr public key. It does not create relay
//! membership or roles: the existing community-scoped `relay_members` table
//! remains the local authorization authority after the assertion and Nostr
//! proof name the same key.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use buzz_auth::{
    DenialClass, FederatedAssertionVerifier, HttpJwksFetcher, IssuerJwksConfig, IssuerPolicy,
    IssuerRegistry, NipFiMode, ProductionJwksSource, VerifiedAssertion, VerifierError,
    CLIENT_ATTACHED_HEADER,
};
use chrono::{DateTime, Utc};
use tokio_util::sync::CancellationToken;

use crate::config::ConfigError;

const MODE_ENV: &str = "BUZZ_NIP_FI_MODE";
const ISSUER_ENV: &str = "BUZZ_NIP_FI_ISSUER";
const AUDIENCE_ENV: &str = "BUZZ_NIP_FI_AUDIENCE";
const JWKS_URL_ENV: &str = "BUZZ_NIP_FI_JWKS_URL";
const ALGORITHM_ENV: &str = "BUZZ_NIP_FI_ALGORITHM";
const CLOCK_SKEW_ENV: &str = "BUZZ_NIP_FI_CLOCK_SKEW_SECONDS";
const ASSERTION_AGE_ENV: &str = "BUZZ_NIP_FI_MAX_ASSERTION_AGE_SECONDS";
const JWKS_REFRESH_ENV: &str = "BUZZ_NIP_FI_JWKS_REFRESH_SECONDS";
const JWKS_DEADLINE_ENV: &str = "BUZZ_NIP_FI_JWKS_HARD_DEADLINE_SECONDS";
const CONNECTION_LIFETIME_ENV: &str = "BUZZ_NIP_FI_MAX_CONNECTION_LIFETIME_SECONDS";

const CONFIG_ENV_NAMES: [&str; 9] = [
    ISSUER_ENV,
    AUDIENCE_ENV,
    JWKS_URL_ENV,
    ALGORITHM_ENV,
    CLOCK_SKEW_ENV,
    ASSERTION_AGE_ENV,
    JWKS_REFRESH_ENV,
    JWKS_DEADLINE_ENV,
    CONNECTION_LIFETIME_ENV,
];

/// Validated deployment configuration for company identity enforcement.
#[derive(Clone)]
pub struct CompanyIdentityConfig {
    mode: NipFiMode,
    registry: IssuerRegistry,
    jwks_configs: Vec<IssuerJwksConfig>,
    max_connection_lifetime: Option<Duration>,
    jwks_refresh_interval: Option<Duration>,
}

impl std::fmt::Debug for CompanyIdentityConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CompanyIdentityConfig")
            .field("mode", &self.mode)
            .field("issuer_count", &self.registry.len())
            .field("max_connection_lifetime", &self.max_connection_lifetime)
            .finish_non_exhaustive()
    }
}

impl CompanyIdentityConfig {
    /// Load and validate NIP-FI configuration from the process environment.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let mode = match lookup(MODE_ENV)
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("off")
        {
            "off" => NipFiMode::Off,
            "enforce" => NipFiMode::Enforce,
            "deny-protected" => NipFiMode::DenyProtected,
            _ => {
                return Err(ConfigError::InvalidValue(format!(
                    "{MODE_ENV} must be off, enforce, or deny-protected"
                )))
            }
        };

        if mode != NipFiMode::Enforce {
            if CONFIG_ENV_NAMES.iter().any(|name| {
                lookup(name)
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty())
            }) {
                return Err(ConfigError::InvalidValue(format!(
                    "NIP-FI issuer settings require {MODE_ENV}=enforce"
                )));
            }
            return Ok(Self {
                mode,
                registry: IssuerRegistry::new(),
                jwks_configs: Vec::new(),
                max_connection_lifetime: None,
                jwks_refresh_interval: None,
            });
        }

        let issuer = required_string(&lookup, ISSUER_ENV)?;
        let audience = required_string(&lookup, AUDIENCE_ENV)?;
        let jwks_url = required_string(&lookup, JWKS_URL_ENV)?;
        let algorithm = match required_string(&lookup, ALGORITHM_ENV)?.as_str() {
            "ES256" => jsonwebtoken::Algorithm::ES256,
            "RS256" => jsonwebtoken::Algorithm::RS256,
            _ => {
                return Err(ConfigError::InvalidValue(format!(
                    "{ALGORITHM_ENV} must be ES256 or RS256"
                )))
            }
        };
        let clock_skew = required_u64(&lookup, CLOCK_SKEW_ENV, true)?;
        let assertion_age = required_u64(&lookup, ASSERTION_AGE_ENV, false)?;
        let jwks_refresh = required_u64(&lookup, JWKS_REFRESH_ENV, false)?;
        let jwks_deadline = required_u64(&lookup, JWKS_DEADLINE_ENV, false)?;
        let connection_lifetime = required_u64(&lookup, CONNECTION_LIFETIME_ENV, false)?;

        let contract = buzz_auth::JwksSourceContract::new(
            jwks_url,
            jwks_refresh,
            jwks_deadline,
        )
        .ok_or_else(|| {
            ConfigError::InvalidValue(
                "NIP-FI JWKS URL/timing contract is invalid; use HTTPS and positive bounded timings with refresh < hard deadline"
                    .to_string(),
            )
        })?;
        let policy = IssuerPolicy::new(
            issuer.clone(),
            vec![audience],
            buzz_auth::TokenClass::DedicatedNipFi,
            buzz_auth::FreshnessClass::OfflineJwt,
            vec![algorithm],
            clock_skew,
            assertion_age,
            None,
            contract.clone(),
        )
        .map_err(|_| {
            ConfigError::InvalidValue(
                "NIP-FI issuer policy is invalid; check exact issuer/audience and bounded time settings"
                    .to_string(),
            )
        })?;

        let mut registry = IssuerRegistry::new();
        registry.insert(policy);
        let jwks_configs = vec![IssuerJwksConfig { issuer, contract }];
        buzz_auth::validate_nip_fi_config(mode, &registry, &jwks_configs).map_err(|error| {
            ConfigError::InvalidValue(format!("NIP-FI startup validation failed: {error}"))
        })?;

        Ok(Self {
            mode,
            registry,
            jwks_configs,
            max_connection_lifetime: Some(Duration::from_secs(connection_lifetime)),
            jwks_refresh_interval: Some(Duration::from_secs(jwks_refresh)),
        })
    }

    /// The configured enforcement mode.
    pub const fn mode(&self) -> NipFiMode {
        self.mode
    }
}

fn required_string(
    lookup: &impl Fn(&str) -> Option<String>,
    name: &str,
) -> Result<String, ConfigError> {
    lookup(name)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ConfigError::InvalidValue(format!("{name} is required in NIP-FI enforce mode"))
        })
}

fn required_u64(
    lookup: &impl Fn(&str) -> Option<String>,
    name: &str,
    allow_zero: bool,
) -> Result<u64, ConfigError> {
    let value = required_string(lookup, name)?;
    let parsed = value
        .parse::<u64>()
        .map_err(|_| ConfigError::InvalidValue(format!("{name} must be an unsigned integer")))?;
    if !allow_zero && parsed == 0 {
        return Err(ConfigError::InvalidValue(format!(
            "{name} must be greater than zero"
        )));
    }
    Ok(parsed)
}

trait AssertionBackend: Send + Sync {
    fn verify<'a>(
        &'a self,
        compact_jws: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<VerifiedAssertion, VerifierError>> + Send + 'a>>;
}

struct ProductionAssertionBackend {
    issuer: String,
    source: Arc<ProductionJwksSource<HttpJwksFetcher>>,
    verifier: FederatedAssertionVerifier<Arc<ProductionJwksSource<HttpJwksFetcher>>>,
}

impl AssertionBackend for ProductionAssertionBackend {
    fn verify<'a>(
        &'a self,
        compact_jws: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<VerifiedAssertion, VerifierError>> + Send + 'a>> {
        Box::pin(async move {
            match self.verifier.verify(compact_jws) {
                Err(VerifierError::KeySourceUnavailable) => {
                    self.source.get_snapshot(&self.issuer).await;
                    self.verifier.verify(compact_jws)
                }
                result => result,
            }
        })
    }
}

/// Runtime verifier and lease policy shared by every relay ingress.
pub struct CompanyIdentityRuntime {
    mode: NipFiMode,
    backend: Option<Arc<dyn AssertionBackend>>,
    max_connection_lifetime: Option<Duration>,
    refresh_cancel: CancellationToken,
}

impl CompanyIdentityRuntime {
    /// Construct the production runtime from already validated config.
    pub fn new(config: &CompanyIdentityConfig) -> Self {
        let refresh_cancel = CancellationToken::new();
        if config.mode != NipFiMode::Enforce {
            return Self {
                mode: config.mode,
                backend: None,
                max_connection_lifetime: None,
                refresh_cancel,
            };
        }

        let Some(source) =
            ProductionJwksSource::new(config.jwks_configs.clone(), HttpJwksFetcher::new())
        else {
            // Validated single-issuer config makes this unreachable. If the
            // constructor contract changes, deny protected traffic rather than
            // silently falling back to ordinary NIP-42.
            return Self {
                mode: NipFiMode::DenyProtected,
                backend: None,
                max_connection_lifetime: None,
                refresh_cancel,
            };
        };
        let source = Arc::new(source);
        let issuer = config
            .jwks_configs
            .first()
            .map(|entry| entry.issuer.clone());
        let Some(issuer) = issuer else {
            return Self {
                mode: NipFiMode::DenyProtected,
                backend: None,
                max_connection_lifetime: None,
                refresh_cancel,
            };
        };
        let verifier =
            FederatedAssertionVerifier::new(config.registry.clone(), Arc::clone(&source));
        let backend: Arc<dyn AssertionBackend> = Arc::new(ProductionAssertionBackend {
            issuer: issuer.clone(),
            source: Arc::clone(&source),
            verifier,
        });

        if let Some(interval) = config.jwks_refresh_interval {
            let cancel = refresh_cancel.clone();
            tokio::spawn(async move {
                let mut ticker = tokio::time::interval(interval);
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = cancel.cancelled() => break,
                        _ = ticker.tick() => {
                            source.get_snapshot(&issuer).await;
                        }
                    }
                }
            });
        }

        Self {
            mode: NipFiMode::Enforce,
            backend: Some(backend),
            max_connection_lifetime: config.max_connection_lifetime,
            refresh_cancel,
        }
    }

    /// Whether company identity enforcement is active for protected traffic.
    pub const fn mode(&self) -> NipFiMode {
        self.mode
    }

    /// Verify the exact single client-attached assertion on an ingress.
    pub async fn verify_headers(
        &self,
        headers: &HeaderMap,
    ) -> Result<Option<VerifiedAssertion>, DenialClass> {
        match self.mode {
            NipFiMode::Off => Ok(None),
            NipFiMode::DenyProtected => Err(DenialClass::AuthorizationUnavailable),
            NipFiMode::Enforce => {
                let compact_jws = extract_bearer_assertion(headers)?;
                let backend = self
                    .backend
                    .as_ref()
                    .ok_or(DenialClass::AuthorizationUnavailable)?;
                backend
                    .verify(compact_jws)
                    .await
                    .map(Some)
                    .map_err(VerifierError::denial_class)
            }
        }
    }

    /// Revalidate the exact assertion, bind it to the proven NIP-42 key, and
    /// compute the finite effective connection lease.
    pub async fn finalize_websocket(
        &self,
        prepared: Option<&VerifiedAssertion>,
        proven_key: &nostr::PublicKey,
        connected_at: DateTime<Utc>,
    ) -> Result<Option<Duration>, DenialClass> {
        match self.mode {
            NipFiMode::Off => return Ok(None),
            NipFiMode::DenyProtected => return Err(DenialClass::AuthorizationUnavailable),
            NipFiMode::Enforce => {}
        }

        let prepared = prepared.ok_or(DenialClass::MissingEvidence)?;
        let compact_jws = prepared
            .revalidation_dependencies()
            .confidential_assertion()
            .compact_jws();
        let backend = self
            .backend
            .as_ref()
            .ok_or(DenialClass::AuthorizationUnavailable)?;
        let current = backend
            .verify(compact_jws)
            .await
            .map_err(VerifierError::denial_class)?;
        if current.asserted_key().as_ref() != Some(proven_key) {
            return Err(DenialClass::AuthorizationDenied);
        }

        let max_lifetime = self
            .max_connection_lifetime
            .ok_or(DenialClass::AuthorizationUnavailable)?;
        let lifetime_deadline = chrono::Duration::from_std(max_lifetime)
            .ok()
            .and_then(|duration| connected_at.checked_add_signed(duration))
            .ok_or(DenialClass::AuthorizationUnavailable)?;
        let deadline = std::cmp::min(lifetime_deadline, current.upstream_authority_deadline());
        let remaining = deadline
            .signed_duration_since(Utc::now())
            .to_std()
            .map_err(|_| DenialClass::EvidenceRejected)?;
        if remaining.is_zero() {
            return Err(DenialClass::EvidenceRejected);
        }
        Ok(Some(remaining))
    }

    #[cfg(test)]
    fn with_test_backend(
        max_connection_lifetime: Duration,
        backend: Arc<dyn AssertionBackend>,
    ) -> Self {
        Self {
            mode: NipFiMode::Enforce,
            backend: Some(backend),
            max_connection_lifetime: Some(max_connection_lifetime),
            refresh_cancel: CancellationToken::new(),
        }
    }
}

impl Drop for CompanyIdentityRuntime {
    fn drop(&mut self) {
        self.refresh_cancel.cancel();
    }
}

fn extract_bearer_assertion(headers: &HeaderMap) -> Result<&str, DenialClass> {
    let mut values = headers.get_all(CLIENT_ATTACHED_HEADER).iter();
    let Some(value) = values.next() else {
        return Err(DenialClass::MissingEvidence);
    };
    if values.next().is_some() {
        return Err(DenialClass::EvidenceRejected);
    }
    let value = value.to_str().map_err(|_| DenialClass::EvidenceRejected)?;
    let token = value
        .strip_prefix("Bearer ")
        .filter(|token| !token.is_empty())
        .ok_or(DenialClass::EvidenceRejected)?;
    if token.contains(',') || token.bytes().any(|byte| byte.is_ascii_whitespace()) {
        return Err(DenialClass::EvidenceRejected);
    }
    Ok(token)
}

/// Convert a NIP-FI denial into its exact privacy-preserving HTTP response.
pub fn denial_response(denial: DenialClass) -> Response {
    let status =
        StatusCode::from_u16(denial.http_status()).unwrap_or(StatusCode::SERVICE_UNAVAILABLE);
    let mut response = (status, denial.http_body()).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static(denial.content_type()),
    );
    if let Some(challenge) = denial.www_authenticate() {
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            axum::http::HeaderValue::from_static(challenge),
        );
    }
    response
}

/// Enforce NIP-FI on non-WebSocket user HTTP routes. The handler still verifies
/// the NIP-98/Blossom event; this boundary only binds the verified assertion to
/// the pubkey declared by that same signed event. X-Pubkey fallback is never
/// accepted while NIP-FI is enforced.
pub async fn enforce_http_request(
    runtime: &CompanyIdentityRuntime,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
) -> Result<(), DenialClass> {
    if runtime.mode() == NipFiMode::Off || is_company_identity_exempt(method, uri, headers) {
        return Ok(());
    }
    if is_unsupported_protected_websocket(uri) {
        return Err(DenialClass::AuthorizationUnavailable);
    }

    let assertion = runtime
        .verify_headers(headers)
        .await?
        .ok_or(DenialClass::MissingEvidence)?;
    let declared_key = declared_nostr_http_pubkey(headers)?;
    if assertion.asserted_key().as_ref() != Some(&declared_key) {
        return Err(DenialClass::AuthorizationDenied);
    }
    Ok(())
}

fn is_company_identity_exempt(method: &Method, uri: &Uri, headers: &HeaderMap) -> bool {
    let path = uri.path();
    if path == "/"
        || path == "/info"
        || path == "/.well-known/nostr.json"
        || path == "/health"
        || path == "/_liveness"
        || path == "/_readiness"
        || path == "/_status"
        || path == "/_mesh"
        || path == "/api/join-policy"
        || path == "/api/join-policy/terms"
        || path == "/api/join-policy/privacy"
        || path.starts_with("/invite/")
        || path.starts_with("/assets/")
        || path == "/favicon.svg"
        || path.starts_with("/api/admin/v1/")
        || path.starts_with("/operator/")
        || path == "/internal/git/policy"
        || path.starts_with("/hooks/")
        || path == "/_mesh/demo/echo"
    {
        return true;
    }

    matches!(*method, Method::GET | Method::HEAD)
        && headers
            .get(header::ACCEPT)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("text/html"))
}

fn is_unsupported_protected_websocket(uri: &Uri) -> bool {
    uri.path().starts_with("/huddle/")
}

fn declared_nostr_http_pubkey(headers: &HeaderMap) -> Result<nostr::PublicKey, DenialClass> {
    let mut values = headers.get_all(header::AUTHORIZATION).iter();
    let Some(value) = values.next() else {
        return Err(DenialClass::MissingEvidence);
    };
    if values.next().is_some() {
        return Err(DenialClass::EvidenceRejected);
    }
    let encoded = value
        .to_str()
        .map_err(|_| DenialClass::EvidenceRejected)?
        .strip_prefix("Nostr ")
        .filter(|value| !value.is_empty())
        .ok_or(DenialClass::EvidenceRejected)?;
    if encoded.len() > 128 * 1024 {
        return Err(DenialClass::EvidenceRejected);
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(encoded))
        .map_err(|_| DenialClass::EvidenceRejected)?;
    let event: nostr::Event =
        serde_json::from_slice(&bytes).map_err(|_| DenialClass::EvidenceRejected)?;
    Ok(event.pubkey)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use buzz_core::CommunityId;
    use buzz_test_client::{BuzzTestClient, RelayMessage, TestClientError};
    use nostr::{EventBuilder, Filter, Keys, Kind, Tag};
    use std::collections::HashMap;
    use std::net::SocketAddr;

    const TEST_ISSUER: &str = "https://company.example";
    const TEST_AUDIENCE: &str = "https://relay.example";

    struct CryptographicTestBackend {
        issuer: buzz_auth::TestFederatedIssuer,
    }

    impl AssertionBackend for CryptographicTestBackend {
        fn verify<'a>(
            &'a self,
            compact_jws: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<VerifiedAssertion, VerifierError>> + Send + 'a>>
        {
            Box::pin(async move { self.issuer.verify(compact_jws) })
        }
    }

    fn enforced_runtime_and_token(
        key: &nostr::PublicKey,
        alter: impl FnOnce(&mut buzz_auth::TestFederatedAssertion),
    ) -> (CompanyIdentityRuntime, String) {
        let issuer = buzz_auth::TestFederatedIssuer::new(TEST_ISSUER, TEST_AUDIENCE);
        let mut assertion = issuer.current_assertion(key.to_hex());
        alter(&mut assertion);
        let token = issuer.mint(&assertion);
        let runtime = CompanyIdentityRuntime::with_test_backend(
            Duration::from_secs(300),
            Arc::new(CryptographicTestBackend { issuer }),
        );
        (runtime, token)
    }

    fn assertion_headers(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            CLIENT_ATTACHED_HEADER,
            axum::http::HeaderValue::from_str(&format!("Bearer {token}"))
                .expect("test assertion header"),
        );
        headers
    }

    fn nostr_authorization_header(keys: &Keys) -> axum::http::HeaderValue {
        let event = EventBuilder::new(Kind::HttpAuth, "")
            .sign_with_keys(keys)
            .expect("sign test possession event");
        let encoded = BASE64.encode(serde_json::to_vec(&event).expect("serialize event"));
        axum::http::HeaderValue::from_str(&format!("Nostr {encoded}"))
            .expect("test Nostr authorization header")
    }

    fn config(values: &[(&str, &str)]) -> Result<CompanyIdentityConfig, ConfigError> {
        let values: HashMap<_, _> = values.iter().copied().collect();
        CompanyIdentityConfig::from_lookup(|name| values.get(name).map(|value| value.to_string()))
    }

    fn valid_values() -> Vec<(&'static str, &'static str)> {
        vec![
            (MODE_ENV, "enforce"),
            (ISSUER_ENV, "https://identity.example"),
            (AUDIENCE_ENV, "https://relay.example"),
            (
                JWKS_URL_ENV,
                "https://identity.example/.well-known/jwks.json",
            ),
            (ALGORITHM_ENV, "ES256"),
            (CLOCK_SKEW_ENV, "30"),
            (ASSERTION_AGE_ENV, "900"),
            (JWKS_REFRESH_ENV, "300"),
            (JWKS_DEADLINE_ENV, "900"),
            (CONNECTION_LIFETIME_ENV, "600"),
        ]
    }

    #[test]
    fn off_is_default_and_preserves_existing_auth() {
        let config = config(&[]).expect("off config");
        assert_eq!(config.mode(), NipFiMode::Off);
    }

    #[test]
    fn enforce_requires_every_trust_and_lease_input() {
        for missing in CONFIG_ENV_NAMES {
            let values = valid_values()
                .into_iter()
                .filter(|(name, _)| *name != missing)
                .collect::<Vec<_>>();
            assert!(
                config(&values).is_err(),
                "missing {missing} must fail closed"
            );
        }
    }

    #[test]
    fn enforce_accepts_an_explicit_valid_contract() {
        let config = config(&valid_values()).expect("valid enforce config");
        assert_eq!(config.mode(), NipFiMode::Enforce);
        assert_eq!(config.registry.len(), 1);
        assert_eq!(
            config.max_connection_lifetime,
            Some(Duration::from_secs(600))
        );
    }

    #[test]
    fn issuer_settings_cannot_sit_inert_while_mode_is_off() {
        let err = config(&[(ISSUER_ENV, "https://identity.example")])
            .expect_err("inert issuer config must be rejected");
        assert!(err.to_string().contains(MODE_ENV));
    }

    #[test]
    fn bearer_transport_rejects_missing_repeated_and_combined_values() {
        let headers = HeaderMap::new();
        assert_eq!(
            extract_bearer_assertion(&headers),
            Err(DenialClass::MissingEvidence)
        );

        let mut headers = HeaderMap::new();
        headers.append(
            CLIENT_ATTACHED_HEADER,
            axum::http::HeaderValue::from_static("Bearer one.two.three"),
        );
        headers.append(
            CLIENT_ATTACHED_HEADER,
            axum::http::HeaderValue::from_static("Bearer four.five.six"),
        );
        assert_eq!(
            extract_bearer_assertion(&headers),
            Err(DenialClass::EvidenceRejected)
        );

        let mut headers = HeaderMap::new();
        headers.insert(
            CLIENT_ATTACHED_HEADER,
            axum::http::HeaderValue::from_static("Bearer one.two.three, Bearer four.five.six"),
        );
        assert_eq!(
            extract_bearer_assertion(&headers),
            Err(DenialClass::EvidenceRejected)
        );
    }

    #[test]
    fn denial_response_uses_the_fixed_privacy_contract() {
        let response = denial_response(DenialClass::MissingEvidence);
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response.headers().get(header::WWW_AUTHENTICATE),
            Some(&axum::http::HeaderValue::from_static("Nostr"))
        );
    }

    #[tokio::test]
    async fn production_verifier_result_binds_to_nip42_key_and_finite_lease() {
        let keys = Keys::generate();
        let (runtime, token) = enforced_runtime_and_token(&keys.public_key(), |_| {});
        let headers = assertion_headers(&token);
        let prepared = runtime
            .verify_headers(&headers)
            .await
            .expect("valid signed assertion")
            .expect("enforce mode returns assertion");
        let lease = runtime
            .finalize_websocket(
                Some(&prepared),
                &keys.public_key(),
                Utc::now() - chrono::Duration::seconds(1),
            )
            .await
            .expect("same-key NIP-42 binding")
            .expect("enforce mode returns finite lease");
        assert!(lease > Duration::ZERO);
        assert!(lease <= Duration::from_secs(300));

        let other = Keys::generate();
        assert_eq!(
            runtime
                .finalize_websocket(Some(&prepared), &other.public_key(), Utc::now())
                .await,
            Err(DenialClass::AuthorizationDenied)
        );
    }

    #[tokio::test]
    async fn production_verifier_rejects_wrong_issuer_audience_and_expiry() {
        let keys = Keys::generate();
        for alter in [
            |assertion: &mut buzz_auth::TestFederatedAssertion| {
                assertion.issuer = "https://other.example".to_owned();
            },
            |assertion: &mut buzz_auth::TestFederatedAssertion| {
                assertion.audience = "https://other-relay.example".to_owned();
            },
            |assertion: &mut buzz_auth::TestFederatedAssertion| {
                assertion.issued_at = Utc::now() - chrono::Duration::minutes(2);
                assertion.expires_at = Utc::now() - chrono::Duration::minutes(1);
            },
        ] {
            let (runtime, token) = enforced_runtime_and_token(&keys.public_key(), alter);
            assert_eq!(
                runtime.verify_headers(&assertion_headers(&token)).await,
                Err(DenialClass::EvidenceRejected)
            );
        }
    }

    #[tokio::test]
    async fn protected_http_requires_matching_assertion_and_nostr_proof() {
        let keys = Keys::generate();
        let (runtime, token) = enforced_runtime_and_token(&keys.public_key(), |_| {});
        let uri: Uri = "/events".parse().expect("test URI");
        let mut headers = assertion_headers(&token);

        assert_eq!(
            enforce_http_request(&runtime, &Method::POST, &uri, &headers).await,
            Err(DenialClass::MissingEvidence)
        );

        let other = Keys::generate();
        headers.insert(header::AUTHORIZATION, nostr_authorization_header(&other));
        assert_eq!(
            enforce_http_request(&runtime, &Method::POST, &uri, &headers).await,
            Err(DenialClass::AuthorizationDenied)
        );

        headers.insert(header::AUTHORIZATION, nostr_authorization_header(&keys));
        assert_eq!(
            enforce_http_request(&runtime, &Method::POST, &uri, &headers).await,
            Ok(())
        );
    }

    #[tokio::test]
    async fn off_preserves_http_and_websocket_admission_without_evidence() {
        let config = config(&[]).expect("off config");
        let runtime = CompanyIdentityRuntime::new(&config);
        let headers = HeaderMap::new();
        assert_eq!(runtime.verify_headers(&headers).await, Ok(None));
        assert_eq!(
            enforce_http_request(
                &runtime,
                &Method::POST,
                &"/events".parse().expect("test URI"),
                &headers,
            )
            .await,
            Ok(())
        );
    }

    async fn integration_state(
        addr: SocketAddr,
        company_identity: CompanyIdentityRuntime,
    ) -> (
        Arc<crate::state::AppState>,
        crate::state::AuditShutdownHandle,
        CommunityId,
    ) {
        let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
            .expect("BUZZ_TEST_DATABASE_URL must name an isolated Postgres database");
        let redis_url = std::env::var("BUZZ_TEST_REDIS_URL")
            .expect("BUZZ_TEST_REDIS_URL must name an isolated Redis instance");
        let mut config = crate::config::Config::from_env().expect("base test config");
        config.database_url = database_url.clone();
        config.redis_url = redis_url.clone();
        config.relay_url = format!("ws://{addr}");
        config.require_relay_membership = true;
        config.pubkey_allowlist_enabled = false;
        config.web_dir = None;
        config.admin = None;

        let pool = sqlx::PgPool::connect(&database_url)
            .await
            .expect("connect isolated Postgres");
        let db = buzz_db::Db::from_pool(pool.clone());
        db.migrate().await.expect("apply relay migrations");
        let community = CommunityId::from_uuid(uuid::Uuid::new_v4());
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(community.as_uuid())
            .bind(addr.to_string())
            .execute(&pool)
            .await
            .expect("insert isolated community");

        let redis_pool = deadpool_redis::Config::from_url(&redis_url)
            .create_pool(Some(deadpool_redis::Runtime::Tokio1))
            .expect("create isolated Redis pool");
        let pubsub = Arc::new(
            buzz_pubsub::PubSubManager::new(&redis_url, redis_pool.clone())
                .await
                .expect("connect isolated Redis pubsub"),
        );
        let auth = buzz_auth::AuthService::new(config.auth.clone());
        let search = buzz_search::SearchService::new(pool.clone());
        let workflow_engine = Arc::new(buzz_workflow::WorkflowEngine::new(
            db.clone(),
            buzz_workflow::WorkflowConfig::default(),
        ));
        let media_storage =
            buzz_media::MediaStorage::new(&config.media).expect("test media config");
        let (mut state, audit_shutdown) = crate::state::AppState::new(
            config,
            db,
            redis_pool,
            None::<buzz_audit::AuditService>,
            pubsub,
            auth,
            search,
            workflow_engine,
            Keys::generate(),
            media_storage,
        );
        state.company_identity = Arc::new(company_identity);
        (Arc::new(state), audit_shutdown, community)
    }

    #[tokio::test]
    #[ignore = "requires isolated Postgres and Redis"]
    async fn websocket_company_identity_binds_real_nip42_membership_publish_and_removal() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind isolated relay listener");
        let addr = listener.local_addr().expect("isolated relay address");
        let verifier_issuer = buzz_auth::TestFederatedIssuer::new(TEST_ISSUER, TEST_AUDIENCE);
        let runtime = CompanyIdentityRuntime::with_test_backend(
            Duration::from_secs(30),
            Arc::new(CryptographicTestBackend {
                issuer: verifier_issuer,
            }),
        );
        let (state, audit_shutdown, community) = integration_state(addr, runtime).await;
        let owner = Keys::generate();
        let member = Keys::generate();
        state
            .db
            .add_relay_member(community, &owner.public_key().to_hex(), "owner", None)
            .await
            .expect("seed owner");
        state
            .db
            .add_relay_member(
                community,
                &member.public_key().to_hex(),
                "member",
                Some(&owner.public_key().to_hex()),
            )
            .await
            .expect("seed member");

        let server = tokio::spawn({
            let state = Arc::clone(&state);
            async move {
                axum::serve(
                    listener,
                    crate::router::build_router(state)
                        .into_make_service_with_connect_info::<SocketAddr>(),
                )
                .await
                .expect("serve isolated relay");
            }
        });
        let url = format!("ws://{addr}");
        let issuer = buzz_auth::TestFederatedIssuer::new(TEST_ISSUER, TEST_AUDIENCE);
        let member_token = issuer.mint(&issuer.current_assertion(member.public_key().to_hex()));
        let owner_token = issuer.mint(&issuer.current_assertion(owner.public_key().to_hex()));

        assert!(
            BuzzTestClient::connect(&url, &member).await.is_err(),
            "Required mode must reject a WebSocket upgrade without company evidence"
        );

        let mut wrong_issuer = issuer.current_assertion(member.public_key().to_hex());
        wrong_issuer.issuer = "https://untrusted.example".to_owned();
        assert!(
            BuzzTestClient::connect_with_federated_assertion(
                &url,
                &member,
                &issuer.mint(&wrong_issuer),
            )
            .await
            .is_err(),
            "wrong issuer must fail before relay admission"
        );
        let mut wrong_audience = issuer.current_assertion(member.public_key().to_hex());
        wrong_audience.audience = "https://other-relay.example".to_owned();
        assert!(
            BuzzTestClient::connect_with_federated_assertion(
                &url,
                &member,
                &issuer.mint(&wrong_audience),
            )
            .await
            .is_err(),
            "wrong audience must fail before relay admission"
        );
        let mut expired = issuer.current_assertion(member.public_key().to_hex());
        expired.issued_at = Utc::now() - chrono::Duration::minutes(2);
        expired.expires_at = Utc::now() - chrono::Duration::minutes(1);
        assert!(
            BuzzTestClient::connect_with_federated_assertion(
                &url,
                &member,
                &issuer.mint(&expired),
            )
            .await
            .is_err(),
            "expired company evidence must fail before relay admission"
        );

        let mismatch =
            BuzzTestClient::connect_with_federated_assertion(&url, &owner, &member_token).await;
        assert!(
            matches!(mismatch, Err(TestClientError::AuthFailed(message)) if message == DenialClass::AuthorizationDenied.nostr_text()),
            "a valid assertion for another Nostr key must fail at the NIP-42 binding seam"
        );

        let mut member_client =
            BuzzTestClient::connect_with_federated_assertion(&url, &member, &member_token)
                .await
                .expect("member assertion and NIP-42 key match");
        let profile = EventBuilder::new(Kind::Metadata, r#"{"name":"NIP-FI member"}"#)
            .sign_with_keys(&member)
            .expect("sign member profile");
        let profile_id = profile.id;
        let publish = member_client
            .send_event(profile)
            .await
            .expect("publish through admitted connection");
        assert!(
            publish.accepted,
            "profile publish must succeed: {}",
            publish.message
        );
        member_client
            .subscribe(
                "nip-fi-member-profile",
                vec![Filter::new()
                    .kind(Kind::Metadata)
                    .authors(vec![member.public_key()])],
            )
            .await
            .expect("subscribe through admitted connection");
        let events = member_client
            .collect_until_eose("nip-fi-member-profile", Duration::from_secs(3))
            .await
            .expect("read through admitted connection");
        assert!(events.iter().any(|event| event.id == profile_id));

        let mut owner_client =
            BuzzTestClient::connect_with_federated_assertion(&url, &owner, &owner_token)
                .await
                .expect("owner assertion and NIP-42 key match");
        let removal = EventBuilder::new(Kind::Custom(9_031), "")
            .tags([Tag::parse(["p", &member.public_key().to_hex()]).expect("member p tag")])
            .sign_with_keys(&owner)
            .expect("sign relay-member removal");
        let removal_id = removal.id.to_hex();
        let removed = owner_client
            .send_event(removal)
            .await
            .expect("remove relay member");
        assert!(
            removed.accepted,
            "member removal must succeed: {}",
            removed.message
        );

        let live_revoke = member_client
            .recv_event(Duration::from_secs(3))
            .await
            .expect("removed live member receives final denial");
        assert!(
            matches!(live_revoke, RelayMessage::Ok(ref ok)
                if ok.event_id == removal_id
                    && !ok.accepted
                    && ok.message == "restricted: not a relay member"),
            "member removal must close the existing community-scoped session"
        );
        let reconnect =
            BuzzTestClient::connect_with_federated_assertion(&url, &member, &member_token).await;
        assert!(
            matches!(reconnect, Err(TestClientError::AuthFailed(message)) if message == "restricted: not a relay member"),
            "a removed member must not reconnect with otherwise valid company evidence"
        );

        server.abort();
        let _ = server.await;
        audit_shutdown.drain(Duration::from_secs(1)).await;
    }
}
