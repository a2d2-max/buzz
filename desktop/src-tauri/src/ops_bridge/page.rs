//! Typed module, scope, and result records for fixed Ops page routes.

use serde::{Deserialize, Deserializer, Serialize};

use super::{
    dormant::{
        OpsApprovalIndexV1, OpsAuditPageV1, OpsChecklistItemPageV1, OpsDecisionPageV1,
        OpsEvidencePageV1, OpsGlobalSessionV1, OpsSearchResultV1, OpsWorkItemV1,
    },
    types::{
        OpsArtifactV1, OpsPageV1, OpsRepositoryStatusV1, OpsResearchCardV1, OpsTimelineItemV1,
    },
};

pub(super) fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

pub(super) fn deserialize_optional_non_null<'de, D, T>(
    deserializer: D,
) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OpsPageModule {
    Timeline,
    Artifacts,
    Research,
    Repositories,
    WorkItems,
    Sessions,
    ChecklistItems,
    Decisions,
    ApprovalIndex,
    Evidence,
    Audit,
    Search,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OpsLastActivitySort {
    LastActivityAtDesc,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OpsUpdatedAtSort {
    UpdatedAtDesc,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OpsObservedAtSort {
    ObservedAtDesc,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OpsChecklistSort {
    OrderAscThenId,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OpsSearchSort {
    RankDescThenObservedAtDesc,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OpsSearchKind {
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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpsNoScope<S> {
    pub(crate) sort: S,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpsChecklistScope {
    pub(crate) work_item: String,
    pub(crate) sort: OpsChecklistSort,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OpsSearchScope {
    pub(crate) q: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) kind: Option<OpsSearchKind>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) work: Option<String>,
    pub(crate) sort: OpsSearchSort,
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub(crate) enum OpsPageResult {
    Timeline(OpsPageV1<OpsTimelineItemV1>),
    Artifacts(OpsPageV1<OpsArtifactV1>),
    Research(OpsPageV1<OpsResearchCardV1>),
    Repositories(OpsPageV1<OpsRepositoryStatusV1>),
    WorkItems(OpsPageV1<OpsWorkItemV1>),
    Sessions(OpsPageV1<OpsGlobalSessionV1>),
    ChecklistItems(OpsPageV1<OpsChecklistItemPageV1>),
    Decisions(OpsPageV1<OpsDecisionPageV1>),
    ApprovalIndex(OpsPageV1<OpsApprovalIndexV1>),
    Evidence(OpsPageV1<OpsEvidencePageV1>),
    Audit(OpsPageV1<OpsAuditPageV1>),
    Search(OpsPageV1<OpsSearchResultV1>),
}
