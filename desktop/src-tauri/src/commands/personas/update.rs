//! The persona edit command surface: `update_persona` (best-effort enqueue)
//! and the `update_persona_with` seam that `update_persona_and_publish` reuses
//! to await relay acceptance for the same save.

use tauri::AppHandle;

use crate::{
    app_state::AppState,
    managed_agents::{
        apply_persona_behavior, effective_agent_command, load_managed_agents, load_personas,
        managed_agent_avatar_url, try_regenerate_nest, validate_agent_definition_text,
        with_claude_account_store, AccountProvider, AgentDefinition, ManagedAgentRecord,
        UpdatePersonaRequest,
    },
    util::now_iso,
};

use super::{normalize_description, pending, retain_persona_pending, trim_optional, trim_required};

#[cfg(test)]
mod name_propagation_tests;

#[derive(Debug, Clone, PartialEq, Eq)]
struct PersonaInstanceAccountUpdates {
    claude_account_id: Option<Option<String>>,
    codex_account_id: Option<Option<String>>,
}

fn validate_account_update(
    provider: &str,
    update: Option<Option<String>>,
    known: &dyn Fn(&str) -> bool,
) -> Result<Option<Option<String>>, String> {
    let Some(update) = update else {
        return Ok(None);
    };
    let next = update
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    if let Some(id) = next.as_deref() {
        if !known(id) {
            return Err(format!("{provider} account {id} not found"));
        }
    }
    Ok(Some(next))
}

fn validate_persona_instance_account_updates(
    claude_account_id: Option<Option<String>>,
    codex_account_id: Option<Option<String>>,
    claude_known: &dyn Fn(&str) -> bool,
    codex_known: &dyn Fn(&str) -> bool,
) -> Result<PersonaInstanceAccountUpdates, String> {
    Ok(PersonaInstanceAccountUpdates {
        claude_account_id: validate_account_update("Claude", claude_account_id, claude_known)?,
        codex_account_id: validate_account_update("Codex", codex_account_id, codex_known)?,
    })
}

/// Apply a validated tri-state patch to every community instance linked to
/// the definition. The caller persists the resulting snapshot in one atomic
/// write with the definition itself.
fn apply_persona_instance_account_updates(
    records: &mut [ManagedAgentRecord],
    persona_id: &str,
    updates: &PersonaInstanceAccountUpdates,
    updated_at: &str,
) -> Vec<String> {
    let mut changed = Vec::new();
    for record in records
        .iter_mut()
        .filter(|record| record.persona_id.as_deref() == Some(persona_id))
    {
        let mut record_changed = false;
        if let Some(next) = updates.claude_account_id.as_ref() {
            if record.claude_account_id.as_ref() != next.as_ref() {
                record.claude_account_id = next.clone();
                record_changed = true;
            }
        }
        if let Some(next) = updates.codex_account_id.as_ref() {
            if record.codex_account_id.as_ref() != next.as_ref() {
                record.codex_account_id = next.clone();
                record_changed = true;
            }
        }
        if record_changed {
            record.updated_at = updated_at.to_string();
            changed.push(record.pubkey.clone());
        }
    }
    changed
}

/// Proof that one definition and the complete linked-instance snapshot were
/// handed to the unified atomic writer. The command consumes this token to
/// obtain its result, so deleting the production persistence call leaves no
/// persona value for the retain/publish phase.
#[derive(Debug)]
#[must_use]
struct PersistedPersonaSnapshot(AgentDefinition);

impl PersistedPersonaSnapshot {
    fn into_persona(self) -> AgentDefinition {
        self.0
    }
}

