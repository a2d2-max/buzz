use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::super::{
    dormant::{positive, public_id, public_text, safe, utc, DormantPageItem},
    types::{OpsPageV1, OpsRepositoryStatusV1, OpsResearchCardV1},
};
use super::{sha256, source_alias, task5_response_within_limit, token};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TeamsActivityKind {
    ChannelMessage,
    ChatMessage,
    Meeting,
    Mention,
    Reply,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpsTeamsActivityV1 {
    pub(crate) id: String,
    pub(crate) connection_id: String,
    activity_kind: TeamsActivityKind,
    summary: String,
    pub(crate) observed_at: String,
    source_alias: String,
    locator_label: String,
}

impl DormantPageItem for OpsTeamsActivityV1 {
    fn validate(&self) -> bool {
        public_id(&self.id)
            && public_id(&self.connection_id)
            && public_text(&self.summary, 280, true)
            && utc(&self.observed_at)
            && source_alias(&self.source_alias)
            && public_text(&self.locator_label, 80, true)
    }
}

fn page_envelope_valid<T>(page: &OpsPageV1<T>, maximum: usize) -> bool {
    page.contract_version == 1
        && safe(page.revision)
        && utc(&page.generated_at)
        && page.items.len() <= maximum
        && page
            .next_cursor
            .as_deref()
            .is_none_or(|value| !value.is_empty() && value.len() <= 4096)
}

fn timestamp_key(value: &str) -> Option<String> {
    let core = value.strip_suffix('Z')?;
    let (seconds, fraction) = core.split_once('.').unwrap_or((core, ""));
    Some(format!("{seconds}.{:0<9}", fraction))
}

pub(crate) fn validate_teams_page(page: &OpsPageV1<OpsTeamsActivityV1>, connection: &str) -> bool {
    page_envelope_valid(page, 100)
        && public_id(connection)
        && page
            .items
            .iter()
            .all(|item| item.validate() && item.connection_id == connection)
        && page
            .items
            .iter()
            .map(|item| &item.id)
            .collect::<HashSet<_>>()
            .len()
            == page.items.len()
        && page.items.windows(2).all(|pair| {
            let left = timestamp_key(&pair[0].observed_at);
            let right = timestamp_key(&pair[1].observed_at);
            left > right || left == right && pair[0].id.as_bytes() <= pair[1].id.as_bytes()
        })
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpsResearchRepresentationV1 {
    artifact_id: String,
    version: u64,
    representation: Representation,
    sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Representation {
    Markdown,
    Json,
}

impl OpsResearchRepresentationV1 {
    fn validate(&self, expected: Representation) -> bool {
        public_id(&self.artifact_id)
            && positive(self.version)
            && self.representation == expected
            && sha256(&self.sha256)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpsResearchDetailV1 {
    id: String,
    title: String,
    status: String,
    release_version: u64,
    updated_at: String,
    review_receipt_id: String,
    reviewed_at: String,
    markdown: OpsResearchRepresentationV1,
    json: OpsResearchRepresentationV1,
}

impl OpsResearchDetailV1 {
    pub(crate) fn validate(&self) -> bool {
        public_id(&self.id)
            && public_text(&self.title, 280, true)
            && token(&self.status)
            && positive(self.release_version)
            && utc(&self.updated_at)
            && public_id(&self.review_receipt_id)
            && utc(&self.reviewed_at)
            && self.markdown.validate(Representation::Markdown)
            && self.json.validate(Representation::Json)
    }

    pub(crate) fn matches_id(&self, id: &str) -> bool {
        self.id == id
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn validate_research_detail(value: &Value) -> bool {
    task5_response_within_limit(value)
        && serde_json::from_value::<OpsResearchDetailV1>(value.clone())
            .ok()
            .is_some_and(|detail| detail.validate())
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum RepositoryEvidenceStatus {
    Verified,
    Unverified,
    Missing,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RepositoryEvidence {
    id: String,
    command_alias: String,
    status: RepositoryEvidenceStatus,
    observed_at: String,
    artifact_id: String,
    artifact_version: u64,
}

impl RepositoryEvidence {
    fn validate(&self) -> bool {
        public_id(&self.id)
            && token(&self.command_alias)
            && utc(&self.observed_at)
            && public_id(&self.artifact_id)
            && positive(self.artifact_version)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpsRepositoryDetailV1 {
    id: String,
    comparison_sha: String,
    tracking_ref_observed_at: String,
    evidence: Vec<RepositoryEvidence>,
}

impl OpsRepositoryDetailV1 {
    pub(crate) fn validate(&self) -> bool {
        let comparison = self.comparison_sha.len() == 40 || self.comparison_sha.len() == 64;
        public_id(&self.id)
            && comparison
            && self
                .comparison_sha
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
            && utc(&self.tracking_ref_observed_at)
            && self.evidence.len() <= 64
            && self.evidence.iter().all(RepositoryEvidence::validate)
            && self
                .evidence
                .iter()
                .map(|row| &row.id)
                .collect::<HashSet<_>>()
                .len()
                == self.evidence.len()
    }

    pub(crate) fn matches_id(&self, id: &str) -> bool {
        self.id == id
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn validate_repository_detail(value: &Value) -> bool {
    task5_response_within_limit(value)
        && serde_json::from_value::<OpsRepositoryDetailV1>(value.clone())
            .ok()
            .is_some_and(|detail| detail.validate())
}

fn validate_research_card(card: &OpsResearchCardV1) -> bool {
    public_id(&card.id)
        && public_text(&card.title, 280, true)
        && public_text(&card.status, 280, true)
        && card.updated_at.as_deref().is_none_or(utc)
}

fn validate_repository_status(status: &OpsRepositoryStatusV1) -> bool {
    public_id(&status.id)
        && public_text(&status.name, 280, true)
        && public_text(&status.branch, 280, true)
        && status
            .ahead
            .is_none_or(|value| safe(value) && value <= 1_000_000)
        && status
            .behind
            .is_none_or(|value| safe(value) && value <= 1_000_000)
}

pub(crate) fn validate_research_snapshot(value: &Value) -> bool {
    task5_response_within_limit(value)
        && serde_json::from_value::<Vec<OpsResearchCardV1>>(value.clone())
            .ok()
            .is_some_and(|items| {
                items.len() <= 200
                    && items.iter().all(validate_research_card)
                    && items
                        .iter()
                        .map(|item| &item.id)
                        .collect::<HashSet<_>>()
                        .len()
                        == items.len()
            })
}

pub(crate) fn validate_repository_snapshot(value: &Value) -> bool {
    task5_response_within_limit(value)
        && serde_json::from_value::<Vec<OpsRepositoryStatusV1>>(value.clone())
            .ok()
            .is_some_and(|items| {
                items.len() <= 200
                    && items.iter().all(validate_repository_status)
                    && items
                        .iter()
                        .map(|item| &item.id)
                        .collect::<HashSet<_>>()
                        .len()
                        == items.len()
            })
}

pub(crate) fn validate_research_page(page: &OpsPageV1<OpsResearchCardV1>) -> bool {
    page_envelope_valid(page, 200)
        && page.items.iter().all(validate_research_card)
        && page
            .items
            .iter()
            .map(|item| &item.id)
            .collect::<HashSet<_>>()
            .len()
            == page.items.len()
}

pub(crate) fn validate_repository_page(page: &OpsPageV1<OpsRepositoryStatusV1>) -> bool {
    page_envelope_valid(page, 200)
        && page.items.iter().all(validate_repository_status)
        && page
            .items
            .iter()
            .map(|item| &item.id)
            .collect::<HashSet<_>>()
            .len()
            == page.items.len()
        && page.items.windows(2).all(|pair| {
            pair[0].name.as_bytes() < pair[1].name.as_bytes()
                || pair[0].name == pair[1].name && pair[0].id.as_bytes() <= pair[1].id.as_bytes()
        })
}
