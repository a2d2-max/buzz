use serde::{de::Error as _, Deserialize, Deserializer, Serialize};

use super::client::OpsBridgeError;

/// Version implemented by the native Ops bridge and its loopback hub contract.
pub const OPS_CONTRACT_VERSION: u8 = 1;

/// Default loopback port for the Ops hub.
pub const DEFAULT_HUB_PORT: u16 = 7331;

/// Maximum accepted JSON response size from the Ops hub.
pub const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

const MAX_ID_BYTES: usize = 256;
const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_IDEMPOTENCY_KEY_BYTES: usize = 128;
pub(crate) const MAX_SAFE_INTEGER_U64: u64 = 9_007_199_254_740_991;

pub(crate) trait VersionedResponse {
    fn contract_version(&self) -> u8;
}

/// Read capability advertised by the version 1 Ops hub.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpsReadCapability {
    Snapshot,
    Events,
    Artifact,
}

/// Draft capability advertised by the version 1 Ops hub.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpsDraftCapability {
    Message,
    InternalTask,
    ProviderAction,
}

/// Approval transition advertised and accepted by the version 1 Ops hub.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpsTransitionAction {
    Submit,
    Approve,
    RiskConfirm,
    Deliver,
    Reject,
}

/// Versioned optional module advertised by the Ops hub.
///
/// The module name remains a public contract string so a version-one hub can
/// advertise a future optional module without making the native bridge reject
/// the entire response. The renderer validates modules it understands.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OpsModuleCapability {
    pub name: String,
    pub schema_version: u64,
    pub paged: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection_revision: Option<u64>,
}

/// Strict version 1 capability response returned to the webview.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OpsBridgeCapabilities {
    pub contract_version: u8,
    pub reads: Vec<OpsReadCapability>,
    pub drafts: Vec<OpsDraftCapability>,
    pub transitions: Vec<OpsTransitionAction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modules: Option<Vec<OpsModuleCapability>>,
}

impl VersionedResponse for OpsBridgeCapabilities {
    fn contract_version(&self) -> u8 {
        self.contract_version
    }
}

impl OpsBridgeCapabilities {
    pub(crate) fn validate(&self) -> Result<(), OpsBridgeError> {
        if let Some(modules) = &self.modules {
            let mut names = std::collections::HashSet::with_capacity(modules.len());
            for module in modules {
                valid_value(&module.name, MAX_ID_BYTES)
                    .map_err(|_| OpsBridgeError::ContractMismatch)?;
                if (module.paged && module.collection_revision.is_none())
                    || module
                        .collection_revision
                        .is_some_and(|revision| revision > MAX_SAFE_INTEGER_U64)
                    || !names.insert(module.name.as_str())
                {
                    return Err(OpsBridgeError::ContractMismatch);
                }
            }
        }
        Ok(())
    }
}

