//! Agent mention claim handler (kind:24250).
//!
//! Several agent runtimes may share one agent key. When the agent is
//! mentioned, all of them see the mention and all of them would answer it.
//! A claim asks the relay for the exclusive right to handle one mention:
//! the `e` tag names the mention event, and the relay answers with OK only.
//!
//! A claim is never stored, never published to pub/sub, and never fanned out
//! to subscribers — it does not go through `ingest_event` at all. The decision
//! itself is one atomic Redis `SET NX EX` (see
//! [`buzz_pubsub::mention_claim`]), so the winner is picked by Redis and not
//! by a read-then-write race in the relay.
//!
//! [`decide_mention_claim`] is the one seam every transport uses — the
//! WebSocket `EVENT` branch and the HTTP `POST /events` bridge — and it owns
//! *all* of the checks (pubkey binding, scope, tags, signature), so the two
//! transports cannot drift apart.
//!
//! # The `nonce` tag
//!
//! A claim may carry `["nonce", <opaque string, ≤64 chars>]`. It is stored as
//! the claim's token so the same runtime can re-claim a mention it already
//! took after a reconnect (and refresh the lease while it works).
//!
//! ⚠ The nonce MUST be unique per runtime process — a random value of at least
//! 16 bytes picked at startup, never a hostname, agent name, or any other
//! constant. Two runtimes that share an agent key *and* a nonce are
//! indistinguishable to the relay, so both are told the claim is theirs and
//! both answer. See the contract and its pinned test in
//! [`buzz_pubsub::mention_claim`].

use std::sync::Arc;

use buzz_core::tenant::TenantContext;
use buzz_core::verification::verify_event;
use buzz_pubsub::mention_claim::ClaimAttempt;
use nostr::{Event, PublicKey};
use tracing::warn;

use crate::connection::ConnectionState;
use crate::protocol::RelayMessage;
use crate::state::AppState;

/// Longest accepted `nonce` tag value, in characters.
const MAX_NONCE_CHARS: usize = 64;

/// The relay's answer to one claim, in transport-neutral form.
///
/// `message` is the OK message on WebSocket and the `message` field of the
/// HTTP bridge's `{event_id, accepted, message}` body — the same string on
/// both, by construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaimDecision {
    /// Whether this runtime may answer the mention.
    pub accepted: bool,
    /// Human-readable outcome; empty on a plain win.
    pub message: &'static str,
    /// Bounded label for `buzz_events_rejected_total`, or `None` when the
    /// outcome is a normal protocol result rather than a rejection. A lost
    /// claim is an expected answer, not a rejected event.
    pub reject_reason: Option<&'static str>,
    /// Bounded `outcome` label for `buzz_mention_claims_total`. One of
    /// `won`, `already_yours`, `lost`, `unavailable`, `invalid` — a refused
    /// scope counts as `invalid` (the submission is not allowed) so the label
    /// set stays the five documented values.
    pub outcome: &'static str,
}

impl ClaimDecision {
    const WON: Self = Self {
        accepted: true,
        message: "",
        reject_reason: None,
        outcome: "won",
    };
    const ALREADY_YOURS: Self = Self {
        accepted: true,
        message: "already yours",
        reject_reason: None,
        outcome: "already_yours",
    };
    const LOST: Self = Self {
        accepted: false,
        message: "duplicate: already claimed",
        reject_reason: None,
        outcome: "lost",
    };
    const UNAVAILABLE: Self = Self {
        accepted: false,
        message: "error: claim unavailable",
        reject_reason: Some("error"),
        outcome: "unavailable",
    };
    const INSUFFICIENT_SCOPE: Self = Self {
        accepted: false,
        message: "restricted: insufficient scope for agent mention claims",
        reject_reason: Some("scope"),
        outcome: "invalid",
    };

    const fn invalid(message: &'static str) -> Self {
        Self {
            accepted: false,
            message,
            reject_reason: Some("invalid"),
            outcome: "invalid",
        }
    }
}

/// Whether `scopes` may submit a mention claim.
///
/// A claim reserves the right to *answer* a mention, so it sits on the same
/// axis as sending a message: it needs `MessagesWrite`, exactly like the
/// agent observer frame and the generic ephemeral branch next to it. An empty
/// scope list is an unscoped NIP-42 session (no token scope list at all) and
/// is allowed, matching every other kind's gate.
fn scopes_allow_claim(scopes: &[buzz_auth::Scope]) -> bool {
    scopes.is_empty() || scopes.contains(&buzz_auth::Scope::MessagesWrite)
}

