//! Strict Task 5 DTO decoders sharing the frozen Task 3 public boundary.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    dormant::{public_id, public_text, utc},
    page::deserialize_required_option,
    types::MAX_RESPONSE_BYTES,
};

fn bounded(value: &Value) -> bool {
    serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= MAX_RESPONSE_BYTES)
}

fn sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn source_alias(value: &str) -> bool {
    value.strip_prefix("source:").is_some_and(|hash| {
        hash.len() == 32
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    })
}

fn token(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'.' | b'-')
        })
        && public_text(value, 64, true)
}

fn unique_strings(values: &[String], maximum: usize, validate: fn(&str) -> bool) -> bool {
    values.len() <= maximum
        && values.iter().all(|value| validate(value))
        && values.iter().collect::<HashSet<_>>().len() == values.len()
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConnectionKind {
    Hub,
    Orca,
    Codex,
    ClaudeCode,
    MicrosoftTeams,
    LocalGit,
    Github,
}

impl ConnectionKind {
    fn wire_name(&self) -> &'static str {
        match self {
            Self::Hub => "hub",
            Self::Orca => "orca",
            Self::Codex => "codex",
            Self::ClaudeCode => "claude_code",
            Self::MicrosoftTeams => "microsoft_teams",
            Self::LocalGit => "local_git",
            Self::Github => "github",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConnectionStatus {
    Connected,
    Ready,
    Degraded,
    NotConfigured,
    Initializing,
    Missing,
    SchemaMismatch,
    Locked,
    ReadError,
    UpstreamUnavailable,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpsConnectionV1 {
    id: String,
    name: String,
    kind: ConnectionKind,
    status: ConnectionStatus,
    updated_at: String,
    observed_at: String,
    source_alias: String,
    locator_label: String,
}

impl OpsConnectionV1 {
    fn validate(&self) -> bool {
        public_id(&self.id)
            && public_text(&self.name, 80, true)
            && utc(&self.updated_at)
            && utc(&self.observed_at)
            && source_alias(&self.source_alias)
            && public_text(&self.locator_label, 80, true)
    }
}

pub(crate) fn validate_connections(value: &Value) -> bool {
    bounded(value)
        && serde_json::from_value::<Vec<OpsConnectionV1>>(value.clone())
            .ok()
            .is_some_and(|rows| {
                rows.len() <= 32
                    && rows.iter().all(OpsConnectionV1::validate)
                    && rows.iter().map(|row| &row.id).collect::<HashSet<_>>().len() == rows.len()
                    && rows.windows(2).all(|pair| {
                        pair[0].kind.wire_name().as_bytes() < pair[1].kind.wire_name().as_bytes()
                            || pair[0].kind.wire_name() == pair[1].kind.wire_name()
                                && pair[0].id.as_bytes() <= pair[1].id.as_bytes()
                    })
            })
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SourceStatus {
    Ready,
    NotConfigured,
    Unverified,
    ReadError,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SuperpowersState {
    status: SourceStatus,
    #[serde(deserialize_with = "deserialize_required_option")]
    version: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    manifest_sha256: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    observed_at: Option<String>,
}

impl SuperpowersState {
    fn validate(&self) -> bool {
        match self.status {
            SourceStatus::Ready => {
                self.version
                    .as_deref()
                    .is_some_and(|value| public_text(value, 64, true))
                    && self.manifest_sha256.as_deref().is_some_and(sha256)
                    && self.observed_at.as_deref().is_some_and(utc)
            }
            _ => {
                self.version.is_none()
                    && self.manifest_sha256.is_none()
                    && self.observed_at.as_deref().is_none_or(utc)
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ApprovalBoundary {
    None,
    LocalInternal,
    ExternalExplicit,
    Forbidden,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RoutingState {
    status: SourceStatus,
    #[serde(deserialize_with = "deserialize_required_option")]
    schema_version: Option<u8>,
    #[serde(deserialize_with = "deserialize_required_option")]
    source_sha256: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    observed_at: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    controller: Option<String>,
    allowed_models: Vec<String>,
    allowed_efforts: Vec<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    max_active_sessions: Option<u64>,
    #[serde(deserialize_with = "deserialize_required_option")]
    fallback: Option<Fallback>,
    approval_boundaries: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Fallback {
    Forbidden,
}

impl RoutingState {
    fn validate(&self) -> bool {
        let provenance = self.schema_version.is_none_or(|value| value == 1)
            && self.source_sha256.as_deref().is_none_or(sha256)
            && self.observed_at.as_deref().is_none_or(utc);
        if !provenance
            || !unique_strings(&self.allowed_models, 16, token)
            || !unique_strings(&self.allowed_efforts, 16, token)
            || !unique_strings(&self.approval_boundaries, 16, token)
        {
            return false;
        }
        match self.status {
            SourceStatus::Ready => {
                self.schema_version == Some(1)
                    && self.controller.as_deref().is_none_or(token)
                    && self
                        .max_active_sessions
                        .is_none_or(|value| (1..=64).contains(&value))
            }
            _ => {
                self.controller.is_none()
                    && self.allowed_models.is_empty()
                    && self.allowed_efforts.is_empty()
                    && self.max_active_sessions.is_none()
                    && self.fallback.is_none()
                    && self.approval_boundaries.is_empty()
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum PlanPhase {
    Spec,
    Plan,
    Implementation,
    Review,
    Verification,
    Release,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum PlanStatus {
    Planned,
    InProgress,
    Blocked,
    Complete,
    Unverified,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Verification {
    Verified,
    Unverified,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PlanState {
    id: String,
    title: String,
    phase: PlanPhase,
    status: PlanStatus,
    plan_sha256: String,
    ledger_sha256: String,
    evidence_count: u64,
    review_finding_count: u64,
    verification: Verification,
}

impl PlanState {
    fn validate(&self) -> bool {
        public_id(&self.id)
            && public_text(&self.title, 280, true)
            && sha256(&self.plan_sha256)
            && sha256(&self.ledger_sha256)
            && self.evidence_count <= 10_000
            && self.review_finding_count <= 10_000
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RouteState {
    id: String,
    from: String,
    to: String,
    model: String,
    effort: String,
    enabled: bool,
    approval_boundary: ApprovalBoundary,
}

impl RouteState {
    fn validate(&self) -> bool {
        public_id(&self.id)
            && [&self.from, &self.to, &self.model, &self.effort]
                .into_iter()
                .all(|value| token(value))
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum WorkflowStatus {
    Ready,
    Partial,
    NotConfigured,
    Unverified,
    ReadError,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WorkflowRouting {
    status: WorkflowStatus,
    superpowers: SuperpowersState,
    routing: RoutingState,
    plans: Vec<PlanState>,
    routes: Vec<RouteState>,
}

fn aggregate(superpowers: &SourceStatus, routing: &SourceStatus) -> WorkflowStatus {
    if matches!(superpowers, SourceStatus::ReadError) || matches!(routing, SourceStatus::ReadError)
    {
        WorkflowStatus::ReadError
    } else if matches!(superpowers, SourceStatus::Unverified)
        || matches!(routing, SourceStatus::Unverified)
    {
        WorkflowStatus::Unverified
    } else if matches!(superpowers, SourceStatus::Ready) && matches!(routing, SourceStatus::Ready) {
        WorkflowStatus::Ready
    } else if matches!(superpowers, SourceStatus::NotConfigured)
        && matches!(routing, SourceStatus::NotConfigured)
    {
        WorkflowStatus::NotConfigured
    } else {
        WorkflowStatus::Partial
    }
}

pub(crate) fn validate_workflow_routing(value: &Value) -> bool {
    bounded(value)
        && serde_json::from_value::<WorkflowRouting>(value.clone())
            .ok()
            .is_some_and(|item| {
                item.status == aggregate(&item.superpowers.status, &item.routing.status)
                    && item.superpowers.validate()
                    && item.routing.validate()
                    && item.plans.len() <= 64
                    && item.routes.len() <= 64
                    && item.plans.iter().all(PlanState::validate)
                    && item.routes.iter().all(RouteState::validate)
                    && item
                        .plans
                        .iter()
                        .map(|row| &row.id)
                        .collect::<HashSet<_>>()
                        .len()
                        == item.plans.len()
                    && item
                        .routes
                        .iter()
                        .map(|row| &row.id)
                        .collect::<HashSet<_>>()
                        .len()
                        == item.routes.len()
                    && (matches!(item.superpowers.status, SourceStatus::Ready)
                        || item.plans.is_empty())
                    && (matches!(item.routing.status, SourceStatus::Ready)
                        || item.routes.is_empty())
            })
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
enum ReadCapability {
    Snapshot,
    Events,
    Artifact,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ForbiddenAction {
    ExternalDelivery,
    ProviderExecution,
    TeamsSend,
    GithubMutation,
    GitMutation,
    AutomaticResearch,
    Push,
    Merge,
    Publish,
    Deploy,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SessionControls {
    drafts: Vec<String>,
    transitions: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PolicyBoundary {
    action: String,
    boundary: ApprovalBoundary,
    requires_expected_revision: bool,
    requires_risk_confirmation: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SafetyPolicy {
    policy_version: u8,
    read_capabilities: Vec<ReadCapability>,
    session_controls: SessionControls,
    forbidden_actions: Vec<ForbiddenAction>,
    approval_boundaries: Vec<PolicyBoundary>,
    control_session_ttl_seconds: u64,
}

pub(crate) fn validate_safety_policy(value: &Value) -> bool {
    bounded(value)
        && serde_json::from_value::<SafetyPolicy>(value.clone())
            .ok()
            .is_some_and(|policy| {
                let read_rank = |read: &ReadCapability| match read {
                    ReadCapability::Snapshot => 0,
                    ReadCapability::Events => 1,
                    ReadCapability::Artifact => 2,
                };
                policy.policy_version == 1
                    && policy
                        .read_capabilities
                        .windows(2)
                        .all(|pair| read_rank(&pair[0]) < read_rank(&pair[1]))
                    && policy.session_controls.drafts == ["message", "internal_task"]
                    && policy.session_controls.transitions
                        == ["submit", "approve", "risk_confirm", "reject"]
                    && policy.forbidden_actions
                        == [
                            ForbiddenAction::ExternalDelivery,
                            ForbiddenAction::ProviderExecution,
                            ForbiddenAction::TeamsSend,
                            ForbiddenAction::GithubMutation,
                            ForbiddenAction::GitMutation,
                            ForbiddenAction::AutomaticResearch,
                            ForbiddenAction::Push,
                            ForbiddenAction::Merge,
                            ForbiddenAction::Publish,
                            ForbiddenAction::Deploy,
                        ]
                    && policy.approval_boundaries.len() <= 16
                    && policy
                        .approval_boundaries
                        .iter()
                        .all(|row| token(&row.action))
                    && policy
                        .approval_boundaries
                        .iter()
                        .map(|row| &row.action)
                        .collect::<HashSet<_>>()
                        .len()
                        == policy.approval_boundaries.len()
                    && policy.control_session_ttl_seconds == 120
            })
}

mod page_detail;
pub(crate) use page_detail::*;
