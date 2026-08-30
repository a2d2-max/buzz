//! Strict Rust decoders for dormant Task 3 global Ops pages.

use std::collections::HashSet;
use std::sync::LazyLock;

use chrono::DateTime;
use regex::Regex;
use serde::Deserialize;
use unicode_normalization::UnicodeNormalization;

use super::{
    client::OpsBridgeError, page::deserialize_required_option, types::MAX_SAFE_INTEGER_U64,
};

pub(crate) fn public_id(value: &str) -> bool {
    (1..=128).contains(&value.chars().count())
        && value == value.nfc().collect::<String>()
        && value.bytes().enumerate().all(|(index, byte)| {
            (byte.is_ascii_alphanumeric() && (index > 0 || byte.is_ascii_alphanumeric()))
                || matches!(byte, b':' | b'.' | b'_' | b'-')
        })
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && safe_public(value)
}

pub(crate) fn module_name(value: &str) -> bool {
    (1..=64).contains(&value.chars().count())
        && value == value.nfc().collect::<String>()
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase() || (index > 0 && (byte.is_ascii_digit() || byte == b'_'))
        })
        && safe_public(value)
}

struct PathPatterns {
    file_uri: Regex,
    bidi_or_path_query: Regex,
    canonical_unix_root: Regex,
    traversal_segment: Regex,
    windows_or_unc: Regex,
    url_span: Regex,
    delimited_absolute: Regex,
}