/// A validated claim request: which mention, and under whose token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClaimRequest {
    /// Target mention event id (64-char lowercase hex).
    pub(crate) target_id: String,
    /// Value stored in Redis — the `nonce` tag when present, else the claim
    /// event id. Lets the same runtime re-claim a mention it already took.
    pub(crate) token: String,
}

/// Every check that runs before Redis is touched, as one pure function.
///
/// 1. **Pubkey binding** — the claim must be signed by the identity the
///    transport authenticated. The Redis key is scoped by pubkey, so a claim
///    accepted under somebody else's key would let one identity park another
///    identity's mentions. On the HTTP bridge this is the *only* place that
///    check happens (the WebSocket door checks it again for every kind).
/// 2. **Scope** — see [`scopes_allow_claim`].
/// 3. **Tags** — exactly one `e` tag holding a 64-char lowercase hex event id,
///    and at most one `nonce` tag of 1..=[`MAX_NONCE_CHARS`] characters.
///
/// Signature verification is deliberately *not* here: it is the expensive
/// check and belongs after the cheap ones, in [`decide_mention_claim`].
pub(crate) fn precheck_claim(
    event: &Event,
    auth_pubkey: &PublicKey,
    scopes: &[buzz_auth::Scope],
) -> Result<ClaimRequest, ClaimDecision> {
    if &event.pubkey != auth_pubkey {
        return Err(ClaimDecision::invalid(
            "invalid: event pubkey does not match authenticated identity",
        ));
    }

    if !scopes_allow_claim(scopes) {
        return Err(ClaimDecision::INSUFFICIENT_SCOPE);
    }

    let mut e_values = event
        .tags
        .iter()
        .filter(|tag| tag.kind().to_string() == "e")
        .map(|tag| tag.content().unwrap_or_default());

    let target = match (e_values.next(), e_values.next()) {
        (Some(value), None) if is_event_id_hex(value) => value.to_owned(),
        _ => return Err(ClaimDecision::invalid("invalid: claim needs one e tag")),
    };

    let mut nonces = event
        .tags
        .iter()
        .filter(|tag| tag.kind().to_string() == "nonce")
        .map(|tag| tag.content().unwrap_or_default());

    let token = match (nonces.next(), nonces.next()) {
        (None, _) => event.id.to_hex(),
        (Some(value), None) if !value.is_empty() && value.chars().count() <= MAX_NONCE_CHARS => {
            value.to_owned()
        }
        _ => return Err(ClaimDecision::invalid("invalid: bad nonce tag")),
    };

    Ok(ClaimRequest {
        target_id: target,
        token,
    })
}

/// True for a 64-character lowercase-hex event id.
fn is_event_id_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Maps one Redis claim outcome onto the relay's answer.
fn decision_for_attempt(attempt: ClaimAttempt) -> ClaimDecision {
    match attempt {
        ClaimAttempt::Won => ClaimDecision::WON,
        ClaimAttempt::AlreadyOwned => ClaimDecision::ALREADY_YOURS,
        ClaimAttempt::Lost => ClaimDecision::LOST,
    }
}

/// Decides one mention claim — the shared seam for every transport.
///
/// `auth_pubkey` and `scopes` are what the transport authenticated (NIP-42 on
/// the WebSocket, NIP-98 on the HTTP bridge); both are enforced here rather
/// than at the call sites so no transport can skip a check.
///
/// Never stores, never publishes, never fans out.
pub async fn decide_mention_claim(
    state: &AppState,
    tenant: &TenantContext,
    event: &Event,
    auth_pubkey: &PublicKey,
    scopes: &[buzz_auth::Scope],
) -> ClaimDecision {
    let decision = decide(state, tenant, event, auth_pubkey, scopes).await;
    metrics::counter!("buzz_mention_claims_total", "outcome" => decision.outcome).increment(1);
    decision
}

/// Body of [`decide_mention_claim`]; split out so the metric is counted on
/// exactly one path, whatever the outcome.
async fn decide(
    state: &AppState,
    tenant: &TenantContext,
    event: &Event,
    auth_pubkey: &PublicKey,
    scopes: &[buzz_auth::Scope],
) -> ClaimDecision {
    let request = match precheck_claim(event, auth_pubkey, scopes) {
        Ok(request) => request,
        Err(decision) => return decision,
    };

    let to_verify = event.clone();
    match tokio::task::spawn_blocking(move || verify_event(&to_verify)).await {
        Ok(Ok(())) => {}
        Ok(Err(_)) => return ClaimDecision::invalid("invalid: signature verification failed"),
        Err(error) => {
            warn!(%error, "mention claim: signature verification task failed");
            return ClaimDecision::UNAVAILABLE;
        }
    }

    match state
        .pubsub
        .try_mention_claim(
            tenant,
            &event.pubkey,
            &request.target_id,
            &request.token,
            state.config.claim_ttl_secs,
        )
        .await
    {
        Ok(attempt) => decision_for_attempt(attempt),
        Err(error) => {
            // Fail closed: a Redis outage must never hand two runtimes the
            // same mention.
            warn!(
                %error,
                target_id = %request.target_id,
                "mention claim: redis unavailable — failing closed"
            );
            ClaimDecision::UNAVAILABLE
        }
    }
}