/// Production persistence seam for a definition edit. Tests drive this same
/// function with a temporary on-disk writer, making both the definition and
/// every linked account choice deletion-falsifiable at the save boundary.
fn persist_persona_snapshot(
    personas: &[AgentDefinition],
    records: &[ManagedAgentRecord],
    result: AgentDefinition,
    save: impl FnOnce(&[ManagedAgentRecord], &[ManagedAgentRecord]) -> Result<(), String>,
) -> Result<PersistedPersonaSnapshot, String> {
    let definitions: Vec<_> = personas
        .iter()
        .cloned()
        .map(AgentDefinition::into_agent_record)
        .collect();
    save(&definitions, records)?;
    Ok(PersistedPersonaSnapshot(result))
}

/// Return value of the `update_persona` command. Uses flatten so all
/// `AgentDefinition` fields appear at the top level of the JSON response —
/// backward-compatible with callers that already destructure a raw persona object.
#[derive(Debug, serde::Serialize)]
pub struct UpdatePersonaResult {
    #[serde(flatten)]
    persona: AgentDefinition,
}

/// Propagate a persona definition's display_name rename to linked agent instances.
/// Only instances whose current `name` equals `old_display_name` are updated;
/// pool-named instances (e.g. "Birch", "Compass") keep their individualised name.
/// Updates both `record.name` (relay display name) and `record.display_name`.
/// Returns the pubkeys of the records that were renamed.
fn propagate_persona_name_rename(
    records: &mut [ManagedAgentRecord],
    persona_id: &str,
    old_display_name: &str,
    new_display_name: &str,
) -> Vec<String> {
    let mut renamed = Vec::new();
    for record in records.iter_mut() {
        if record.persona_id.as_deref() != Some(persona_id) {
            continue;
        }
        if record.name != old_display_name {
            continue; // pool-named instance — keep its individualised name
        }
        record.name = new_display_name.to_string();
        record.display_name = Some(new_display_name.to_string());
        renamed.push(record.pubkey.clone());
    }
    renamed
}

#[derive(Debug, PartialEq, Eq)]
struct LinkedProfileUpdate {
    /// Whether this update changed bytes in the managed-agent record.
    record_changed: bool,
    /// Whether this instance needs a complete kind:0 replacement event.
    profile_sync_required: bool,
    /// Avatar to publish with the complete kind:0 replacement event.
    profile_avatar: Option<String>,
}

/// Apply the persisted portion of a persona identity edit to one linked
/// instance and resolve the avatar for the complete kind:0 replacement.
///
/// Description-only edits deliberately leave the record unchanged, but still
/// need a non-empty avatar projection for legacy records whose `avatar_url`
/// has not yet been backfilled. The persona avatar is authoritative there;
/// the effective command icon is the final fallback.
fn prepare_linked_profile_update(
    record: &mut ManagedAgentRecord,
    persona: &AgentDefinition,
    renamed: bool,
    avatar_changed: bool,
    about_changed: bool,
) -> LinkedProfileUpdate {
    let mut record_changed = renamed;
    if avatar_changed {
        let effective_cmd = effective_agent_command(
            record.persona_id.as_deref(),
            std::slice::from_ref(persona),
            record.agent_command_override.as_deref(),
        );
        record.avatar_url = persona
            .avatar_url
            .clone()
            .or_else(|| managed_agent_avatar_url(&effective_cmd));
        record_changed = true;
    }

    let effective_cmd = effective_agent_command(
        record.persona_id.as_deref(),
        std::slice::from_ref(persona),
        record.agent_command_override.as_deref(),
    );
    let profile_avatar = record
        .avatar_url
        .clone()
        .or_else(|| persona.avatar_url.clone())
        .or_else(|| managed_agent_avatar_url(&effective_cmd));

    LinkedProfileUpdate {
        record_changed,
        profile_sync_required: record_changed || about_changed,
        profile_avatar,
    }
}

/// Profile sync params collected under the store lock for async relay publish:
/// (agent keys, relay url, display name, avatar url, kind:0 about, auth tag).
type ProfileSyncParams = Vec<(
    nostr::Keys,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
)>;

