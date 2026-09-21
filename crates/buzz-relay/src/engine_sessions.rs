//! Bounded one-time session broker for replaceable product UIs.
//!
//! The broker never receives or stores a Nostr private key. A launch is minted
//! only after the HTTP layer verifies the user's NIP-98 signature, current
//! relay membership, product origin, and explicit provider principal mapping.
//! Provider servers exchange the opaque code once and must revalidate the
//! resulting session on every active request/write.

use std::{collections::HashMap, sync::Mutex};

use base64::Engine as _;
use buzz_core::{engine_bridge::EngineProduct, CommunityId};
use hmac::{Hmac, KeyInit as _, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq as _;
use uuid::Uuid;

const LAUNCH_TTL_SECONDS: i64 = 60;
const SESSION_TTL_SECONDS: i64 = 15 * 60;
const MAX_LAUNCHES: usize = 1_024;
const MAX_SESSIONS: usize = 4_096;
const SERVER_AUTH_MAX_SKEW_SECONDS: i64 = 30;

/// One trusted engine server configured at relay startup.
#[derive(Clone)]
pub struct EngineProviderConfig {
    /// Exact configured full-product origin.
    pub origin: String,
    server_key: Vec<u8>,
}

/// Optional managed-session endpoints. With no configured product the broker
/// surface remains fail-closed and inert.
#[derive(Clone, Default)]
pub struct EngineSessionConfig {
    affine: Option<EngineProviderConfig>,
    plane: Option<EngineProviderConfig>,
}

impl EngineSessionConfig {
    /// Load product origins and server-only verifier keys from environment.
    /// Both values are required per product; partial configuration is ignored.
    pub fn from_env() -> Self {
        Self {
            affine: provider_from_env("BUZZ_ENGINE_AFFINE_ORIGIN", "BUZZ_ENGINE_AFFINE_BROKER_KEY"),
            plane: provider_from_env("BUZZ_ENGINE_PLANE_ORIGIN", "BUZZ_ENGINE_PLANE_BROKER_KEY"),
        }
    }

    /// Return the configured provider for one product, if fully configured.
    pub fn provider(&self, product: EngineProduct) -> Option<&EngineProviderConfig> {
        match product {
            EngineProduct::Affine => self.affine.as_ref(),
            EngineProduct::Plane => self.plane.as_ref(),
        }
    }
}

fn provider_from_env(origin_name: &str, key_name: &str) -> Option<EngineProviderConfig> {
    let origin = std::env::var(origin_name).ok()?;
    let key = std::env::var(key_name).ok()?;
    let parsed = url::Url::parse(&origin).ok()?;
    let loopback = parsed.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if !(parsed.scheme() == "https" || (parsed.scheme() == "http" && loopback))
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || key.len() < 32
    {
        return None;
    }
    Some(EngineProviderConfig {
        origin,
        server_key: key.into_bytes(),
    })
}

impl EngineProviderConfig {
    /// Verify a provider callback without exposing the configured key.
    pub fn verify_server_auth(
        &self,
        timestamp: i64,
        signature_hex: &str,
        body: &[u8],
        now: i64,
    ) -> bool {
        if (now - timestamp).abs() > SERVER_AUTH_MAX_SKEW_SECONDS {
            return false;
        }
        let Ok(signature) = hex::decode(signature_hex) else {
            return false;
        };
        let body_hash = hex::encode(Sha256::digest(body));
        let message = format!("{timestamp}\n{body_hash}");
        let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(&self.server_key) else {
            return false;
        };
        mac.update(message.as_bytes());
        let expected = mac.finalize().into_bytes();
        expected.as_slice().ct_eq(signature.as_slice()).into()
    }
}

/// Scope resolved by trusted relay code before minting a launch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineLaunchScope {
    /// Server-derived A2D2 community.
    pub community: CommunityId,
    /// Active member's Nostr public key bytes.
    pub pubkey: [u8; 32],
    /// Managed product receiving the session.
    pub product: EngineProduct,
    /// Exact configured provider origin.
    pub origin: String,
    /// Native child mount UUID.
    pub mount_session: Uuid,
    /// Digest of the product-origin callback state bound into this launch.
    pub callback_state_sha256: [u8; 32],
    /// Current A2D2 membership role (`owner`, `admin`, or `member`).
    pub role: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct LaunchRecord {
    scope: EngineLaunchScope,
    expires_at: i64,
}

/// Server-side session scope returned after consuming a launch code.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineSessionScope {
    /// Server-derived A2D2 community.
    pub community: CommunityId,
    /// Active member's Nostr public key bytes.
    pub pubkey: [u8; 32],
    /// Managed product receiving the session.
    pub product: EngineProduct,
    /// Exact configured provider origin.
    pub origin: String,
    /// Native child mount UUID.
    pub mount_session: Uuid,
    /// Current A2D2 membership role. Provider access is derived from this
    /// minimum authority and never defaults to provider admin.
    pub role: String,
    /// Session expiry as Unix seconds.
    pub expires_at: i64,
}

