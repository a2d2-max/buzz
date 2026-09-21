//! Catalog projection of the per-agent data home and the account-support
//! note: every constructor (builtin, preset, custom ×2) must project the
//! same facts spawn reads, or the UI's "Memory" note / disabled account
//! field and the spawn disagree.

use std::collections::BTreeMap;

use super::*;
use crate::managed_agents::agent_home::DataHomeKind;
use crate::managed_agents::custom_harnesses::HarnessDefinition;

fn custom(command: &str) -> HarnessDefinition {
    HarnessDefinition {
        id: "my-harness".to_string(),
        label: "My Harness".to_string(),
        command: command.to_string(),
        args: Vec::new(),
        env: BTreeMap::new(),
        install_instructions_url: String::new(),
        install_hint: String::new(),
    }
}

#[test]
fn data_home_and_account_reason_follow_the_static_command() {
    assert_eq!(data_home_for_command("codex-acp"), DataHomeKind::CodexHome);
    assert_eq!(
        data_home_for_command("/opt/shim/codex-acp"),
        DataHomeKind::CodexHome,
        "matched the way spawn matches (basename)"
    );
    assert_eq!(
        data_home_for_command("hermes-acp"),
        DataHomeKind::HermesProfile
    );
    assert_eq!(
        data_home_for_command("claude-agent-acp"),
        DataHomeKind::None
    );
    assert_eq!(data_home_for_command("goose"), DataHomeKind::None);
    assert_eq!(data_home_for_command("my-own-acp"), DataHomeKind::None);

    // Where a picker applies there is no reason to show.
    assert_eq!(
        account_unsupported_reason_for_command("claude-agent-acp"),
        None
    );
    assert_eq!(account_unsupported_reason_for_command("codex-acp"), None);
    // Specific reasons for runtimes that sign in their own way.
    assert!(account_unsupported_reason_for_command("goose")
        .is_some_and(|reason| reason.contains("Goose")));
    assert!(account_unsupported_reason_for_command("buzz-agent")
        .is_some_and(|reason| reason.contains("buzz-agent")));
    assert!(account_unsupported_reason_for_command("hermes-acp")
        .is_some_and(|reason| reason.contains("Hermes") && reason.contains("refresh token")));
    // Everything else gets the generic note.
    assert!(account_unsupported_reason_for_command("amp-acp")
        .is_some_and(|reason| reason.contains("Claude Code and Codex")));
    assert!(account_unsupported_reason_for_command("my-own-acp")
        .is_some_and(|reason| reason.contains("Claude Code and Codex")));
}

#[test]
fn builtin_constructor_projects_the_home_and_the_reason() {
    let codex = discover_acp_runtime_phase1(known_acp_runtime_exact("codex").unwrap(), false).entry;
    assert_eq!(codex.data_home, DataHomeKind::CodexHome);
    assert_eq!(codex.account_unsupported_reason, None);

    let goose = discover_acp_runtime_phase1(known_acp_runtime_exact("goose").unwrap(), false).entry;
    assert_eq!(goose.data_home, DataHomeKind::None);
    assert!(goose
        .account_unsupported_reason
        .as_deref()
        .is_some_and(|reason| reason.contains("Goose")));

    let claude =
        discover_acp_runtime_phase1(known_acp_runtime_exact("claude").unwrap(), false).entry;
    assert_eq!(claude.data_home, DataHomeKind::None);
    assert_eq!(claude.account_unsupported_reason, None);
}

#[test]
fn custom_constructor_projects_from_the_definition_command() {
    let hermes = custom_catalog_entry(&custom("hermes-acp"), |_| None);
    assert_eq!(hermes.data_home, DataHomeKind::HermesProfile);
    assert!(hermes
        .account_unsupported_reason
        .as_deref()
        .is_some_and(|reason| reason.contains("Hermes")));
    assert_eq!(hermes.source, HarnessSource::Custom);

    let wraps_codex = custom_catalog_entry(&custom("/opt/shim/codex-acp"), |_| None);
    assert_eq!(wraps_codex.data_home, DataHomeKind::CodexHome);
    assert!(wraps_codex.supports_codex_accounts);
    assert_eq!(wraps_codex.account_unsupported_reason, None);

    let plain = custom_catalog_entry(&custom("my-own-acp"), |_| None);
    assert_eq!(plain.data_home, DataHomeKind::None);
    assert!(plain
        .account_unsupported_reason
        .as_deref()
        .is_some_and(|reason| reason.contains("Claude Code and Codex")));
}
