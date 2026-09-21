//! Narrow cryptographic fixtures for downstream production-seam tests.
//!
//! This module is absent from production builds. It deliberately exposes no
//! issuer key source or `VerifiedAssertion` constructor: callers can only mint
//! a compact JWS with the fixed test key and submit it to the real verifier.

use chrono::{DateTime, Duration, Utc};
use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde_json::json;

use super::config::{FreshnessClass, IssuerPolicy, IssuerRegistry, TokenClass};
use super::jwks::JwksSourceContract;
use super::verifier::{AssertionKeySet, StaticIssuerKeySource};
use super::{FederatedAssertionVerifier, VerifiedAssertion, VerifierError};

const TEST_EC_PKCS8_PEM: &str = "-----BEGIN PRIVATE KEY-----\n\
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgcnxDM4EiirH9dHUE\n\
WZc759TX4s5PAn8kO5ovXSnGxCWhRANCAARFb6ZnsfkqOOXyEhj3KBQphGKF4vTa\n\
zhebbavbZ1ZoklqkF1cGg+jTO7rONAVEzXvXUWtV6CdDV+rybiVmFP2w\n\
-----END PRIVATE KEY-----\n";
const TEST_JWK_X: &str = "RW-mZ7H5Kjjl8hIY9ygUKYRiheL02s4Xm22r22dWaJI";
const TEST_JWK_Y: &str = "WqQXVwaD6NM7us40BUTNe9dRa1XoJ0NX6vJuJWYU_bA";
const TEST_KID: &str = "nip-fi-integration-test-key";

/// Explicit claims for one cryptographically signed test assertion.
#[derive(Clone, Debug)]
pub struct TestFederatedAssertion {
    /// Exact issuer claim.
    pub issuer: String,
    /// Exact audience claim.
    pub audience: String,
    /// Opaque stable subject claim.
    pub subject: String,
    /// Lowercase hexadecimal Nostr public key claim.
    pub nostr_pubkey: String,
    /// Issued-at instant.
    pub issued_at: DateTime<Utc>,
    /// Expiration instant.
    pub expires_at: DateTime<Utc>,
}

/// Fixed-key issuer fixture backed by the production assertion verifier.
pub struct TestFederatedIssuer {
    issuer: String,
    audience: String,
    verifier: FederatedAssertionVerifier<StaticIssuerKeySource>,
}

impl TestFederatedIssuer {
    /// Construct one exact issuer/audience trust domain.
    pub fn new(issuer: impl Into<String>, audience: impl Into<String>) -> Self {
        let issuer = issuer.into();
        let audience = audience.into();
        let contract =
            JwksSourceContract::new(format!("{issuer}/.well-known/jwks.json"), 300, 3600)
                .expect("test issuer must be an HTTPS origin");
        let policy = IssuerPolicy::new(
            issuer.clone(),
            vec![audience.clone()],
            TokenClass::DedicatedNipFi,
            FreshnessClass::OfflineJwt,
            vec![Algorithm::ES256],
            30,
            3600,
            None,
            contract,
        )
        .expect("fixed test policy is valid");
        let mut registry = IssuerRegistry::new();
        registry.insert(policy);
        let jwks: JwkSet = serde_json::from_value(json!({
            "keys": [{
                "kty": "EC",
                "crv": "P-256",
                "use": "sig",
                "alg": "ES256",
                "kid": TEST_KID,
                "x": TEST_JWK_X,
                "y": TEST_JWK_Y,
            }]
        }))
        .expect("fixed test JWKS is valid");
        let key_set =
            AssertionKeySet::new(issuer.clone(), 1, jwks, Utc::now() + Duration::hours(1))
                .expect("fixed test key set is valid");
        let verifier =
            FederatedAssertionVerifier::new(registry, StaticIssuerKeySource::new([key_set]));
        Self {
            issuer,
            audience,
            verifier,
        }
    }

    /// Claims that should be valid now for the supplied Nostr key.
    pub fn current_assertion(&self, nostr_pubkey: impl Into<String>) -> TestFederatedAssertion {
        let issued_at = Utc::now() - Duration::seconds(1);
        TestFederatedAssertion {
            issuer: self.issuer.clone(),
            audience: self.audience.clone(),
            subject: "company-user-1".to_owned(),
            nostr_pubkey: nostr_pubkey.into(),
            issued_at,
            expires_at: issued_at + Duration::minutes(10),
        }
    }

    /// Mint one real ES256 compact JWS with the fixed test-only private key.
    pub fn mint(&self, assertion: &TestFederatedAssertion) -> String {
        let mut header = Header::new(Algorithm::ES256);
        header.typ = Some("nip-fi+jwt".to_owned());
        header.kid = Some(TEST_KID.to_owned());
        jsonwebtoken::encode(
            &header,
            &json!({
                "iss": assertion.issuer,
                "sub": assertion.subject,
                "aud": assertion.audience,
                "iat": assertion.issued_at.timestamp(),
                "exp": assertion.expires_at.timestamp(),
                "nostr_pubkey": assertion.nostr_pubkey,
            }),
            &EncodingKey::from_ec_pem(TEST_EC_PKCS8_PEM.as_bytes())
                .expect("fixed test signing key is valid"),
        )
        .expect("fixed test assertion serializes")
    }

    /// Run the production verifier over a compact JWS.
    pub fn verify(&self, compact_jws: &str) -> Result<VerifiedAssertion, VerifierError> {
        self.verifier.verify(compact_jws)
    }
}
