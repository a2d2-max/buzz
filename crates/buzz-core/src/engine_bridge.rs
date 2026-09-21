//! Shared wire contract for replaceable engine UIs hosted by Buzz Desktop.
//!
//! The contract carries public identity and scope only. A private key, signed
//! launch assertion, provider credential, or provider session must never be
//! serialized into this envelope. The native host derives and verifies the
//! authoritative values before signing the exact canonical event.

use nostr::PublicKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use url::Url;
use uuid::Uuid;

/// Current engine bridge wire version.
pub const ENGINE_BRIDGE_VERSION: u16 = 1;
/// Maximum lifetime of a one-time launch intent.
pub const ENGINE_LAUNCH_MAX_TTL_SECONDS: i64 = 60;
/// Maximum product mutation body accepted by the native bridge (32 MiB raw).
pub const ENGINE_MUTATION_MAX_BYTES: usize = 32 * 1024 * 1024;

/// Replaceable upstream product hosted by the native child WebView.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineProduct {
    /// AFFiNE full product UI.
    Affine,
    /// Plane full product UI.
    Plane,
}

/// Operation requested through the native bridge.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineAction {
    /// Mint one short-lived, one-time provider-session launch intent.
    LaunchSession,
    /// Create a canonical entity before projecting it to the engine.
    Create,
    /// Update a canonical entity before projecting it to the engine.
    Update,
    /// Delete a canonical entity before projecting it to the engine.
    Delete,
    /// Attach a canonical blob before projecting it to the engine.
    UploadAsset,
}

/// Body signed by the native A2D2 identity to mint one product launch.
///
/// The relay derives the community from the request host. The native host does
/// not accept identity or scope fields from the child product; it supplies the
/// actual mounted view, configured origin, and active public key itself. The
/// only child-provided value is the product origin's CSRF state, represented
/// here by its digest so the raw value never enters the NIP-98 event or logs.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EngineLaunchIntent {
    /// Wire contract version. Must equal [`ENGINE_BRIDGE_VERSION`].
    pub version: u16,
    /// Product whose managed session will be created.
    pub product: EngineProduct,
    /// Must be [`EngineAction::LaunchSession`].
    pub action: EngineAction,
    /// UUID of the currently mounted native child view.
    pub mount_session: Uuid,
    /// Exact configured product origin, without credentials, query, or fragment.
    pub origin: String,
    /// Lowercase hex public key of the active A2D2 identity.
    pub pubkey: String,
    /// Native-generated single-use request nonce.
    pub nonce: Uuid,
    /// SHA-256 of the product-origin CSRF state returned by its begin endpoint.
    pub callback_state_sha256: String,
    /// Unix timestamp after which this launch is rejected.
    pub expires_at: i64,
}

/// Canonical entity namespace. Product identifiers remain opaque strings.
///
/// AFFiNE workspace metadata/tree rows intentionally do not share the legacy
/// one-page document namespace: projecting them as a kind-30623 page would
/// leak product metadata into the user's A2D2 Docs tree.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineEntityClass {
    /// AFFiNE workspace root metadata.
    AffineWorkspaceRoot,
    /// AFFiNE page tree metadata (parent/order/trash state).
    AffinePageTree,
    /// AFFiNE Yjs document snapshot/update mapped to an A2D2 Docs page.
    AffineDocument,
    /// AFFiNE comment thread/reply metadata.
    AffineComment,
    /// AFFiNE binary asset stored through the community Blossom endpoint.
    AffineAsset,
    /// Plane work item mapped to an A2D2 canonical task.
    PlaneTask,
    /// Plane work-item attachment stored through the community Blossom endpoint.
    PlaneAsset,
}

impl EngineEntityClass {
    fn product(self) -> EngineProduct {
        match self {
            Self::AffineWorkspaceRoot
            | Self::AffinePageTree
            | Self::AffineDocument
            | Self::AffineComment
            | Self::AffineAsset => EngineProduct::Affine,
            Self::PlaneTask | Self::PlaneAsset => EngineProduct::Plane,
        }
    }
}

/// Product identifiers bound to one canonical A2D2 entity.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EngineEntityRef {
    /// Canonical namespace for this object.
    pub class: EngineEntityClass,
    /// Opaque product workspace/space identifier (not required to be a UUID).
    pub workspace_id: String,
    /// Opaque product object identifier (AFFiNE DocID may be a nanoid).
    pub entity_id: String,
    /// A2D2 page/task id when this product object maps to an existing native surface.
    pub canonical_entity_id: Option<String>,
}