/// WebSocket `EVENT` branch for kind:24250.
///
/// Answers with OK and returns — the event is never ingested, stored, or
/// fanned out.
pub async fn handle_mention_claim_event(
    event: Event,
    event_id_hex: &str,
    auth_pubkey: PublicKey,
    scopes: &[buzz_auth::Scope],
    conn: Arc<ConnectionState>,
    state: Arc<AppState>,
) {
    let decision = decide_mention_claim(&state, &conn.tenant, &event, &auth_pubkey, scopes).await;
    if let Some(reason) = decision.reject_reason {
        super::ingest::reject_with_transport("ws", reason);
    }
    conn.send(RelayMessage::ok(
        event_id_hex,
        decision.accepted,
        decision.message,
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_auth::Scope;
    use buzz_core::kind::KIND_AGENT_MENTION_CLAIM;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    fn event_id_hex() -> String {
        Keys::generate().public_key().to_hex()
    }

    fn claim_event_signed_by(keys: &Keys, tags: Vec<Vec<String>>) -> Event {
        let tags: Vec<Tag> = tags
            .into_iter()
            .map(|parts| Tag::parse(parts).expect("tag parses"))
            .collect();
        EventBuilder::new(Kind::Custom(KIND_AGENT_MENTION_CLAIM as u16), "")
            .tags(tags)
            .sign_with_keys(keys)
            .expect("sign claim")
    }

    fn e_tag(value: &str) -> Vec<String> {
        vec!["e".to_owned(), value.to_owned()]
    }

    fn nonce_tag(value: &str) -> Vec<String> {
        vec!["nonce".to_owned(), value.to_owned()]
    }

    /// Who the transport says is calling, relative to the event's signer.
    #[derive(Clone, Copy)]
    enum Caller {
        /// The authenticated identity signed this claim.
        Signer,
        /// Some other identity is presenting the claim.
        Other,
    }

    /// One row: name, tags, caller, scopes, expected answer
    /// (`Ok` = passes the pre-check, `Err(message)` = refused with that text).
    type PrecheckCase = (
        &'static str,
        Vec<Vec<String>>,
        Caller,
        Vec<Scope>,
        Result<(), &'static str>,
    );

    /// Everything that must be refused before Redis is touched, in one table.
    /// Each row is a bite: delete the matching guard in `precheck_claim` and
    /// that row goes red.
    #[test]
    fn claim_precheck_table() {
        let target = event_id_hex();
        let write = vec![Scope::MessagesWrite];
        let cases: Vec<PrecheckCase> = vec![
            (
                "valid",
                vec![e_tag(&target)],
                Caller::Signer,
                write.clone(),
                Ok(()),
            ),
            (
                "valid with nonce",
                vec![e_tag(&target), nonce_tag("runtime-a")],
                Caller::Signer,
                write.clone(),
                Ok(()),
            ),
            (
                "unscoped NIP-42 session",
                vec![e_tag(&target)],
                Caller::Signer,
                vec![],
                Ok(()),
            ),
            (
                // The pubkey binding: on the HTTP bridge nothing else checks it.
                "claim signed by somebody other than the authenticated identity",
                vec![e_tag(&target)],
                Caller::Other,
                write.clone(),
                Err("invalid: event pubkey does not match authenticated identity"),
            ),
            (
                "token cannot write messages",
                vec![e_tag(&target)],
                Caller::Signer,
                vec![Scope::MessagesRead, Scope::ChannelsWrite],
                Err("restricted: insufficient scope for agent mention claims"),
            ),
            (
                "no e tag",
                vec![],
                Caller::Signer,
                write.clone(),
                Err("invalid: claim needs one e tag"),
            ),
            (
                "two e tags",
                vec![e_tag(&target), e_tag(&event_id_hex())],
                Caller::Signer,
                write.clone(),
                Err("invalid: claim needs one e tag"),
            ),
            (
                "non-hex e tag",
                vec![e_tag(&"z".repeat(64))],
                Caller::Signer,
                write.clone(),
                Err("invalid: claim needs one e tag"),
            ),
            (
                "uppercase hex e tag",
                vec![e_tag(&target.to_uppercase())],
                Caller::Signer,
                write.clone(),
                Err("invalid: claim needs one e tag"),
            ),
            (
                "short e tag",
                vec![e_tag(&target[..63])],
                Caller::Signer,
                write.clone(),
                Err("invalid: claim needs one e tag"),
            ),
            (
                "nonce too long",
                vec![e_tag(&target), nonce_tag(&"n".repeat(65))],
                Caller::Signer,
                write.clone(),
                Err("invalid: bad nonce tag"),
            ),
            (
                "two nonce tags",
                vec![e_tag(&target), nonce_tag("a"), nonce_tag("b")],
                Caller::Signer,
                write.clone(),
                Err("invalid: bad nonce tag"),
            ),
        ];

        for (name, tags, caller, scopes, expected) in cases {
            let signer = Keys::generate();
            let event = claim_event_signed_by(&signer, tags);
            let auth_pubkey = match caller {
                Caller::Signer => signer.public_key(),
                Caller::Other => Keys::generate().public_key(),
            };

            match (precheck_claim(&event, &auth_pubkey, &scopes), expected) {
                (Ok(request), Ok(())) => {
                    assert_eq!(request.target_id, target, "{name}: wrong target");
                }
                (Err(decision), Err(message)) => {
                    assert!(!decision.accepted, "{name}: must not accept");
                    assert_eq!(decision.message, message, "{name}: wrong message");
                }
                (actual, expected) => {
                    panic!("{name}: expected {expected:?}, got {actual:?}");
                }
            }
        }
    }

    #[test]
    fn nonce_of_exactly_sixty_four_chars_is_accepted() {
        let signer = Keys::generate();
        let target = event_id_hex();
        let nonce = "n".repeat(MAX_NONCE_CHARS);
        let event = claim_event_signed_by(&signer, vec![e_tag(&target), nonce_tag(&nonce)]);
        let request = precheck_claim(&event, &signer.public_key(), &[]).expect("64-char nonce");
        assert_eq!(request.token, nonce);
    }

    #[test]
    fn token_defaults_to_the_claim_event_id_without_a_nonce() {
        let signer = Keys::generate();
        let target = event_id_hex();
        let event = claim_event_signed_by(&signer, vec![e_tag(&target)]);
        let request = precheck_claim(&event, &signer.public_key(), &[]).expect("valid claim");
        assert_eq!(request.token, event.id.to_hex());
    }

    #[test]
    fn redis_outcomes_map_to_the_documented_answers() {
        assert_eq!(
            decision_for_attempt(ClaimAttempt::Won),
            ClaimDecision {
                accepted: true,
                message: "",
                reject_reason: None,
                outcome: "won",
            }
        );
        assert_eq!(
            decision_for_attempt(ClaimAttempt::AlreadyOwned),
            ClaimDecision {
                accepted: true,
                message: "already yours",
                reject_reason: None,
                outcome: "already_yours",
            }
        );
        assert_eq!(
            decision_for_attempt(ClaimAttempt::Lost),
            ClaimDecision {
                accepted: false,
                message: "duplicate: already claimed",
                reject_reason: None,
                outcome: "lost",
            }
        );
        assert_eq!(
            ClaimDecision::UNAVAILABLE,
            ClaimDecision {
                accepted: false,
                message: "error: claim unavailable",
                reject_reason: Some("error"),
                outcome: "unavailable",
            },
            "a Redis outage must fail closed, never hand out the mention"
        );
    }

    /// `buzz_mention_claims_total` must stay a five-value label set; anything
    /// unbounded here multiplies series per claim.
    #[test]
    fn claim_outcome_labels_are_bounded() {
        let outcomes = [
            ClaimDecision::WON.outcome,
            ClaimDecision::ALREADY_YOURS.outcome,
            ClaimDecision::LOST.outcome,
            ClaimDecision::UNAVAILABLE.outcome,
            ClaimDecision::INSUFFICIENT_SCOPE.outcome,
            ClaimDecision::invalid("invalid: whatever").outcome,
        ];
        for outcome in outcomes {
            assert!(
                ["won", "already_yours", "lost", "unavailable", "invalid"].contains(&outcome),
                "unexpected metric label {outcome}"
            );
        }
    }

    /// The claim kind must keep its own metrics bucket instead of falling into
    /// the `"other"` catch-all.
    #[test]
    fn claim_kind_has_its_own_metrics_label() {
        assert_eq!(
            super::super::event::bounded_kind_label(KIND_AGENT_MENTION_CLAIM),
            "24250"
        );
    }
}
