//! Tests for `propagate_persona_name_rename` — the helper that propagates a
//! persona definition's display_name change to linked agent instances.

use super::*;

fn agent(persona_id: &str, name: &str, display_name: Option<&str>) -> ManagedAgentRecord {
    ManagedAgentRecord {
        description: None,
        pubkey: format!("pubkey-{name}"),
        name: name.to_string(),
        persona_id: Some(persona_id.to_string()),
        private_key_nsec: String::new(),
        auth_tag: None,
        relay_url: String::new(),
        avatar_url: None,
        acp_command: String::new(),
        agent_command: String::new(),
        agent_command_override: None,
        agent_args: vec![],
        mcp_command: String::new(),
        turn_timeout_seconds: 0,
        idle_timeout_seconds: None,
        max_turn_duration_seconds: None,
        parallelism: 1,
        system_prompt: None,
        model: None,
        provider: None,
        persona_source_version: None,
        env_vars: std::collections::BTreeMap::new(),
        start_on_app_launch: false,
        auto_restart_on_config_change: true,
        runtime_pid: None,
        backend: Default::default(),
        backend_agent_id: None,
        provider_policy_pending: false,
        provider_binary_path: None,
        team_id: None,
        persona_team_dir: None,
        persona_name_in_team: None,
        created_at: String::new(),
        updated_at: String::new(),
        last_started_at: None,
        last_stopped_at: None,
        last_exit_code: None,
        last_error: None,
        last_error_code: None,
        respond_to: Default::default(),
        respond_to_allowlist: vec![],
        display_name: display_name.map(str::to_string),
        slug: None,
        runtime: None,
        name_pool: vec![],
        is_builtin: false,
        is_active: true,
        shared: false,
        source_team: None,
        source_team_persona_slug: None,
        catalog_source: None,
        team_catalog_source: None,
        definition_respond_to: None,
        definition_respond_to_allowlist: vec![],
        definition_parallelism: None,
        relay_mesh: None,
        effort_level: None,
        claude_account_id: None,
        codex_account_id: None,
    }
}

#[test]
fn test_rename_propagates_to_matching_instance() {
    // An instance whose `name` equals the OLD persona display_name must get
    // both `name` and `display_name` updated to the new value.
    let mut records = vec![agent("persona-1", "Paul", Some("Paul"))];

    let renamed = propagate_persona_name_rename(&mut records, "persona-1", "Paul", "Paul Atreides");

    assert_eq!(
        renamed,
        vec!["pubkey-Paul".to_string()],
        "must report the renamed record's pubkey"
    );
    assert_eq!(records[0].name, "Paul Atreides", "name must be updated");
    assert_eq!(
        records[0].display_name,
        Some("Paul Atreides".to_string()),
        "display_name must be updated"
    );
    // The relay-profile sync params use `record.name`; after rename it carries
    // the new display_name, so the relay profile will be published with the correct name.
    assert_eq!(records[0].name, "Paul Atreides");
}

#[test]
fn test_rename_skips_pool_named_instance() {
    // A pool-named instance (e.g. "Birch") has a name DIFFERENT from the
    // persona display_name. It must keep its individualised name.
    let mut records = vec![agent("persona-1", "Birch", Some("Birch"))];

    let renamed = propagate_persona_name_rename(&mut records, "persona-1", "Paul", "Paul Atreides");

    assert!(
        renamed.is_empty(),
        "pool-named instance must not be reported as renamed"
    );
    assert_eq!(records[0].name, "Birch", "pool name must be preserved");
    assert_eq!(
        records[0].display_name,
        Some("Birch".to_string()),
        "pool display_name must be preserved"
    );
}

#[test]
fn test_rename_propagates_both_name_and_display_name() {
    // Explicit dual-field check: BOTH `name` and `display_name` must be
    // updated so the relay profile and the local UI are consistent.
    let mut records = vec![agent("persona-1", "OldName", None)];

    propagate_persona_name_rename(&mut records, "persona-1", "OldName", "NewName");

    assert_eq!(records[0].name, "NewName");
    assert_eq!(records[0].display_name, Some("NewName".to_string()));
}

