//! Agent mention claims — at most one runtime answers a given mention.
//!
//! Several runtimes may share one agent key (a laptop, a server, a phone).
//! When the agent is mentioned, every one of them sees the same mention event
//! and would otherwise answer it. The relay is the referee: each runtime sends
//! a kind:24250 claim for the mention's event id, and exactly one of them is
//! told it won.
//!
//! Stored as `SET buzz:{community}:claim:{pubkey_hex}:{target_id} <token> NX EX <ttl>`.
//! `NX` makes the decision atomic — Redis returns `OK` only to the first
//! caller, so the win is decided by Redis, never by a read-then-write race in
//! the relay.
//!
//! # The token, and why the nonce must be unique per runtime
//!
//! The stored `<token>` is the caller's `nonce` tag when it sent one, else the
//! claim event id. It exists so a runtime that reconnects and replays a mention
//! it already handled can re-claim it: when `SET NX` loses, the holder is
//! compared against this caller's token and, on a match, the lease is extended.
//!
//! ⚠ **The nonce MUST be unique per runtime process** — a random value of at
//! least 16 bytes, generated at startup. It must never be a hostname, an agent
//! name, a deployment id, or any other constant two processes could both
//! produce. The token *is* the identity check here: if two runtimes sharing an
//! agent key send the same nonce, the second one is indistinguishable from the
//! first re-claiming, so **both win and both answer the mention** — exactly the
//! duplicate this kind exists to prevent. `two_runtimes_sharing_a_nonce_both_win`
//! in this module's tests pins that behaviour so a future change to it is a
//! deliberate one.

use buzz_core::TenantContext;
use deadpool_redis::Pool;
use nostr::PublicKey;
use redis::Script;

use crate::error::PubSubError;
use crate::topic::BUZZ_PREFIX;

/// Default lifetime of one claim, in seconds.
///
/// Long enough for a slow agent turn to finish before another runtime may take
/// the mention over, short enough that a runtime which dies mid-turn does not
/// park the mention forever.
pub const DEFAULT_CLAIM_TTL_SECS: u64 = 600;

/// Upper bound on a configured claim TTL, in seconds (1 hour).
///
/// A claim is a lease on somebody else's work, so a misconfigured deployment
/// must not be able to pin a mention for an implausibly long time.
pub const MAX_CLAIM_TTL_SECS: u64 = 3600;

/// Compare-and-refresh for a claim this caller may already hold.
///
/// Runs after a lost `SET NX`. Returns 1 only when the stored token is this
/// caller's, and extends the lease in the same script so no other runtime can
/// win between the comparison and the refresh.
///
/// `SET ... XX` would be wrong here: it overwrites whatever is stored, so a
/// runtime whose claim had expired and been won by somebody else would silently
/// steal the new holder's lease.
const RECLAIM_SCRIPT: &str = r#"
if redis.call('GET', KEYS[1]) == ARGV[1] then
    redis.call('EXPIRE', KEYS[1], ARGV[2])
    return 1
else
    return 0
end
"#;

/// Outcome of one atomic claim attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimAttempt {
    /// This caller now holds the claim — it should answer the mention.
    Won,
    /// The claim is already held by this same caller's token (a replay of a
    /// mention this runtime already took) and its lease has been refreshed.
    /// Treated as a win.
    AlreadyOwned,
    /// Another runtime holds the claim — this caller must stay quiet.
    Lost,
}

/// Returns the Redis key for the claim on `target_event_id` by `pubkey` under `ctx`.
///
/// The community id is part of the key, so the same agent key working in two
/// communities claims independently.
pub fn mention_claim_key(ctx: &TenantContext, pubkey: &PublicKey, target_event_id: &str) -> String {
    format!(
        "{BUZZ_PREFIX}:{}:claim:{}:{}",
        ctx.community(),
        pubkey.to_hex(),
        target_event_id
    )
}

