//! Atomic compatibility and authorization checks for community task snapshots.
use crate::{DbError, Result};
use serde_json::Value;

fn reject(message: &str) -> DbError {
    DbError::CommunityTaskRejected(message.to_owned())
}

fn valid_extension(field: &str, value: &Value) -> bool {
    let Some(values) = value.as_array().filter(|values| values.len() <= 20) else {
        return false;
    };
    let mut ids = std::collections::HashSet::new();
    values.iter().all(|value| {
        if field == "customFields" {
            let Some(id) = value["id"].as_str().filter(|id| {
                !id.is_empty()
                    && id.len() <= 128
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
            }) else {
                return false;
            };
            if !ids.insert(id.to_owned())
                || value["name"]
                    .as_str()
                    .is_none_or(|name| name.trim().is_empty() || name.encode_utf16().count() > 64)
            {
                return false;
            }
            if value.get("value").is_none() {
                return false;
            }
            let data = &value["value"];
            match value["type"].as_str() {
                Some("text") => {
                    data.is_null()
                        || data
                            .as_str()
                            .is_some_and(|text| text.encode_utf16().count() <= 1024)
                }
                Some("number") => data.is_null() || data.as_f64().is_some(),
                Some("checkbox") => data.is_null() || data.as_bool().is_some(),
                _ => false,
            }
        } else {
            let Some(id) = value["pageId"].as_str().filter(|id| {
                !id.is_empty()
                    && id.len() <= 128
                    && id.as_bytes()[0].is_ascii_alphanumeric()
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            }) else {
                return false;
            };
            let Some(url) = value["relayUrl"]
                .as_str()
                .and_then(|url| nostr::Url::parse(url).ok())
            else {
                return false;
            };
            matches!(url.scheme(), "ws" | "wss")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
                && value["title"].is_string()
                && ids.insert(format!("{url}:{id}"))
        }
    })
}

fn validate_snapshot(
    signer: &str,
    incoming: &Value,
    revisions: &[(String, Value)],
    event_created_at_seconds: i64,
) -> Result<()> {
    let author = incoming
        .get("author")
        .and_then(Value::as_str)
        .filter(|author| {
            author.len() == 64
                && author
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        })
        .ok_or_else(|| reject("invalid task author"))?;
    let own = revisions
        .iter()
        .find(|(key, value)| key == author && value["author"] == author)
        .map(|(_, value)| value);
    let deleted = incoming["deleted"] == true;
    if own.is_none() && signer != author {
        return Err(reject("task author revision is missing"));
    }
    if let Some(own) = own {
        if own["deleted"] == true && !deleted {
            return Err(reject("deleted task cannot be restored; create a new task"));
        }
        if incoming["createdAt"] != own["createdAt"] {
            return Err(reject("task creation identity cannot change"));
        }
        if signer != author {
            let assignees = own["assignees"]
                .as_array()
                .ok_or_else(|| reject("invalid task authority"))?;
            if !assignees.iter().any(|key| key.as_str() == Some(signer)) || deleted {
                return Err(reject(
                    "only the author and current assignees may edit this task",
                ));
            }
            if incoming["assignees"] != own["assignees"] {
                return Err(reject("only the author may change task assignees"));
            }
        }
    }
    if revisions
        .iter()
        .any(|(key, value)| key == signer && value["author"] != author)
    {
        return Err(reject("a task address cannot change its author"));
    }
    // Bind admission to the same typed snapshot the projection resolver uses.
    // Otherwise a signed head can replace the valid author revision yet be
    // dropped by the resolver forever (for example `body: 7` or a string due
    // date), leaving only an unrecoverable retry journal.
    if serde_json::from_value::<super::engine_projection::TaskContent>(incoming.clone()).is_err()
        || incoming["title"]
            .as_str()
            .is_none_or(|title| title.is_empty() || title.len() > 1024)
        || !matches!(incoming["status"].as_str(), Some("todo" | "doing" | "done"))
        || incoming["createdAt"].as_i64().is_none_or(|value| value < 0)
        || incoming["updatedAt"].as_i64().is_none_or(|value| {
            value < 0 || value > event_created_at_seconds.saturating_add(15 * 60)
        })
        || incoming["order"].as_f64().is_none()
        || incoming["assignees"].as_array().is_none_or(|keys| {
            keys.len() > 100
                || keys.iter().any(|key| {
                    key.as_str().is_none_or(|key| {
                        key.len() != 64
                            || !key
                                .bytes()
                                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                    })
                })
        })
    {
        return Err(reject("invalid task snapshot"));
    }
    if deleted {
        return Ok(());
    }
    for field in ["documents", "customFields"] {
        let protected = revisions.iter().any(|(key, value)| {
            let authorized = key == author
                || own
                    .and_then(|own| own["assignees"].as_array())
                    .is_some_and(|keys| keys.iter().any(|value| value.as_str() == Some(key)));
            authorized && value["author"] == author && value.get(field).is_some()
        });
        if protected && incoming.get(field).is_none() {
            return Err(reject(
                "upgrade required: this task contains protected documents or fields; omitted data cannot overwrite it",
            ));
        }
        if let Some(value) = incoming.get(field) {
            if !valid_extension(field, value) {
                return Err(reject("invalid task extension"));
            }
        }
    }
    Ok(())
}