#[tauri::command]
pub async fn update_persona(
    input: UpdatePersonaRequest,
    app: AppHandle,
    caller: tauri::Webview,
) -> Result<UpdatePersonaResult, String> {
    crate::commands::upstream_apps::ensure_trusted_caller(&caller)?;
    let (persona, ()) = update_persona_with(input, app, |app, state, persona| {
        retain_persona_pending(app, state, persona);
        // F2: immediately refresh any shared 30178 heads that include this
        // persona as a member. Best-effort inside retain so a hiccup cannot
        // fail the persona edit itself.
        crate::commands::refresh_team_catalog_heads_for_persona(app, state, &persona.id);
        Ok(())
    })
    .await?;
    Ok(UpdatePersonaResult { persona })
}

/// Save an edited persona, hand the saved record to `retain` while the store
/// lock is still held, then sync the relay profiles of linked agent instances.
///
/// `retain` is the only difference between the two update commands:
/// [`update_persona`] enqueues best-effort, while
/// [`sharing::update_persona_and_publish`] prepares a strict publication and
/// returns the event so the caller can await relay acceptance.
pub(super) async fn update_persona_with<R: Send + 'static>(
    input: UpdatePersonaRequest,
    app: AppHandle,
    retain: impl FnOnce(&AppHandle, &AppState, &AgentDefinition) -> Result<R, String> + Send + 'static,
) -> Result<(AgentDefinition, R), String> {
    use tauri::Manager;

    // Phase 1: synchronous save (persona record + linked agent avatar updates)
    let (result, retained, profile_sync_params) = tokio::task::spawn_blocking({
        let app = app.clone();
        move || -> Result<(AgentDefinition, R, ProfileSyncParams), String> {
            let state = app.state::<AppState>();
            let display_name = trim_required(&input.display_name, "Display name")?;
            let system_prompt = input.system_prompt.clone();
            validate_agent_definition_text(&display_name, &system_prompt)?;
            let description = normalize_description(input.description)?;
            let avatar_url = trim_optional(input.avatar_url);
            let runtime = trim_optional(input.runtime);
            let model = trim_optional(input.model);
            let provider = trim_optional(input.provider);

            let _store_guard = state
                .managed_agents_store_lock
                .lock()
                .map_err(|error| error.to_string())?;

            // Resolve and validate every selected id before mutating either
            // half of the unified agent snapshot. A stale picker therefore
            // cannot update a prefix of the linked instances.
            let claude_accounts = if input.claude_account_id.is_some() {
                with_claude_account_store(&app, |store| store.list(AccountProvider::Claude))?
            } else {
                Vec::new()
            };
            let codex_accounts = if input.codex_account_id.is_some() {
                with_claude_account_store(&app, |store| store.list(AccountProvider::Codex))?
            } else {
                Vec::new()
            };
            let account_updates = validate_persona_instance_account_updates(
                input.claude_account_id.clone(),
                input.codex_account_id.clone(),
                &|id| claude_accounts.iter().any(|account| account.id == id),
                &|id| codex_accounts.iter().any(|account| account.id == id),
            )?;
            let mut records = load_managed_agents(&app)?;
            let account_updated_at = now_iso();
            apply_persona_instance_account_updates(
                &mut records,
                &input.id,
                &account_updates,
                &account_updated_at,
            );

            let mut personas = load_personas(&app)?;
            pending::project_active_persona_sharing(&app, &state, &mut personas);
            let persona = personas
                .iter_mut()
                .find(|record| record.id == input.id)
                .ok_or_else(|| format!("agent {} not found", input.id))?;

            // Track what changed so we can propagate to linked agent records.
            let avatar_changed = persona.avatar_url != avatar_url;
            let name_changed = persona.display_name != display_name;
            let old_display_name = persona.display_name.clone();
            // The kind:0 `about` is the authored description, so a
            // description edit changes what should be published.
            let old_about =
                crate::managed_agents::effective_agent_description(persona.description.as_deref());
            let new_about =
                crate::managed_agents::effective_agent_description(description.as_deref());
            let about_changed = old_about != new_about;

            persona.display_name = display_name;
            persona.avatar_url = avatar_url;
            persona.description = description;
            persona.system_prompt = system_prompt;
            persona.runtime = runtime;
            persona.model = model;
            persona.provider = provider;
            persona.name_pool = input
                .name_pool
                .into_iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if let Some(env_vars) = input.env_vars {
                crate::managed_agents::validate_user_env_keys(&env_vars)?;
                persona.env_vars = env_vars;
            }
            apply_persona_behavior(persona, input.behavior)?;
            persona.updated_at = now_iso();

            let pending_result = persona.clone();

            // Propagate definition identity changes in the same in-memory
            // instance snapshot and collect relay profile sync parameters.
            let renamed: Vec<String> = if name_changed {
                propagate_persona_name_rename(
                    &mut records,
                    &pending_result.id,
                    &old_display_name,
                    &pending_result.display_name,
                )
            } else {
                Vec::new()
            };
            let mut sync_params: ProfileSyncParams = Vec::new();
            if avatar_changed || name_changed || about_changed {
                let workspace_relay = crate::relay::relay_ws_url_with_override(&state);
                for record in records.iter_mut() {
                    if record.persona_id.as_deref() != Some(&pending_result.id) {
                        continue;
                    }
                    let update = prepare_linked_profile_update(
                        record,
                        &pending_result,
                        renamed.contains(&record.pubkey),
                        avatar_changed,
                        about_changed,
                    );
                    if update.profile_sync_required {
                        if let Ok(agent_keys) = nostr::Keys::parse(&record.private_key_nsec) {
                            let relay_url = crate::relay::effective_agent_relay_url(
                                &record.relay_url,
                                &workspace_relay,
                            );
                            sync_params.push((
                                agent_keys,
                                relay_url,
                                record.name.clone(),
                                update.profile_avatar,
                                new_about.clone(),
                                record.auth_tag.clone(),
                            ));
                        }
                    }
                }
            }

            // Definitions and linked instances share managed-agents.json.
            // Commit the entire user action in one owner-only atomic replace;
            // no separate account batch or restart-only retry state remains.
            let result = persist_persona_snapshot(
                &personas,
                &records,
                pending_result,
                |definitions, records| {
                    crate::managed_agents::storage::save_agent_definitions_and_managed_agents(
                        &app,
                        definitions,
                        records,
                    )
                },
            )?
            .into_persona();

            let retained = retain(&app, &state, &result)?;
            try_regenerate_nest(&app);

            // Keep retained kind:30177 identity records in lockstep with a
            // rename after the shared snapshot is durable.
            for record in records.iter().filter(|r| renamed.contains(&r.pubkey)) {
                crate::commands::agents::retain_managed_agent_pending(&app, &state, record);
            }

            Ok((result, retained, sync_params))
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))??;

    // Phase 2: await relay profile sync for linked agents whose avatar,
    // display_name, or effective description (kind:0 about) was just
    // updated. We await (rather than fire-and-forget)
    // so the frontend cache invalidation that follows the mutation settlement
    // sees the fresh relay profile. Best-effort — failures are logged, not surfaced.
    if !profile_sync_params.is_empty() {
        let state = app.state::<AppState>();
        for (agent_keys, relay_url, display_name, avatar_url, about, auth_tag) in
            profile_sync_params
        {
            if let Err(e) = crate::relay::sync_managed_agent_profile(
                &state,
                &relay_url,
                &agent_keys,
                &display_name,
                avatar_url.as_deref(),
                about.as_deref(),
                auth_tag.as_deref(),
            )
            .await
            {
                eprintln!("buzz-desktop: relay profile sync failed after persona update: {e}");
            }
        }
    }

    Ok((result, retained))
}
