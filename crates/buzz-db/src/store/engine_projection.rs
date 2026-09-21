//! Durable projection state for replaceable external engines.
//!
//! Buzz events and Buzz-hosted media remain authoritative. Rows here are a
//! retry journal and an opaque mapping to a derived engine entity; they never
//! grant membership or replace the signed event lineage.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use buzz_core::CommunityId;
use buzz_datastore_tracing::datastore_span;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Postgres, Row as _, Transaction};
use uuid::Uuid;

use crate::{Db, DbError, Result};

const COMMUNITY_TASK_KIND: i32 = 30_078;
const COMMUNITY_TASK_PREFIX: &str = "community-task:";
const PROJECTION_BINDING_LOCK_SCOPE: &[u8] = b"engine-projection-binding";

fn projection_binding_lock_key(community: CommunityId) -> i64 {
    super::replaceable::event_replacement_lock_key(
        community,
        COMMUNITY_TASK_KIND,
        PROJECTION_BINDING_LOCK_SCOPE,
        None,
    )
}

/// Keep one canonical task write from crossing a projection binding activation.
///
/// Task writes take the shared form before their lineage lock. Binding changes
/// take the exclusive form, so ordinary task writes remain concurrent while an
/// activation sees every write on exactly one side of its bounded backfill.
pub(super) async fn lock_projection_binding_shared(
    tx: &mut Transaction<'_, Postgres>,
    community: CommunityId,
) -> Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock_shared($1)")
        .bind(projection_binding_lock_key(community))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn lock_projection_binding_exclusive(
    tx: &mut Transaction<'_, Postgres>,
    community: CommunityId,
) -> Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(projection_binding_lock_key(community))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Plane state identifiers configured for the three canonical Buzz states.
#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PlaneStateMap {
    /// Plane state used for a canonical `todo` task.
    pub todo: Uuid,
    /// Plane state used for a canonical `doing` task.
    pub doing: Uuid,
    /// Plane state used for a canonical `done` task.
    pub done: Uuid,
}

impl PlaneStateMap {
    /// Resolve one canonical Buzz status to its configured Plane state.
    pub fn state_for(&self, status: CommunityTaskStatus) -> Uuid {
        match status {
            CommunityTaskStatus::Todo => self.todo,
            CommunityTaskStatus::Doing => self.doing,
            CommunityTaskStatus::Done => self.done,
        }
    }
}

/// One enabled, non-secret binding from an A2D2 community to Plane.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineProjectionBinding {
    /// Durable binding identifier.
    pub id: Uuid,
    /// Server-resolved A2D2 community.
    pub community: CommunityId,
    /// HTTPS Plane origin. Runtime code validates it before use.
    pub origin: String,
    /// Plane workspace slug.
    pub workspace_slug: String,
    /// Plane project UUID.
    pub project_id: Uuid,
    /// Environment variable name containing the server-only Plane API key.
    pub api_key_env: String,
    /// Explicit mapping from A2D2 task status to Plane state UUID.
    pub state_map: PlaneStateMap,
}

/// Non-secret operator configuration for one community's Plane projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlaneProjectionBindingConfig {
    /// Root URL of the private Plane API.
    pub origin: String,
    /// Provider workspace slug.
    pub workspace_slug: String,
    /// Provider project receiving derived work items.
    pub project_id: Uuid,
    /// Server environment variable containing the API credential.
    pub api_key_env: String,
    /// Explicit A2D2 status mapping.
    pub state_map: PlaneStateMap,
    /// Disabled bindings retain desired changes but workers do not claim them.
    pub enabled: bool,
}

/// A fenced unit of projection work claimed by one worker.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimedEngineProjection {
    /// Binding and non-secret provider configuration.
    pub binding: EngineProjectionBinding,
    /// Stable canonical key (`community:author:task-id`).
    pub entity_key: String,
    /// Canonical task d-tag.
    pub task_d_tag: String,
    /// Canonical task author pubkey bytes.
    pub author_pubkey: Vec<u8>,
    /// Event that caused this desired generation to be enqueued.
    pub desired_event_id: Vec<u8>,
    /// Generation captured by this claim.
    pub generation: i64,
    /// Opaque lease token required by completion and retry updates.
    pub lease_token: Uuid,
    /// Existing Plane entity mapping, if a prior projection completed.
    pub engine_entity_id: Option<Uuid>,
    /// A create request may have reached Plane without a response. While true,
    /// the worker may only look up the stable external id; it must not POST.
    pub create_uncertain: bool,
    /// Number of claim attempts for this desired generation.
    pub attempt: i32,
}

/// Canonical task status values understood by A2D2.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CommunityTaskStatus {
    /// Not started.
    Todo,
    /// In progress.
    Doing,
    /// Completed.
    Done,
}

/// One typed custom field retained by the canonical task snapshot.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommunityTaskCustomField {
    /// Stable task-local field identifier.
    pub id: String,
    /// Display name preserved by A2D2.
    pub name: String,
    /// Field value type.
    #[serde(rename = "type")]
    pub field_type: String,
    /// Typed field value.
    pub value: Value,
}

/// Canonical A2D2 task state resolved from every authorized signer head.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedCommunityTask {
    /// Stable task id from the `community-task:` d-tag.
    pub id: String,
    /// Stable canonical key including community and author.
    pub key: String,
    /// Author pubkey as lowercase hex.
    pub author: String,
    /// Pubkey that signed the winning revision.
    pub signer: String,
    /// Winning canonical event id.
    pub event_id: Vec<u8>,
    /// Task title.
    pub title: String,
    /// Canonical Markdown body.
    pub body: String,
    /// Canonical task status.
    pub status: CommunityTaskStatus,
    /// Canonical assignee pubkeys.
    pub assignees: Vec<String>,
    /// Optional due date as Unix seconds.
    pub due: Option<i64>,
    /// Task-local custom fields.
    pub custom_fields: Vec<CommunityTaskCustomField>,
    /// True when the author's latest revision retired this task.
    pub deleted: bool,
}

impl ResolvedCommunityTask {
    /// Return the Plane priority encoded by a canonical `priority` text field.
    pub fn plane_priority(&self) -> &'static str {
        self.custom_fields
            .iter()
            .find(|field| field.id == "priority" && field.field_type == "text")
            .and_then(|field| field.value.as_str())
            .and_then(|value| match value {
                "urgent" => Some("urgent"),
                "high" => Some("high"),
                "medium" => Some("medium"),
                "low" => Some("low"),
                "none" => Some("none"),
                _ => None,
            })
            .unwrap_or("none")
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskContent {
    author: String,
    title: String,
    #[serde(default)]
    body: String,
    status: CommunityTaskStatus,
    #[serde(default)]
    assignees: Vec<String>,
    due: Option<i64>,
    #[serde(default)]
    custom_fields: Vec<CommunityTaskCustomField>,
    order: f64,
    created_at: i64,
    updated_at: i64,
    #[serde(default)]
    deleted: bool,
}

#[derive(Clone, Debug)]
struct TaskRevision {
    id: String,
    signer: String,
    event_id: Vec<u8>,
    event_created_at: i64,
    content: TaskContent,
}

fn task_id_from_d_tag(d_tag: &str) -> Option<&str> {
    let id = d_tag.strip_prefix(COMMUNITY_TASK_PREFIX)?;
    (!id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte)))
    .then_some(id)
}

fn valid_pubkey(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_plane_workspace_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 48
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn valid_plane_origin(value: &str) -> bool {
    let Ok(origin) = url::Url::parse(value) else {
        return false;
    };
    if origin.username() != ""
        || origin.password().is_some()
        || origin.query().is_some()
        || origin.fragment().is_some()
        || origin.path() != "/"
    {
        return false;
    }
    let loopback = origin.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    origin.scheme() == "https" || (origin.scheme() == "http" && loopback)
}

fn parse_revision(
    d_tag: &str,
    signer: Vec<u8>,
    event_id: Vec<u8>,
    event_created_at: DateTime<Utc>,
    content: &str,
) -> Option<TaskRevision> {
    let id = task_id_from_d_tag(d_tag)?.to_owned();
    let signer = hex::encode(signer);
    let mut content: TaskContent = serde_json::from_str(content).ok()?;
    if !valid_pubkey(&signer)
        || !valid_pubkey(&content.author)
        || !content.order.is_finite()
        || content.created_at < 0
        || content.updated_at < 0
        || content
            .assignees
            .iter()
            .any(|assignee| !valid_pubkey(assignee))
    {
        return None;
    }
    let mut seen = HashSet::new();
    content.assignees.retain(|key| seen.insert(key.clone()));
    Some(TaskRevision {
        id,
        signer,
        event_id,
        event_created_at: event_created_at.timestamp(),
        content,
    })
}

fn revision_order(a: &TaskRevision, b: &TaskRevision) -> Ordering {
    b.content
        .updated_at
        .cmp(&a.content.updated_at)
        .then_with(|| b.event_created_at.cmp(&a.event_created_at))
        .then_with(|| a.event_id.cmp(&b.event_id))
}

fn newest_signed_by<'a>(
    revisions: &'a [&TaskRevision],
    allowed: impl Fn(&str) -> bool,
) -> Option<&'a TaskRevision> {
    revisions
        .iter()
        .copied()
        .filter(|revision| allowed(&revision.signer))
        .min_by(|a, b| revision_order(a, b))
}