/// Serialize all signers of one task address before checking authority and replacing any head.
/// The caller keeps this transaction open through the actual signed-event replacement.
pub(super) async fn lock_and_validate(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    community: buzz_core::CommunityId,
    event: &nostr::Event,
    d_tag: &str,
) -> Result<()> {
    if buzz_core::kind::event_kind_i32(event) != 30078 || !d_tag.starts_with("community-task:") {
        return Ok(());
    }
    super::engine_projection::lock_projection_binding_shared(tx, community).await?;
    let value: Value =
        serde_json::from_str(&event.content).map_err(|_| reject("invalid task JSON"))?;
    let lock = super::replaceable::event_replacement_lock_key(
        community,
        30078,
        b"community-task-lineage",
        Some(d_tag.as_bytes()),
    );
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(lock)
        .execute(&mut **tx)
        .await?;
    let rows: Vec<(Vec<u8>,String)> = sqlx::query_as("SELECT pubkey, content FROM events WHERE community_id=$1 AND kind=30078 AND d_tag=$2 AND deleted_at IS NULL ORDER BY created_at DESC, id ASC LIMIT 1001")
        .bind(community.as_uuid()).bind(d_tag).fetch_all(&mut **tx).await?;
    if rows.len() > 1000 {
        return Err(reject("too many task revisions to validate safely"));
    }
    let mut revisions = Vec::new();
    for (key, content) in rows {
        if let Ok(content) = serde_json::from_str::<Value>(&content) {
            revisions.push((hex::encode(key), content));
        }
    }
    let event_created_at_seconds = i64::try_from(event.created_at.as_secs())
        .ok()
        .ok_or_else(|| reject("invalid task event timestamp"))?;
    validate_snapshot(
        &event.pubkey.to_hex(),
        &value,
        &revisions,
        event_created_at_seconds,
    )
}