/// Optional snapshot selection. Only these three query fields can reach the hub.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OpsSelection {
    pub channel: Option<String>,
    pub thread: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpsPageModule {
    Timeline,
    Artifacts,
    Research,
    Repositories,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpsTimelineSort {
    OccurredAtDesc,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpsCreatedAtSort {
    CreatedAtDesc,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpsRepositorySort {
    DisplayNameAsc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpsArtifactRepresentation {
    Rendered,
    Preview,
}

impl OpsArtifactRepresentation {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Rendered => "rendered",
            Self::Preview => "preview",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OpsArtifactReadRequest {
    pub artifact_id: String,
    pub version: u64,
    pub representation: OpsArtifactRepresentation,
}

impl OpsArtifactReadRequest {
    pub(crate) fn validate(&self) -> Result<(), OpsBridgeError> {
        if self.version == 0
            || self.version > MAX_SAFE_INTEGER_U64
            || !is_public_artifact_id(&self.artifact_id)
        {
            return Err(OpsBridgeError::InvalidRequest);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OpsArtifactHandleReadRequest {
    pub handle: String,
    pub offset: u64,
    pub length: u32,
}

impl OpsArtifactHandleReadRequest {
    pub(crate) fn validate(&self) -> Result<(), OpsBridgeError> {
        if !is_artifact_handle(&self.handle)
            || self.offset > MAX_SAFE_INTEGER_U64
            || !(1..=256 * 1024).contains(&self.length)
        {
            return Err(OpsBridgeError::InvalidRequest);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OpsArtifactHandleReleaseRequest {
    pub handle: String,
}

impl OpsArtifactHandleReleaseRequest {
    pub(crate) fn validate(&self) -> Result<(), OpsBridgeError> {
        if !is_artifact_handle(&self.handle) {
            return Err(OpsBridgeError::InvalidRequest);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpsArtifactProvenance {
    pub classifier: OpsArtifactClassifier,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OpsArtifactClassifier {
    HubGuestSafeV1,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpsArtifactManifestV1 {
    pub contract_version: u8,
    pub artifact_id: String,
    pub version: u64,
    pub representation: OpsArtifactRepresentation,
    pub total_size: u64,
    pub sha256: String,
    pub mime: String,
    pub visibility: String,
    pub guest_readable: bool,
    pub provenance: OpsArtifactProvenance,
    pub created_at: String,
}

impl VersionedResponse for OpsArtifactManifestV1 {
    fn contract_version(&self) -> u8 {
        self.contract_version
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpsArtifactChunkV1 {
    pub contract_version: u8,
    pub artifact_id: String,
    pub version: u64,
    pub representation: OpsArtifactRepresentation,
    pub offset: u64,
    pub next_offset: u64,
    pub total_size: u64,
    pub sha256: String,
    pub mime: String,
    pub data_base64: String,
    pub eof: bool,
}

impl VersionedResponse for OpsArtifactChunkV1 {
    fn contract_version(&self) -> u8 {
        self.contract_version
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OpsArtifactReadResult {
    InlineText {
        contract_version: u8,
        artifact_id: String,
        version: u64,
        representation: OpsArtifactRepresentation,
        mime: String,
        total_size: u64,
        sha256: String,
        text: String,
    },
    OpaqueHandle {
        contract_version: u8,
        artifact_id: String,
        version: u64,
        representation: OpsArtifactRepresentation,
        mime: String,
        total_size: u64,
        sha256: String,
        handle: String,
        expires_at: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OpsArtifactHandleChunk {
    pub contract_version: u8,
    pub handle: String,
    pub mime: String,
    pub offset: u64,
    pub next_offset: u64,
    pub total_size: u64,
    pub data_base64: String,
    pub eof: bool,
}

impl OpsArtifactHandleChunk {
    #[cfg(test)]
    pub(crate) fn data_base64(&self) -> &str {
        &self.data_base64
    }
    #[cfg(test)]
    pub(crate) fn eof(&self) -> bool {
        self.eof
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct OpsArtifactHandleReleaseResult {
    pub released: bool,
}

pub(crate) fn is_public_artifact_id(value: &str) -> bool {
    value.len() == 41
        && value.starts_with("artifact:")
        && value[9..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(crate) fn is_artifact_handle(value: &str) -> bool {
    let Some(uuid) = value.strip_prefix("artifact-handle:") else {
        return false;
    };
    uuid::Uuid::parse_str(uuid)
        .is_ok_and(|parsed| parsed.get_version_num() == 4 && parsed.to_string() == uuid)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OpsTimelineScope {
    #[serde(deserialize_with = "deserialize_required_option")]
    pub channel: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub thread: Option<String>,
    pub sort: OpsTimelineSort,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OpsArtifactScope {
    #[serde(deserialize_with = "deserialize_required_option")]
    pub work_item: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub representation: Option<OpsArtifactRepresentation>,
    pub sort: OpsCreatedAtSort,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OpsResearchScope {
    #[serde(deserialize_with = "deserialize_required_option")]
    pub work_item: Option<String>,
    pub sort: OpsCreatedAtSort,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OpsRepositoryScope {
    #[serde(deserialize_with = "deserialize_required_option")]
    pub project: Option<String>,
    pub sort: OpsRepositorySort,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "module", rename_all = "snake_case", deny_unknown_fields)]
pub enum OpsPageRequest {
    Timeline {
        scope: OpsTimelineScope,
        page_size: u16,
        #[serde(deserialize_with = "deserialize_required_option")]
        cursor: Option<String>,
    },
    Artifacts {
        scope: OpsArtifactScope,
        page_size: u16,
        #[serde(deserialize_with = "deserialize_required_option")]
        cursor: Option<String>,
    },
    Research {
        scope: OpsResearchScope,
        page_size: u16,
        #[serde(deserialize_with = "deserialize_required_option")]
        cursor: Option<String>,
    },
    Repositories {
        scope: OpsRepositoryScope,
        page_size: u16,
        #[serde(deserialize_with = "deserialize_required_option")]
        cursor: Option<String>,
    },
}

impl OpsPageRequest {
    pub(crate) fn module(&self) -> OpsPageModule {
        match self {
            Self::Timeline { .. } => OpsPageModule::Timeline,
            Self::Artifacts { .. } => OpsPageModule::Artifacts,
            Self::Research { .. } => OpsPageModule::Research,
            Self::Repositories { .. } => OpsPageModule::Repositories,
        }
    }

    pub(crate) fn page_size(&self) -> u16 {
        match self {
            Self::Timeline { page_size, .. }
            | Self::Artifacts { page_size, .. }
            | Self::Research { page_size, .. }
            | Self::Repositories { page_size, .. } => *page_size,
        }
    }

    pub(crate) fn cursor(&self) -> Option<&str> {
        match self {
            Self::Timeline { cursor, .. }
            | Self::Artifacts { cursor, .. }
            | Self::Research { cursor, .. }
            | Self::Repositories { cursor, .. } => cursor.as_deref(),
        }
    }

    pub(crate) fn validate(&self) -> Result<(), OpsBridgeError> {
        if !(1..=200).contains(&self.page_size()) {
            return Err(OpsBridgeError::InvalidRequest);
        }
        valid_optional_value(self.cursor(), 4096).map_err(|_| OpsBridgeError::InvalidRequest)?;
        match self {
            Self::Timeline { scope, .. } => {
                valid_optional_value(scope.channel.as_deref(), MAX_ID_BYTES)
                    .and_then(|_| valid_optional_value(scope.thread.as_deref(), MAX_ID_BYTES))
            }
            Self::Artifacts { scope, .. } => {
                valid_optional_value(scope.work_item.as_deref(), MAX_ID_BYTES)
            }
            Self::Research { scope, .. } => {
                valid_optional_value(scope.work_item.as_deref(), MAX_ID_BYTES)
            }
            Self::Repositories { scope, .. } => {
                valid_optional_value(scope.project.as_deref(), MAX_ID_BYTES)
            }
        }
        .map_err(|_| OpsBridgeError::InvalidRequest)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OpsPageV1<T> {
    pub contract_version: u8,
    pub revision: u64,
    pub generated_at: String,
    pub items: Vec<T>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub next_cursor: Option<String>,
}

impl<T> VersionedResponse for OpsPageV1<T> {
    fn contract_version(&self) -> u8 {
        self.contract_version
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OpsTimelineItemV1 {
    pub id: String,
    pub timestamp: String,
    pub kind: String,
    pub author: String,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OpsArtifactV1 {
    pub id: String,
    pub work_item_id: String,
    pub title: String,
    pub kind: String,
    pub status: String,
    pub version: u64,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub source_event_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OpsResearchCardV1 {
    pub id: String,
    pub title: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OpsRepositoryStatusV1 {
    pub id: String,
    pub name: String,
    pub branch: String,
    pub clean: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ahead: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behind: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum OpsPageResult {
    Timeline(OpsPageV1<OpsTimelineItemV1>),
    Artifacts(OpsPageV1<OpsArtifactV1>),
    Research(OpsPageV1<OpsResearchCardV1>),
    Repositories(OpsPageV1<OpsRepositoryStatusV1>),
}

/// Hub health in the public snapshot contract.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpsHubHealth {
    Ready,
    Degraded,
}

/// Per-source health projected by the Ops hub.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OpsHealth {
    pub hub: OpsHubHealth,
    pub orca: String,
    pub codex: String,
}

/// Canonical source for one Ops session node.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpsSessionSource {
    Orca,
    CodexDirect,
    CodexSub,
    ClaudeCode,
}

/// Public session lineage node from the version 1 snapshot.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OpsSessionNode {
    pub id: String,
    pub source: OpsSessionSource,
    pub parent_session_id: Option<String>,
    pub work_item_id: Option<String>,
    pub title: String,
    pub activity: Option<String>,
    pub health: String,
    pub last_activity_at: Option<String>,
    pub child_ids: Vec<String>,
}

/// Strict top-level version 1 snapshot returned to the webview.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OpsBridgeSnapshot {
    pub contract_version: u8,
    pub revision: u64,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_event_sequence",
        skip_serializing_if = "Option::is_none"
    )]
    pub event_sequence: Option<String>,
    pub generated_at: String,
    pub health: OpsHealth,
    pub room: serde_json::Value,
    pub session_tree: Vec<OpsSessionNode>,
    pub checklist: Vec<serde_json::Value>,
    pub decisions: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeline: Option<Vec<serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals: Option<Vec<serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<Vec<serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connections: Option<Vec<serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_routing: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub research: Option<Vec<serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repositories: Option<Vec<serde_json::Value>>,
}

impl VersionedResponse for OpsBridgeSnapshot {
    fn contract_version(&self) -> u8 {
        self.contract_version
    }
}

/// Provider accepted by an internal-task draft. It does not execute a provider.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpsDraftProvider {
    ClaudeCode,
    Codex,
}

/// Provider operation represented by a draft. It is not an execution command.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpsProviderDraftAction {
    Run,
    Retry,
    Interrupt,
}

/// Typed draft request accepted from the webview.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum OpsDraftRequest {
    Message {
        work_item_id: String,
        target_session_id: String,
        text: String,
    },
    InternalTask {
        title: String,
        spec: String,
        provider: OpsDraftProvider,
        model: String,
        effort: String,
        idempotency_key: String,
    },
    ProviderAction {
        action: OpsProviderDraftAction,
        work_item_id: String,
        provider_run_id: Option<String>,
        dispatch_id: Option<String>,
    },
}

impl OpsDraftRequest {
    pub(crate) fn validate(&self) -> Result<(), ()> {
        match self {
            Self::Message {
                work_item_id,
                target_session_id,
                text,
            } => {
                valid_value(work_item_id, MAX_ID_BYTES)?;
                valid_value(target_session_id, MAX_ID_BYTES)?;
                valid_value(text, MAX_TEXT_BYTES)
            }
            Self::InternalTask {
                title,
                spec,
                model,
                effort,
                idempotency_key,
                ..
            } => {
                valid_value(title, 512)?;
                valid_value(spec, MAX_TEXT_BYTES)?;
                valid_value(model, 256)?;
                valid_value(effort, 64)?;
                valid_idempotency_key(idempotency_key)
            }
            Self::ProviderAction {
                work_item_id,
                provider_run_id,
                dispatch_id,
                ..
            } => {
                valid_value(work_item_id, MAX_ID_BYTES)?;
                valid_optional_value(provider_run_id.as_deref(), MAX_ID_BYTES)?;
                valid_optional_value(dispatch_id.as_deref(), MAX_ID_BYTES)
            }
        }
    }

    pub(crate) fn idempotency_key(&self) -> Option<&str> {
        match self {
            Self::InternalTask {
                idempotency_key, ..
            } => Some(idempotency_key),
            _ => None,
        }
    }
}

/// Only visual controls may request approval transitions through this bridge.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpsTransitionOrigin {
    VisualControl,
}

/// Typed approval transition request accepted from the webview.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpsTransitionRequest {
    pub approval_id: String,
    pub action: OpsTransitionAction,
    pub expected_revision: u64,
    pub origin: OpsTransitionOrigin,
    pub targets: Option<Vec<String>>,
}

impl OpsTransitionRequest {
    pub(crate) fn validate_initial_profile(&self) -> Result<(), OpsBridgeError> {
        if matches!(self.action, OpsTransitionAction::Deliver) {
            return Err(OpsBridgeError::ExternalActionDisabled);
        }
        self.validate().map_err(|_| OpsBridgeError::InvalidRequest)
    }

    pub(crate) fn validate(&self) -> Result<(), ()> {
        if !valid_path_id(&self.approval_id) {
            return Err(());
        }
        match (&self.action, &self.targets) {
            (OpsTransitionAction::RiskConfirm, Some(targets)) if !targets.is_empty() => {
                for target in targets {
                    valid_value(target, 1024)?;
                }
                Ok(())
            }
            (OpsTransitionAction::RiskConfirm, _) => Err(()),
            (_, None) => Ok(()),
            (_, Some(_)) => Err(()),
        }
    }
}

#[derive(Serialize)]
pub(crate) struct OpsTransitionWireRequest<'a> {
    pub action: &'a OpsTransitionAction,
    pub expected_revision: u64,
    pub origin: &'a OpsTransitionOrigin,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub targets: Option<&'a [String]>,
}

impl<'a> From<&'a OpsTransitionRequest> for OpsTransitionWireRequest<'a> {
    fn from(request: &'a OpsTransitionRequest) -> Self {
        Self {
            action: &request.action,
            expected_revision: request.expected_revision,
            origin: &request.origin,
            targets: request.targets.as_deref(),
        }
    }
}

/// Versioned receipt for a draft-only mutation.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OpsDraftReceipt {
    pub contract_version: u8,
    pub approval: serde_json::Value,
}

impl VersionedResponse for OpsDraftReceipt {
    fn contract_version(&self) -> u8 {
        self.contract_version
    }
}

/// Versioned receipt for a visual approval transition.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OpsTransitionReceipt {
    pub contract_version: u8,
    pub approval: serde_json::Value,
}

impl VersionedResponse for OpsTransitionReceipt {
    fn contract_version(&self) -> u8 {
        self.contract_version
    }
}

/// Result of the idempotent watcher start command.
#[derive(Debug, Clone, Serialize)]
pub struct OpsWatchStartResult {
    pub started: bool,
    pub connection_generation: u64,
    pub sync_required: bool,
    pub anchor_sequence: Option<String>,
}

/// Generation-bound acknowledgement sent only after a canonical refetch.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpsSyncAckRequest {
    pub generation: u64,
    #[serde(deserialize_with = "deserialize_event_sequence")]
    pub applied_sequence: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpsSyncAckResult {
    pub accepted: bool,
    pub connection_generation: u64,
}

pub(crate) fn parse_event_sequence(value: &str) -> Result<u64, ()> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(());
    }
    value.parse::<u64>().map_err(|_| ())
}

fn deserialize_event_sequence<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    parse_event_sequence(&value)
        .map(|_| value)
        .map_err(|_| D::Error::custom("invalid decimal event sequence"))
}

fn deserialize_optional_event_sequence<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_event_sequence(deserializer).map(Some)
}

fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

fn valid_value(value: &str, max_bytes: usize) -> Result<(), ()> {
    if value.trim().is_empty() || value.len() > max_bytes || value.chars().any(char::is_control) {
        return Err(());
    }
    Ok(())
}

fn valid_optional_value(value: Option<&str>, max_bytes: usize) -> Result<(), ()> {
    match value {
        Some(value) => valid_value(value, max_bytes),
        None => Ok(()),
    }
}

fn valid_idempotency_key(value: &str) -> Result<(), ()> {
    if value.is_empty()
        || value.len() > MAX_IDEMPOTENCY_KEY_BYTES
        || !value.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err(());
    }
    Ok(())
}

fn valid_path_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}