/// Exact product mutation passed across the narrow native bridge.
///
/// `payload_base64` contains product-specific bytes: an AFFiNE Yjs update or
/// a deterministic Plane task payload. The trusted A2D2 consumer validates and
/// merges those bytes; the child cannot provide a pre-signed canonical event.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EngineMutationRequest {
    /// Mount, origin, community, and active identity fence.
    pub binding: EngineBridgeBinding,
    /// Product object and canonical namespace.
    pub entity: EngineEntityRef,
    /// Current canonical event the product UI edited, if one exists.
    pub base_event_id: Option<String>,
    /// Current durable projection generation observed before editing.
    pub base_generation: i64,
    /// SHA-256 of the decoded product payload.
    pub payload_sha256: String,
    /// Base64 standard encoding of the exact product mutation bytes.
    pub payload_base64: String,
}

/// Untrusted product payload accepted by the injected narrow JS surface.
///
/// The child cannot supply `product`, `origin`, `mount_session`, `community`,
/// `pubkey`, `nonce`, or `expires_at`. Native code derives all of those fields
/// and constructs [`EngineMutationRequest`] only after matching the actual
/// WebView label and URL to its live mount record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EngineMutationDraft {
    /// Mutation operation requested by the product UI.
    pub action: EngineAction,
    /// Product object and canonical namespace.
    pub entity: EngineEntityRef,
    /// Current canonical event the product UI edited, if one exists.
    pub base_event_id: Option<String>,
    /// Current durable generation observed before editing.
    pub base_generation: i64,
    /// SHA-256 of decoded `payload_base64`.
    pub payload_sha256: String,
    /// Base64 standard encoding of the exact product mutation bytes.
    pub payload_base64: String,
}

impl EngineMutationDraft {
    /// Bind an untrusted draft to trusted native mount state.
    pub fn bind(self, binding: EngineBridgeBinding) -> EngineMutationRequest {
        EngineMutationRequest {
            binding,
            entity: self.entity,
            base_event_id: self.base_event_id,
            base_generation: self.base_generation,
            payload_sha256: self.payload_sha256,
            payload_base64: self.payload_base64,
        }
    }
}

/// One content-addressed blob durably accepted by the A2D2 community store.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CanonicalBlobReceipt {
    /// SHA-256 content address returned by the community Blossom server.
    pub sha256: String,
    /// Exact accepted byte length.
    pub size: u64,
}

/// Synchronous result returned only after native signing and relay ACK.
///
/// This receipt deliberately contains no provider identifier: the canonical
/// commit precedes every derived AFFiNE/Plane write.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CanonicalAccepted {
    /// Single-use bridge nonce copied from the verified binding.
    pub request_nonce: Uuid,
    /// Product and action that were accepted.
    pub product: EngineProduct,
    /// Exact mutation operation accepted for this product entity.
    pub action: EngineAction,
    /// Exact product/canonical coordinate committed.
    pub entity: EngineEntityRef,
    /// Signed A2D2 event accepted by the relay.
    pub event_id: String,
    /// Monotonic generation in the durable projection outbox.
    pub generation: i64,
    /// Exact product payload digest covered by the accepted event.
    pub payload_sha256: String,
    /// Blobs accepted before the canonical event was published.
    pub blobs: Vec<CanonicalBlobReceipt>,
}

/// Later derived-provider readback. Never substitutes for canonical acceptance.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProductProjectionApplied {
    /// Relay-accepted canonical event this projection derives from.
    pub event_id: String,
    /// Generation fenced by the projection worker.
    pub generation: i64,
    /// Opaque provider id (UUID, nanoid, or composite string).
    pub provider_entity_id: String,
    /// SHA-256 of normalized provider readback.
    pub readback_sha256: String,
}

/// Scope bound into every launch or mutation request.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EngineBridgeBinding {
    /// Wire contract version. Must equal [`ENGINE_BRIDGE_VERSION`].
    pub version: u16,
    /// Product receiving the derived projection.
    pub product: EngineProduct,
    /// Requested operation.
    pub action: EngineAction,
    /// UUID of the currently mounted native child view.
    pub mount_session: Uuid,
    /// Exact configured product origin, without credentials, query, or fragment.
    pub origin: String,
    /// Community UUID resolved by the trusted host and compared by native code.
    pub community_id: Uuid,
    /// Lowercase hex Nostr public key owned by the active A2D2 identity.
    pub pubkey: String,
    /// Single-use request nonce.
    pub nonce: Uuid,
    /// Unix timestamp after which this request is rejected.
    pub expires_at: i64,
}