#[cfg(test)]
mod community_task_postgres_tests {
    use super::*;
    use serde_json::json;
    fn task() -> Value {
        json!({ "author": "a".repeat(64), "title":"Task", "body":"", "status":"todo", "assignees":["b".repeat(64)], "order":1, "createdAt":100, "updatedAt":100, "documents":[], "customFields":[{"id":"estimate","name":"Estimate","type":"number","value":2.5}] })
    }
    #[test]
    fn old_writer_cannot_drop_extensions_but_explicit_clear_is_allowed() {
        let old = task();
        let rows = vec![("a".repeat(64), old.clone())];
        let mut incoming = old.clone();
        incoming.as_object_mut().unwrap().remove("customFields");
        assert!(validate_snapshot(&"a".repeat(64), &incoming, &rows, 100).is_err());
        incoming = old;
        incoming["customFields"] = json!([]);
        assert!(validate_snapshot(&"a".repeat(64), &incoming, &rows, 100).is_ok());
    }
    #[test]
    fn stranger_revoked_assignee_and_assignee_grant_are_rejected() {
        let mut own = task();
        let mut incoming = own.clone();
        assert!(validate_snapshot(
            &"c".repeat(64),
            &incoming,
            &[("a".repeat(64), own.clone())],
            100
        )
        .is_err());
        assert!(validate_snapshot(
            &"b".repeat(64),
            &incoming,
            &[("a".repeat(64), own.clone())],
            100
        )
        .is_ok());
        incoming["assignees"] = json!(["b".repeat(64), "c".repeat(64)]);
        assert!(validate_snapshot(
            &"b".repeat(64),
            &incoming,
            &[("a".repeat(64), own.clone())],
            100
        )
        .is_err());
        own["assignees"] = json!([]);
        assert!(
            validate_snapshot(&"b".repeat(64), &incoming, &[("a".repeat(64), own)], 100).is_err()
        );
    }
    #[test]
    fn tombstone_and_generation_cannot_be_resurrected() {
        let incoming = task();
        let mut own = incoming.clone();
        own["deleted"] = json!(true);
        assert!(
            validate_snapshot(&"a".repeat(64), &incoming, &[("a".repeat(64), own)], 100).is_err()
        );
        let mut changed = incoming.clone();
        changed["createdAt"] = json!(101);
        assert!(validate_snapshot(
            &"a".repeat(64),
            &changed,
            &[("a".repeat(64), incoming)],
            101
        )
        .is_err());
    }
    #[test]
    fn malformed_extensions_cannot_be_accepted_as_a_clear() {
        let own = task();
        for invalid in [
            json!([null]),
            json!([{ "id":"x", "name":"N", "type":"number", "value":"wrong" }]),
        ] {
            let mut incoming = own.clone();
            incoming["customFields"] = invalid;
            assert!(validate_snapshot(
                &"a".repeat(64),
                &incoming,
                &[("a".repeat(64), own.clone())],
                100,
            )
            .is_err());
        }
        let mut incoming = own.clone();
        incoming["documents"] =
            json!([{ "pageId":"../bad", "relayUrl":"javascript:bad", "title":"Bad" }]);
        assert!(
            validate_snapshot(&"a".repeat(64), &incoming, &[("a".repeat(64), own)], 100).is_err()
        );
    }

    #[test]
    fn accepted_snapshots_match_projection_types_and_cannot_win_from_the_far_future() {
        let valid = task();
        for (field, value) in [
            ("body", json!(7)),
            ("due", json!("tomorrow")),
            ("deleted", json!("yes")),
            ("createdAt", json!(i64::MAX as u64 + 1)),
        ] {
            let mut incoming = valid.clone();
            incoming[field] = value;
            assert!(
                validate_snapshot(&"a".repeat(64), &incoming, &[], 100).is_err(),
                "{field} must be rejected before replacing the canonical head"
            );
        }
        let mut future = valid;
        future["updatedAt"] = json!(1_001);
        assert!(validate_snapshot(&"a".repeat(64), &future, &[], 100).is_err());
    }