#[test]
fn test_rename_only_affects_linked_persona() {
    // An instance linked to a DIFFERENT persona must not be touched, even
    // if it happens to carry the same display_name.
    let mut records = vec![
        agent("persona-1", "Paul", Some("Paul")),
        agent("persona-2", "Paul", Some("Paul")),
    ];

    propagate_persona_name_rename(&mut records, "persona-1", "Paul", "Paul Atreides");

    assert_eq!(records[0].name, "Paul Atreides", "linked instance renamed");
    assert_eq!(
        records[1].name, "Paul",
        "unrelated persona's instance untouched"
    );
}

#[test]
fn description_only_update_syncs_without_mutating_record_and_preserves_legacy_persona_avatar() {
    let mut record = agent("persona-1", "Paul", Some("Paul"));
    record.avatar_url = None;
    record.slug = Some("persona-1".to_string());
    let before = record.clone();
    let mut persona = record
        .clone()
        .to_definition_view()
        .expect("test record projects to a definition");
    persona.id = "persona-1".to_string();
    persona.avatar_url = Some("https://example.com/paul.png".to_string());

    let update = prepare_linked_profile_update(&mut record, &persona, false, false, true);

    assert!(update.profile_sync_required, "about-only edits must sync");
    assert!(
        !update.record_changed,
        "about-only edits must not write the agent store"
    );
    assert_eq!(
        record, before,
        "description-only edits leave instance bytes untouched"
    );
    assert_eq!(
        update.profile_avatar.as_deref(),
        Some("https://example.com/paul.png"),
        "complete kind:0 replacement must not clear a legacy agent avatar"
    );
}

#[test]
fn unchanged_identity_needs_neither_store_write_nor_profile_sync() {
    let mut record = agent("persona-1", "Paul", Some("Paul"));
    record.slug = Some("persona-1".to_string());
    let persona = record
        .clone()
        .to_definition_view()
        .expect("test record projects to a definition");

    let update = prepare_linked_profile_update(&mut record, &persona, false, false, false);

    assert!(!update.record_changed);
    assert!(!update.profile_sync_required);
}

#[test]
fn test_rename_renames_all_matching_instances_in_one_pass() {
    // Several instances may carry the definition name (multi-instance deploys
    // without a name pool): one call renames every match and reports each
    // pubkey, which is what the relay profile sync collection keys on.
    let mut records = vec![
        agent("persona-1", "Paul", Some("Paul")),
        agent("persona-1", "Paul", Some("Paul")),
        agent("persona-1", "Birch", Some("Birch")),
    ];
    records[1].pubkey = "pubkey-Paul-2".to_string();

    let renamed = propagate_persona_name_rename(&mut records, "persona-1", "Paul", "Duncan Idaho");

    assert_eq!(
        renamed,
        vec!["pubkey-Paul".to_string(), "pubkey-Paul-2".to_string()],
        "every matching instance's pubkey must be reported"
    );
    assert_eq!(records[0].name, "Duncan Idaho");
    assert_eq!(records[1].name, "Duncan Idaho");
    assert_eq!(records[2].name, "Birch", "pool-named instance untouched");
}

#[test]
fn definition_account_update_applies_to_every_linked_instance_only() {
    let mut records = vec![
        agent("persona-1", "Paul", Some("Paul")),
        agent("persona-1", "Birch", Some("Birch")),
        agent("persona-2", "Other", Some("Other")),
    ];
    records[0].claude_account_id = Some("old-claude".to_string());
    records[1].claude_account_id = Some("different-claude".to_string());
    records[2].claude_account_id = Some("unrelated".to_string());

    let updates = validate_persona_instance_account_updates(
        Some(Some(" claude-1 ".to_string())),
        Some(Some("codex-1".to_string())),
        &|id| id == "claude-1",
        &|id| id == "codex-1",
    )
    .expect("known account ids validate");
    let changed = apply_persona_instance_account_updates(
        &mut records,
        "persona-1",
        &updates,
        "2026-09-21T00:00:00Z",
    );

    assert_eq!(changed, vec!["pubkey-Paul", "pubkey-Birch"]);
    for record in &records[..2] {
        assert_eq!(record.claude_account_id.as_deref(), Some("claude-1"));
        assert_eq!(record.codex_account_id.as_deref(), Some("codex-1"));
        assert_eq!(record.updated_at, "2026-09-21T00:00:00Z");
    }
    assert_eq!(records[2].claude_account_id.as_deref(), Some("unrelated"));
    assert_eq!(records[2].codex_account_id, None);
}