/// Validation failure for an untrusted engine bridge envelope.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum EngineBridgeError {
    /// The sender used a contract version this binary does not implement.
    #[error("unsupported engine bridge version")]
    Version,
    /// The request expired or exceeds the one-minute launch lifetime.
    #[error("engine bridge request expired or exceeds its lifetime")]
    Lifetime,
    /// The origin is not HTTPS or an explicit loopback development URL.
    #[error("invalid engine origin")]
    Origin,
    /// The public key is not canonical lowercase Nostr hex.
    #[error("invalid engine bridge public key")]
    Pubkey,
    /// The provider callback-state digest is not canonical SHA-256 hex.
    #[error("invalid engine callback state")]
    CallbackState,
    /// Product and canonical entity namespace disagree.
    #[error("engine product does not match its canonical entity class")]
    Product,
    /// Entity identifiers are empty, oversized, or contain control bytes.
    #[error("invalid engine entity identifier")]
    Entity,
    /// Base event id/generation is malformed.
    #[error("invalid canonical mutation base")]
    Base,
    /// Mutation bytes are malformed, oversized, or fail their SHA-256 digest.
    #[error("invalid engine mutation payload")]
    Payload,
}

impl EngineLaunchIntent {
    /// Validate launch syntax before relay host/member authorization.
    pub fn validate_syntax(&self, now: i64) -> Result<(), EngineBridgeError> {
        if self.action != EngineAction::LaunchSession {
            return Err(EngineBridgeError::Product);
        }
        let binding = EngineBridgeBinding {
            version: self.version,
            product: self.product,
            action: self.action,
            mount_session: self.mount_session,
            origin: self.origin.clone(),
            // Launch communities are host-derived by the relay. This local
            // binding exists only to reuse common origin/pubkey/lifetime checks.
            community_id: Uuid::nil(),
            pubkey: self.pubkey.clone(),
            nonce: self.nonce,
            expires_at: self.expires_at,
        };
        binding.validate_syntax(now)?;
        if !valid_sha256(&self.callback_state_sha256) {
            return Err(EngineBridgeError::CallbackState);
        }
        Ok(())
    }
}

impl EngineBridgeBinding {
    /// Validate client-independent syntax before trusted scope comparison.
    ///
    /// The native and relay callers must additionally compare `origin`,
    /// `community_id`, `pubkey`, and `mount_session` to values they resolved
    /// themselves. Passing this function alone does not authorize a request.
    pub fn validate_syntax(&self, now: i64) -> Result<(), EngineBridgeError> {
        if self.version != ENGINE_BRIDGE_VERSION {
            return Err(EngineBridgeError::Version);
        }
        if self.expires_at <= now || self.expires_at - now > ENGINE_LAUNCH_MAX_TTL_SECONDS {
            return Err(EngineBridgeError::Lifetime);
        }
        let url = Url::parse(&self.origin).map_err(|_| EngineBridgeError::Origin)?;
        let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
        if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(EngineBridgeError::Origin);
        }
        let parsed = PublicKey::from_hex(&self.pubkey).map_err(|_| EngineBridgeError::Pubkey)?;
        if parsed.to_hex() != self.pubkey {
            return Err(EngineBridgeError::Pubkey);
        }
        Ok(())
    }
}

fn valid_opaque_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