/// Attempts to claim `target_event_id` for `pubkey` under `ctx`.
///
/// `token` is the value stored under the claim key — the caller's `nonce` tag
/// when it sent one, else the claim event id. See the module docs: a nonce
/// shared by two runtimes makes both of them win. `ttl_secs` is clamped to
/// `1..=`[`MAX_CLAIM_TTL_SECS`].
///
/// Returns [`ClaimAttempt::Won`] only when Redis itself set the key, and
/// [`ClaimAttempt::AlreadyOwned`] only when the stored token is this caller's —
/// in which case the lease is extended to a full `ttl_secs` again, so a runtime
/// that re-claims near expiry keeps the mention instead of losing it mid-turn.
/// A Redis failure surfaces as `Err` so the caller can fail closed — never as a
/// silent win.
pub async fn try_claim(
    pool: &Pool,
    ctx: &TenantContext,
    pubkey: &PublicKey,
    target_event_id: &str,
    token: &str,
    ttl_secs: u64,
) -> Result<ClaimAttempt, PubSubError> {
    let ttl = ttl_secs.clamp(1, MAX_CLAIM_TTL_SECS);
    let mut conn = pool.get().await?;
    let key = mention_claim_key(ctx, pubkey, target_event_id);

    // SET key <token> NX EX <ttl>. redis-rs typed return: Some("OK") on the
    // first claim, None when the key already exists.
    let set: Option<String> = redis::cmd("SET")
        .arg(&key)
        .arg(token)
        .arg("NX")
        .arg("EX")
        .arg(ttl)
        .query_async(&mut *conn)
        .await?;

    match set.as_deref() {
        Some("OK") => Ok(ClaimAttempt::Won),
        Some(other) => {
            tracing::error!(
                reply = %other,
                "mention claim: redis SET NX EX returned an unexpected reply — investigate"
            );
            Err(PubSubError::UnexpectedReply(other.to_owned()))
        }
        None => {
            // Lost the SET: somebody holds the key. One script decides whether
            // that somebody is this caller and, if so, refreshes the lease.
            let held_by_caller: i64 = Script::new(RECLAIM_SCRIPT)
                .key(&key)
                .arg(token)
                .arg(ttl)
                .invoke_async(&mut *conn)
                .await?;
            if held_by_caller == 1 {
                Ok(ClaimAttempt::AlreadyOwned)
            } else {
                // Includes the key expiring between the SET and the script:
                // fail closed, another runtime may already be answering.
                Ok(ClaimAttempt::Lost)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::CommunityId;
    use nostr::Keys;
    use uuid::Uuid;

    fn ctx(id: u128, host: &str) -> TenantContext {
        TenantContext::resolved(CommunityId::from_uuid(Uuid::from_u128(id)), host)
    }

    fn pubkey() -> PublicKey {
        Keys::generate().public_key()
    }

    /// A fresh 64-char lowercase-hex id, shaped like a real event id.
    fn target() -> String {
        format!(
            "{:032x}{:032x}",
            Uuid::new_v4().as_u128(),
            Uuid::new_v4().as_u128()
        )
    }

    /// Pool for the `#[ignore]`d Redis tests. Panics when no Redis answers:
    /// these tests are selected explicitly by the CI lane that provides one, so
    /// a missing Redis is a failed lane, never a silent skip.
    fn redis_pool() -> Pool {
        let url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".into());
        deadpool_redis::Config::from_url(url)
            .create_pool(Some(deadpool_redis::Runtime::Tokio1))
            .expect("create redis pool")
    }

    async fn ttl_of(pool: &Pool, key: &str) -> i64 {
        let mut conn = pool.get().await.expect("redis conn");
        redis::cmd("TTL")
            .arg(key)
            .query_async(&mut *conn)
            .await
            .expect("TTL")
    }

    async fn del(pool: &Pool, key: &str) {
        let mut conn = pool.get().await.expect("redis conn");
        let _: () = redis::cmd("DEL")
            .arg(key)
            .query_async(&mut *conn)
            .await
            .expect("DEL claim key");
    }

    #[test]
    fn claim_key_is_scoped_by_community_pubkey_and_target() {
        let pk = pubkey();
        let other_pk = pubkey();
        let target_a = target();
        let target_b = target();
        let community_a = ctx(0xaaaa, "a.example");
        let community_b = ctx(0xbbbb, "b.example");

        let key = mention_claim_key(&community_a, &pk, &target_a);
        assert_eq!(
            key,
            format!(
                "buzz:{}:claim:{}:{}",
                community_a.community(),
                pk.to_hex(),
                target_a
            )
        );
        // Each of the three scoping parts must actually move the key.
        assert_ne!(key, mention_claim_key(&community_b, &pk, &target_a));
        assert_ne!(key, mention_claim_key(&community_a, &other_pk, &target_a));
        assert_ne!(key, mention_claim_key(&community_a, &pk, &target_b));
    }

    #[tokio::test]
    #[ignore = "requires Redis"]
    async fn first_claim_wins_and_a_second_runtime_loses() {
        let pool = redis_pool();
        let ctx = ctx(0xc1a1, "claim.example");
        let pk = pubkey();
        let target_a = target();
        let target_b = target();

        let first = try_claim(&pool, &ctx, &pk, &target_a, "runtime-1", 60)
            .await
            .expect("first claim");
        assert_eq!(first, ClaimAttempt::Won);

        // Same community + key + target, different runtime token → loses.
        let second = try_claim(&pool, &ctx, &pk, &target_a, "runtime-2", 60)
            .await
            .expect("second claim");
        assert_eq!(second, ClaimAttempt::Lost);

        // A different mention is a different race — the loser wins that one.
        let other = try_claim(&pool, &ctx, &pk, &target_b, "runtime-2", 60)
            .await
            .expect("other target claim");
        assert_eq!(other, ClaimAttempt::Won);

        del(&pool, &mention_claim_key(&ctx, &pk, &target_a)).await;
        del(&pool, &mention_claim_key(&ctx, &pk, &target_b)).await;
    }

    #[tokio::test]
    #[ignore = "requires Redis"]
    async fn same_nonce_reclaims_and_a_different_nonce_loses() {
        let pool = redis_pool();
        let ctx = ctx(0xc1a2, "claim.example");
        let pk = pubkey();
        let target_id = target();

        assert_eq!(
            try_claim(&pool, &ctx, &pk, &target_id, "nonce-a", 60)
                .await
                .expect("first claim"),
            ClaimAttempt::Won
        );
        // Reconnect replay: the same runtime re-sends its own nonce.
        assert_eq!(
            try_claim(&pool, &ctx, &pk, &target_id, "nonce-a", 60)
                .await
                .expect("re-claim"),
            ClaimAttempt::AlreadyOwned
        );
        // A different runtime still loses.
        assert_eq!(
            try_claim(&pool, &ctx, &pk, &target_id, "nonce-b", 60)
                .await
                .expect("other nonce"),
            ClaimAttempt::Lost
        );

        del(&pool, &mention_claim_key(&ctx, &pk, &target_id)).await;
    }

    /// A re-claim must extend the lease, not ride out the original one. A
    /// runtime that re-claims near expiry would otherwise lose the mention
    /// mid-turn to whoever claimed next.
    #[tokio::test]
    #[ignore = "requires Redis"]
    async fn reclaiming_with_the_same_nonce_refreshes_the_lease() {
        let pool = redis_pool();
        let ctx = ctx(0xc1a4, "claim.example");
        let pk = pubkey();
        let target_id = target();
        let key = mention_claim_key(&ctx, &pk, &target_id);

        // Win with a lease about to run out.
        assert_eq!(
            try_claim(&pool, &ctx, &pk, &target_id, "nonce-a", 5)
                .await
                .expect("first claim"),
            ClaimAttempt::Won
        );
        let before = ttl_of(&pool, &key).await;
        assert!(
            before > 0 && before <= 5,
            "expected a 1-5s lease, got {before}"
        );

        // Re-claim near expiry: same holder, full lease again.
        assert_eq!(
            try_claim(&pool, &ctx, &pk, &target_id, "nonce-a", 120)
                .await
                .expect("re-claim"),
            ClaimAttempt::AlreadyOwned
        );
        let after = ttl_of(&pool, &key).await;
        assert!(
            after > 5 && after <= 120,
            "re-claim must refresh the lease to the full TTL, got {after} (was {before})"
        );

        // A loser must not refresh anything.
        assert_eq!(
            try_claim(&pool, &ctx, &pk, &target_id, "nonce-b", 3600)
                .await
                .expect("losing claim"),
            ClaimAttempt::Lost
        );
        let after_loss = ttl_of(&pool, &key).await;
        assert!(
            after_loss <= after,
            "a lost claim must not extend the holder's lease: {after_loss} > {after}"
        );

        del(&pool, &key).await;
    }

    /// Contract pin, not an endorsement: the token *is* the runtime identity
    /// here, so two runtimes that share an agent key **and** a nonce both get
    /// `AlreadyOwned` and both answer the mention. That is why the nonce must be
    /// unique per process (see the module docs). If this ever changes, it has to
    /// be a deliberate change — this test is the tripwire.
    #[tokio::test]
    #[ignore = "requires Redis"]
    async fn two_runtimes_sharing_a_nonce_both_win() {
        let pool = redis_pool();
        let ctx = ctx(0xc1a5, "claim.example");
        let pk = pubkey();
        let target_id = target();
        let shared = "agent-hostname"; // exactly what a nonce must NOT be

        assert_eq!(
            try_claim(&pool, &ctx, &pk, &target_id, shared, 60)
                .await
                .expect("runtime A"),
            ClaimAttempt::Won
        );
        assert_eq!(
            try_claim(&pool, &ctx, &pk, &target_id, shared, 60)
                .await
                .expect("runtime B"),
            ClaimAttempt::AlreadyOwned,
            "a shared nonce is indistinguishable from a re-claim — both runtimes answer"
        );

        del(&pool, &mention_claim_key(&ctx, &pk, &target_id)).await;
    }

    #[tokio::test]
    #[ignore = "requires Redis"]
    async fn claim_key_expires_and_the_ttl_is_clamped() {
        let pool = redis_pool();
        let ctx = ctx(0xc1a3, "claim.example");
        let pk = pubkey();
        let target_id = target();

        // Way above the ceiling — try_claim must clamp it.
        try_claim(&pool, &ctx, &pk, &target_id, "runtime-1", 86_400)
            .await
            .expect("claim");

        let key = mention_claim_key(&ctx, &pk, &target_id);
        let ttl = ttl_of(&pool, &key).await;

        assert!(
            ttl > 0 && ttl <= MAX_CLAIM_TTL_SECS as i64,
            "claim must carry a TTL of 1-{MAX_CLAIM_TTL_SECS}s, got {ttl}"
        );

        del(&pool, &key).await;
    }
}