#[test]
fn definition_account_update_preserves_omitted_and_clears_null() {
    let mut records = vec![agent("persona-1", "Paul", Some("Paul"))];
    records[0].claude_account_id = Some("claude-1".to_string());
    records[0].codex_account_id = Some("codex-1".to_string());

    let updates =
        validate_persona_instance_account_updates(None, Some(None), &|_| false, &|_| false)
            .expect("null clear does not require a stored account");
    apply_persona_instance_account_updates(
        &mut records,
        "persona-1",
        &updates,
        "2026-09-21T00:00:01Z",
    );

    assert_eq!(records[0].claude_account_id.as_deref(), Some("claude-1"));
    assert_eq!(records[0].codex_account_id, None);
}

#[test]
fn definition_account_update_rejects_all_ids_before_record_mutation() {
    let records = vec![
        agent("persona-1", "Paul", Some("Paul")),
        agent("persona-1", "Birch", Some("Birch")),
    ];
    let before = records.clone();

    let error = validate_persona_instance_account_updates(
        Some(Some("claude-1".to_string())),
        Some(Some("missing-codex".to_string())),
        &|id| id == "claude-1",
        &|_| false,
    )
    .expect_err("a stale id must reject the whole account selection");

    assert!(error.contains("Codex account missing-codex not found"));
    assert_eq!(records, before, "validation must not mutate any record");
}

#[test]
fn definition_production_seam_persists_definition_and_linked_accounts_once() {
    let dir = tempfile::TempDir::new().expect("tempdir");
    let path = dir.path().join("managed-agents.json");
    let writes = std::cell::Cell::new(0usize);

    let persona: AgentDefinition = serde_json::from_value(serde_json::json!({
        "id": "persona-1",
        "display_name": "Updated definition",
        "avatar_url": null,
        "system_prompt": "Updated prompt",
        "created_at": "2026-09-21T00:00:00Z",
        "updated_at": "2026-09-21T00:00:01Z"
    }))
    .expect("definition fixture");
    let mut records = vec![
        agent("persona-1", "Linked one", Some("Linked one")),
        agent("persona-1", "Linked two", Some("Linked two")),
        agent("persona-2", "Unrelated", Some("Unrelated")),
    ];
    records[2].claude_account_id = Some("claude-keep".to_string());
    let updates = validate_persona_instance_account_updates(
        Some(Some("claude-next".to_string())),
        Some(Some("codex-next".to_string())),
        &|id| id == "claude-next",
        &|id| id == "codex-next",
    )
    .expect("account selections validate before persistence");
    apply_persona_instance_account_updates(
        &mut records,
        "persona-1",
        &updates,
        "2026-09-21T00:00:01Z",
    );

    let saved_persona = persist_persona_snapshot(
        std::slice::from_ref(&persona),
        &records,
        persona.clone(),
        |definitions, instances| {
            writes.set(writes.get() + 1);
            let mut snapshot = definitions.to_vec();
            snapshot.extend_from_slice(instances);
            let payload =
                serde_json::to_vec_pretty(&snapshot).map_err(|error| error.to_string())?;
            crate::managed_agents::storage::atomic_write_json_restricted(&path, &payload)
        },
    )
    .expect("definition and linked instances persist")
    .into_persona();

    assert_eq!(saved_persona.display_name, "Updated definition");
    assert_eq!(writes.get(), 1, "one edit writes one unified snapshot");
    let saved: Vec<ManagedAgentRecord> =
        serde_json::from_slice(&std::fs::read(&path).expect("unified snapshot exists"))
            .expect("unified snapshot parses");
    let definition = saved
        .iter()
        .find(|record| record.pubkey.is_empty())
        .expect("definition persisted");
    assert_eq!(definition.slug.as_deref(), Some("persona-1"));
    for pubkey in ["pubkey-Linked one", "pubkey-Linked two"] {
        let linked = saved
            .iter()
            .find(|record| record.pubkey == pubkey)
            .expect("linked instance persisted");
        assert_eq!(linked.claude_account_id.as_deref(), Some("claude-next"));
        assert_eq!(linked.codex_account_id.as_deref(), Some("codex-next"));
    }
    let unrelated = saved
        .iter()
        .find(|record| record.pubkey == "pubkey-Unrelated")
        .expect("unrelated instance preserved");
    assert_eq!(unrelated.claude_account_id.as_deref(), Some("claude-keep"));
    assert_eq!(unrelated.codex_account_id, None);
}