impl EngineMutationRequest {
    /// Validate untrusted wire syntax before trusted native scope comparison.
    pub fn validate_syntax(&self, now: i64) -> Result<(), EngineBridgeError> {
        self.binding.validate_syntax(now)?;
        if self.binding.action == EngineAction::LaunchSession {
            return Err(EngineBridgeError::Product);
        }
        if self.entity.class.product() != self.binding.product {
            return Err(EngineBridgeError::Product);
        }
        if !valid_opaque_id(&self.entity.workspace_id)
            || !valid_opaque_id(&self.entity.entity_id)
            || self
                .entity
                .canonical_entity_id
                .as_deref()
                .is_some_and(|value| !valid_opaque_id(value))
        {
            return Err(EngineBridgeError::Entity);
        }
        if self.base_generation < 0
            || self.base_event_id.as_deref().is_some_and(|value| {
                value.len() != 64
                    || !value
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
        {
            return Err(EngineBridgeError::Base);
        }
        if !valid_sha256(&self.payload_sha256)
            || self.payload_base64.len() > ENGINE_MUTATION_MAX_BYTES.saturating_mul(4) / 3 + 4
        {
            return Err(EngineBridgeError::Payload);
        }
        use base64::Engine as _;
        let payload = base64::engine::general_purpose::STANDARD
            .decode(&self.payload_base64)
            .map_err(|_| EngineBridgeError::Payload)?;
        if payload.len() > ENGINE_MUTATION_MAX_BYTES
            || hex::encode(Sha256::digest(&payload)) != self.payload_sha256
        {
            return Err(EngineBridgeError::Payload);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding() -> EngineBridgeBinding {
        EngineBridgeBinding {
            version: ENGINE_BRIDGE_VERSION,
            product: EngineProduct::Plane,
            action: EngineAction::LaunchSession,
            mount_session: Uuid::new_v4(),
            origin: "https://plane.example.test".into(),
            community_id: Uuid::new_v4(),
            pubkey: "340bf15539596e863cb1291c099da793f0fdebd994037594e2f749d5a855345e".into(),
            nonce: Uuid::new_v4(),
            expires_at: 1_050,
        }
    }

    fn mutation() -> EngineMutationRequest {
        use base64::Engine as _;
        let payload = b"exact product mutation";
        let mut binding = binding();
        binding.action = EngineAction::Update;
        EngineMutationRequest {
            binding,
            entity: EngineEntityRef {
                class: EngineEntityClass::PlaneTask,
                workspace_id: "a2d2".into(),
                entity_id: "work-item-nanoid".into(),
                canonical_entity_id: Some("canonical-task-1".into()),
            },
            base_event_id: Some("a".repeat(64)),
            base_generation: 4,
            payload_sha256: hex::encode(Sha256::digest(payload)),
            payload_base64: base64::engine::general_purpose::STANDARD.encode(payload),
        }
    }

    #[test]
    fn exact_bound_launch_contract_validates() {
        assert_eq!(binding().validate_syntax(1_000), Ok(()));
        let binding = binding();
        let launch = EngineLaunchIntent {
            version: binding.version,
            product: binding.product,
            action: binding.action,
            mount_session: binding.mount_session,
            origin: binding.origin,
            pubkey: binding.pubkey,
            nonce: binding.nonce,
            callback_state_sha256: "b".repeat(64),
            expires_at: binding.expires_at,
        };
        assert_eq!(launch.validate_syntax(1_000), Ok(()));

        let mut invalid_state = launch;
        invalid_state.callback_state_sha256 = "not-a-digest".into();
        assert_eq!(
            invalid_state.validate_syntax(1_000),
            Err(EngineBridgeError::CallbackState)
        );
    }

    #[test]
    fn stale_long_lived_and_wrong_version_requests_fail_closed() {
        let mut request = binding();
        request.expires_at = 1_000;
        assert_eq!(
            request.validate_syntax(1_000),
            Err(EngineBridgeError::Lifetime)
        );
        request.expires_at = 1_061;
        assert_eq!(
            request.validate_syntax(1_000),
            Err(EngineBridgeError::Lifetime)
        );
        request.expires_at = 1_050;
        request.version += 1;
        assert_eq!(
            request.validate_syntax(1_000),
            Err(EngineBridgeError::Version)
        );
    }

    #[test]
    fn origin_credentials_and_noncanonical_pubkeys_are_rejected() {
        for origin in [
            "http://plane.example.test",
            "https://user@plane.example.test",
            "https://plane.example.test?ticket=secret",
            "https://plane.example.test/#secret",
        ] {
            let mut request = binding();
            request.origin = origin.into();
            assert_eq!(
                request.validate_syntax(1_000),
                Err(EngineBridgeError::Origin)
            );
        }
        let mut request = binding();
        request.pubkey = request.pubkey.to_uppercase();
        assert_eq!(
            request.validate_syntax(1_000),
            Err(EngineBridgeError::Pubkey)
        );
    }

    #[test]
    fn mutation_binds_product_and_exact_payload_digest() {
        assert_eq!(mutation().validate_syntax(1_000), Ok(()));

        let mut wrong_product = mutation();
        wrong_product.entity.class = EngineEntityClass::AffineDocument;
        assert_eq!(
            wrong_product.validate_syntax(1_000),
            Err(EngineBridgeError::Product)
        );

        let mut wrong_digest = mutation();
        wrong_digest.payload_sha256 = "0".repeat(64);
        assert_eq!(
            wrong_digest.validate_syntax(1_000),
            Err(EngineBridgeError::Payload)
        );
    }
}