fn canonical_entity_key(community: CommunityId, author: &str, task_id: &str) -> String {
    format!("{}:{author}:{task_id}", community.as_uuid())
}

fn resolve_task(
    community: CommunityId,
    author: &str,
    task_id: &str,
    revisions: &[TaskRevision],
) -> Option<ResolvedCommunityTask> {
    let lineage: Vec<&TaskRevision> = revisions
        .iter()
        .filter(|revision| revision.id == task_id && revision.content.author == author)
        .collect();
    let own = newest_signed_by(&lineage, |signer| signer == author)?;
    if own.content.deleted {
        return Some(ResolvedCommunityTask {
            id: task_id.to_owned(),
            key: canonical_entity_key(community, author, task_id),
            author: author.to_owned(),
            signer: own.signer.clone(),
            event_id: own.event_id.clone(),
            title: String::new(),
            body: String::new(),
            status: own.content.status,
            assignees: Vec::new(),
            due: None,
            custom_fields: Vec::new(),
            deleted: true,
        });
    }

    let live: Vec<&TaskRevision> = lineage
        .iter()
        .copied()
        .filter(|revision| {
            !revision.content.deleted
                && revision.content.created_at == own.content.created_at
                && (revision.signer == author
                    || (revision.content.assignees.len() == own.content.assignees.len()
                        && revision
                            .content
                            .assignees
                            .iter()
                            .all(|key| own.content.assignees.contains(key))))
        })
        .collect();
    let winner = newest_signed_by(&live, |signer| {
        signer == author || own.content.assignees.iter().any(|key| key == signer)
    })?;
    Some(ResolvedCommunityTask {
        id: task_id.to_owned(),
        key: canonical_entity_key(community, author, task_id),
        author: author.to_owned(),
        signer: winner.signer.clone(),
        event_id: winner.event_id.clone(),
        title: winner.content.title.clone(),
        body: winner.content.body.clone(),
        status: winner.content.status,
        assignees: own.content.assignees.clone(),
        due: winner.content.due,
        custom_fields: winner.content.custom_fields.clone(),
        deleted: false,
    })
}

