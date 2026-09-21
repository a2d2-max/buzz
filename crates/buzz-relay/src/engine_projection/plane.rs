//! Durable A2D2 task projection into the Plane headless API.
//!
//! The signed A2D2 task remains authoritative. Plane credentials live only in
//! the relay process, and all reads shown to users continue to come from A2D2.

use std::collections::{HashMap, HashSet};
#[cfg(unix)]
use std::fs::{self, OpenOptions};
#[cfg(unix)]
use std::io::{Cursor, Read as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use buzz_db::engine_projection::ClaimedEngineProjection;
use buzz_db::Db;
use chrono::Utc;
use futures_util::StreamExt as _;
use pulldown_cmark::{html, Event, Parser};
use reqwest::{Certificate, Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use thiserror::Error;
use url::Url;
use uuid::Uuid;

const API_KEY_HEADER: &str = "X-API-Key";
const EXTERNAL_SOURCE: &str = "a2d2-community-task-v1";
const MAX_RESPONSE_BYTES: usize = 1_048_576;
// Claim one item immediately before use. A queued batch would share one lease
// deadline even though each Plane reconciliation can perform four requests.
const CLAIM_BATCH: i64 = 1;
const CLAIM_LEASE: Duration = Duration::from_secs(120);
const TASK_DEADLINE: Duration = Duration::from_secs(90);
const IDLE_INTERVAL: Duration = Duration::from_secs(5);
const PENDING_BATCHES_PER_RECONCILIATION_SLOT: u8 = 9;
const PLANE_CA_FILE_ENV: &str = "BUZZ_PLANE_ENGINE_CA_FILE";
const MAX_CA_FILE_BYTES: u64 = 1_048_576;
const MAX_PRINCIPALS_PER_REQUEST: usize = 100;

/// Projection failure safe to persist without credentials or response bodies.
#[derive(Debug, Error)]
pub enum PlaneProjectionError {
    /// Binding origin violates the internal-engine transport contract.
    #[error("invalid Plane engine origin: {0}")]
    InvalidOrigin(&'static str),
    /// Non-secret binding fields violate the private Plane API contract.
    #[error("invalid Plane engine binding: {0}")]
    InvalidBinding(&'static str),
    /// Server-only credential configuration is absent or malformed.
    #[error("Plane engine credential is unavailable in configured environment variable")]
    CredentialUnavailable,
    /// A configured engine-only trust root could not be loaded.
    #[error("Plane engine CA file is unavailable")]
    CaUnavailable,
    /// A configured engine-only trust root was not a valid PEM certificate.
    #[error("Plane engine CA file is invalid")]
    InvalidCa,
    /// Canonical assignees do not all have an active provider mapping.
    #[error("Plane principal mapping is incomplete for canonical assignees")]
    PrincipalMappingIncomplete,
    /// Provider returned an unexpected status.
    #[error("Plane API {operation} returned HTTP {status}")]
    ApiStatus {
        /// Stable operation name without URLs or request data.
        operation: &'static str,
        /// HTTP response status.
        status: StatusCode,
    },
    /// Provider response exceeded the fixed parser budget.
    #[error("Plane API response exceeded the byte limit")]
    ResponseTooLarge,
    /// Provider response was structurally invalid.
    #[error("Plane API response was invalid for {0}")]
    InvalidResponse(&'static str),
    /// Provider readback did not match the derived canonical state.
    #[error("Plane API readback did not match canonical task projection")]
    ReadbackMismatch,
    /// A previous create may have committed without its response. Only a
    /// stable external-id lookup or explicit operator recovery may proceed.
    #[error(
        "Plane create outcome is uncertain; waiting for external-id lookup or operator recovery"
    )]
    AmbiguousCreate,
    /// HTTP transport failed. The error is not persisted verbatim because it
    /// may contain a signed or credential-bearing URL.
    #[error("Plane API transport failed")]
    Transport,
    /// Canonical database operation failed.
    #[error("canonical projection database operation failed: {0}")]
    Database(#[from] buzz_db::DbError),
    /// One bounded reconciliation exceeded the claim's processing budget.
    #[error("Plane projection attempt exceeded its processing deadline")]
    Deadline,
}

impl PlaneProjectionError {
    fn remote_write_may_still_finish(&self) -> bool {
        matches!(self, Self::Transport | Self::Deadline)
    }
}

#[derive(Clone)]
struct PlaneClient {
    http: Client,
    origin: Url,
    workspace_slug: String,
    project_id: Uuid,
    api_key: Arc<str>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PlaneWorkItem {
    id: Uuid,
    name: String,
    #[serde(default)]
    description_html: String,
    priority: String,
    state: Option<Uuid>,
    #[serde(default)]
    assignees: Vec<Uuid>,
    external_id: Option<String>,
    external_source: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ConflictWorkItem {
    id: Uuid,
}

#[derive(Clone, Debug, Serialize)]
struct PlaneWorkItemPayload<'a> {
    name: &'a str,
    description_html: &'a str,
    priority: &'a str,
    state: Uuid,
    assignees: &'a [Uuid],
    external_id: &'a str,
    external_source: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
struct PrincipalEnsure {
    pubkey: String,
    principal_key: String,
    role: String,
}

#[derive(Debug, Serialize)]
struct PrincipalEnsureRequest<'a> {
    community_id: Uuid,
    workspace_slug: &'a str,
    project_id: Uuid,
    principals: &'a [PrincipalEnsure],
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrincipalEnsureResponse {
    principals: Vec<PrincipalEnsureResult>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrincipalEnsureResult {
    pubkey: String,
    user_id: Uuid,
}

enum Lookup {
    Found(PlaneWorkItem),
    Missing,
}

fn validate_origin(value: &str) -> Result<Url, PlaneProjectionError> {
    let origin = Url::parse(value)
        .map_err(|_| PlaneProjectionError::InvalidOrigin("origin is not a URL"))?;
    if origin.username() != ""
        || origin.password().is_some()
        || origin.query().is_some()
        || origin.fragment().is_some()
        || origin.path() != "/"
    {
        return Err(PlaneProjectionError::InvalidOrigin(
            "origin must be a credential-free root URL",
        ));
    }
    let loopback = origin.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if origin.scheme() != "https" && !(origin.scheme() == "http" && loopback) {
        return Err(PlaneProjectionError::InvalidOrigin(
            "non-loopback engines require HTTPS",
        ));
    }
    Ok(origin)
}

fn valid_workspace_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 48
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn plane_principal_key(community: Uuid, pubkey: &str) -> String {
    hex::encode(Sha256::digest(format!(
        "a2d2-engine-principal:v1:{community}:plane:{pubkey}"
    )))
}

fn truncate_title(value: &str) -> String {
    value.chars().take(255).collect()
}

fn render_markdown(markdown: &str) -> String {
    let mut output = String::new();
    html::push_html(
        &mut output,
        Parser::new(markdown).map(|event| match event {
            Event::Html(raw) => Event::Text(raw.into_string().into()),
            Event::InlineHtml(raw) => Event::Text(raw.into_string().into()),
            other => other,
        }),
    );
    output
}

async fn response_bytes(response: Response) -> Result<Vec<u8>, PlaneProjectionError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(PlaneProjectionError::ResponseTooLarge);
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| PlaneProjectionError::Transport)?;
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(PlaneProjectionError::ResponseTooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn parse_json<T: for<'de> Deserialize<'de>>(
    bytes: &[u8],
    operation: &'static str,
) -> Result<T, PlaneProjectionError> {
    serde_json::from_slice(bytes).map_err(|_| PlaneProjectionError::InvalidResponse(operation))
}

fn configured_ca_path() -> Result<Option<PathBuf>, PlaneProjectionError> {
    let Some(value) = std::env::var_os(PLANE_CA_FILE_ENV) else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if path.as_os_str().is_empty() {
        return Err(PlaneProjectionError::CaUnavailable);
    }
    Ok(Some(path))
}

fn read_ca_certificates(path: &Path) -> Result<Vec<Certificate>, PlaneProjectionError> {
    #[cfg(not(unix))]
    {
        let _ = path;
        return Err(PlaneProjectionError::CaUnavailable);
    }

    #[cfg(unix)]
    {
        let path_metadata =
            fs::symlink_metadata(path).map_err(|_| PlaneProjectionError::CaUnavailable)?;
        if !path_metadata.file_type().is_file()
            || path_metadata.len() == 0
            || path_metadata.len() > MAX_CA_FILE_BYTES
        {
            return Err(PlaneProjectionError::InvalidCa);
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
        }
        let file = options
            .open(path)
            .map_err(|_| PlaneProjectionError::CaUnavailable)?;
        let file_metadata = file
            .metadata()
            .map_err(|_| PlaneProjectionError::CaUnavailable)?;
        if !file_metadata.file_type().is_file()
            || file_metadata.len() == 0
            || file_metadata.len() > MAX_CA_FILE_BYTES
        {
            return Err(PlaneProjectionError::InvalidCa);
        }
        let mut bytes = Vec::new();
        file.take(MAX_CA_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| PlaneProjectionError::CaUnavailable)?;
        if bytes.is_empty() || bytes.len() as u64 > MAX_CA_FILE_BYTES {
            return Err(PlaneProjectionError::InvalidCa);
        }
        let certificates = rustls_pemfile::certs(&mut Cursor::new(bytes))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| PlaneProjectionError::InvalidCa)?;
        if certificates.is_empty() {
            return Err(PlaneProjectionError::InvalidCa);
        }
        let mut verifier = rustls::RootCertStore::empty();
        let mut roots = Vec::with_capacity(certificates.len());
        for certificate in certificates {
            verifier
                .add(certificate.clone())
                .map_err(|_| PlaneProjectionError::InvalidCa)?;
            roots.push(
                Certificate::from_der(certificate.as_ref())
                    .map_err(|_| PlaneProjectionError::InvalidCa)?,
            );
        }
        Ok(roots)
    }
}

fn build_http_client(ca_path: Option<&Path>) -> Result<Client, PlaneProjectionError> {
    let mut builder = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(path) = ca_path {
        for certificate in read_ca_certificates(path)? {
            builder = builder.add_root_certificate(certificate);
        }
    }
    builder.build().map_err(|_| PlaneProjectionError::Transport)
}

impl PlaneClient {
    fn new(claim: &ClaimedEngineProjection) -> Result<Self, PlaneProjectionError> {
        // Validate every non-secret field before reading server credentials.
        validate_origin(&claim.binding.origin)?;
        if !valid_workspace_slug(&claim.binding.workspace_slug) {
            return Err(PlaneProjectionError::InvalidBinding(
                "workspace slug must contain 1-48 ASCII letters, digits, underscores, or hyphens",
            ));
        }
        let api_key = std::env::var(&claim.binding.api_key_env)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .ok_or(PlaneProjectionError::CredentialUnavailable)?;
        let ca_path = configured_ca_path()?;
        Self::with_material(claim, api_key, ca_path.as_deref())
    }

    fn with_material(
        claim: &ClaimedEngineProjection,
        api_key: String,
        ca_path: Option<&Path>,
    ) -> Result<Self, PlaneProjectionError> {
        let origin = validate_origin(&claim.binding.origin)?;
        if !valid_workspace_slug(&claim.binding.workspace_slug) {
            return Err(PlaneProjectionError::InvalidBinding(
                "workspace slug must contain 1-48 ASCII letters, digits, underscores, or hyphens",
            ));
        }
        let http = build_http_client(ca_path)?;
        Ok(Self {
            http,
            origin,
            workspace_slug: claim.binding.workspace_slug.clone(),
            project_id: claim.binding.project_id,
            api_key: Arc::from(api_key),
        })
    }

    fn collection_url(&self) -> Result<Url, PlaneProjectionError> {
        self.origin
            .join(&format!(
                "api/v1/workspaces/{}/projects/{}/work-items/",
                self.workspace_slug, self.project_id
            ))
            .map_err(|_| PlaneProjectionError::InvalidOrigin("API path cannot be joined"))
    }

    fn detail_url(&self, id: Uuid) -> Result<Url, PlaneProjectionError> {
        self.origin
            .join(&format!(
                "api/v1/workspaces/{}/projects/{}/work-items/{id}/",
                self.workspace_slug, self.project_id
            ))
            .map_err(|_| PlaneProjectionError::InvalidOrigin("API path cannot be joined"))
    }

    fn principal_ensure_url(&self) -> Result<Url, PlaneProjectionError> {
        self.origin
            .join("api/a2d2/principals/ensure")
            .map_err(|_| PlaneProjectionError::InvalidOrigin("API path cannot be joined"))
    }

    fn request(&self, method: reqwest::Method, url: Url) -> reqwest::RequestBuilder {
        self.http
            .request(method, url)
            .header(API_KEY_HEADER, self.api_key.as_ref())
    }

    async fn lookup_external(&self, external_id: &str) -> Result<Lookup, PlaneProjectionError> {
        let mut url = self.collection_url()?;
        url.query_pairs_mut()
            .append_pair("external_id", external_id)
            .append_pair("external_source", EXTERNAL_SOURCE);
        let response = self
            .request(reqwest::Method::GET, url)
            .send()
            .await
            .map_err(|_| PlaneProjectionError::Transport)?;
        match response.status() {
            StatusCode::OK => Ok(Lookup::Found(parse_json(
                &response_bytes(response).await?,
                "external lookup",
            )?)),
            StatusCode::NOT_FOUND => Ok(Lookup::Missing),
            status => Err(PlaneProjectionError::ApiStatus {
                operation: "external lookup",
                status,
            }),
        }
    }

    async fn create(
        &self,
        payload: &PlaneWorkItemPayload<'_>,
    ) -> Result<Uuid, PlaneProjectionError> {
        let response = self
            .request(reqwest::Method::POST, self.collection_url()?)
            .json(payload)
            .send()
            .await
            .map_err(|_| PlaneProjectionError::Transport)?;
        let status = response.status();
        let bytes = response_bytes(response).await?;
        match status {
            StatusCode::CREATED => Ok(parse_json::<PlaneWorkItem>(&bytes, "create")?.id),
            StatusCode::CONFLICT => {
                Ok(parse_json::<ConflictWorkItem>(&bytes, "create conflict")?.id)
            }
            status => Err(PlaneProjectionError::ApiStatus {
                operation: "create",
                status,
            }),
        }
    }

    async fn patch(
        &self,
        id: Uuid,
        payload: &PlaneWorkItemPayload<'_>,
    ) -> Result<(), PlaneProjectionError> {
        let response = self
            .request(reqwest::Method::PATCH, self.detail_url(id)?)
            .json(payload)
            .send()
            .await
            .map_err(|_| PlaneProjectionError::Transport)?;
        if response.status() != StatusCode::OK {
            return Err(PlaneProjectionError::ApiStatus {
                operation: "update",
                status: response.status(),
            });
        }
        let _ = response_bytes(response).await?;
        Ok(())
    }

    async fn get(&self, id: Uuid) -> Result<Lookup, PlaneProjectionError> {
        let response = self
            .request(reqwest::Method::GET, self.detail_url(id)?)
            .send()
            .await
            .map_err(|_| PlaneProjectionError::Transport)?;
        match response.status() {
            StatusCode::OK => Ok(Lookup::Found(parse_json(
                &response_bytes(response).await?,
                "readback",
            )?)),
            StatusCode::NOT_FOUND => Ok(Lookup::Missing),
            status => Err(PlaneProjectionError::ApiStatus {
                operation: "readback",
                status,
            }),
        }
    }

    async fn delete(&self, id: Uuid) -> Result<(), PlaneProjectionError> {
        let response = self
            .request(reqwest::Method::DELETE, self.detail_url(id)?)
            .send()
            .await
            .map_err(|_| PlaneProjectionError::Transport)?;
        if !matches!(
            response.status(),
            StatusCode::NO_CONTENT | StatusCode::NOT_FOUND
        ) {
            return Err(PlaneProjectionError::ApiStatus {
                operation: "delete",
                status: response.status(),
            });
        }
        let _ = response_bytes(response).await?;
        Ok(())
    }

    async fn ensure_principals(
        &self,
        community_id: Uuid,
        principals: &[PrincipalEnsure],
    ) -> Result<HashMap<String, Uuid>, PlaneProjectionError> {
        if principals.is_empty() || principals.len() > MAX_PRINCIPALS_PER_REQUEST {
            return Err(PlaneProjectionError::PrincipalMappingIncomplete);
        }
        let response = self
            .request(reqwest::Method::POST, self.principal_ensure_url()?)
            .json(&PrincipalEnsureRequest {
                community_id,
                workspace_slug: &self.workspace_slug,
                project_id: self.project_id,
                principals,
            })
            .send()
            .await
            .map_err(|_| PlaneProjectionError::Transport)?;
        if response.status() != StatusCode::OK {
            return Err(PlaneProjectionError::ApiStatus {
                operation: "principal ensure",
                status: response.status(),
            });
        }
        let response: PrincipalEnsureResponse =
            parse_json(&response_bytes(response).await?, "principal ensure")?;
        if response.principals.len() != principals.len() {
            return Err(PlaneProjectionError::InvalidResponse("principal ensure"));
        }
        let mut resolved = HashMap::with_capacity(response.principals.len());
        let mut user_ids = HashSet::with_capacity(response.principals.len());
        for principal in response.principals {
            if resolved
                .insert(principal.pubkey.clone(), principal.user_id)
                .is_some()
                || !user_ids.insert(principal.user_id)
                || !principals
                    .iter()
                    .any(|expected| expected.pubkey == principal.pubkey)
            {
                return Err(PlaneProjectionError::InvalidResponse("principal ensure"));
            }
        }
        Ok(resolved)
    }
}

async fn ensure_assignee_principals(
    db: &Db,
    claim: &ClaimedEngineProjection,
    client: &PlaneClient,
    assignee_pubkeys: &[String],
) -> Result<HashMap<String, Uuid>, PlaneProjectionError> {
    if assignee_pubkeys.is_empty() {
        return Ok(HashMap::new());
    }
    if assignee_pubkeys.len() > MAX_PRINCIPALS_PER_REQUEST {
        return Err(PlaneProjectionError::PrincipalMappingIncomplete);
    }

    let authority_by_pubkey = db
        .resolve_engine_principal_authorities(claim.binding.community, assignee_pubkeys)
        .await?;
    if authority_by_pubkey.len() != assignee_pubkeys.len() {
        return Err(PlaneProjectionError::PrincipalMappingIncomplete);
    }
    let mut authorities = Vec::with_capacity(assignee_pubkeys.len());
    for pubkey in assignee_pubkeys {
        let Some(role) = authority_by_pubkey.get(pubkey) else {
            return Err(PlaneProjectionError::PrincipalMappingIncomplete);
        };
        if !matches!(role.as_str(), "owner" | "admin" | "member") {
            return Err(PlaneProjectionError::PrincipalMappingIncomplete);
        }
        authorities.push(PrincipalEnsure {
            pubkey: pubkey.clone(),
            principal_key: plane_principal_key(*claim.binding.community.as_uuid(), pubkey),
            role: role.clone(),
        });
    }

    let mut mappings = db
        .resolve_engine_principals(claim.binding.community, claim.binding.id, assignee_pubkeys)
        .await?;
    let ensured = client
        .ensure_principals(*claim.binding.community.as_uuid(), &authorities)
        .await?;
    let missing: Vec<&PrincipalEnsure> = authorities
        .iter()
        .filter(|principal| !mappings.contains_key(&principal.pubkey))
        .collect();
    let adoptions: Vec<(String, String, Uuid)> = missing
        .iter()
        .map(|principal| {
            ensured
                .get(&principal.pubkey)
                .copied()
                .map(|user_id| (principal.pubkey.clone(), principal.role.clone(), user_id))
                .ok_or(PlaneProjectionError::InvalidResponse("principal ensure"))
        })
        .collect::<Result<_, _>>()?;
    if !adoptions.is_empty() {
        db.adopt_engine_principals(claim.binding.community, claim.binding.id, &adoptions)
            .await?;
    }
    mappings = db
        .resolve_engine_principals(claim.binding.community, claim.binding.id, assignee_pubkeys)
        .await?;
    if mappings.len() != assignee_pubkeys.len()
        || ensured
            .iter()
            .any(|(pubkey, user_id)| mappings.get(pubkey) != Some(user_id))
    {
        return Err(PlaneProjectionError::PrincipalMappingIncomplete);
    }
    Ok(mappings)
}

fn matches_readback(item: &PlaneWorkItem, payload: &PlaneWorkItemPayload<'_>) -> bool {
    let actual_assignees: HashSet<Uuid> = item.assignees.iter().copied().collect();
    let expected_assignees: HashSet<Uuid> = payload.assignees.iter().copied().collect();
    let expected_description = payload
        .description_html
        .strip_suffix('\n')
        .unwrap_or(payload.description_html);
    item.name == payload.name
        // Plane's serializer removes the terminal newline emitted by
        // pulldown-cmark while preserving the rendered HTML itself.
        && (item.description_html == payload.description_html
            || item.description_html == expected_description)
        && item.priority == payload.priority
        && item.state == Some(payload.state)
        && actual_assignees == expected_assignees
        && item.external_id.as_deref() == Some(payload.external_id)
        && item.external_source.as_deref() == Some(payload.external_source)
}

async fn sync_live_task(
    client: &PlaneClient,
    payload: &PlaneWorkItemPayload<'_>,
    existing: Option<Uuid>,
) -> Result<Uuid, PlaneProjectionError> {
    let id = match existing {
        Some(id) => id,
        None => client.create(payload).await?,
    };
    // Plane assigns a project default assignee on create when an explicit
    // empty list is supplied. Always patch once so the derived engine exactly
    // reflects the canonical A2D2 assignee set.
    client.patch(id, payload).await?;
    let Lookup::Found(readback) = client.get(id).await? else {
        return Err(PlaneProjectionError::ReadbackMismatch);
    };
    if !matches_readback(&readback, payload) {
        return Err(PlaneProjectionError::ReadbackMismatch);
    }
    Ok(id)
}

async fn project_task(
    db: &Db,
    claim: &ClaimedEngineProjection,
) -> Result<(Vec<u8>, Option<Uuid>), PlaneProjectionError> {
    let task = db
        .resolve_community_task_projection(
            claim.binding.community,
            &claim.task_d_tag,
            &claim.author_pubkey,
        )
        .await?;
    let client = PlaneClient::new(claim)?;
    if task.deleted {
        let existing = match client.lookup_external(&task.key).await? {
            Lookup::Found(item) => Some(item.id),
            Lookup::Missing => None,
        };
        let engine_id = existing.or(claim.engine_entity_id);
        if let Some(id) = engine_id {
            client.delete(id).await?;
            if matches!(client.get(id).await?, Lookup::Found(_)) {
                return Err(PlaneProjectionError::ReadbackMismatch);
            }
        }
        return Ok((task.event_id, engine_id));
    }

    let principals = ensure_assignee_principals(db, claim, &client, &task.assignees).await?;
    let assignees: Vec<Uuid> = task
        .assignees
        .iter()
        .filter_map(|pubkey| principals.get(pubkey).copied())
        .collect();
    let title = truncate_title(&task.title);
    let description = render_markdown(&task.body);
    let payload = PlaneWorkItemPayload {
        name: &title,
        description_html: &description,
        priority: task.plane_priority(),
        state: claim.binding.state_map.state_for(task.status),
        assignees: &assignees,
        external_id: &task.key,
        external_source: EXTERNAL_SOURCE,
    };
    let existing = match client.lookup_external(&task.key).await? {
        Lookup::Found(item) if matches_readback(&item, &payload) => {
            return Ok((task.event_id, Some(item.id)))
        }
        Lookup::Found(item) => Some(item.id),
        Lookup::Missing if claim.create_uncertain => {
            return Err(PlaneProjectionError::AmbiguousCreate)
        }
        Lookup::Missing => {
            if !db.mark_engine_projection_create_uncertain(claim).await? {
                return Err(PlaneProjectionError::Database(
                    buzz_db::DbError::InvalidData(
                        "projection claim changed before provider create".to_owned(),
                    ),
                ));
            }
            None
        }
    };
    let id = sync_live_task(&client, &payload, existing).await?;
    Ok((task.event_id, Some(id)))
}

fn retry_delay(attempt: i32) -> Duration {
    let exponent = u32::try_from(attempt.clamp(1, 8)).unwrap_or(8);
    Duration::from_secs(1_u64 << exponent)
}

/// Process one bounded batch of durable Plane projection claims.
pub async fn run_plane_projection_batch(db: &Db) -> usize {
    run_plane_projection_batch_with_policy(db, CLAIM_LEASE, TASK_DEADLINE, false).await
}

async fn run_plane_projection_batch_with_policy(
    db: &Db,
    claim_lease: Duration,
    task_deadline: Duration,
    prefer_reconciliation: bool,
) -> usize {
    if task_deadline >= claim_lease {
        tracing::error!("Plane projection deadline must be shorter than its lease");
        return 0;
    }
    let claims = match db
        .claim_engine_projections(CLAIM_BATCH, claim_lease, prefer_reconciliation)
        .await
    {
        Ok(claims) => claims,
        Err(error) => {
            tracing::warn!(%error, "Plane projection claim failed");
            return 0;
        }
    };
    let processed = claims.len();
    for claim in claims {
        let result = tokio::time::timeout(task_deadline, project_task(db, &claim))
            .await
            .unwrap_or(Err(PlaneProjectionError::Deadline));
        match result {
            Ok((canonical_event_id, engine_entity_id)) => {
                match db
                    .complete_engine_projection(&claim, &canonical_event_id, engine_entity_id)
                    .await
                {
                    Ok(true) => {}
                    Ok(false) => {
                        let _ = db
                            .retry_engine_projection(
                                &claim,
                                "claim generation advanced",
                                Utc::now(),
                            )
                            .await;
                    }
                    Err(error) => {
                        tracing::warn!(%error, binding_id = %claim.binding.id, "Plane projection completion failed")
                    }
                }
            }
            Err(error) => {
                if error.remote_write_may_still_finish() {
                    if let Err(db_error) = db
                        .quarantine_engine_projection(&claim, &error.to_string())
                        .await
                    {
                        tracing::warn!(%db_error, binding_id = %claim.binding.id, "Plane projection quarantine persistence failed");
                    }
                    continue;
                }
                let retry_at = Utc::now()
                    + chrono::Duration::from_std(retry_delay(claim.attempt))
                        .unwrap_or_else(|_| chrono::Duration::minutes(5));
                if let Err(db_error) = db
                    .retry_engine_projection(&claim, &error.to_string(), retry_at)
                    .await
                {
                    tracing::warn!(%db_error, binding_id = %claim.binding.id, "Plane projection retry persistence failed");
                }
            }
        }
    }
    processed
}

/// Run the bounded Plane projection worker until relay shutdown.
pub async fn run_plane_projection_worker(db: Db, shutting_down: Arc<AtomicBool>) {
    let mut pending_batches = 0_u8;
    while !shutting_down.load(Ordering::Acquire) {
        let reconciliation_slot = pending_batches >= PENDING_BATCHES_PER_RECONCILIATION_SLOT;
        let processed = run_plane_projection_batch_with_policy(
            &db,
            CLAIM_LEASE,
            TASK_DEADLINE,
            reconciliation_slot,
        )
        .await;
        if processed == 0 {
            tokio::time::sleep(IDLE_INTERVAL).await;
        } else {
            pending_batches = if reconciliation_slot {
                0
            } else {
                pending_batches.saturating_add(1)
            };
            tokio::task::yield_now().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::{Path, Query, State};
    use axum::http::HeaderMap;
    use axum::response::{IntoResponse, Response as AxumResponse};
    use axum::routing::get;
    use axum::{Json, Router};
    use buzz_core::CommunityId;
    use buzz_db::engine_projection::{
        EngineProjectionBinding, PlaneProjectionBindingConfig, PlaneStateMap,
    };
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};
    use serde_json::{json, Value};
    use sqlx::{postgres::PgPoolOptions, PgPool};
    use std::collections::HashMap;
    use std::io::Write as _;
    use std::sync::atomic::AtomicU32;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpListener;
    use tokio::sync::{Mutex, Notify};
    use tokio_rustls::TlsAcceptor;

    #[derive(Default)]
    struct MockPlaneState {
        item: Mutex<Option<Value>>,
        creates: Mutex<u32>,
        patches: Mutex<u32>,
    }

    #[derive(Default)]
    struct DelayedPlaneState {
        item: Mutex<Option<Value>>,
        creates: AtomicU32,
        patches: AtomicU32,
        first_patch_started: Notify,
        release_first_patch: Notify,
    }

    struct LostCreateState {
        item: Mutex<Option<Value>>,
        creates: AtomicU32,
        post_create_lookup_misses: AtomicU32,
    }

    struct MockPrincipalState {
        request: Mutex<Option<Value>>,
        response: Mutex<Value>,
    }

    impl Default for LostCreateState {
        fn default() -> Self {
            Self {
                item: Mutex::new(None),
                creates: AtomicU32::new(0),
                post_create_lookup_misses: AtomicU32::new(1),
            }
        }
    }

    fn authorized(headers: &HeaderMap) -> bool {
        headers
            .get(API_KEY_HEADER)
            .and_then(|value| value.to_str().ok())
            == Some("test-key")
    }

    async fn list_item(
        State(state): State<Arc<MockPlaneState>>,
        headers: HeaderMap,
        Query(query): Query<HashMap<String, String>>,
    ) -> AxumResponse {
        if !authorized(&headers) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let item = state.item.lock().await;
        match item.as_ref().filter(|item| {
            item["external_id"].as_str() == query.get("external_id").map(String::as_str)
                && item["external_source"].as_str()
                    == query.get("external_source").map(String::as_str)
        }) {
            Some(item) => Json(item.clone()).into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        }
    }

    async fn create_item(
        State(state): State<Arc<MockPlaneState>>,
        headers: HeaderMap,
        Json(mut body): Json<Value>,
    ) -> AxumResponse {
        if !authorized(&headers) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        *state.creates.lock().await += 1;
        body["id"] = json!(Uuid::from_u128(99));
        body["state"] = body["state"].clone();
        *state.item.lock().await = Some(body.clone());
        (StatusCode::CREATED, Json(body)).into_response()
    }

    async fn patch_item(
        State(state): State<Arc<MockPlaneState>>,
        headers: HeaderMap,
        Path((_slug, _project, id)): Path<(String, Uuid, Uuid)>,
        Json(mut body): Json<Value>,
    ) -> AxumResponse {
        if !authorized(&headers) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        *state.patches.lock().await += 1;
        body["id"] = json!(id);
        *state.item.lock().await = Some(body.clone());
        Json(body).into_response()
    }

    async fn get_item(
        State(state): State<Arc<MockPlaneState>>,
        headers: HeaderMap,
        Path((_slug, _project, id)): Path<(String, Uuid, Uuid)>,
    ) -> AxumResponse {
        if !authorized(&headers) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let item = state.item.lock().await;
        match item.as_ref().filter(|item| item["id"] == json!(id)) {
            Some(item) => Json(item.clone()).into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        }
    }

    async fn delayed_list_item(
        State(state): State<Arc<DelayedPlaneState>>,
        headers: HeaderMap,
        Query(query): Query<HashMap<String, String>>,
    ) -> AxumResponse {
        if !authorized(&headers) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let item = state.item.lock().await;
        match item.as_ref().filter(|item| {
            item["external_id"].as_str() == query.get("external_id").map(String::as_str)
                && item["external_source"].as_str()
                    == query.get("external_source").map(String::as_str)
        }) {
            Some(item) => Json(item.clone()).into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        }
    }

    async fn delayed_create_item(
        State(state): State<Arc<DelayedPlaneState>>,
        headers: HeaderMap,
        Json(mut body): Json<Value>,
    ) -> AxumResponse {
        if !authorized(&headers) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        state.creates.fetch_add(1, Ordering::SeqCst);
        body["id"] = json!(Uuid::from_u128(199));
        *state.item.lock().await = Some(body.clone());
        (StatusCode::CREATED, Json(body)).into_response()
    }

    async fn delayed_patch_item(
        State(state): State<Arc<DelayedPlaneState>>,
        headers: HeaderMap,
        Path((_slug, _project, id)): Path<(String, Uuid, Uuid)>,
        Json(mut body): Json<Value>,
    ) -> AxumResponse {
        if !authorized(&headers) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let patch_number = state.patches.fetch_add(1, Ordering::SeqCst) + 1;
        body["id"] = json!(id);
        if patch_number == 1 {
            let delayed_state = Arc::clone(&state);
            let delayed_body = body.clone();
            tokio::spawn(async move {
                delayed_state.release_first_patch.notified().await;
                *delayed_state.item.lock().await = Some(delayed_body);
            });
            state.first_patch_started.notify_one();
            // Model a provider that accepted the mutation but never delivered
            // the response. The detached server-side commit survives the
            // client's bounded timeout and may land after a newer generation.
            tokio::time::sleep(Duration::from_secs(5)).await;
            return Json(body).into_response();
        }
        *state.item.lock().await = Some(body.clone());
        Json(body).into_response()
    }

    async fn delayed_get_item(
        State(state): State<Arc<DelayedPlaneState>>,
        headers: HeaderMap,
        Path((_slug, _project, id)): Path<(String, Uuid, Uuid)>,
    ) -> AxumResponse {
        if !authorized(&headers) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let item = state.item.lock().await;
        match item.as_ref().filter(|item| item["id"] == json!(id)) {
            Some(item) => Json(item.clone()).into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        }
    }

    async fn lost_create_list_item(
        State(state): State<Arc<LostCreateState>>,
        headers: HeaderMap,
        Query(query): Query<HashMap<String, String>>,
    ) -> AxumResponse {
        if !authorized(&headers) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        if state.creates.load(Ordering::SeqCst) > 0
            && state
                .post_create_lookup_misses
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_ok()
        {
            return StatusCode::NOT_FOUND.into_response();
        }
        let item = state.item.lock().await;
        match item.as_ref().filter(|item| {
            item["external_id"].as_str() == query.get("external_id").map(String::as_str)
                && item["external_source"].as_str()
                    == query.get("external_source").map(String::as_str)
        }) {
            Some(item) => Json(item.clone()).into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        }
    }

    async fn lost_create_item(
        State(state): State<Arc<LostCreateState>>,
        headers: HeaderMap,
        Json(mut body): Json<Value>,
    ) -> AxumResponse {
        if !authorized(&headers) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        state.creates.fetch_add(1, Ordering::SeqCst);
        body["id"] = json!(Uuid::from_u128(299));
        *state.item.lock().await = Some(body.clone());
        // The provider committed, but the client never receives the response.
        tokio::time::sleep(Duration::from_secs(5)).await;
        (StatusCode::CREATED, Json(body)).into_response()
    }

    async fn lost_create_patch_item(
        State(state): State<Arc<LostCreateState>>,
        headers: HeaderMap,
        Path((_slug, _project, id)): Path<(String, Uuid, Uuid)>,
        Json(mut body): Json<Value>,
    ) -> AxumResponse {
        if !authorized(&headers) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        body["id"] = json!(id);
        *state.item.lock().await = Some(body.clone());
        Json(body).into_response()
    }

    async fn lost_create_get_item(
        State(state): State<Arc<LostCreateState>>,
        headers: HeaderMap,
        Path((_slug, _project, id)): Path<(String, Uuid, Uuid)>,
    ) -> AxumResponse {
        if !authorized(&headers) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let item = state.item.lock().await;
        match item.as_ref().filter(|item| item["id"] == json!(id)) {
            Some(item) => Json(item.clone()).into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        }
    }

    async fn ensure_principals(
        State(state): State<Arc<MockPrincipalState>>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> AxumResponse {
        if !authorized(&headers) {
            return StatusCode::FORBIDDEN.into_response();
        }
        *state.request.lock().await = Some(body);
        Json(state.response.lock().await.clone()).into_response()
    }

    async fn scratch_database(prefix: &str) -> (PgPool, PgPool, String) {
        let base = std::env::var("DATABASE_URL").expect("DATABASE_URL for isolated test server");
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
        Db::from_pool(pool.clone())
            .migrate()
            .await
            .expect("migrate isolated projection database");
        (admin, pool, name)
    }

    async fn drop_scratch_database(admin: PgPool, pool: PgPool, name: String) {
        pool.close().await;
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DROP DATABASE IF EXISTS {name} WITH (FORCE)"
        )))
        .execute(&admin)
        .await
        .expect("drop isolated projection database");
        admin.close().await;
    }

    fn signed_task(
        keys: &Keys,
        d_tag: &str,
        title: &str,
        body: &str,
        created_at: u64,
        updated_at: u64,
    ) -> nostr::Event {
        EventBuilder::new(
            Kind::Custom(30_078),
            json!({
                "author": keys.public_key().to_hex(),
                "title": title,
                "body": body,
                "status": "todo",
                "assignees": [],
                "order": 1,
                "createdAt": created_at,
                "updatedAt": updated_at
            })
            .to_string(),
        )
        .tags([Tag::custom(nostr::TagKind::d(), [d_tag.to_owned()])])
        .custom_created_at(Timestamp::from(updated_at))
        .sign_with_keys(keys)
        .expect("sign canonical task")
    }

    fn claim(origin: &str) -> ClaimedEngineProjection {
        ClaimedEngineProjection {
            binding: EngineProjectionBinding {
                id: Uuid::nil(),
                community: CommunityId::from_uuid(Uuid::nil()),
                origin: origin.to_owned(),
                workspace_slug: "a2d2".to_owned(),
                project_id: Uuid::nil(),
                api_key_env: "A2D2_TEST_PLANE_API_KEY".to_owned(),
                state_map: PlaneStateMap {
                    todo: Uuid::from_u128(1),
                    doing: Uuid::from_u128(2),
                    done: Uuid::from_u128(3),
                },
            },
            entity_key: "key".to_owned(),
            task_d_tag: "community-task:task-1".to_owned(),
            author_pubkey: vec![0; 32],
            desired_event_id: vec![1; 32],
            generation: 1,
            lease_token: Uuid::nil(),
            engine_entity_id: None,
            create_uncertain: false,
            attempt: 1,
        }
    }

    async fn tls_plane_server(
        status: &'static str,
        extra_headers: &'static str,
    ) -> (
        std::net::SocketAddr,
        tempfile::NamedTempFile,
        tokio::task::JoinHandle<()>,
    ) {
        let certified = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()])
            .expect("generate isolated Plane TLS certificate");
        let mut ca_file = tempfile::NamedTempFile::new().expect("create Plane CA fixture");
        ca_file
            .write_all(certified.cert.pem().as_bytes())
            .expect("write Plane CA fixture");
        ca_file.flush().expect("flush Plane CA fixture");

        let server = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("ring supports safe TLS versions")
        .with_no_client_auth()
        .with_single_cert(
            vec![certified.cert.der().clone()],
            rustls::pki_types::PrivatePkcs8KeyDer::from(certified.signing_key.serialize_der())
                .into(),
        )
        .expect("build isolated Plane TLS server");
        let acceptor = TlsAcceptor::from(Arc::new(server));
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind isolated Plane TLS server");
        let address = listener.local_addr().expect("Plane TLS server address");
        let task = tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    return;
                };
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    let Ok(mut stream) = acceptor.accept(socket).await else {
                        return;
                    };
                    let mut request = [0_u8; 8_192];
                    if stream.read(&mut request).await.is_err() {
                        return;
                    }
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: 2\r\nContent-Type: application/json\r\n{extra_headers}Connection: close\r\n\r\n{{}}"
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        (address, ca_file, task)
    }

    #[test]
    fn origin_contract_allows_https_and_loopback_http_only() {
        assert!(validate_origin("https://plane.internal.example/").is_ok());
        assert!(validate_origin("http://127.0.0.1:3020/").is_ok());
        assert!(validate_origin("http://plane.internal.example/").is_err());
        assert!(validate_origin("https://user@example.com/").is_err());
        assert!(validate_origin("https://example.com/base/").is_err());
    }

    #[test]
    fn mounted_ca_file_fails_closed_when_missing_invalid_or_oversized() {
        let missing = PathBuf::from(format!("/missing/plane-ca-{}.pem", Uuid::new_v4()));
        assert!(matches!(
            build_http_client(Some(&missing)),
            Err(PlaneProjectionError::CaUnavailable)
        ));

        let mut invalid = tempfile::NamedTempFile::new().expect("create invalid CA fixture");
        invalid
            .write_all(b"not a certificate")
            .expect("write invalid CA fixture");
        let invalid_result = build_http_client(Some(invalid.path()));
        assert!(
            matches!(invalid_result, Err(PlaneProjectionError::InvalidCa)),
            "invalid CA returned {invalid_result:?}"
        );

        let mut oversized = tempfile::NamedTempFile::new().expect("create oversized CA fixture");
        std::io::copy(
            &mut std::io::repeat(0).take(MAX_CA_FILE_BYTES + 1),
            &mut oversized,
        )
        .expect("write oversized CA fixture");
        assert!(matches!(
            build_http_client(Some(oversized.path())),
            Err(PlaneProjectionError::InvalidCa)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn mounted_ca_file_refuses_fifo_without_blocking() {
        let directory = tempfile::tempdir().expect("create CA FIFO fixture directory");
        let fifo = directory.path().join("ca.pem");
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .expect("invoke mkfifo");
        assert!(status.success());
        assert!(matches!(
            build_http_client(Some(&fifo)),
            Err(PlaneProjectionError::InvalidCa)
        ));
    }

    #[tokio::test]
    async fn mounted_ca_is_engine_scoped_and_keeps_hostname_verification() {
        let (address, ca_file, server) = tls_plane_server("200 OK", "").await;
        let (_wrong_ca_address, wrong_ca_file, wrong_ca_server) =
            tls_plane_server("200 OK", "").await;
        let origin = format!("https://localhost:{}/", address.port());
        let trusted = PlaneClient::with_material(
            &claim(&origin),
            "test-key".to_owned(),
            Some(ca_file.path()),
        )
        .expect("build Plane client with mounted CA");
        let response = trusted
            .request(
                reqwest::Method::GET,
                trusted.collection_url().expect("collection URL"),
            )
            .send()
            .await
            .expect("mounted CA trusts matching engine certificate");
        assert_eq!(response.status(), StatusCode::OK);

        let untrusted = PlaneClient::with_material(&claim(&origin), "test-key".to_owned(), None)
            .expect("build system-trust-only Plane client");
        assert!(untrusted
            .request(
                reqwest::Method::GET,
                untrusted.collection_url().expect("untrusted URL")
            )
            .send()
            .await
            .is_err());

        let wrong_ca = PlaneClient::with_material(
            &claim(&origin),
            "test-key".to_owned(),
            Some(wrong_ca_file.path()),
        )
        .expect("build wrong-CA Plane client");
        assert!(wrong_ca
            .request(
                reqwest::Method::GET,
                wrong_ca.collection_url().expect("wrong-CA URL")
            )
            .send()
            .await
            .is_err());

        let wrong_host_origin = format!("https://127.0.0.1:{}/", address.port());
        let wrong_host = PlaneClient::with_material(
            &claim(&wrong_host_origin),
            "test-key".to_owned(),
            Some(ca_file.path()),
        )
        .expect("build wrong-host Plane client");
        assert!(wrong_host
            .request(
                reqwest::Method::GET,
                wrong_host.collection_url().expect("wrong-host URL")
            )
            .send()
            .await
            .is_err());
        server.abort();
        wrong_ca_server.abort();
    }

    #[tokio::test]
    #[ignore = "mutates Plane client environment; run as an isolated production-seam test"]
    async fn production_client_consumes_configured_mounted_ca() {
        struct RestoreEnv(Vec<(&'static str, Option<std::ffi::OsString>)>);
        impl Drop for RestoreEnv {
            fn drop(&mut self) {
                for (key, value) in self.0.drain(..) {
                    match value {
                        Some(value) => std::env::set_var(key, value),
                        None => std::env::remove_var(key),
                    }
                }
            }
        }

        let (address, ca_file, server) = tls_plane_server("200 OK", "").await;
        let keys = ["A2D2_TEST_PLANE_API_KEY", PLANE_CA_FILE_ENV];
        let _restore = RestoreEnv(
            keys.into_iter()
                .map(|key| (key, std::env::var_os(key)))
                .collect(),
        );
        std::env::set_var("A2D2_TEST_PLANE_API_KEY", "test-key");
        std::env::set_var(PLANE_CA_FILE_ENV, ca_file.path());

        let origin = format!("https://localhost:{}/", address.port());
        let client = PlaneClient::new(&claim(&origin))
            .expect("production client consumes mounted CA environment");
        let response = client
            .request(
                reqwest::Method::GET,
                client.collection_url().expect("collection URL"),
            )
            .send()
            .await
            .expect("production client trusts mounted CA");
        assert_eq!(response.status(), StatusCode::OK);
        server.abort();
    }

    #[tokio::test]
    async fn mounted_ca_client_does_not_follow_provider_redirects() {
        let (address, ca_file, server) =
            tls_plane_server("302 Found", "Location: http://127.0.0.1:9/\r\n").await;
        let origin = format!("https://localhost:{}/", address.port());
        let client = PlaneClient::with_material(
            &claim(&origin),
            "test-key".to_owned(),
            Some(ca_file.path()),
        )
        .expect("build redirect test Plane client");
        let response = client
            .request(
                reqwest::Method::GET,
                client.collection_url().expect("collection URL"),
            )
            .send()
            .await
            .expect("redirect response remains observable");
        assert_eq!(response.status(), StatusCode::FOUND);
        server.abort();
    }

    #[test]
    fn workspace_slug_cannot_change_the_credential_bearing_api_path() {
        for valid in ["a2d2", "team_01", "Team-42", &"a".repeat(48)] {
            assert!(valid_workspace_slug(valid));
        }
        for invalid in [
            "",
            "../admin",
            "a/b",
            "a?token",
            "a#fragment",
            &"a".repeat(49),
        ] {
            assert!(!valid_workspace_slug(invalid));
        }
        let mut invalid = claim("https://plane.internal.example/");
        invalid.binding.workspace_slug = "../admin".to_owned();
        assert!(matches!(
            PlaneClient::new(&invalid),
            Err(PlaneProjectionError::InvalidBinding(_))
        ));
    }

    #[test]
    fn api_paths_are_v1_work_item_paths() {
        // SAFETY: changing process env is unsafe in Rust 2024; avoid it by
        // constructing the client directly rather than exercising secret load.
        let binding = claim("https://plane.internal.example/").binding;
        let client = PlaneClient {
            http: Client::new(),
            origin: validate_origin(&binding.origin).expect("valid origin"),
            workspace_slug: binding.workspace_slug,
            project_id: binding.project_id,
            api_key: Arc::from("test-only"),
        };
        assert_eq!(
            client.collection_url().expect("collection").as_str(),
            "https://plane.internal.example/api/v1/workspaces/a2d2/projects/00000000-0000-0000-0000-000000000000/work-items/"
        );
        assert!(client
            .detail_url(Uuid::from_u128(7))
            .expect("detail")
            .as_str()
            .ends_with("/work-items/00000000-0000-0000-0000-000000000007/"));
    }

    #[test]
    fn markdown_does_not_pass_raw_html_to_plane() {
        let rendered = render_markdown("# Safe\n<script>alert(1)</script>");
        assert!(rendered.contains("<h1>Safe</h1>"));
        assert!(rendered.contains("&lt;script&gt;"));
        assert!(!rendered.contains("<script>"));
    }

    #[test]
    fn plane_principal_key_matches_provider_contract_vector() {
        assert_eq!(
            plane_principal_key(
                Uuid::from_u128(1),
                "1111111111111111111111111111111111111111111111111111111111111111",
            ),
            "d13addb4341c40a2db6478db73b78a2e17b4e42bc5925d0a926b86662659e5cc"
        );
    }

    #[tokio::test]
    async fn production_client_ensures_exact_authoritative_principal_shape() {
        let pubkey = "11".repeat(32);
        let community = Uuid::from_u128(1);
        let user_id = Uuid::from_u128(9);
        let state = Arc::new(MockPrincipalState {
            request: Mutex::new(None),
            response: Mutex::new(json!({
                "principals": [{"pubkey": pubkey, "user_id": user_id}]
            })),
        });
        let app = Router::new()
            .route(
                "/api/a2d2/principals/ensure",
                axum::routing::post(ensure_principals),
            )
            .with_state(Arc::clone(&state));
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind principal API");
        let address = listener.local_addr().expect("principal API address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve principal API");
        });
        let client = PlaneClient {
            http: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("test client"),
            origin: validate_origin(&format!("http://{address}/")).expect("loopback origin"),
            workspace_slug: "a2d2".to_owned(),
            project_id: Uuid::from_u128(7),
            api_key: Arc::from("test-key"),
        };
        let principal = PrincipalEnsure {
            pubkey: pubkey.clone(),
            principal_key: plane_principal_key(community, &pubkey),
            role: "member".to_owned(),
        };
        let resolved = client
            .ensure_principals(community, std::slice::from_ref(&principal))
            .await
            .expect("ensure principal through production client");
        assert_eq!(resolved.get(&pubkey), Some(&user_id));
        assert_eq!(
            state.request.lock().await.as_ref(),
            Some(&json!({
                "community_id": community,
                "workspace_slug": "a2d2",
                "project_id": Uuid::from_u128(7),
                "principals": [{
                    "pubkey": pubkey,
                    "principal_key": principal.principal_key,
                    "role": "member"
                }]
            }))
        );

        *state.response.lock().await = json!({
            "principals": [
                {"pubkey": "22".repeat(32), "user_id": Uuid::from_u128(10)}
            ]
        });
        assert!(matches!(
            client
                .ensure_principals(community, std::slice::from_ref(&principal))
                .await,
            Err(PlaneProjectionError::InvalidResponse("principal ensure"))
        ));
        server.abort();
    }

    #[test]
    fn readback_accepts_only_plane_terminal_newline_normalization() {
        let state = Uuid::from_u128(1);
        let payload = PlaneWorkItemPayload {
            name: "Task",
            description_html: "<p>Body</p>\n",
            priority: "none",
            state,
            assignees: &[],
            external_id: "canonical-key",
            external_source: EXTERNAL_SOURCE,
        };
        let mut item = PlaneWorkItem {
            id: Uuid::from_u128(2),
            name: "Task".to_owned(),
            description_html: "<p>Body</p>".to_owned(),
            priority: "none".to_owned(),
            state: Some(state),
            assignees: Vec::new(),
            external_id: Some("canonical-key".to_owned()),
            external_source: Some(EXTERNAL_SOURCE.to_owned()),
        };
        assert!(matches_readback(&item, &payload));
        item.description_html = "<p>Body</p> ".to_owned();
        assert!(!matches_readback(&item, &payload));
        item.description_html = "<p>Different</p>".to_owned();
        assert!(!matches_readback(&item, &payload));
    }

    #[test]
    fn backoff_is_bounded() {
        assert_eq!(retry_delay(1), Duration::from_secs(2));
        assert_eq!(retry_delay(99), Duration::from_secs(256));
    }

    #[tokio::test]
    async fn production_client_creates_updates_and_reads_back_by_stable_external_id() {
        let state = Arc::new(MockPlaneState::default());
        let app = Router::new()
            .route(
                "/api/v1/workspaces/{slug}/projects/{project}/work-items/",
                get(list_item).post(create_item),
            )
            .route(
                "/api/v1/workspaces/{slug}/projects/{project}/work-items/{id}/",
                get(get_item).patch(patch_item),
            )
            .with_state(Arc::clone(&state));
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock Plane API");
        let address = listener.local_addr().expect("mock Plane address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve mock Plane API");
        });
        let client = PlaneClient {
            http: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("test client"),
            origin: validate_origin(&format!("http://{address}/")).expect("loopback origin"),
            workspace_slug: "a2d2".to_owned(),
            project_id: Uuid::nil(),
            api_key: Arc::from("test-key"),
        };
        let name = "Canonical task";
        let description = "<p>Canonical body</p>\n";
        let assignees = [Uuid::from_u128(8)];
        let external_id = format!("{}:{}:task-1", Uuid::nil(), "a".repeat(64));
        let payload = PlaneWorkItemPayload {
            name,
            description_html: description,
            priority: "high",
            state: Uuid::from_u128(7),
            assignees: &assignees,
            external_id: &external_id,
            external_source: EXTERNAL_SOURCE,
        };
        let first = sync_live_task(&client, &payload, None)
            .await
            .expect("create and read back");
        let second = sync_live_task(&client, &payload, Some(first))
            .await
            .expect("idempotent update and read back");
        assert_eq!(first, Uuid::from_u128(99));
        assert_eq!(second, first);
        assert_eq!(*state.creates.lock().await, 1);
        assert_eq!(*state.patches.lock().await, 2);
        server.abort();
    }

    #[tokio::test]
    #[ignore = "requires isolated Postgres and A2D2_TEST_PLANE_API_KEY=test-key"]
    async fn delayed_old_patch_is_quarantined_then_periodic_reconciliation_restores_latest() {
        assert_eq!(
            std::env::var("A2D2_TEST_PLANE_API_KEY").as_deref(),
            Ok("test-key"),
            "test credential must be injected by the isolated test command"
        );
        let state = Arc::new(DelayedPlaneState::default());
        let app = Router::new()
            .route(
                "/api/v1/workspaces/{slug}/projects/{project}/work-items/",
                get(delayed_list_item).post(delayed_create_item),
            )
            .route(
                "/api/v1/workspaces/{slug}/projects/{project}/work-items/{id}/",
                get(delayed_get_item).patch(delayed_patch_item),
            )
            .with_state(Arc::clone(&state));
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind delayed Plane API");
        let address = listener.local_addr().expect("delayed Plane address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve delayed Plane API");
        });

        let (admin, pool, name) = scratch_database("plane_late_patch").await;
        let db = Db::from_pool(pool.clone());
        let community = CommunityId::from_uuid(Uuid::new_v4());
        sqlx::query("INSERT INTO communities (id,host) VALUES ($1,$2)")
            .bind(community.as_uuid())
            .bind(format!(
                "late-patch-{}.example",
                community.as_uuid().simple()
            ))
            .execute(&pool)
            .await
            .expect("insert test community");
        let config = PlaneProjectionBindingConfig {
            origin: format!("http://{address}/"),
            workspace_slug: "a2d2".to_owned(),
            project_id: Uuid::new_v4(),
            api_key_env: "A2D2_TEST_PLANE_API_KEY".to_owned(),
            state_map: PlaneStateMap {
                todo: Uuid::new_v4(),
                doing: Uuid::new_v4(),
                done: Uuid::new_v4(),
            },
            enabled: true,
        };
        let (binding, queued) = db
            .configure_plane_projection(community, &config)
            .await
            .expect("configure production binding seam");
        assert_eq!(queued, 0);

        let keys = Keys::generate();
        let d_tag = format!("community-task:{}", Uuid::new_v4());
        let now = Timestamp::now().as_secs();
        let first = signed_task(&keys, &d_tag, "Generation one", "old body", now, now);
        assert!(
            db.replace_parameterized_event(community, &first, &d_tag, None)
                .await
                .expect("persist generation one")
                .1
        );
        assert_eq!(
            run_plane_projection_batch_with_policy(
                &db,
                Duration::from_millis(1_000),
                Duration::from_millis(500),
                false,
            )
            .await,
            1
        );
        tokio::time::timeout(Duration::from_secs(1), state.first_patch_started.notified())
            .await
            .expect("first delayed patch reached Plane");
        let quarantined: (i64, i64, bool, Option<String>) = sqlx::query_as(
            "SELECT desired_generation,applied_generation,lease_token IS NOT NULL,last_error \
             FROM engine_projection_heads WHERE community_id=$1 AND binding_id=$2",
        )
        .bind(community.as_uuid())
        .bind(binding)
        .fetch_one(&pool)
        .await
        .expect("read quarantined generation");
        assert_eq!(quarantined.0, 1);
        assert_eq!(quarantined.1, 0);
        assert!(quarantined.2);
        assert!(quarantined.3.is_some());

        let second = signed_task(&keys, &d_tag, "Generation two", "new body", now, now + 1);
        assert!(
            db.replace_parameterized_event(community, &second, &d_tag, None)
                .await
                .expect("persist generation two while old write is uncertain")
                .1
        );
        assert_eq!(
            run_plane_projection_batch_with_policy(
                &db,
                Duration::from_millis(1_000),
                Duration::from_millis(500),
                false,
            )
            .await,
            0,
            "the old request's lease prevents an immediate conflicting write"
        );
        tokio::time::sleep(Duration::from_millis(1_050)).await;
        assert_eq!(
            run_plane_projection_batch_with_policy(
                &db,
                Duration::from_millis(1_000),
                Duration::from_millis(700),
                false,
            )
            .await,
            1
        );
        assert_eq!(
            state
                .item
                .lock()
                .await
                .as_ref()
                .and_then(|item| item["name"].as_str()),
            Some("Generation two")
        );
        assert_eq!(
            run_plane_projection_batch_with_policy(
                &db,
                Duration::from_millis(1_000),
                Duration::from_millis(700),
                false,
            )
            .await,
            0,
            "successful completion schedules reconciliation instead of hot-looping"
        );

        state.release_first_patch.notify_one();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if state
                    .item
                    .lock()
                    .await
                    .as_ref()
                    .and_then(|item| item["name"].as_str())
                    == Some("Generation one")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("late generation one patch reaches provider after generation two");

        sqlx::query(
            "UPDATE engine_projection_heads SET next_attempt_at=now() \
             WHERE community_id=$1 AND binding_id=$2",
        )
        .bind(community.as_uuid())
        .bind(binding)
        .execute(&pool)
        .await
        .expect("make periodic reconciliation due");
        assert_eq!(
            run_plane_projection_batch_with_policy(
                &db,
                Duration::from_millis(1_000),
                Duration::from_millis(700),
                false,
            )
            .await,
            1
        );
        let final_item = state.item.lock().await.clone().expect("final Plane item");
        assert_eq!(final_item["name"], json!("Generation two"));
        assert!(final_item["description_html"]
            .as_str()
            .is_some_and(|value| value.contains("new body")));
        assert_eq!(state.creates.load(Ordering::SeqCst), 1);
        assert_eq!(state.patches.load(Ordering::SeqCst), 3);
        let journal: (i64, i64, Vec<u8>) = sqlx::query_as(
            "SELECT desired_generation,applied_generation,applied_event_id \
             FROM engine_projection_heads WHERE community_id=$1 AND binding_id=$2",
        )
        .bind(community.as_uuid())
        .bind(binding)
        .fetch_one(&pool)
        .await
        .expect("read reconciled journal");
        assert_eq!(journal.0, 2);
        assert_eq!(journal.1, 2);
        assert_eq!(journal.2, second.id.as_bytes());

        server.abort();
        drop(db);
        drop_scratch_database(admin, pool, name).await;
    }

    #[tokio::test]
    #[ignore = "requires isolated Postgres and A2D2_TEST_PLANE_API_KEY=test-key"]
    async fn lost_create_response_never_reposts_during_replica_lookup_lag() {
        assert_eq!(
            std::env::var("A2D2_TEST_PLANE_API_KEY").as_deref(),
            Ok("test-key")
        );
        let state = Arc::new(LostCreateState::default());
        let app = Router::new()
            .route(
                "/api/v1/workspaces/{slug}/projects/{project}/work-items/",
                get(lost_create_list_item).post(lost_create_item),
            )
            .route(
                "/api/v1/workspaces/{slug}/projects/{project}/work-items/{id}/",
                get(lost_create_get_item).patch(lost_create_patch_item),
            )
            .with_state(Arc::clone(&state));
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind lost-response Plane API");
        let address = listener.local_addr().expect("lost-response address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("serve lost-response Plane API");
        });

        let (admin, pool, name) = scratch_database("plane_lost_create").await;
        let db = Db::from_pool(pool.clone());
        let community = CommunityId::from_uuid(Uuid::new_v4());
        sqlx::query("INSERT INTO communities (id,host) VALUES ($1,$2)")
            .bind(community.as_uuid())
            .bind(format!(
                "lost-create-{}.example",
                community.as_uuid().simple()
            ))
            .execute(&pool)
            .await
            .expect("insert test community");
        let config = PlaneProjectionBindingConfig {
            origin: format!("http://{address}/"),
            workspace_slug: "a2d2".to_owned(),
            project_id: Uuid::new_v4(),
            api_key_env: "A2D2_TEST_PLANE_API_KEY".to_owned(),
            state_map: PlaneStateMap {
                todo: Uuid::new_v4(),
                doing: Uuid::new_v4(),
                done: Uuid::new_v4(),
            },
            enabled: true,
        };
        let (binding, _) = db
            .configure_plane_projection(community, &config)
            .await
            .expect("configure production binding seam");
        let keys = Keys::generate();
        let d_tag = format!("community-task:{}", Uuid::new_v4());
        let now = Timestamp::now().as_secs();
        let event = signed_task(&keys, &d_tag, "Create once", "canonical body", now, now);
        assert!(
            db.replace_parameterized_event(community, &event, &d_tag, None)
                .await
                .expect("persist canonical task")
                .1
        );

        assert_eq!(
            run_plane_projection_batch_with_policy(
                &db,
                Duration::from_millis(1_000),
                Duration::from_millis(500),
                false,
            )
            .await,
            1
        );
        assert_eq!(state.creates.load(Ordering::SeqCst), 1);
        let uncertain: (String, bool) = sqlx::query_as(
            "SELECT create_state,lease_token IS NOT NULL FROM engine_projection_heads \
             WHERE community_id=$1 AND binding_id=$2",
        )
        .bind(community.as_uuid())
        .bind(binding)
        .fetch_one(&pool)
        .await
        .expect("read uncertain create state");
        assert_eq!(uncertain, ("uncertain".to_owned(), true));

        tokio::time::sleep(Duration::from_millis(1_050)).await;
        assert_eq!(
            run_plane_projection_batch_with_policy(
                &db,
                Duration::from_millis(1_000),
                Duration::from_millis(700),
                false,
            )
            .await,
            1,
            "lookup lag is recorded without another POST"
        );
        assert_eq!(state.creates.load(Ordering::SeqCst), 1);
        let after_lag: (String, i64, Option<String>) = sqlx::query_as(
            "SELECT create_state,applied_generation,last_error FROM engine_projection_heads \
             WHERE community_id=$1 AND binding_id=$2",
        )
        .bind(community.as_uuid())
        .bind(binding)
        .fetch_one(&pool)
        .await
        .expect("read durable ambiguous create error");
        assert_eq!(after_lag.0, "uncertain");
        assert_eq!(after_lag.1, 0);
        assert!(after_lag.2.is_some());

        sqlx::query(
            "UPDATE engine_projection_heads SET next_attempt_at=now() \
             WHERE community_id=$1 AND binding_id=$2",
        )
        .bind(community.as_uuid())
        .bind(binding)
        .execute(&pool)
        .await
        .expect("make lookup reconciliation due");
        assert_eq!(
            run_plane_projection_batch_with_policy(
                &db,
                Duration::from_millis(1_000),
                Duration::from_millis(700),
                false,
            )
            .await,
            1
        );
        assert_eq!(state.creates.load(Ordering::SeqCst), 1);
        let complete: (String, i64, i64, Option<Uuid>) = sqlx::query_as(
            "SELECT create_state,desired_generation,applied_generation,engine_entity_id \
             FROM engine_projection_heads WHERE community_id=$1 AND binding_id=$2",
        )
        .bind(community.as_uuid())
        .bind(binding)
        .fetch_one(&pool)
        .await
        .expect("read recovered create state");
        assert_eq!(complete.0, "safe");
        assert_eq!(complete.1, 1);
        assert_eq!(complete.2, 1);
        assert_eq!(complete.3, Some(Uuid::from_u128(299)));

        server.abort();
        drop(db);
        drop_scratch_database(admin, pool, name).await;
    }

    #[tokio::test]
    #[ignore = "requires isolated Postgres and an explicitly configured Plane QA engine"]
    async fn signed_task_persists_before_actual_plane_projection_and_readback() {
        fn required(name: &str) -> String {
            std::env::var(name).unwrap_or_else(|_| panic!("{name} must be configured"))
        }

        let pool = PgPool::connect(&required("DATABASE_URL"))
            .await
            .expect("connect isolated projection database");
        let db = Db::from_pool(pool.clone());
        let preconfigured_community = std::env::var("A2D2_TEST_PRECONFIGURED_COMMUNITY")
            .ok()
            .map(|value| value.parse::<Uuid>().expect("preconfigured community UUID"));
        let community_uuid = preconfigured_community.unwrap_or_else(Uuid::new_v4);
        let workspace_slug = required("A2D2_TEST_PLANE_WORKSPACE");
        let project_id = required("A2D2_TEST_PLANE_PROJECT_ID")
            .parse::<Uuid>()
            .expect("Plane project UUID");
        let state_map = PlaneStateMap {
            todo: required("A2D2_TEST_PLANE_TODO_STATE")
                .parse()
                .expect("Plane todo state UUID"),
            doing: required("A2D2_TEST_PLANE_DOING_STATE")
                .parse()
                .expect("Plane doing state UUID"),
            done: required("A2D2_TEST_PLANE_DONE_STATE")
                .parse()
                .expect("Plane done state UUID"),
        };
        let community = CommunityId::from_uuid(community_uuid);
        let binding_id: Uuid = if preconfigured_community.is_some() {
            sqlx::query_scalar(
                "SELECT id FROM engine_projection_bindings \
                 WHERE community_id=$1 AND provider='plane' AND enabled",
            )
            .bind(community_uuid)
            .fetch_one(&pool)
            .await
            .expect("buzz-admin configured Plane binding")
        } else {
            sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
                .bind(community_uuid)
                .bind(format!("plane-projection-{}.test", community_uuid.simple()))
                .execute(&pool)
                .await
                .expect("insert isolated community");
            db.configure_plane_projection(
                community,
                &PlaneProjectionBindingConfig {
                    origin: required("A2D2_TEST_PLANE_ORIGIN"),
                    workspace_slug: workspace_slug.clone(),
                    project_id,
                    api_key_env: "A2D2_TEST_PLANE_API_KEY".to_owned(),
                    state_map: state_map.clone(),
                    enabled: true,
                },
            )
            .await
            .expect("configure isolated Plane binding")
            .0
        };

        let keys = Keys::generate();
        let task_id = Uuid::new_v4();
        let d_tag = format!("community-task:{task_id}");
        let marker = task_id.simple().to_string();
        let title = format!("A2D2 engine projection {marker}");
        let now = Timestamp::now().as_secs();
        let content = json!({
            "author": keys.public_key().to_hex(),
            "title": title,
            "body": "Canonical **body** <script>not-html</script>",
            "status": "doing",
            "assignees": [],
            "customFields": [{
                "id": "priority",
                "name": "Priority",
                "type": "text",
                "value": "high"
            }],
            "order": 1,
            "createdAt": now,
            "updatedAt": now
        });
        let event = EventBuilder::new(Kind::Custom(30_078), content.to_string())
            .tags([Tag::custom(nostr::TagKind::d(), [d_tag.clone()])])
            .custom_created_at(Timestamp::from(now))
            .sign_with_keys(&keys)
            .expect("sign canonical task");
        assert!(
            db.replace_parameterized_event(community, &event, &d_tag, None)
                .await
                .expect("persist signed canonical task")
                .1
        );
        let before: (i64, i64, Vec<u8>) = sqlx::query_as(
            "SELECT desired_generation, applied_generation, desired_event_id \
             FROM engine_projection_heads WHERE binding_id=$1",
        )
        .bind(binding_id)
        .fetch_one(&pool)
        .await
        .expect("canonical write also persists projection intent");
        assert_eq!(before.0, 1);
        assert_eq!(before.1, 0);
        assert_eq!(before.2, event.id.as_bytes());

        assert_eq!(run_plane_projection_batch(&db).await, 1);
        let after: (i64, i64, Option<Uuid>, Option<String>, Option<Vec<u8>>) = sqlx::query_as(
            "SELECT desired_generation, applied_generation, engine_entity_id, last_error, \
                    applied_event_id \
             FROM engine_projection_heads WHERE binding_id=$1",
        )
        .bind(binding_id)
        .fetch_one(&pool)
        .await
        .expect("read completed projection journal");
        assert_eq!(after.0, 1, "desired generation");
        assert_eq!(after.1, 1, "projection failed: {:?}", after.3);
        assert_eq!(after.3, None);
        assert_eq!(after.4.as_deref(), Some(event.id.as_bytes().as_slice()));
        let engine_id = after.2.expect("Plane entity mapping");

        let claim = ClaimedEngineProjection {
            binding: EngineProjectionBinding {
                id: binding_id,
                community,
                origin: required("A2D2_TEST_PLANE_ORIGIN"),
                workspace_slug,
                project_id,
                api_key_env: "A2D2_TEST_PLANE_API_KEY".to_owned(),
                state_map,
            },
            entity_key: format!(
                "{}:{}:{task_id}",
                community.as_uuid(),
                keys.public_key().to_hex()
            ),
            task_d_tag: d_tag,
            author_pubkey: keys.public_key().to_bytes().to_vec(),
            desired_event_id: event.id.as_bytes().to_vec(),
            generation: 1,
            lease_token: Uuid::nil(),
            engine_entity_id: Some(engine_id),
            create_uncertain: false,
            attempt: 1,
        };
        let client = PlaneClient::new(&claim).expect("configured Plane client");
        let Lookup::Found(readback) = client.get(engine_id).await.expect("actual Plane readback")
        else {
            panic!("projected Plane item is missing");
        };
        assert_eq!(readback.name, title);
        assert_eq!(readback.priority, "high");
        assert_eq!(readback.state, Some(claim.binding.state_map.doing));
        assert!(readback.assignees.is_empty());
        assert_eq!(
            readback.external_id.as_deref(),
            Some(claim.entity_key.as_str())
        );
        assert_eq!(readback.external_source.as_deref(), Some(EXTERNAL_SOURCE));
        assert!(readback.description_html.contains("<strong>body</strong>"));
        assert!(readback.description_html.contains("&lt;script&gt;"));
        assert!(!readback.description_html.contains("<script>"));

        let revised_title = format!("{title} revised");
        let revised_content = json!({
            "author": keys.public_key().to_hex(),
            "title": revised_title,
            "body": "Canonical **revised body**",
            "status": "done",
            "assignees": [],
            "customFields": [{
                "id": "priority",
                "name": "Priority",
                "type": "text",
                "value": "urgent"
            }],
            "order": 1,
            "createdAt": now,
            "updatedAt": now + 1
        });
        let revised_event = EventBuilder::new(Kind::Custom(30_078), revised_content.to_string())
            .tags([Tag::custom(nostr::TagKind::d(), [claim.task_d_tag.clone()])])
            .custom_created_at(Timestamp::from(now + 1))
            .sign_with_keys(&keys)
            .expect("sign revised canonical task");
        assert!(
            db.replace_parameterized_event(community, &revised_event, &claim.task_d_tag, None,)
                .await
                .expect("persist revised canonical task")
                .1
        );
        let pending_update: (i64, i64, Option<Uuid>) = sqlx::query_as(
            "SELECT desired_generation, applied_generation, engine_entity_id \
             FROM engine_projection_heads WHERE binding_id=$1",
        )
        .bind(binding_id)
        .fetch_one(&pool)
        .await
        .expect("read pending second generation");
        assert_eq!(pending_update, (2, 1, Some(engine_id)));
        assert_eq!(run_plane_projection_batch(&db).await, 1);
        let completed_update: (i64, i64, Option<Uuid>, Option<String>, Option<Vec<u8>>) =
            sqlx::query_as(
                "SELECT desired_generation, applied_generation, engine_entity_id, last_error, \
                        applied_event_id \
                 FROM engine_projection_heads WHERE binding_id=$1",
            )
            .bind(binding_id)
            .fetch_one(&pool)
            .await
            .expect("read completed second generation");
        assert_eq!(completed_update.0, 2);
        assert_eq!(
            completed_update.1, 2,
            "projection update failed: {:?}",
            completed_update.3
        );
        assert_eq!(completed_update.2, Some(engine_id));
        assert_eq!(completed_update.3, None);
        assert_eq!(
            completed_update.4.as_deref(),
            Some(revised_event.id.as_bytes().as_slice())
        );
        let Lookup::Found(revised_readback) = client
            .get(engine_id)
            .await
            .expect("actual Plane update readback")
        else {
            panic!("updated Plane item is missing");
        };
        assert_eq!(revised_readback.name, revised_title);
        assert_eq!(revised_readback.priority, "urgent");
        assert_eq!(revised_readback.state, Some(claim.binding.state_map.done));
        assert!(revised_readback.assignees.is_empty());
        assert_eq!(
            revised_readback.external_id.as_deref(),
            Some(claim.entity_key.as_str())
        );

        let title_hash = hex::encode(Sha256::digest(revised_readback.name.as_bytes()));
        println!(
            "actual_plane_projection first_event_id={} revised_event_id={} engine_id={} \
             generation=2 status=done title_sha256={title_hash}",
            event.id, revised_event.id, engine_id
        );
    }
}
