use serde::{Deserialize, Serialize};

use super::{
    client::OpsBridgeError,
    page::deserialize_optional_non_null,
    types::{VersionedResponse, MAX_SAFE_INTEGER_U64},
};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpsReadCapability {
    Snapshot,
    Events,
    Artifact,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpsDraftCapability {
    Message,
    InternalTask,
    ProviderAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpsTransitionAction {
    Submit,
    Approve,
    RiskConfirm,
    Deliver,
    Reject,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(transparent)]
pub struct OpsModuleCapability(serde_json::Value);

impl OpsModuleCapability {
    fn name(&self) -> Option<&str> {
        self.0
            .as_object()
            .and_then(|record| record.get("name"))
            .and_then(serde_json::Value::as_str)
    }

    fn is_exact_valid_record(&self) -> bool {
        let Some(record) = self.0.as_object() else {
            return false;
        };
        let Some(name) = self.name() else {
            return false;
        };
        if !super::dormant::module_name(name)
            || record
                .get("schema_version")
                .and_then(serde_json::Value::as_u64)
                != Some(1)
        {
            return false;
        }
        match record.get("paged").and_then(serde_json::Value::as_bool) {
            Some(false) => {
                record.len() == 3
                    && record.contains_key("name")
                    && record.contains_key("schema_version")
                    && record.contains_key("paged")
            }
            Some(true) => {
                record.len() == 4
                    && record.contains_key("name")
                    && record.contains_key("schema_version")
                    && record.contains_key("paged")
                    && record
                        .get("collection_revision")
                        .and_then(serde_json::Value::as_u64)
                        .is_some_and(|revision| revision <= MAX_SAFE_INTEGER_U64)
            }
            None => false,
        }
    }
}

fn known_module_name(name: &str) -> bool {
    matches!(
        name,
        "timeline"
            | "approvals"
            | "artifacts"
            | "connections"
            | "workflow_routing"
            | "safety_policy"
            | "research"
            | "repositories"
            | "teams_activity"
            | "work_items"
            | "sessions"
            | "checklist_items"
            | "decisions"
            | "approval_index"
            | "evidence"
            | "audit"
            | "search"
    )
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OpsBridgeCapabilities {
    pub contract_version: u8,
    pub reads: Vec<OpsReadCapability>,
    pub drafts: Vec<OpsDraftCapability>,
    pub transitions: Vec<OpsTransitionAction>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
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
                let Some(name) = module.name() else {
                    return Err(OpsBridgeError::ContractMismatch);
                };
                if (!module.is_exact_valid_record() && !known_module_name(name))
                    || !names.insert(name)
                {
                    return Err(OpsBridgeError::ContractMismatch);
                }
            }
        }
        Ok(())
    }

    pub(crate) fn retain_known_modules(&mut self) {
        if let Some(modules) = &mut self.modules {
            modules.retain(|module| module.name().is_some_and(known_module_name));
            for module in modules {
                if module.is_exact_valid_record() {
                    continue;
                }
                let Some(name) = module.name().map(str::to_owned) else {
                    continue;
                };
                let mut marker = serde_json::Map::new();
                marker.insert("name".to_owned(), serde_json::Value::String(name));
                module.0 = serde_json::Value::Object(marker);
            }
        }
    }
}