static PATH_PATTERNS: LazyLock<Result<PathPatterns, regex::Error>> = LazyLock::new(|| {
    Ok(PathPatterns {
        file_uri: Regex::new(r"(?i)\bfile://")?,
        bidi_or_path_query: Regex::new(
            r"(?i)(?:^|[\\/])(?:\.{1,2})(?:[\\/]|$)|^(?:[\\/]|~[\\/]|[A-Za-z]:[\\/])|%2f|%5c",
        )?,
        canonical_unix_root: Regex::new(
            r"/(?:Users|etc|home|root|var|tmp|private|opt|System|Library|usr|bin|sbin)(?:[\\/]|$)",
        )?,
        traversal_segment: Regex::new(r"(?:^|[^A-Za-z0-9])\.\.[\\/]")?,
        windows_or_unc: Regex::new(r#"(?:^|[\s=;:,()\[\]{}"'`])[A-Za-z]:[\\/]|\\\\"#)?,
        url_span: Regex::new(r"(?i)\b[a-z][a-z0-9+.-]*://[^\s]+")?,
        delimited_absolute: Regex::new(
            r#"(?:^|[\s=;:,()\[\]{}"'`])[\\/](?:[^\s\\/]+(?:[\\/]|$))"#,
        )?,
    })
});

struct SensitivePatterns {
    url_userinfo: Regex,
    redacted_assignment: Regex,
    raw: Vec<Regex>,
}

static SENSITIVE_PATTERNS: LazyLock<Result<SensitivePatterns, regex::Error>> = LazyLock::new(
    || {
        let raw = [
            r"(?i)-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----",
            r#"(?i)(?:^|[^A-Za-z0-9])(?:[A-Z0-9]+[_-])*(?:SECRET_ACCESS_KEY|SESSION_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|SECRET_KEY|PRIVATE_KEY|API_KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)"#,
            r#"(?i)\btoken\s*[:=]\s*(?:"[^"\r\n]{8,}"|'[^'\r\n]{8,}'|[A-Za-z0-9._~+/=-]{8,})"#,
            r#"(?im)(?:^|[^A-Za-z0-9_])["']?(?:capability[\s_-]*hash|launch[\s_-]*token[\s_-]*hash)["']?(?:\s*[:=]\s*|\s+)["']?[0-9a-f]{64}(?:$|[^0-9a-f])"#,
            r"(?i)(?:^|[^A-Za-z0-9])dcap_[A-Za-z0-9_-]{8,}",
            r"(?i)\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}",
            r"(?:^|[^A-Za-z0-9])(?:sk-(?:ant-)?|gh[pousr]_)[A-Za-z0-9_-]{8,}",
            r"(?i)(?:^|[^A-Za-z0-9])xox[a-z]-[A-Za-z0-9_-]{8,}",
            r"(?:^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{8,}",
            r"(?:^|[^A-Za-z0-9])xapp-[A-Za-z0-9-]{8,}",
            r"(?:^|[^A-Za-z0-9])AKIA[A-Z0-9]{16}(?:$|[^A-Za-z0-9])",
            r"(?i)</?(?:analysis|reasoning|thinking|goal[_-]?context|chain[_-]?of[_-]?thought|internal[_-]?reasoning)(?:[\s/>]|$)",
        ]
        .into_iter()
        .map(Regex::new)
        .collect::<Result<Vec<_>, _>>()?;
        Ok(SensitivePatterns {
            url_userinfo: Regex::new(r"(?i)\b[a-z][a-z0-9+.-]*://[^\s/@]+@")?,
            redacted_assignment: Regex::new(
                r#"(?i)["']?\b(?:[A-Z0-9]+[_-])*(?:SECRET_ACCESS_KEY|SESSION_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|SECRET_KEY|PRIVATE_KEY|API_KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL)\b["']?\s*[:=]\s*\[가림\]"#,
            )?,
            raw,
        })
    },
);

pub(crate) fn safe_public(value: &str) -> bool {
    if value.chars().any(|ch| {
        ch.is_control()
            || matches!(ch, '\u{200b}'..='\u{200d}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
            || (0xfdd0..=0xfdef).contains(&u32::from(ch))
            || (u32::from(ch) & 0xffff) >= 0xfffe
    }) { return false; }
    let (Ok(path_patterns), Ok(sensitive_patterns)) =
        (PATH_PATTERNS.as_ref(), SENSITIVE_PATTERNS.as_ref())
    else {
        return false;
    };
    if path_patterns.file_uri.is_match(value)
        || path_patterns.bidi_or_path_query.is_match(value)
        || path_patterns.canonical_unix_root.is_match(value)
        || path_patterns.traversal_segment.is_match(value)
        || path_patterns.windows_or_unc.is_match(value)
        || path_patterns
            .delimited_absolute
            .is_match(path_patterns.url_span.replace_all(value, "").as_ref())
    {
        return false;
    }
    if sensitive_patterns.url_userinfo.is_match(value) {
        return false;
    }
    let redacted_assignments_removed = sensitive_patterns
        .redacted_assignment
        .replace_all(value, "");
    if sensitive_patterns
        .raw
        .iter()
        .any(|pattern| pattern.is_match(redacted_assignments_removed.as_ref()))
    {
        return false;
    }
    true
}

pub(crate) fn public_text(value: &str, maximum: usize, required: bool) -> bool {
    (!required || !value.is_empty())
        && value.chars().count() <= maximum
        && value == value.nfc().collect::<String>()
        && safe_public(value)
}

pub(crate) fn utc(value: &str) -> bool {
    if !value.is_ascii() {
        return false;
    }
    let bytes = value.as_bytes();
    if !value.ends_with('Z') || bytes.len() < 20 || value.as_bytes().get(10) != Some(&b'T') {
        return false;
    }
    let core = &value[..value.len() - 1];
    let Some((date, time)) = core.split_once('T') else {
        return false;
    };
    let valid_digits =
        |part: &str, len: usize| part.len() == len && part.bytes().all(|b| b.is_ascii_digit());
    if date.len() != 10
        || !valid_digits(&date[0..4], 4)
        || &date[4..5] != "-"
        || !valid_digits(&date[5..7], 2)
        || &date[7..8] != "-"
        || !valid_digits(&date[8..10], 2)
        || time.len() < 8
        || !valid_digits(&time[0..2], 2)
        || &time[2..3] != ":"
        || !valid_digits(&time[3..5], 2)
        || &time[5..6] != ":"
        || !valid_digits(&time[6..8], 2)
        || (time.len() > 8
            && (!time[8..].starts_with('.')
                || !(1..=9).contains(&(time.len() - 9))
                || !time[9..].bytes().all(|b| b.is_ascii_digit())))
    {
        return false;
    }
    let components = (
        date[0..4].parse::<u16>(),
        time[0..2].parse::<u8>(),
        time[3..5].parse::<u8>(),
        time[6..8].parse::<u8>(),
    );
    let (Ok(_year), Ok(hour), Ok(minute), Ok(second)) = components else {
        return false;
    };
    if hour > 23 || minute > 59 || second > 59 {
        return false;
    }
    DateTime::parse_from_rfc3339(value).is_ok()
}

/// Validates a Task 3 search query before native HTTP is constructed.
pub(crate) fn search_query(value: &str) -> bool {
    (1..=100).contains(&value.chars().count())
        && value == value.nfc().collect::<String>()
        && !value.contains('\u{fffd}')
        && safe_public(value)
}

pub(crate) fn positive(value: u64) -> bool {
    (1..=MAX_SAFE_INTEGER_U64).contains(&value)
}
pub(crate) fn safe(value: u64) -> bool {
    value <= MAX_SAFE_INTEGER_U64
}
fn unique_ids(values: &[String], maximum: usize) -> bool {
    values.len() <= maximum
        && values.iter().all(|value| public_id(value))
        && values.iter().collect::<HashSet<_>>().len() == values.len()
}

/// Validates a page item after exact serde decoding.
pub(crate) trait DormantPageItem {
    fn validate(&self) -> bool;
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpsWorkItemV1 {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub status: WorkStatus,
    pub progress: f64,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub last_activity_at: Option<String>,
    pub session_count: u64,
    pub approval_count: u64,
    pub artifact_count: u64,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkStatus {
    Candidate,
    Active,
    WaitingApproval,
    Blocked,
    Done,
    Failed,
    Archived,
}
impl DormantPageItem for OpsWorkItemV1 {
    fn validate(&self) -> bool {
        public_id(&self.id)
            && public_id(&self.project_id)
            && public_text(&self.title, 280, true)
            && self.progress.is_finite()
            && (0.0..=1.0).contains(&self.progress)
            && self.last_activity_at.as_deref().is_none_or(utc)
            && [self.session_count, self.approval_count, self.artifact_count]
                .into_iter()
                .all(|n| n <= 10_000)
    }
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionSource {
    Orca,
    CodexDirect,
    CodexSub,
    ClaudeCode,
}
impl SessionSource {
    fn prefix(&self) -> &'static str {
        match self {
            Self::Orca => "orca:",
            Self::CodexDirect => "codex_direct:",
            Self::CodexSub => "codex_sub:",
            Self::ClaudeCode => "claude_code:",
        }
    }
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionActivity {
    Working,
    WaitingInput,
    Idle,
    Done,
    Failed,
    Interrupted,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionHealth {
    Live,
    Stale,
    Disconnected,
    Unknown,
    ContextUnavailable,
    Conflicting,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpsGlobalSessionV1 {
    pub id: String,
    pub source: SessionSource,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub parent_session_id: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub work_item_id: Option<String>,
    pub title: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub activity: Option<SessionActivity>,
    pub health: SessionHealth,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub last_activity_at: Option<String>,
    pub child_count: u64,
}
fn session_id(value: &str) -> bool {
    ["orca:", "codex_direct:", "codex_sub:", "claude_code:"]
        .into_iter()
        .any(|prefix| {
            value.strip_prefix(prefix).is_some_and(|suffix| {
                suffix
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphanumeric)
                    && suffix.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
                    })
            })
        })
        && public_id(value)
}
impl DormantPageItem for OpsGlobalSessionV1 {
    fn validate(&self) -> bool {
        session_id(&self.id)
            && self.id.starts_with(self.source.prefix())
            && self.parent_session_id.as_deref().is_none_or(session_id)
            && self.work_item_id.as_deref().is_none_or(public_id)
            && public_text(&self.title, 280, true)
            && self.last_activity_at.as_deref().is_none_or(utc)
            && self.child_count <= 10_000
    }
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ChecklistOrigin {
    Instruction,
    AgentPlan,
    User,
    Template,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ChecklistStatus {
    Candidate,
    Todo,
    InProgress,
    Claimed,
    Done,
    Blocked,
    Failed,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpsChecklistItemPageV1 {
    pub id: String,
    pub work_item_id: String,
    pub key: String,
    pub title: String,
    pub order: u64,
    pub origin: ChecklistOrigin,
    pub status: ChecklistStatus,
    pub evidence_ids: Vec<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub claimed_by_session_id: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub claimed_at: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub stage: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub next_action: Option<String>,
    pub depends_on: Vec<String>,
    pub updated_at: String,
    pub revision: u64,
}
impl DormantPageItem for OpsChecklistItemPageV1 {
    fn validate(&self) -> bool {
        public_id(&self.id)
            && public_id(&self.work_item_id)
            && public_text(&self.key, 120, true)
            && public_text(&self.title, 280, true)
            && self.order <= 1_000_000
            && unique_ids(&self.evidence_ids, 64)
            && self.claimed_by_session_id.as_deref().is_none_or(session_id)
            && self.claimed_at.as_deref().is_none_or(utc)
            && self
                .stage
                .as_deref()
                .is_none_or(|v| public_text(v, 80, false))
            && self
                .next_action
                .as_deref()
                .is_none_or(|v| public_text(v, 280, false))
            && unique_ids(&self.depends_on, 64)
            && utc(&self.updated_at)
            && positive(self.revision)
    }
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DecisionSource {
    Checklist,
    Approval,
    Message,
    Attention,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DecisionQueue {
    UserDecision,
    ExternalWait,
    AgentAutonomous,
    NeedsInfo,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DecisionStatus {
    Open,
    Stale,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpsDecisionPageV1 {
    pub id: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub work_item_id: Option<String>,
    pub source: DecisionSource,
    pub source_id: String,
    pub title: String,
    pub question: String,
    pub options: Vec<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub needed_input: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub impact: Option<String>,
    pub queue: DecisionQueue,
    pub status: DecisionStatus,
    pub updated_at: String,
    pub revision: u64,
}
impl DormantPageItem for OpsDecisionPageV1 {
    fn validate(&self) -> bool {
        public_id(&self.id)
            && self.work_item_id.as_deref().is_none_or(public_id)
            && public_id(&self.source_id)
            && public_text(&self.title, 280, true)
            && public_text(&self.question, 280, true)
            && self.options.len() <= 16
            && self.options.iter().all(|v| public_text(v, 120, true))
            && self.options.iter().collect::<HashSet<_>>().len() == self.options.len()
            && self
                .needed_input
                .as_deref()
                .is_none_or(|v| public_text(v, 280, false))
            && self
                .impact
                .as_deref()
                .is_none_or(|v| public_text(v, 280, false))
            && utc(&self.updated_at)
            && positive(self.revision)
    }
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ApprovalAction {
    Message,
    ProviderRun,
    ProviderRetry,
    ProviderInterrupt,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ApprovalStatus {
    Draft,
    PendingApproval,
    AwaitingRiskConfirm,
    Approved,
    Delivering,
    Delivered,
    DeliveryUnconfirmed,
    DeliveryFailed,
    Executing,
    Executed,
    ExecutionFailed,
    Held,
    Rejected,
    Expired,
    Superseded,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RiskClass {
    ExternalMessage,
    FileDelete,
    SessionStop,
    GitDestructive,
    Deploy,
    DispatchCreate,
    UnclassifiedInstruction,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpsApprovalIndexV1 {
    pub id: String,
    pub work_item_id: String,
    pub action_kind: ApprovalAction,
    pub status: ApprovalStatus,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub hold_reason: Option<String>,
    pub risk_class: Vec<RiskClass>,
    pub updated_at: String,
    pub revision: u64,
}
impl DormantPageItem for OpsApprovalIndexV1 {
    fn validate(&self) -> bool {
        public_id(&self.id)
            && public_id(&self.work_item_id)
            && self
                .hold_reason
                .as_deref()
                .is_none_or(|v| public_text(v, 280, false))
            && self.risk_class.len() <= 7
            && self.risk_class.iter().collect::<HashSet<_>>().len() == self.risk_class.len()
            && utc(&self.updated_at)
            && positive(self.revision)
    }
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum EvidenceKind {
    ExitCode,
    TestReport,
    CommitSha,
    ArtifactPath,
    WorkerDone,
    FileChange,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum EvidenceStatus {
    Verified,
    Unverified,
    Missing,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpsEvidencePageV1 {
    pub id: String,
    pub work_item_id: String,
    pub kind: EvidenceKind,
    pub status: EvidenceStatus,
    pub observed_at: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub artifact_id: Option<String>,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub artifact_version: Option<u64>,
}
impl DormantPageItem for OpsEvidencePageV1 {
    fn validate(&self) -> bool {
        public_id(&self.id)
            && public_id(&self.work_item_id)
            && utc(&self.observed_at)
            && match (&self.artifact_id, self.artifact_version) {
                (None, None) => true,
                (Some(id), Some(version)) => public_id(id) && positive(version),
                _ => false,
            }
    }
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpsAuditPageV1 {
    pub id: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub work_item_id: Option<String>,
    pub kind: String,
    pub summary: String,
    pub observed_at: String,
}
impl DormantPageItem for OpsAuditPageV1 {
    fn validate(&self) -> bool {
        public_id(&self.id)
            && self.work_item_id.as_deref().is_none_or(public_id)
            && self.kind.len() <= 64
            && self
                .kind
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_lowercase)
            && self.kind.bytes().all(|b| {
                b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'.' | b'-')
            })
            && public_text(&self.summary, 280, true)
            && utc(&self.observed_at)
    }
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SearchKind {
    WorkItem,
    Session,
    ChecklistItem,
    Decision,
    Approval,
    Evidence,
    Audit,
    Artifact,
    Repository,
    Research,
}
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpsSearchResultV1 {
    pub id: String,
    pub kind: SearchKind,
    pub title: String,
    pub snippet: String,
    pub observed_at: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub work_item_id: Option<String>,
}
impl DormantPageItem for OpsSearchResultV1 {
    fn validate(&self) -> bool {
        public_id(&self.id)
            && public_text(&self.title, 280, true)
            && public_text(&self.snippet, 280, true)
            && utc(&self.observed_at)
            && self.work_item_id.as_deref().is_none_or(public_id)
    }
}

pub(crate) fn validate_page<T: DormantPageItem>(
    page: &super::types::OpsPageV1<T>,
) -> Result<(), OpsBridgeError> {
    if !safe(page.revision)
        || !utc(&page.generated_at)
        || page.items.len() > 200
        || page
            .next_cursor
            .as_deref()
            .is_some_and(|value| value.is_empty() || value.len() > 4096)
        || !page.items.iter().all(DormantPageItem::validate)
    {
        return Err(OpsBridgeError::ContractMismatch);
    }
    Ok(())
}

pub(crate) fn validate_checklist_scope(
    page: &super::types::OpsPageV1<OpsChecklistItemPageV1>,
    work_item: &str,
) -> Result<(), OpsBridgeError> {
    if !public_id(work_item) || page.items.iter().any(|item| item.work_item_id != work_item) {
        return Err(OpsBridgeError::ContractMismatch);
    }
    Ok(())
}
