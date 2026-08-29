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

/// Optional snapshot selection. Only these three query fields can reach the hub.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OpsSelection {
    pub channel: Option<String>,
    pub thread: Option<String>,
    pub limit: Option<u32>,
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