/// Enqueue a canonical community-task projection in the event's savepoint.
///
/// The event row and desired generation commit atomically. Disabled bindings
/// retain their latest desired head; workers gate claims on `enabled`.
pub(crate) async fn enqueue_community_task_projection_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    community: CommunityId,
    event: &nostr::Event,
    d_tag: &str,
) -> Result<()> {
    if buzz_core::kind::event_kind_i32(event) != COMMUNITY_TASK_KIND {
        return Ok(());
    }
    let Some(task_id) = task_id_from_d_tag(d_tag) else {
        return Ok(());
    };
    let content: Value = serde_json::from_str(&event.content)?;
    let author = content
        .get("author")
        .and_then(Value::as_str)
        .filter(|value| valid_pubkey(value))
        .ok_or_else(|| DbError::InvalidData("community task author is invalid".to_owned()))?;
    let entity_key = canonical_entity_key(community, author, task_id);
    let author_bytes = hex::decode(author)
        .map_err(|_| DbError::InvalidData("community task author is invalid".to_owned()))?;
    sqlx::query(
        r#"
        INSERT INTO engine_projection_heads (
            community_id, binding_id, entity_kind, entity_key, task_d_tag, author_pubkey,
            desired_event_id, desired_generation, next_attempt_at
        )
        SELECT community_id, id, 'community_task', $2, $3, $4, $5, 1, now()
        FROM engine_projection_bindings
        WHERE community_id = $1 AND provider = 'plane'
        ON CONFLICT (community_id, binding_id, entity_kind, entity_key) DO UPDATE SET
            task_d_tag = EXCLUDED.task_d_tag,
            author_pubkey = EXCLUDED.author_pubkey,
            desired_event_id = EXCLUDED.desired_event_id,
            desired_generation = engine_projection_heads.desired_generation + 1,
            attempt_count = 0,
            next_attempt_at = now(),
            last_error = NULL,
            updated_at = now()
        "#,
    )
    .bind(community.as_uuid())
    .bind(entity_key)
    .bind(d_tag)
    .bind(author_bytes)
    .bind(event.id.as_bytes().as_slice())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn binding_from_row(row: &sqlx::postgres::PgRow) -> Result<EngineProjectionBinding> {
    let state_map: Value = row.try_get("state_map")?;
    Ok(EngineProjectionBinding {
        id: row.try_get("binding_id")?,
        community: CommunityId::from_uuid(row.try_get("community_id")?),
        origin: row.try_get("origin")?,
        workspace_slug: row.try_get("workspace_slug")?,
        project_id: row.try_get("project_id")?,
        api_key_env: row.try_get("api_key_env")?,
        state_map: serde_json::from_value(state_map)?,
    })
}

impl Db {
    /// Configure a Plane binding and atomically enqueue every current task.
    ///
    /// The scan is bounded and rolls back in full on overflow. Re-running the
    /// explicit operator action advances each desired generation so endpoint,
    /// project, or status-map changes are reconciled even when task content did
    /// not change.
    #[datastore_span(name = "configure_plane_projection", system = "postgresql")]
    pub async fn configure_plane_projection(
        &self,
        community: CommunityId,
        config: &PlaneProjectionBindingConfig,
    ) -> Result<(Uuid, usize)> {
        const MAX_TASK_REVISIONS: usize = 10_000;
        if !valid_plane_workspace_slug(&config.workspace_slug) {
            return Err(DbError::InvalidData(
                "Plane workspace slug is invalid".to_owned(),
            ));
        }
        if !valid_plane_origin(&config.origin) {
            return Err(DbError::InvalidData(
                "Plane origin must be a credential-free HTTPS root or loopback HTTP root"
                    .to_owned(),
            ));
        }
        let mut tx = self.pool.begin().await?;
        lock_projection_binding_exclusive(&mut tx, community).await?;
        let binding_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO engine_projection_bindings (
                community_id, provider, origin, workspace_slug, project_id,
                api_key_env, state_map, enabled
            ) VALUES ($1, 'plane', $2, $3, $4, $5, $6, $7)
            ON CONFLICT (community_id, provider) DO UPDATE SET
                origin=EXCLUDED.origin, workspace_slug=EXCLUDED.workspace_slug,
                project_id=EXCLUDED.project_id, api_key_env=EXCLUDED.api_key_env,
                state_map=EXCLUDED.state_map, enabled=EXCLUDED.enabled,
                updated_at=now()
            RETURNING id
            "#,
        )
        .bind(community.as_uuid())
        .bind(&config.origin)
        .bind(&config.workspace_slug)
        .bind(config.project_id)
        .bind(&config.api_key_env)
        .bind(serde_json::to_value(&config.state_map)?)
        .bind(config.enabled)
        .fetch_one(&mut *tx)
        .await?;

        let rows = sqlx::query(
            "SELECT pubkey, id, created_at, d_tag, content FROM events \
             WHERE community_id=$1 AND kind=$2 AND d_tag LIKE 'community-task:%' \
               AND deleted_at IS NULL \
             ORDER BY d_tag, created_at DESC, id ASC LIMIT $3",
        )
        .bind(community.as_uuid())
        .bind(COMMUNITY_TASK_KIND)
        .bind((MAX_TASK_REVISIONS + 1) as i64)
        .fetch_all(&mut *tx)
        .await?;
        if rows.len() > MAX_TASK_REVISIONS {
            return Err(DbError::InvalidData(
                "too many task revisions to configure projection safely".to_owned(),
            ));
        }
        let mut by_tag: HashMap<String, (HashSet<String>, Vec<TaskRevision>)> = HashMap::new();
        for row in rows {
            let d_tag: String = row.try_get("d_tag")?;
            let Some(revision) = parse_revision(
                &d_tag,
                row.try_get("pubkey")?,
                row.try_get("id")?,
                row.try_get("created_at")?,
                row.try_get("content")?,
            ) else {
                continue;
            };
            let entry = by_tag.entry(d_tag).or_default();
            entry.0.insert(revision.content.author.clone());
            entry.1.push(revision);
        }
        let mut queued = 0;
        for (d_tag, (authors, revisions)) in by_tag {
            let Some(task_id) = task_id_from_d_tag(&d_tag) else {
                continue;
            };
            for author in authors {
                let Some(task) = resolve_task(community, &author, task_id, &revisions) else {
                    continue;
                };
                let author_pubkey = hex::decode(&author).map_err(|_| {
                    DbError::InvalidData("community task author is invalid".to_owned())
                })?;
                sqlx::query(
                    r#"
                    INSERT INTO engine_projection_heads (
                        community_id, binding_id, entity_kind, entity_key,
                        task_d_tag, author_pubkey, desired_event_id,
                        desired_generation, next_attempt_at
                    ) VALUES ($1, $2, 'community_task', $3, $4, $5, $6, 1, now())
                    ON CONFLICT (community_id, binding_id, entity_kind, entity_key)
                    DO UPDATE SET task_d_tag=EXCLUDED.task_d_tag,
                        author_pubkey=EXCLUDED.author_pubkey,
                        desired_event_id=EXCLUDED.desired_event_id,
                        desired_generation=engine_projection_heads.desired_generation + 1,
                        attempt_count=0, next_attempt_at=now(), last_error=NULL,
                        updated_at=now()
                    "#,
                )
                .bind(community.as_uuid())
                .bind(binding_id)
                .bind(&task.key)
                .bind(&d_tag)
                .bind(author_pubkey)
                .bind(&task.event_id)
                .execute(&mut *tx)
                .await?;
                queued += 1;
            }
        }
        tx.commit().await?;
        Ok((binding_id, queued))
    }

    /// Create or update one provider-internal principal mapping.
    #[datastore_span(name = "upsert_engine_principal", system = "postgresql")]
    pub async fn upsert_engine_principal(
        &self,
        community: CommunityId,
        binding_id: Uuid,
        a2d2_pubkey: &[u8],
        engine_user_id: Uuid,
        active: bool,
    ) -> Result<()> {
        if a2d2_pubkey.len() != 32 {
            return Err(DbError::InvalidData(
                "A2D2 principal pubkey is invalid".to_owned(),
            ));
        }
        sqlx::query(
            r#"
            INSERT INTO engine_principal_mappings (
                community_id, binding_id, a2d2_pubkey, engine_user_id, active
            ) VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (community_id, binding_id, a2d2_pubkey) DO UPDATE SET
                engine_user_id=EXCLUDED.engine_user_id,
                active=EXCLUDED.active, updated_at=now()
            "#,
        )
        .bind(community.as_uuid())
        .bind(binding_id)
        .bind(a2d2_pubkey)
        .bind(engine_user_id)
        .bind(active)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Adopt provider principal ids only while the matching relay memberships
    /// and roles are still authoritative.
    ///
    /// Existing mappings are never overwritten. The whole batch commits only
    /// when every provider id either inserts cleanly or exactly matches an
    /// already-active mapping, so a concurrent operator mapping cannot be
    /// silently replaced by a provider response.
    #[datastore_span(name = "adopt_engine_principals", system = "postgresql")]
    pub async fn adopt_engine_principals(
        &self,
        community: CommunityId,
        binding_id: Uuid,
        principals: &[(String, String, Uuid)],
    ) -> Result<()> {
        if principals.is_empty() {
            return Ok(());
        }
        if principals.len() > 100 {
            return Err(DbError::InvalidData(
                "too many engine principals in one batch".to_owned(),
            ));
        }

        let mut sorted = principals.to_vec();
        sorted.sort_by(|left, right| left.0.cmp(&right.0));
        let mut previous_pubkey: Option<&str> = None;
        let mut decoded = Vec::with_capacity(sorted.len());
        for (pubkey, role, engine_user_id) in &sorted {
            if previous_pubkey == Some(pubkey) {
                return Err(DbError::InvalidData(
                    "duplicate engine principal pubkey".to_owned(),
                ));
            }
            previous_pubkey = Some(pubkey);
            if !matches!(role.as_str(), "owner" | "admin" | "member") {
                return Err(DbError::InvalidData(
                    "engine principal relay role is invalid".to_owned(),
                ));
            }
            let bytes = hex::decode(pubkey)
                .map_err(|_| DbError::InvalidData("A2D2 principal pubkey is invalid".to_owned()))?;
            if bytes.len() != 32 || hex::encode(&bytes) != *pubkey {
                return Err(DbError::InvalidData(
                    "A2D2 principal pubkey is invalid".to_owned(),
                ));
            }
            decoded.push((pubkey.clone(), role.clone(), bytes, *engine_user_id));
        }

        let pubkeys: Vec<String> = decoded
            .iter()
            .map(|(pubkey, _, _, _)| pubkey.clone())
            .collect();
        let mut tx = self.pool.begin().await?;
        let membership_rows = sqlx::query(
            "SELECT pubkey,role FROM relay_members \
             WHERE community_id=$1 AND pubkey = ANY($2) ORDER BY pubkey FOR UPDATE",
        )
        .bind(community.as_uuid())
        .bind(&pubkeys)
        .fetch_all(&mut *tx)
        .await?;
        let memberships: HashMap<String, String> = membership_rows
            .into_iter()
            .map(|row| (row.get("pubkey"), row.get("role")))
            .collect();
        if decoded.iter().any(|(pubkey, role, _, _)| {
            memberships.get(pubkey).map(String::as_str) != Some(role.as_str())
        }) {
            return Err(DbError::InvalidData(
                "engine principal relay membership changed during provisioning".to_owned(),
            ));
        }

        for (_, _, pubkey, engine_user_id) in &decoded {
            sqlx::query(
                "INSERT INTO engine_principal_mappings (\
                     community_id,binding_id,a2d2_pubkey,engine_user_id,active\
                 ) VALUES ($1,$2,$3,$4,true) \
                 ON CONFLICT (community_id,binding_id,a2d2_pubkey) DO NOTHING",
            )
            .bind(community.as_uuid())
            .bind(binding_id)
            .bind(pubkey)
            .bind(engine_user_id)
            .execute(&mut *tx)
            .await?;
        }

        let pubkey_bytes: Vec<Vec<u8>> = decoded
            .iter()
            .map(|(_, _, pubkey, _)| pubkey.clone())
            .collect();
        let mapping_rows = sqlx::query(
            "SELECT a2d2_pubkey,engine_user_id,active FROM engine_principal_mappings \
             WHERE community_id=$1 AND binding_id=$2 AND a2d2_pubkey = ANY($3)",
        )
        .bind(community.as_uuid())
        .bind(binding_id)
        .bind(&pubkey_bytes)
        .fetch_all(&mut *tx)
        .await?;
        let mappings: HashMap<String, (Uuid, bool)> = mapping_rows
            .into_iter()
            .map(|row| {
                let pubkey: Vec<u8> = row.get("a2d2_pubkey");
                (
                    hex::encode(pubkey),
                    (row.get("engine_user_id"), row.get("active")),
                )
            })
            .collect();
        if decoded.iter().any(|(pubkey, _, _, engine_user_id)| {
            mappings.get(pubkey) != Some(&(*engine_user_id, true))
        }) {
            return Err(DbError::InvalidData(
                "engine principal mapping conflicts with provider response".to_owned(),
            ));
        }
        tx.commit().await?;
        Ok(())
    }

    /// Claim due projection heads with a generation and lease-token fence.
    #[datastore_span(name = "claim_engine_projections", system = "postgresql")]
    pub async fn claim_engine_projections(
        &self,
        limit: i64,
        lease_duration: Duration,
        prefer_reconciliation: bool,
    ) -> Result<Vec<ClaimedEngineProjection>> {
        let limit = limit.clamp(1, 100);
        let lease = chrono::Duration::from_std(lease_duration)
            .map_err(|_| DbError::InvalidData("projection lease is too large".to_owned()))?;
        let lease_until = Utc::now() + lease;
        let mut connection = crate::observability::acquire_writer(
            &self.pool,
            crate::observability::WriterOperation::Maintenance,
        )
        .await?;
        let rows = sqlx::query(
            r#"
            WITH candidates AS (
                SELECT h.community_id, h.binding_id, h.entity_kind, h.entity_key
                FROM engine_projection_heads h
                JOIN engine_projection_bindings b
                  ON b.community_id = h.community_id AND b.id = h.binding_id
                WHERE b.enabled
                  AND h.desired_generation > 0
                  AND h.next_attempt_at <= now()
                  AND (h.lease_token IS NULL OR h.lease_expires_at < now())
                ORDER BY CASE
                           WHEN $3 AND h.desired_generation = h.applied_generation THEN 0
                           WHEN h.desired_generation > h.applied_generation THEN 1
                           ELSE 2
                         END,
                         h.next_attempt_at, h.updated_at, h.binding_id, h.entity_key
                FOR UPDATE OF h SKIP LOCKED
                LIMIT $1
            )
            UPDATE engine_projection_heads h
            SET lease_token = gen_random_uuid(), lease_expires_at = $2,
                attempt_count = h.attempt_count + 1, updated_at = now()
            FROM candidates c, engine_projection_bindings b
            WHERE h.binding_id = c.binding_id
              AND h.community_id = c.community_id
              AND h.entity_kind = c.entity_kind
              AND h.entity_key = c.entity_key
              AND b.community_id = h.community_id
              AND b.id = h.binding_id
            RETURNING h.binding_id, b.community_id, b.origin, b.workspace_slug,
                      b.project_id, b.api_key_env, b.state_map,
                      h.entity_key, h.task_d_tag, h.author_pubkey,
                      h.desired_event_id, h.desired_generation, h.lease_token,
                      h.engine_entity_id, h.create_state, h.attempt_count
            "#,
        )
        .bind(limit)
        .bind(lease_until)
        .bind(prefer_reconciliation)
        .fetch_all(&mut *connection)
        .await?;

        rows.into_iter()
            .map(|row| {
                let binding = binding_from_row(&row)?;
                Ok(ClaimedEngineProjection {
                    binding,
                    entity_key: row.try_get("entity_key")?,
                    task_d_tag: row.try_get("task_d_tag")?,
                    author_pubkey: row.try_get("author_pubkey")?,
                    desired_event_id: row.try_get("desired_event_id")?,
                    generation: row.try_get("desired_generation")?,
                    lease_token: row.try_get("lease_token")?,
                    engine_entity_id: row.try_get("engine_entity_id")?,
                    create_uncertain: row.try_get::<String, _>("create_state")? == "uncertain",
                    attempt: row.try_get("attempt_count")?,
                })
            })
            .collect()
    }

    /// Recompute the canonical task from all current signer heads.
    #[datastore_span(name = "resolve_community_task_projection", system = "postgresql")]
    pub async fn resolve_community_task_projection(
        &self,
        community: CommunityId,
        d_tag: &str,
        author_pubkey: &[u8],
    ) -> Result<ResolvedCommunityTask> {
        let task_id = task_id_from_d_tag(d_tag)
            .ok_or_else(|| DbError::InvalidData("projection task d-tag is invalid".to_owned()))?;
        if author_pubkey.len() != 32 {
            return Err(DbError::InvalidData(
                "projection task author pubkey is invalid".to_owned(),
            ));
        }
        let author = hex::encode(author_pubkey);
        let mut connection = crate::observability::acquire_writer(
            &self.pool,
            crate::observability::WriterOperation::Maintenance,
        )
        .await?;
        let rows = sqlx::query(
            "SELECT pubkey, id, created_at, content FROM events \
             WHERE community_id=$1 AND kind=$2 AND d_tag=$3 AND deleted_at IS NULL \
             ORDER BY created_at DESC, id ASC LIMIT 1001",
        )
        .bind(community.as_uuid())
        .bind(COMMUNITY_TASK_KIND)
        .bind(d_tag)
        .fetch_all(&mut *connection)
        .await?;
        if rows.len() > 1_000 {
            return Err(DbError::InvalidData(
                "too many task revisions to project safely".to_owned(),
            ));
        }
        let revisions: Vec<TaskRevision> = rows
            .into_iter()
            .filter_map(|row| {
                parse_revision(
                    d_tag,
                    row.get("pubkey"),
                    row.get("id"),
                    row.get("created_at"),
                    row.get("content"),
                )
            })
            .collect();
        resolve_task(community, &author, task_id, &revisions).ok_or_else(|| {
            DbError::InvalidData("canonical task lineage cannot be resolved".to_owned())
        })
    }

    /// Resolve every canonical assignee to an active provider-internal user id.
    ///
    /// Missing mappings are returned to the caller so the projection remains
    /// pending instead of silently erasing assignees in the derived engine.
    #[datastore_span(name = "resolve_engine_principals", system = "postgresql")]
    pub async fn resolve_engine_principals(
        &self,
        community: CommunityId,
        binding_id: Uuid,
        pubkeys: &[String],
    ) -> Result<HashMap<String, Uuid>> {
        if pubkeys.is_empty() {
            return Ok(HashMap::new());
        }
        let decoded: Vec<Vec<u8>> = pubkeys
            .iter()
            .map(|pubkey| {
                hex::decode(pubkey).map_err(|_| {
                    DbError::InvalidData("canonical assignee pubkey is invalid".to_owned())
                })
            })
            .collect::<Result<_>>()?;
        let mut connection = crate::observability::acquire_writer(
            &self.pool,
            crate::observability::WriterOperation::Maintenance,
        )
        .await?;
        let rows = sqlx::query(
            "SELECT a2d2_pubkey, engine_user_id FROM engine_principal_mappings \
             WHERE community_id=$1 AND binding_id=$2 AND active AND a2d2_pubkey = ANY($3)",
        )
        .bind(community.as_uuid())
        .bind(binding_id)
        .bind(&decoded)
        .fetch_all(&mut *connection)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let pubkey: Vec<u8> = row.get("a2d2_pubkey");
                (hex::encode(pubkey), row.get("engine_user_id"))
            })
            .collect())
    }

    /// Resolve the current relay role for only the requested provider principals.
    #[datastore_span(name = "resolve_engine_principal_authorities", system = "postgresql")]
    pub async fn resolve_engine_principal_authorities(
        &self,
        community: CommunityId,
        pubkeys: &[String],
    ) -> Result<HashMap<String, String>> {
        if pubkeys.is_empty() {
            return Ok(HashMap::new());
        }
        if pubkeys.len() > 100 {
            return Err(DbError::InvalidData(
                "too many engine principals in one batch".to_owned(),
            ));
        }
        for pubkey in pubkeys {
            let decoded = hex::decode(pubkey).map_err(|_| {
                DbError::InvalidData("canonical assignee pubkey is invalid".to_owned())
            })?;
            if decoded.len() != 32 || hex::encode(decoded) != *pubkey {
                return Err(DbError::InvalidData(
                    "canonical assignee pubkey is invalid".to_owned(),
                ));
            }
        }
        let mut connection = crate::observability::acquire_writer(
            &self.pool,
            crate::observability::WriterOperation::Authorization,
        )
        .await?;
        let rows = sqlx::query(
            "SELECT pubkey,role FROM relay_members \
             WHERE community_id=$1 AND pubkey = ANY($2)",
        )
        .bind(community.as_uuid())
        .bind(pubkeys)
        .fetch_all(&mut *connection)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| (row.get("pubkey"), row.get("role")))
            .collect())
    }

    /// Complete a claim only when its desired generation is still current.
    #[datastore_span(name = "complete_engine_projection", system = "postgresql")]
    pub async fn complete_engine_projection(
        &self,
        claim: &ClaimedEngineProjection,
        canonical_event_id: &[u8],
        engine_entity_id: Option<Uuid>,
    ) -> Result<bool> {
        let mut connection = crate::observability::acquire_writer(
            &self.pool,
            crate::observability::WriterOperation::Maintenance,
        )
        .await?;
        let result = sqlx::query(
            "UPDATE engine_projection_heads SET \
                 applied_generation=$5, applied_event_id=$6, engine_entity_id=$7, \
                 lease_token=NULL, lease_expires_at=NULL, attempt_count=0, \
                 create_state='safe', \
                 last_error=NULL, next_attempt_at=now() + interval '5 minutes', \
                 updated_at=now() \
             WHERE binding_id=$1 AND entity_kind='community_task' AND entity_key=$2 \
               AND community_id=$8 AND lease_token=$3 AND desired_generation=$4",
        )
        .bind(claim.binding.id)
        .bind(&claim.entity_key)
        .bind(claim.lease_token)
        .bind(claim.generation)
        .bind(claim.generation)
        .bind(canonical_event_id)
        .bind(engine_entity_id)
        .bind(claim.binding.community.as_uuid())
        .execute(&mut *connection)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Fence a provider create before sending the request.
    ///
    /// A crash or lost response after this durable write leaves the head in an
    /// explicit lookup-only state. The worker must never infer that a missing
    /// response means the provider did not create an item.
    #[datastore_span(
        name = "mark_engine_projection_create_uncertain",
        system = "postgresql"
    )]
    pub async fn mark_engine_projection_create_uncertain(
        &self,
        claim: &ClaimedEngineProjection,
    ) -> Result<bool> {
        let mut connection = crate::observability::acquire_writer(
            &self.pool,
            crate::observability::WriterOperation::Maintenance,
        )
        .await?;
        let result = sqlx::query(
            "UPDATE engine_projection_heads SET create_state='uncertain', updated_at=now() \
             WHERE community_id=$1 AND binding_id=$2 \
               AND entity_kind='community_task' AND entity_key=$3 \
               AND lease_token=$4 AND desired_generation=$5 \
               AND engine_entity_id IS NULL AND create_state='safe'",
        )
        .bind(claim.binding.community.as_uuid())
        .bind(claim.binding.id)
        .bind(&claim.entity_key)
        .bind(claim.lease_token)
        .bind(claim.generation)
        .execute(&mut *connection)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Re-enable exactly one provider create after an operator has confirmed
    /// that its canonical external id is absent in Plane.
    ///
    /// `external_id` is the canonical entity key itself. Requiring it here
    /// makes the recovery target reviewable and prevents a broad reset. An
    /// active worker lease must finish or expire first.
    #[datastore_span(
        name = "confirm_engine_projection_create_absent",
        system = "postgresql"
    )]
    pub async fn confirm_engine_projection_create_absent(
        &self,
        community: CommunityId,
        binding_id: Uuid,
        external_id: &str,
    ) -> Result<bool> {
        if external_id.is_empty() || external_id.len() > 512 {
            return Err(DbError::InvalidData(
                "projection external id is invalid".to_owned(),
            ));
        }
        let mut connection = crate::observability::acquire_writer(
            &self.pool,
            crate::observability::WriterOperation::Maintenance,
        )
        .await?;
        let result = sqlx::query(
            "UPDATE engine_projection_heads SET create_state='safe', \
                 lease_token=NULL, lease_expires_at=NULL, next_attempt_at=now(), \
                 last_error=NULL, updated_at=now() \
             WHERE community_id=$1 AND binding_id=$2 \
               AND entity_kind='community_task' AND entity_key=$3 \
               AND create_state='uncertain' AND engine_entity_id IS NULL \
               AND (lease_token IS NULL OR lease_expires_at < now())",
        )
        .bind(community.as_uuid())
        .bind(binding_id)
        .bind(external_id)
        .execute(&mut *connection)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Release a claim after a bounded error, preserving newer generations.
    #[datastore_span(name = "retry_engine_projection", system = "postgresql")]
    pub async fn retry_engine_projection(
        &self,
        claim: &ClaimedEngineProjection,
        error: &str,
        retry_at: DateTime<Utc>,
    ) -> Result<bool> {
        let bounded_error: String = error.chars().take(1_024).collect();
        let mut connection = crate::observability::acquire_writer(
            &self.pool,
            crate::observability::WriterOperation::Maintenance,
        )
        .await?;
        let result = sqlx::query(
            "UPDATE engine_projection_heads SET \
                 lease_token=NULL, lease_expires_at=NULL, \
                 next_attempt_at=CASE WHEN desired_generation=$4 THEN $5 ELSE now() END, \
                 last_error=CASE WHEN desired_generation=$4 THEN $6 ELSE NULL END, \
                 updated_at=now() \
             WHERE binding_id=$1 AND entity_kind='community_task' AND entity_key=$2 \
               AND community_id=$7 AND lease_token=$3",
        )
        .bind(claim.binding.id)
        .bind(&claim.entity_key)
        .bind(claim.lease_token)
        .bind(claim.generation)
        .bind(retry_at)
        .bind(bounded_error)
        .bind(claim.binding.community.as_uuid())
        .execute(&mut *connection)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// Record an attempt whose remote write may still be finishing.
    ///
    /// The lease deliberately remains held until its bounded expiry, so a
    /// retry cannot race a provider request after the client timed out.
    #[datastore_span(name = "quarantine_engine_projection", system = "postgresql")]
    pub async fn quarantine_engine_projection(
        &self,
        claim: &ClaimedEngineProjection,
        error: &str,
    ) -> Result<bool> {
        let bounded_error: String = error.chars().take(1_024).collect();
        let mut connection = crate::observability::acquire_writer(
            &self.pool,
            crate::observability::WriterOperation::Maintenance,
        )
        .await?;
        let result = sqlx::query(
            "UPDATE engine_projection_heads SET last_error=$6, updated_at=now() \
             WHERE community_id=$1 AND binding_id=$2 \
               AND entity_kind='community_task' AND entity_key=$3 \
               AND lease_token=$4 AND lease_expires_at IS NOT NULL \
               AND desired_generation >= $5",
        )
        .bind(claim.binding.community.as_uuid())
        .bind(claim.binding.id)
        .bind(&claim.entity_key)
        .bind(claim.lease_token)
        .bind(claim.generation)
        .bind(bounded_error)
        .execute(&mut *connection)
        .await?;
        Ok(result.rows_affected() == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn revision(
        signer: char,
        author: char,
        event_id: u8,
        updated_at: i64,
        assignees: Vec<String>,
        deleted: bool,
    ) -> TaskRevision {
        TaskRevision {
            id: "task-1".to_owned(),
            signer: signer.to_string().repeat(64),
            event_id: vec![event_id; 32],
            event_created_at: updated_at,
            content: TaskContent {
                author: author.to_string().repeat(64),
                title: format!("revision-{event_id}"),
                body: String::new(),
                status: CommunityTaskStatus::Todo,
                assignees,
                due: None,
                custom_fields: Vec::new(),
                order: 1.0,
                created_at: 10,
                updated_at,
                deleted,
            },
        }
    }

    #[test]
    fn canonical_task_key_includes_community_author_and_stable_task_id() {
        let community = CommunityId::from_uuid(Uuid::nil());
        let key = canonical_entity_key(community, &"a".repeat(64), "same-id");
        assert_eq!(key, format!("{}:{}:same-id", Uuid::nil(), "a".repeat(64)));
    }

    #[test]
    fn author_controls_assignee_set_and_author_tombstone() {
        let community = CommunityId::from_uuid(Uuid::nil());
        let author = "a".repeat(64);
        let assignee = "b".repeat(64);
        let revisions = vec![
            revision('a', 'a', 1, 10, vec![assignee.clone()], false),
            revision('b', 'a', 2, 20, vec![assignee], false),
        ];
        let resolved = resolve_task(community, &author, "task-1", &revisions)
            .expect("authorized assignee revision resolves");
        assert_eq!(resolved.title, "revision-2");
        assert_eq!(resolved.signer, "b".repeat(64));

        let mut tombstoned = revisions;
        tombstoned.push(revision('a', 'a', 3, 30, Vec::new(), true));
        let resolved = resolve_task(community, &author, "task-1", &tombstoned)
            .expect("author tombstone resolves");
        assert!(resolved.deleted);
        assert_eq!(resolved.event_id, vec![3; 32]);
    }

    #[test]
    fn revoked_or_mutating_assignee_revision_cannot_win() {
        let community = CommunityId::from_uuid(Uuid::nil());
        let author = "a".repeat(64);
        let assignee = "b".repeat(64);
        let revisions = vec![
            revision('a', 'a', 1, 10, vec![assignee.clone()], false),
            revision('b', 'a', 2, 30, Vec::new(), false),
            revision('c', 'a', 3, 40, vec![assignee], false),
        ];
        let resolved = resolve_task(community, &author, "task-1", &revisions)
            .expect("author revision remains canonical");
        assert_eq!(resolved.title, "revision-1");
    }

    #[test]
    fn priority_mapping_is_closed_and_defaults_to_none() {
        let mut task = ResolvedCommunityTask {
            id: "task-1".to_owned(),
            key: "key".to_owned(),
            author: "a".repeat(64),
            signer: "a".repeat(64),
            event_id: vec![1; 32],
            title: "Task".to_owned(),
            body: String::new(),
            status: CommunityTaskStatus::Todo,
            assignees: Vec::new(),
            due: None,
            custom_fields: Vec::new(),
            deleted: false,
        };
        assert_eq!(task.plane_priority(), "none");
        task.custom_fields.push(CommunityTaskCustomField {
            id: "priority".to_owned(),
            name: "Priority".to_owned(),
            field_type: "text".to_owned(),
            value: Value::String("urgent".to_owned()),
        });
        assert_eq!(task.plane_priority(), "urgent");
        task.custom_fields[0].value = Value::String("provider-only".to_owned());
        assert_eq!(task.plane_priority(), "none");
    }
}

#[cfg(test)]
mod engine_projection_postgres_tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};
    use serde_json::json;
    use sqlx::{postgres::PgPoolOptions, PgPool};

    async fn scratch_through(prefix: &str, target: Option<i64>) -> (PgPool, PgPool, String) {
        let base = crate::test_support::database_url();
        let admin = PgPoolOptions::new()
            .max_connections(2)
            .connect(&base)
            .await
            .expect("connect test database server");
        let name = format!("{prefix}_{}", Uuid::new_v4().simple());
        sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
            .execute(&admin)
            .await
            .expect("create isolated projection database");
        let slash = base.rfind('/').expect("database URL path");
        let url = format!("{}/{}", &base[..slash], name);
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .connect(&url)
            .await
            .expect("connect isolated projection database");
        match target {
            Some(target) => crate::migration::run_migrations_through(&pool, target)
                .await
                .expect("migrate isolated projection database through target"),
            None => crate::migration::run_migrations(&pool)
                .await
                .expect("migrate isolated projection database"),
        }
        (admin, pool, name)
    }

    async fn scratch(prefix: &str) -> (PgPool, PgPool, String) {
        scratch_through(prefix, None).await
    }

    async fn cleanup(admin: PgPool, pool: PgPool, name: String) {
        pool.close().await;
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DROP DATABASE IF EXISTS {name} WITH (FORCE)"
        )))
        .execute(&admin)
        .await
        .expect("drop isolated projection database");
        admin.close().await;
    }

    async fn setup() -> (PgPool, PgPool, String, Db, CommunityId, Uuid, Keys, String) {
        let (admin, pool, name) = scratch("engine_projection").await;
        let community_uuid = Uuid::new_v4();
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(community_uuid)
            .bind(format!("projection-{}.example", community_uuid.simple()))
            .execute(&pool)
            .await
            .expect("insert isolated community");
        let binding_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO engine_projection_bindings (
                community_id, provider, origin, workspace_slug, project_id,
                api_key_env, state_map, enabled
            ) VALUES ($1, 'plane', 'http://127.0.0.1:3020/', 'a2d2', $2,
                      'A2D2_TEST_PLANE_API_KEY', $3, true)
            RETURNING id
            "#,
        )
        .bind(community_uuid)
        .bind(Uuid::new_v4())
        .bind(json!({
            "todo": Uuid::new_v4(),
            "doing": Uuid::new_v4(),
            "done": Uuid::new_v4()
        }))
        .fetch_one(&pool)
        .await
        .expect("insert projection binding");
        let keys = Keys::generate();
        let d_tag = format!("community-task:{}", Uuid::new_v4());
        (
            admin,
            pool.clone(),
            name,
            Db::from_pool(pool),
            CommunityId::from_uuid(community_uuid),
            binding_id,
            keys,
            d_tag,
        )
    }

    fn task_event(keys: &Keys, d_tag: &str, title: &str, stamp: u64) -> nostr::Event {
        let body = json!({
            "author": keys.public_key().to_hex(),
            "title": title,
            "body": "Canonical body",
            "status": "todo",
            "assignees": [],
            "order": 1,
            "createdAt": 100,
            "updatedAt": stamp
        });
        EventBuilder::new(Kind::Custom(COMMUNITY_TASK_KIND as u16), body.to_string())
            .tags([Tag::custom(nostr::TagKind::d(), [d_tag.to_owned()])])
            .custom_created_at(Timestamp::from(stamp))
            .sign_with_keys(keys)
            .expect("sign task event")
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn adopted_engine_principal_is_authority_fenced_and_never_overwritten() {
        let (admin, pool, name, db, community, binding_id, keys, _) = setup().await;
        let pubkey = keys.public_key().to_hex();
        sqlx::query("INSERT INTO relay_members (community_id,pubkey,role) VALUES ($1,$2,'member')")
            .bind(community.as_uuid())
            .bind(&pubkey)
            .execute(&pool)
            .await
            .expect("insert authoritative relay member");

        let first_user = Uuid::new_v4();
        const TEST_ADVISORY_LOCK: i64 = 7_010_917;
        sqlx::query(
            "CREATE FUNCTION pause_engine_principal_insert() RETURNS trigger \
             LANGUAGE plpgsql AS $$ BEGIN \
                 PERFORM pg_advisory_xact_lock(7010917); RETURN NEW; \
             END $$",
        )
        .execute(&pool)
        .await
        .expect("create principal insert pause function");
        sqlx::query(
            "CREATE TRIGGER pause_engine_principal_insert \
             BEFORE INSERT ON engine_principal_mappings FOR EACH ROW \
             EXECUTE FUNCTION pause_engine_principal_insert()",
        )
        .execute(&pool)
        .await
        .expect("create principal insert pause trigger");
        let mut pause = pool.begin().await.expect("begin principal insert pause");
        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(TEST_ADVISORY_LOCK)
            .execute(&mut *pause)
            .await
            .expect("hold principal insert pause");

        let adopting_db = db.clone();
        let adopting_pubkey = pubkey.clone();
        let mut adoption = tokio::spawn(async move {
            adopting_db
                .adopt_engine_principals(
                    community,
                    binding_id,
                    &[(adopting_pubkey, "member".to_owned(), first_user)],
                )
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let waiting: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM pg_locks \
                     WHERE locktype='advisory' AND NOT granted)",
                )
                .fetch_one(&pool)
                .await
                .expect("observe paused principal insert");
                if waiting {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("principal adoption must reach the paused insert");

        let mut updater = pool.acquire().await.expect("acquire role updater");
        sqlx::query("SET lock_timeout='200ms'")
            .execute(&mut *updater)
            .await
            .expect("bound role update wait");
        sqlx::query(
            "UPDATE relay_members SET role='admin',updated_at=now() \
             WHERE community_id=$1 AND pubkey=$2",
        )
        .bind(community.as_uuid())
        .bind(&pubkey)
        .execute(&mut *updater)
        .await
        .expect_err("role update must not race a principal adoption");
        drop(updater);

        pause
            .rollback()
            .await
            .expect("release principal insert pause");
        tokio::time::timeout(std::time::Duration::from_secs(5), &mut adoption)
            .await
            .expect("principal adoption must finish after pause release")
            .expect("join principal adoption")
            .expect("adopt exact provider principal");
        let first = db
            .resolve_engine_principals(community, binding_id, std::slice::from_ref(&pubkey))
            .await
            .expect("resolve adopted principal");
        assert_eq!(first.get(&pubkey), Some(&first_user));

        sqlx::query(
            "UPDATE relay_members SET role='admin',updated_at=now() \
             WHERE community_id=$1 AND pubkey=$2",
        )
        .bind(community.as_uuid())
        .bind(&pubkey)
        .execute(&pool)
        .await
        .expect("change authoritative role");
        assert!(db
            .adopt_engine_principals(
                community,
                binding_id,
                &[(pubkey.clone(), "member".to_owned(), Uuid::new_v4())],
            )
            .await
            .is_err());
        assert!(db
            .adopt_engine_principals(
                community,
                binding_id,
                &[(pubkey.clone(), "admin".to_owned(), Uuid::new_v4())],
            )
            .await
            .is_err());
        let unchanged = db
            .resolve_engine_principals(community, binding_id, std::slice::from_ref(&pubkey))
            .await
            .expect("resolve conflict-safe principal");
        assert_eq!(unchanged.get(&pubkey), Some(&first_user));

        drop(db);
        cleanup(admin, pool, name).await;
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn desired_generation_is_atomic_and_stale_claim_cannot_complete() {
        let (admin, pool, name, db, community, binding_id, keys, d_tag) = setup().await;
        let now = Timestamp::now().as_secs();
        let first = task_event(&keys, &d_tag, "First", now);
        assert!(
            db.replace_parameterized_event(community, &first, &d_tag, None)
                .await
                .expect("insert canonical event")
                .1
        );
        let persisted: (i64, Vec<u8>) = sqlx::query_as(
            "SELECT desired_generation, desired_event_id FROM engine_projection_heads \
             WHERE binding_id=$1",
        )
        .bind(binding_id)
        .fetch_one(&pool)
        .await
        .expect("event transaction also enqueues projection");
        assert_eq!(persisted.0, 1);
        assert_eq!(persisted.1, first.id.as_bytes());

        let mut claims = db
            .claim_engine_projections(1, Duration::from_secs(30), false)
            .await
            .expect("claim first generation");
        let first_claim = claims.pop().expect("one claim");
        assert_eq!(first_claim.generation, 1);
        let first_task = db
            .resolve_community_task_projection(community, &d_tag, &keys.public_key().to_bytes())
            .await
            .expect("resolve first canonical winner");
        assert_eq!(first_task.title, "First");

        let second = task_event(&keys, &d_tag, "Second", now + 1);
        assert!(
            db.replace_parameterized_event(community, &second, &d_tag, None)
                .await
                .expect("insert newer canonical event")
                .1
        );
        assert!(!db
            .complete_engine_projection(&first_claim, &first_task.event_id, Some(Uuid::new_v4()))
            .await
            .expect("stale completion is a clean no-op"));
        assert!(db
            .retry_engine_projection(&first_claim, "stale", Utc::now())
            .await
            .expect("stale claim releases without delaying the new generation"));

        let mut claims = db
            .claim_engine_projections(1, Duration::from_secs(30), false)
            .await
            .expect("claim second generation");
        let second_claim = claims.pop().expect("one current claim");
        assert_eq!(second_claim.generation, 2);
        let second_task = db
            .resolve_community_task_projection(community, &d_tag, &keys.public_key().to_bytes())
            .await
            .expect("resolve second canonical winner");
        assert_eq!(second_task.title, "Second");
        let engine_id = Uuid::new_v4();
        assert!(db
            .complete_engine_projection(&second_claim, &second_task.event_id, Some(engine_id))
            .await
            .expect("complete current generation"));
        let state: (i64, i64, Option<Uuid>, Option<String>) = sqlx::query_as(
            "SELECT desired_generation, applied_generation, engine_entity_id, last_error \
             FROM engine_projection_heads WHERE binding_id=$1",
        )
        .bind(binding_id)
        .fetch_one(&pool)
        .await
        .expect("read completed projection");
        assert_eq!(state, (2, 2, Some(engine_id), None));

        sqlx::query(
            "UPDATE engine_projection_heads SET next_attempt_at=now() - interval '1 hour' \
             WHERE community_id=$1 AND binding_id=$2 AND task_d_tag=$3",
        )
        .bind(community.as_uuid())
        .bind(binding_id)
        .bind(&d_tag)
        .execute(&pool)
        .await
        .expect("make completed reconciliation overdue");
        let pending_d_tag = format!("community-task:{}", Uuid::new_v4());
        let pending = task_event(&keys, &pending_d_tag, "New pending task", now + 2);
        assert!(
            db.replace_parameterized_event(community, &pending, &pending_d_tag, None)
                .await
                .expect("insert new pending task")
                .1
        );
        let prioritized = db
            .claim_engine_projections(1, Duration::from_secs(30), false)
            .await
            .expect("claim one pending-or-reconcile row")
            .pop()
            .expect("one prioritized claim");
        assert_eq!(
            prioritized.task_d_tag, pending_d_tag,
            "new canonical work must outrank overdue periodic reads"
        );
        assert!(db
            .retry_engine_projection(&prioritized, "fairness-test", Utc::now())
            .await
            .expect("release pending fairness claim"));
        let reconciliation = db
            .claim_engine_projections(1, Duration::from_secs(30), true)
            .await
            .expect("reserve bounded reconciliation slot")
            .pop()
            .expect("one reconciliation claim");
        assert_eq!(
            reconciliation.task_d_tag, d_tag,
            "a reserved slot prevents continuous pending work from starving reconciliation"
        );
        drop(db);
        cleanup(admin, pool, name).await;
    }

    fn projection_config(enabled: bool) -> PlaneProjectionBindingConfig {
        PlaneProjectionBindingConfig {
            origin: "http://127.0.0.1:3020/".to_owned(),
            workspace_slug: "a2d2".to_owned(),
            project_id: Uuid::new_v4(),
            api_key_env: "A2D2_TEST_PLANE_API_KEY".to_owned(),
            state_map: PlaneStateMap {
                todo: Uuid::new_v4(),
                doing: Uuid::new_v4(),
                done: Uuid::new_v4(),
            },
            enabled,
        }
    }

    async fn insert_community(pool: &PgPool, community: Uuid, label: &str) {
        sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
            .bind(community)
            .bind(format!("{label}-{}.example", community.simple()))
            .execute(pool)
            .await
            .expect("insert isolated community");
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn activation_backfill_disabled_journal_and_shared_fence_preserve_latest_intent() {
        let (admin, pool, name) = scratch("projection_activation").await;
        let db = Db::from_pool(pool.clone());
        let community = CommunityId::from_uuid(Uuid::new_v4());
        insert_community(&pool, *community.as_uuid(), "activation").await;
        let keys = Keys::generate();
        let d_tag = format!("community-task:{}", Uuid::new_v4());
        let now = Timestamp::now().as_secs();

        let before_binding = task_event(&keys, &d_tag, "Before binding", now);
        assert!(
            db.replace_parameterized_event(community, &before_binding, &d_tag, None)
                .await
                .expect("persist task before binding")
                .1
        );
        let disabled = projection_config(false);
        let (binding_id, queued) = db
            .configure_plane_projection(community, &disabled)
            .await
            .expect("configure disabled binding with backfill");
        assert_eq!(queued, 1);
        assert!(db
            .claim_engine_projections(1, Duration::from_secs(30), false)
            .await
            .expect("disabled claim query")
            .is_empty());

        let while_disabled = task_event(&keys, &d_tag, "While disabled", now + 1);
        assert!(
            db.replace_parameterized_event(community, &while_disabled, &d_tag, None)
                .await
                .expect("persist while disabled")
                .1
        );
        let disabled_head: (i64, Vec<u8>) = sqlx::query_as(
            "SELECT desired_generation, desired_event_id FROM engine_projection_heads \
             WHERE community_id=$1 AND binding_id=$2",
        )
        .bind(community.as_uuid())
        .bind(binding_id)
        .fetch_one(&pool)
        .await
        .expect("disabled binding retains latest intent");
        assert_eq!(disabled_head.0, 2);
        assert_eq!(disabled_head.1, while_disabled.id.as_bytes());

        let mut enabled = disabled;
        enabled.enabled = true;
        let (enabled_id, enabled_queued) = db
            .configure_plane_projection(community, &enabled)
            .await
            .expect("enable binding and reconcile current heads");
        assert_eq!(enabled_id, binding_id);
        assert_eq!(enabled_queued, 1);
        let claim = db
            .claim_engine_projections(1, Duration::from_secs(30), false)
            .await
            .expect("claim enabled latest head")
            .pop()
            .expect("one latest projection");
        assert_eq!(claim.generation, 3);
        assert_eq!(claim.desired_event_id, while_disabled.id.as_bytes());

        // Hold the task lineage lock so the signed writer acquires the shared
        // projection fence and then pauses. The production configure call must
        // wait for that writer; removing either production lock makes this
        // assertion fail and recreates the activation SELECT/commit gap.
        let race_community = CommunityId::from_uuid(Uuid::new_v4());
        insert_community(&pool, *race_community.as_uuid(), "activation-race").await;
        let race_keys = Keys::generate();
        let race_d_tag = format!("community-task:{}", Uuid::new_v4());
        let race_event = task_event(&race_keys, &race_d_tag, "Activation overlap", now + 2);
        let lineage_lock = crate::replaceable::event_replacement_lock_key(
            race_community,
            COMMUNITY_TASK_KIND,
            b"community-task-lineage",
            Some(race_d_tag.as_bytes()),
        );
        let mut lineage_holder = pool.begin().await.expect("begin lineage holder");
        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(lineage_lock)
            .execute(&mut *lineage_holder)
            .await
            .expect("hold task lineage lock");
        let race_db = db.clone();
        let race_d_tag_for_write = race_d_tag.clone();
        let write = tokio::spawn(async move {
            race_db
                .replace_parameterized_event(
                    race_community,
                    &race_event,
                    &race_d_tag_for_write,
                    None,
                )
                .await
        });
        let projection_lock = projection_binding_lock_key(race_community);
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let mut probe = pool.begin().await.expect("begin projection lock probe");
                let acquired: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock($1)")
                    .bind(projection_lock)
                    .fetch_one(&mut *probe)
                    .await
                    .expect("probe production projection lock");
                probe
                    .rollback()
                    .await
                    .expect("release projection lock probe");
                if !acquired {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("signed writer acquires shared projection lock");

        let race_config = projection_config(true);
        let configure_db = db.clone();
        let configure = tokio::spawn(async move {
            configure_db
                .configure_plane_projection(race_community, &race_config)
                .await
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !configure.is_finished(),
            "production configure must wait for the in-flight signed writer"
        );
        lineage_holder
            .commit()
            .await
            .expect("release task lineage lock");
        assert!(
            write
                .await
                .expect("join canonical writer")
                .expect("canonical writer succeeds")
                .1
        );
        let (race_binding, race_queued) = configure
            .await
            .expect("join production configure")
            .expect("production configure succeeds");
        assert_eq!(race_queued, 1);
        let race_heads: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM engine_projection_heads \
             WHERE community_id=$1 AND binding_id=$2",
        )
        .bind(race_community.as_uuid())
        .bind(race_binding)
        .fetch_one(&pool)
        .await
        .expect("count activation-overlap head");
        assert_eq!(race_heads, 1);

        drop(db);
        cleanup(admin, pool, name).await;
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn tenant_composites_and_state_map_constraints_fail_closed() {
        let (admin, pool, name) = scratch("projection_tenants").await;
        let db = Db::from_pool(pool.clone());
        let binding = Uuid::new_v4();
        let author = vec![7_u8; 32];
        let community_a = CommunityId::from_uuid(Uuid::new_v4());
        let community_b = CommunityId::from_uuid(Uuid::new_v4());
        insert_community(&pool, *community_a.as_uuid(), "tenant-a").await;
        insert_community(&pool, *community_b.as_uuid(), "tenant-b").await;
        let config = projection_config(true);
        for community in [community_a, community_b] {
            sqlx::query(
                "INSERT INTO engine_projection_bindings \
                 (community_id,id,provider,origin,workspace_slug,project_id,api_key_env,state_map,enabled) \
                 VALUES ($1,$2,'plane',$3,$4,$5,$6,$7,true)",
            )
            .bind(community.as_uuid())
            .bind(binding)
            .bind(&config.origin)
            .bind(&config.workspace_slug)
            .bind(config.project_id)
            .bind(&config.api_key_env)
            .bind(serde_json::to_value(&config.state_map).expect("state map"))
            .execute(&pool)
            .await
            .expect("same opaque binding id is valid in another tenant");
        }
        let user_a = Uuid::new_v4();
        let user_b = Uuid::new_v4();
        db.upsert_engine_principal(community_a, binding, &author, user_a, true)
            .await
            .expect("map tenant A principal");
        db.upsert_engine_principal(community_b, binding, &author, user_b, true)
            .await
            .expect("map tenant B principal");
        let author_hex = hex::encode(&author);
        assert_eq!(
            db.resolve_engine_principals(community_a, binding, std::slice::from_ref(&author_hex))
                .await
                .expect("resolve A")
                .get(&author_hex),
            Some(&user_a)
        );
        assert_eq!(
            db.resolve_engine_principals(community_b, binding, std::slice::from_ref(&author_hex))
                .await
                .expect("resolve B")
                .get(&author_hex),
            Some(&user_b)
        );
        assert!(sqlx::query(
            "INSERT INTO engine_principal_mappings \
             (community_id,binding_id,a2d2_pubkey,engine_user_id) VALUES ($1,$2,$3,$4)",
        )
        .bind(Uuid::new_v4())
        .bind(binding)
        .bind(&author)
        .bind(Uuid::new_v4())
        .execute(&pool)
        .await
        .is_err());

        for invalid in [
            json!({"todo": Uuid::new_v4(), "doing": Uuid::new_v4(), "done": Uuid::new_v4(), "extra": Uuid::new_v4()}),
            json!({"todo": "not-a-uuid", "doing": Uuid::new_v4(), "done": Uuid::new_v4()}),
            json!({"todo": Value::Null, "doing": Uuid::new_v4(), "done": Uuid::new_v4()}),
        ] {
            assert!(sqlx::query(
                "UPDATE engine_projection_bindings SET state_map=$3 \
                 WHERE community_id=$1 AND id=$2",
            )
            .bind(community_a.as_uuid())
            .bind(binding)
            .bind(invalid)
            .execute(&pool)
            .await
            .is_err());
        }

        drop(db);
        cleanup(admin, pool, name).await;
    }

    #[tokio::test]
    #[ignore = "requires Postgres"]
    async fn migration_44_to_45_preserves_data_and_installs_projection_contract() {
        let (admin, pool, name) = scratch_through("projection_upgrade", Some(44)).await;
        let community = Uuid::new_v4();
        insert_community(&pool, community, "upgrade-preserved").await;
        let before: (Uuid, String) = sqlx::query_as("SELECT id,host FROM communities WHERE id=$1")
            .bind(community)
            .fetch_one(&pool)
            .await
            .expect("read pre-upgrade data");

        crate::migration::run_migrations(&pool)
            .await
            .expect("upgrade migration 44 to 45");
        let after: (Uuid, String) = sqlx::query_as("SELECT id,host FROM communities WHERE id=$1")
            .bind(community)
            .fetch_one(&pool)
            .await
            .expect("read preserved post-upgrade data");
        assert_eq!(after, before);
        let config = projection_config(true);
        let binding: Uuid = sqlx::query_scalar(
            "INSERT INTO engine_projection_bindings \
             (community_id,provider,origin,workspace_slug,project_id,api_key_env,state_map,enabled) \
             VALUES ($1,'plane',$2,$3,$4,$5,$6,true) RETURNING id",
        )
        .bind(community)
        .bind(&config.origin)
        .bind(&config.workspace_slug)
        .bind(config.project_id)
        .bind(&config.api_key_env)
        .bind(serde_json::to_value(&config.state_map).expect("state map"))
        .fetch_one(&pool)
        .await
        .expect("insert post-upgrade binding");
        let entity_key = format!("{community}:{}:upgrade-task", "a".repeat(64));
        sqlx::query(
            "INSERT INTO engine_projection_heads \
             (community_id,binding_id,entity_kind,entity_key,task_d_tag,author_pubkey,desired_event_id,desired_generation) \
             VALUES ($1,$2,'community_task',$3,'community-task:upgrade-task',$4,$5,1)",
        )
        .bind(community)
        .bind(binding)
        .bind(&entity_key)
        .bind(vec![0xaa_u8; 32])
        .bind(vec![0xbb_u8; 32])
        .execute(&pool)
        .await
        .expect("insert post-upgrade projection head");
        let create_state: String = sqlx::query_scalar(
            "SELECT create_state FROM engine_projection_heads \
             WHERE community_id=$1 AND binding_id=$2 AND entity_key=$3",
        )
        .bind(community)
        .bind(binding)
        .bind(&entity_key)
        .fetch_one(&pool)
        .await
        .expect("read create state default");
        assert_eq!(create_state, "safe");
        assert!(sqlx::query(
            "UPDATE engine_projection_heads SET create_state='invalid' \
             WHERE community_id=$1 AND binding_id=$2 AND entity_key=$3",
        )
        .bind(community)
        .bind(binding)
        .bind(&entity_key)
        .execute(&pool)
        .await
        .is_err());
        assert!(sqlx::query(
            "INSERT INTO engine_projection_bindings \
             (community_id,provider,origin,workspace_slug,project_id,api_key_env,state_map,enabled) \
             VALUES ($1,'plane',$2,'../escape',$3,$4,$5,true)",
        )
        .bind(Uuid::new_v4())
        .bind(&config.origin)
        .bind(Uuid::new_v4())
        .bind(&config.api_key_env)
        .bind(serde_json::to_value(&config.state_map).expect("state map"))
        .execute(&pool)
        .await
        .is_err());

        let mut explain = pool.begin().await.expect("begin explain transaction");
        sqlx::query("SET LOCAL enable_seqscan=off")
            .execute(&mut *explain)
            .await
            .expect("prefer indexes in small scratch fixture");
        let plan: Vec<String> = sqlx::query_scalar(
            "EXPLAIN (COSTS OFF) \
             SELECT entity_key FROM engine_projection_heads \
             WHERE community_id=$1 AND binding_id=$2 \
               AND desired_generation > 0 AND next_attempt_at <= now() \
             ORDER BY next_attempt_at,updated_at,entity_kind,entity_key LIMIT 1",
        )
        .bind(community)
        .bind(binding)
        .fetch_all(&mut *explain)
        .await
        .expect("explain periodic due lookup");
        explain
            .rollback()
            .await
            .expect("finish explain transaction");
        assert!(
            plan.iter()
                .any(|line| line.contains("engine_projection_heads_reconcile_idx")),
            "periodic reconciliation query must consume its partial due index: {plan:?}"
        );

        cleanup(admin, pool, name).await;
    }
}