/// One opaque code returned to the trusted native launcher.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MintedEngineLaunch {
    /// Opaque single-use launch code.
    pub code: String,
    /// Launch expiry as Unix seconds.
    pub expires_at: i64,
}

/// One opaque provider-server session. The token must become an HttpOnly cookie
/// or a server-side session key and must never be exposed in a URL.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MintedEngineSession {
    /// Opaque provider-server session token.
    pub token: String,
    /// Public scope bound to the token.
    pub scope: EngineSessionScope,
}

/// Fail-closed broker result. Errors intentionally carry no secret material.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EngineSessionError {
    /// The bounded broker is full or unavailable.
    Full,
    /// The launch is missing, expired, or already consumed.
    InvalidLaunch,
    /// The session is missing, expired, or revoked.
    InvalidSession,
    /// Product, origin, mount, or callback state did not match.
    ScopeMismatch,
}

#[derive(Default)]
struct EngineSessionState {
    launches: HashMap<[u8; 32], LaunchRecord>,
    sessions: HashMap<[u8; 32], EngineSessionScope>,
}

/// Process-local bounded broker. Restart invalidates all product sessions.
#[derive(Default)]
pub struct EngineSessionBroker {
    state: Mutex<EngineSessionState>,
}

fn opaque_token() -> String {
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn token_key(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

fn retain_live(state: &mut EngineSessionState, now: i64) {
    state.launches.retain(|_, launch| launch.expires_at > now);
    state.sessions.retain(|_, session| session.expires_at > now);
}

impl EngineSessionBroker {
    /// Mint a one-time, one-minute launch code for an already-authorized scope.
    pub fn mint(
        &self,
        scope: EngineLaunchScope,
        now: i64,
    ) -> Result<MintedEngineLaunch, EngineSessionError> {
        let mut state = self.state.lock().map_err(|_| EngineSessionError::Full)?;
        retain_live(&mut state, now);
        if state.launches.len() >= MAX_LAUNCHES {
            return Err(EngineSessionError::Full);
        }
        let code = opaque_token();
        let expires_at = now + LAUNCH_TTL_SECONDS;
        state
            .launches
            .insert(token_key(&code), LaunchRecord { scope, expires_at });
        Ok(MintedEngineLaunch { code, expires_at })
    }

    /// Consume a launch exactly once and bind a server-side provider session.
    pub fn exchange(
        &self,
        code: &str,
        expected_product: EngineProduct,
        expected_origin: &str,
        expected_mount: Uuid,
        callback_state: &[u8],
        now: i64,
    ) -> Result<MintedEngineSession, EngineSessionError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| EngineSessionError::InvalidLaunch)?;
        retain_live(&mut state, now);
        // Removal happens before scope validation: a stolen/misbinding attempt
        // burns the code instead of leaving it reusable.
        let launch = state
            .launches
            .remove(&token_key(code))
            .ok_or(EngineSessionError::InvalidLaunch)?;
        if launch.scope.product != expected_product
            || launch.scope.origin != expected_origin
            || launch.scope.mount_session != expected_mount
        {
            return Err(EngineSessionError::ScopeMismatch);
        }
        let callback_digest: [u8; 32] = Sha256::digest(callback_state).into();
        if launch
            .scope
            .callback_state_sha256
            .ct_eq(&callback_digest)
            .unwrap_u8()
            != 1
        {
            return Err(EngineSessionError::ScopeMismatch);
        }
        if state.sessions.len() >= MAX_SESSIONS {
            return Err(EngineSessionError::Full);
        }
        let token = opaque_token();
        let scope = EngineSessionScope {
            community: launch.scope.community,
            pubkey: launch.scope.pubkey,
            product: launch.scope.product,
            origin: launch.scope.origin,
            mount_session: launch.scope.mount_session,
            role: launch.scope.role,
            expires_at: now + SESSION_TTL_SECONDS,
        };
        state.sessions.insert(token_key(&token), scope.clone());
        Ok(MintedEngineSession { token, scope })
    }

    /// Resolve a live session for provider middleware. Callers must recheck
    /// relay membership after this lookup and call [`Self::revoke`] on denial.
    pub fn session(&self, token: &str, now: i64) -> Result<EngineSessionScope, EngineSessionError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| EngineSessionError::InvalidSession)?;
        retain_live(&mut state, now);
        state
            .sessions
            .get(&token_key(token))
            .cloned()
            .ok_or(EngineSessionError::InvalidSession)
    }

    /// Revoke one active provider session immediately.
    pub fn revoke(&self, token: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.sessions.remove(&token_key(token));
        }
    }

    /// Revoke every launch and session for a removed A2D2 member.
    pub fn revoke_principal(&self, community: CommunityId, pubkey: &[u8; 32]) {
        if let Ok(mut state) = self.state.lock() {
            state.launches.retain(|_, launch| {
                launch.scope.community != community || &launch.scope.pubkey != pubkey
            });
            state
                .sessions
                .retain(|_, session| session.community != community || &session.pubkey != pubkey);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(community: CommunityId, pubkey_byte: u8) -> EngineLaunchScope {
        EngineLaunchScope {
            community,
            pubkey: [pubkey_byte; 32],
            product: EngineProduct::Plane,
            origin: "https://plane.example.test".into(),
            mount_session: Uuid::new_v4(),
            callback_state_sha256: Sha256::digest(b"provider-state").into(),
            role: "member".into(),
        }
    }

    #[test]
    fn two_users_are_isolated_and_launch_is_one_time() {
        let broker = EngineSessionBroker::default();
        let community = CommunityId::from_uuid(Uuid::new_v4());
        let alice = scope(community, 1);
        let bob = scope(community, 2);
        let alice_launch = broker.mint(alice.clone(), 1_000).unwrap();
        let bob_launch = broker.mint(bob.clone(), 1_000).unwrap();

        let alice_session = broker
            .exchange(
                &alice_launch.code,
                alice.product,
                &alice.origin,
                alice.mount_session,
                b"provider-state",
                1_001,
            )
            .unwrap();
        let bob_session = broker
            .exchange(
                &bob_launch.code,
                bob.product,
                &bob.origin,
                bob.mount_session,
                b"provider-state",
                1_001,
            )
            .unwrap();
        assert_ne!(alice_session.token, bob_session.token);
        assert_eq!(
            broker.session(&alice_session.token, 1_002).unwrap().pubkey,
            [1; 32]
        );
        assert_eq!(
            broker.session(&bob_session.token, 1_002).unwrap().pubkey,
            [2; 32]
        );
        assert_eq!(
            broker.exchange(
                &alice_launch.code,
                alice.product,
                &alice.origin,
                alice.mount_session,
                b"provider-state",
                1_002,
            ),
            Err(EngineSessionError::InvalidLaunch)
        );
    }

    #[test]
    fn revoke_removes_only_the_target_principal_and_expiry_fails_closed() {
        let broker = EngineSessionBroker::default();
        let community = CommunityId::from_uuid(Uuid::new_v4());
        let alice = scope(community, 1);
        let bob = scope(community, 2);
        let alice_launch = broker.mint(alice.clone(), 1_000).unwrap();
        let bob_launch = broker.mint(bob.clone(), 1_000).unwrap();
        let alice_session = broker
            .exchange(
                &alice_launch.code,
                alice.product,
                &alice.origin,
                alice.mount_session,
                b"provider-state",
                1_001,
            )
            .unwrap();
        let bob_session = broker
            .exchange(
                &bob_launch.code,
                bob.product,
                &bob.origin,
                bob.mount_session,
                b"provider-state",
                1_001,
            )
            .unwrap();

        broker.revoke_principal(community, &[1; 32]);
        assert_eq!(
            broker.session(&alice_session.token, 1_002),
            Err(EngineSessionError::InvalidSession)
        );
        assert_eq!(
            broker.session(&bob_session.token, 1_002).unwrap().pubkey,
            [2; 32]
        );
        assert_eq!(
            broker.session(&bob_session.token, 1_001 + SESSION_TTL_SECONDS),
            Err(EngineSessionError::InvalidSession)
        );
    }

    #[test]
    fn callback_state_is_bound_and_a_mismatch_burns_the_launch() {
        let broker = EngineSessionBroker::default();
        let community = CommunityId::from_uuid(Uuid::new_v4());
        let launch_scope = scope(community, 1);
        let launch = broker.mint(launch_scope.clone(), 1_000).unwrap();

        assert_eq!(
            broker.exchange(
                &launch.code,
                launch_scope.product,
                &launch_scope.origin,
                launch_scope.mount_session,
                b"wrong-state",
                1_001,
            ),
            Err(EngineSessionError::ScopeMismatch)
        );
        assert_eq!(
            broker.exchange(
                &launch.code,
                launch_scope.product,
                &launch_scope.origin,
                launch_scope.mount_session,
                b"provider-state",
                1_001,
            ),
            Err(EngineSessionError::InvalidLaunch)
        );
    }
}