    #[tokio::test]
    #[ignore = "requires isolated Postgres"]
    async fn actual_replacement_preserves_signed_head_and_serializes_revocation() {
        use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};
        let url = std::env::var("TEST_DATABASE_URL").expect("isolated test database URL");
        let pool = sqlx::PgPool::connect(&url)
            .await
            .expect("connect test database");
        crate::migration::run_migrations(&pool)
            .await
            .expect("migrate isolated database");
        let community_uuid = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO communities (id,host) VALUES ($1,$2)")
            .bind(community_uuid)
            .bind(format!("plane-{}.example", community_uuid))
            .execute(&pool)
            .await
            .expect("create test community");
        let community = buzz_core::CommunityId::from_uuid(community_uuid);
        let db = crate::Db::from_pool(pool.clone());
        let owner = Keys::generate();
        let assignee = Keys::generate();
        let stranger = Keys::generate();
        let d = format!("community-task:{}", uuid::Uuid::new_v4());
        let now = Timestamp::now().as_secs();
        let mut body = task();
        body["author"] = json!(owner.public_key().to_hex());
        body["assignees"] = json!([assignee.public_key().to_hex()]);
        body["createdAt"] = json!(now);
        body["updatedAt"] = json!(now);
        let sign = |keys: &Keys, body: &Value, stamp| {
            EventBuilder::new(Kind::Custom(30078), body.to_string())
                .tags([Tag::custom(nostr::TagKind::d(), [d.clone()])])
                .custom_created_at(Timestamp::from(stamp))
                .sign_with_keys(keys)
                .expect("sign test task")
        };
        let initial = sign(&owner, &body, now);
        assert!(
            db.replace_parameterized_event(community, &initial, &d, None)
                .await
                .expect("initial save")
                .1
        );
        let mut old = body.clone();
        old.as_object_mut().expect("object").remove("customFields");
        let incompatible = sign(&owner, &old, now + 1);
        assert!(matches!(
            db.replace_parameterized_event(community, &incompatible, &d, None)
                .await,
            Err(DbError::CommunityTaskRejected(_))
        ));
        let active: Vec<u8> = sqlx::query_scalar(
            "SELECT id FROM events WHERE community_id=$1 AND d_tag=$2 AND deleted_at IS NULL",
        )
        .bind(community_uuid)
        .bind(&d)
        .fetch_one(&pool)
        .await
        .expect("read head");
        assert_eq!(active, initial.id.as_bytes());
        let malicious = sign(&stranger, &body, now + 2);
        assert!(matches!(
            db.replace_parameterized_event(community, &malicious, &d, None)
                .await,
            Err(DbError::CommunityTaskRejected(_))
        ));
        let allowed = sign(&assignee, &body, now + 2);
        assert!(
            db.replace_parameterized_event(community, &allowed, &d, None)
                .await
                .expect("authorized positive control")
                .1
        );
        let mut revoke = body.clone();
        revoke["assignees"] = json!([]);
        revoke["updatedAt"] = json!(now + 3);
        let revoke_event = sign(&owner, &revoke, now + 3);
        let racing = sign(&assignee, &body, now + 4);
        let (revoked, raced) = tokio::join!(
            db.replace_parameterized_event(community, &revoke_event, &d, None),
            db.replace_parameterized_event(community, &racing, &d, None)
        );
        assert!(revoked.expect("author revocation").1);
        assert!(raced.is_ok() || matches!(raced, Err(DbError::CommunityTaskRejected(_))));
        let late = sign(&assignee, &body, now + 5);
        assert!(matches!(
            db.replace_parameterized_event(community, &late, &d, None)
                .await,
            Err(DbError::CommunityTaskRejected(_))
        ));
        let mut clear = revoke.clone();
        clear["customFields"] = json!([]);
        clear["documents"] = json!([]);
        let clear_event = sign(&owner, &clear, now + 6);
        assert!(
            db.replace_parameterized_event(community, &clear_event, &d, None)
                .await
                .expect("explicit clear")
                .1
        );
        let raw: String=sqlx::query_scalar("SELECT content FROM events WHERE community_id=$1 AND d_tag=$2 AND pubkey=$3 AND deleted_at IS NULL").bind(community_uuid).bind(&d).bind(owner.public_key().to_bytes().as_slice()).fetch_one(&pool).await.expect("fresh read");
        assert_eq!(
            raw, clear_event.content,
            "server never rewrites the signed payload"
        );
        pool.close().await;
    }
}
