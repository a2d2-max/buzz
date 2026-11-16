use buzz_core::{
    git_perms::{parse_protection_tag, parse_protection_tags, RefPattern},
    kind::KIND_GIT_REPO_ANNOUNCEMENT,
};
use nostr::{Event, EventBuilder, Tag, Timestamp};

use crate::client::BuzzClient;
use crate::commands::parse_write_response;
use crate::error::CliError;
use crate::validate::validate_repo_id;

fn parse_events(json: &str) -> Result<Vec<Event>, CliError> {
    serde_json::from_str(json)
        .map_err(|error| CliError::Other(format!("failed to parse relay response: {error}")))
}

pub(crate) async fn fetch_own_repo_announcement(
    client: &BuzzClient,
    repo_id: &str,
) -> Result<Option<Event>, CliError> {
    let filter = serde_json::json!({
        "kinds": [KIND_GIT_REPO_ANNOUNCEMENT],
        "authors": [client.keys().public_key().to_hex()],
        "#d": [repo_id],
        "limit": 1,
    });
    let raw = client.query(&filter).await?;
    let mut events = parse_events(&raw)?;
    events.sort_by_key(|event| std::cmp::Reverse(event.created_at));
    Ok(events.into_iter().next())
}

fn repo_id_from_event(event: &Event) -> Result<&str, CliError> {
    event
        .tags
        .iter()
        .find_map(|tag| {
            let values = tag.as_slice();
            (values.first().map(String::as_str) == Some("d"))
                .then(|| values.get(1).map(String::as_str))
                .flatten()
        })
        .ok_or_else(|| CliError::Other("repository announcement is missing its d tag".into()))
}

fn tag_error(error: impl std::fmt::Display) -> CliError {
    CliError::Other(format!("failed to build protection tag: {error}"))
}

fn protection_pattern(tag: &Tag) -> Option<&str> {
    let values = tag.as_slice();
    (values.first().map(String::as_str) == Some("buzz-protect"))
        .then(|| values.get(1).map(String::as_str))
        .flatten()
}

fn has_tag_name(tag: &Tag, name: &str) -> bool {
    tag.as_slice().first().map(String::as_str) == Some(name)
}

fn build_protection_tag(
    ref_pattern: &str,
    push_role: Option<&str>,
    no_force_push: bool,
    no_delete: bool,
    require_patch: bool,
) -> Result<Tag, CliError> {
    let mut values = vec!["buzz-protect".to_string(), ref_pattern.to_string()];
    if let Some(role) = push_role {
        values.push(format!("push:{role}"));
    }
    if no_force_push {
        values.push("no-force-push".into());
    }
    if no_delete {
        values.push("no-delete".into());
    }
    if require_patch {
        values.push("require-patch".into());
    }
    let rule_values: Vec<&str> = values[1..].iter().map(String::as_str).collect();
    parse_protection_tag(&rule_values)
        .map_err(|error| CliError::Usage(format!("invalid protection rule: {error}")))?;
    Tag::parse(values).map_err(tag_error)
}

enum RepoChange {
    SetProtection(Box<Tag>),
    RemoveProtection(String),
    /// Bind (or rebind) the repo to a channel: replaces every existing
    /// `buzz-channel` tag with exactly one carrying the validated UUID.
    BindChannel(String),
}

fn build_updated_repo_announcement(
    existing: &Event,
    change: RepoChange,
) -> Result<EventBuilder, CliError> {
    let repo_id = repo_id_from_event(existing)?;
    // What to strip beyond `auth` (always stripped), and what to append.
    let (removed_pattern, removed_channel, replacement) = match change {
        RepoChange::SetProtection(tag) => {
            let pattern = protection_pattern(&tag)
                .ok_or_else(|| CliError::Other("replacement is not a protection tag".into()))?
                .to_string();
            (Some(pattern), false, Some(*tag))
        }
        RepoChange::RemoveProtection(pattern) => {
            RefPattern::parse(&pattern)
                .map_err(|error| CliError::Usage(format!("invalid ref pattern: {error}")))?;
            (Some(pattern), false, None)
        }
        RepoChange::BindChannel(channel) => {
            crate::validate::validate_uuid(&channel)?;
            let tag = Tag::parse(["buzz-channel", channel.as_str()]).map_err(tag_error)?;
            (None, true, Some(tag))
        }
    };

    let mut tags: Vec<Tag> = existing
        .tags
        .iter()
        .filter(|tag| {
            if has_tag_name(tag, "auth") {
                return false;
            }
            if removed_channel && has_tag_name(tag, "buzz-channel") {
                return false;
            }
            removed_pattern.is_none() || protection_pattern(tag) != removed_pattern.as_deref()
        })
        .cloned()
        .collect();
    if let Some(tag) = replacement {
        tags.push(tag);
    }

    let raw_tags: Vec<Vec<String>> = tags.iter().map(|tag| tag.as_slice().to_vec()).collect();
    parse_protection_tags(&raw_tags).map_err(|error| {
        CliError::Other(format!(
            "repository contains invalid protection rules; refusing update: {error}"
        ))
    })?;

    // Advance only the observed head. Using wall-clock time here would let a
    // delayed writer leapfrog an intervening update and silently erase metadata.
    let next_created_at = existing
        .created_at
        .as_secs()
        .checked_add(1)
        .ok_or_else(|| CliError::Other("repository timestamp cannot be advanced".into()))?;
    buzz_sdk::build_repo_announcement_with_tags(repo_id, &existing.content, tags)
        .map_err(|error| CliError::Other(format!("failed to build repository update: {error}")))
        .map(|builder| builder.custom_created_at(Timestamp::from(next_created_at)))
}

fn protection_rules_json(event: &Event) -> Result<serde_json::Value, CliError> {
    let raw_tags: Vec<Vec<String>> = event
        .tags
        .iter()
        .map(|tag| tag.as_slice().to_vec())
        .collect();
    let (unknown_rules, validation_error) = match parse_protection_tags(&raw_tags) {
        Ok(parsed) => (parsed.unknown_rules, None),
        Err(error) => (Vec::new(), Some(error.to_string())),
    };
    let protections: Vec<serde_json::Value> = event
        .tags
        .iter()
        .filter_map(|tag| {
            let values = tag.as_slice();
            (values.first().map(String::as_str) == Some("buzz-protect")).then(|| {
                serde_json::json!({
                    "ref": values.get(1).map(String::as_str).unwrap_or(""),
                    "rules": values.get(2..).unwrap_or_default(),
                })
            })
        })
        .collect();

    Ok(serde_json::json!({
        "repo_id": repo_id_from_event(event)?,
        "protections": protections,
        "unknown_rules": unknown_rules,
        "validation_error": validation_error,
    }))
}

fn validate_write_response(raw: &str) -> Result<String, CliError> {
    parse_write_response(
        raw,
        "repository changed concurrently; fetch the latest rules and retry",
    )
}

async fn submit_repo_update(client: &BuzzClient, builder: EventBuilder) -> Result<(), CliError> {
    let event = client.sign_event(builder)?;
    let raw = client.submit_event(event).await?;
    println!("{}", validate_write_response(&raw)?);
    Ok(())
}

/// Build the kind:30617 announcement for `repos create`, including the
/// `buzz-channel` binding when requested.
///
/// Pure (no I/O) so the emitted tags are unit-testable. Exactly one
/// validated `buzz-channel` tag is appended — the tag is the git ACL
/// (issue #3527: without it the relay 404s every clone/fetch/push), so the
/// UUID is shape-validated here and its existence/membership is the relay's
/// authority at git-access time, same posture as `repos bind`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_create_announcement(
    repo_id: &str,
    name: Option<&str>,
    description: Option<&str>,
    clone_urls: &[String],
    web_url: Option<&str>,
    relays: &[String],
    channel: Option<&str>,
) -> Result<EventBuilder, CliError> {
    validate_repo_id(repo_id)?;

    let clone_refs: Vec<&str> = clone_urls.iter().map(|s| s.as_str()).collect();
    let relay_refs: Vec<&str> = relays.iter().map(|s| s.as_str()).collect();

    let mut builder = buzz_sdk::build_repo_announcement(
        repo_id,
        name,
        description,
        &clone_refs,
        web_url,
        &relay_refs,
    )
    .map_err(|e| CliError::Other(format!("build_repo_announcement failed: {e}")))?;

    if let Some(channel) = channel {
        crate::validate::validate_uuid(channel)?;
        builder = builder.tag(Tag::parse(["buzz-channel", channel]).map_err(tag_error)?);
    }
    Ok(builder)
}

#[allow(clippy::too_many_arguments)]
pub async fn cmd_create_repo(
    client: &BuzzClient,
    repo_id: &str,
    name: Option<&str>,
    description: Option<&str>,
    clone_urls: &[String],
    web_url: Option<&str>,
    relays: &[String],
    channel: Option<&str>,
) -> Result<(), CliError> {
    let builder = build_create_announcement(
        repo_id,
        name,
        description,
        clone_urls,
        web_url,
        relays,
        channel,
    )?;
    let event = client.sign_event(builder)?;
    let owner = event.pubkey.to_hex();
    let resp = client.submit_event(event).await?;
    // `link` renders as a rich preview card in Buzz Desktop when included in
    // a chat message — agents announce repos with it (see base_prompt.md).
    let link = crate::links::repo_link(&owner, repo_id);
    crate::client::print_create_response(&resp, "link", &link);
    if let Some(channel) = channel {
        // Best-effort: a repo announced into a project home channel should
        // join that project instead of rendering as a second project card.
        let _ = crate::commands::projects::try_add_own_repo_to_channel_project(
            client, channel, repo_id,
        )
        .await;
    }
    Ok(())
}

pub async fn cmd_get_repo(
    client: &BuzzClient,
    repo_id: &str,
    owner: Option<&str>,
) -> Result<(), CliError> {
    validate_repo_id(repo_id)?;

    let mut filter = serde_json::json!({
        "kinds": [30617],
        "#d": [repo_id]
    });

    // If owner specified, filter by author pubkey; otherwise return any match.
    // Note: without --owner, multiple repos with the same name (different owners) may be returned.
    if let Some(pk) = owner {
        crate::validate::validate_hex64(pk)?;
        filter["authors"] = serde_json::json!([pk]);
    }

    let resp = client.query(&filter).await?;
    println!("{resp}");
    Ok(())
}

pub async fn cmd_list_repos(
    client: &BuzzClient,
    owner: Option<&str>,
    limit: Option<u32>,
) -> Result<(), CliError> {
    // Default to self if no owner specified.
    let pubkey = match owner {
        Some(pk) => {
            crate::validate::validate_hex64(pk)?;
            pk.to_string()
        }
        None => client.keys().public_key().to_hex(),
    };

    let mut filter = serde_json::json!({
        "kinds": [30617],
        "authors": [pubkey]
    });

    if let Some(n) = limit {
        filter["limit"] = serde_json::json!(n);
    }

    let resp = client.query(&filter).await?;
    println!("{resp}");
    Ok(())
}

async fn current_repo(client: &BuzzClient, repo_id: &str) -> Result<Event, CliError> {
    validate_repo_id(repo_id)?;
    fetch_own_repo_announcement(client, repo_id)
        .await?
        .ok_or_else(|| {
            CliError::NotFound(format!(
                "repository {repo_id:?} was not found for the current identity"
            ))
        })
}

async fn cmd_protect_list(client: &BuzzClient, repo_id: &str) -> Result<(), CliError> {
    let event = current_repo(client, repo_id).await?;
    println!("{}", protection_rules_json(&event)?);
    Ok(())
}

async fn cmd_protect_set(
    client: &BuzzClient,
    repo_id: &str,
    ref_pattern: &str,
    push_role: Option<crate::RepoPushRole>,
    no_force_push: bool,
    no_delete: bool,
    require_patch: bool,
) -> Result<(), CliError> {
    let push_role = push_role.map(|role| match role {
        crate::RepoPushRole::Owner => "owner",
        crate::RepoPushRole::Admin => "admin",
        crate::RepoPushRole::Member => "member",
    });
    let tag = build_protection_tag(
        ref_pattern,
        push_role,
        no_force_push,
        no_delete,
        require_patch,
    )?;
    let event = current_repo(client, repo_id).await?;
    let builder =
        build_updated_repo_announcement(&event, RepoChange::SetProtection(Box::new(tag)))?;
    submit_repo_update(client, builder).await
}

async fn cmd_protect_remove(
    client: &BuzzClient,
    repo_id: &str,
    ref_pattern: &str,
) -> Result<(), CliError> {
    RefPattern::parse(ref_pattern)
        .map_err(|error| CliError::Usage(format!("invalid ref pattern: {error}")))?;
    let event = current_repo(client, repo_id).await?;
    if !event
        .tags
        .iter()
        .any(|tag| protection_pattern(tag) == Some(ref_pattern))
    {
        return Err(CliError::NotFound(format!(
            "repository {repo_id:?} has no protection rule for {ref_pattern:?}"
        )));
    }
    let builder = build_updated_repo_announcement(
        &event,
        RepoChange::RemoveProtection(ref_pattern.to_string()),
    )?;
    submit_repo_update(client, builder).await
}

/// Build the NIP-09 kind:5 tombstone for the caller's own repository
/// announcement.
///
/// The deletion carries **only** an `a` tag (`30617:<pubkey>:<id>`) and no `e`
/// tag. That is load-bearing: the relay routes to its coordinate soft-delete
/// path (`handle_standard_deletion_event` → `handle_a_tag_deletion`) only when
/// the kind:5 has no `e` target; an `e` tag would route to the per-event path
/// and leave the live addressable row — and therefore the git ACL — intact.
/// `buzz_sdk::build_delete_addressable` emits exactly that shape.
///
/// The coordinate is taken from the observed head, never from user input, so
/// the deletion can only ever address the announcement we just read back for
/// the signing identity.
///
/// `created_at` is `max(now, head.created_at + 1)`: NIP-09 scopes an a-tag
/// deletion to versions at or before the tombstone's own timestamp, so a
/// tombstone older than the head is a silent no-op at the relay. Pure and
/// unit-testable.
fn build_delete_announcement(head: &Event, now: Timestamp) -> Result<EventBuilder, CliError> {
    let repo_id = repo_id_from_event(head)?;
    let after_head = head
        .created_at
        .as_secs()
        .checked_add(1)
        .ok_or_else(|| CliError::Other("repository timestamp cannot be advanced".into()))?;
    let next_created_at = Timestamp::from(after_head.max(now.as_secs()));

    buzz_sdk::build_delete_addressable(KIND_GIT_REPO_ANNOUNCEMENT, &head.pubkey.to_hex(), repo_id)
        .map_err(|error| CliError::Other(format!("failed to build delete event: {error}")))
        .map(|builder| builder.custom_created_at(next_created_at))
}

/// `buzz repos delete` — retire one of your own kind:30617 announcements.
///
/// Head-based and verified, mirroring `projects delete`:
///   1. Fetch the caller's own live head — `NotFound` if absent (this is also
///      the ownership check: the query is scoped to the signing pubkey, so
///      another owner's repo is simply not found).
///   2. Build the tombstone at `max(now, head.created_at + 1)`.
///   3. Submit.
///   4. Re-query the coordinate; a surviving head means a concurrent write
///      raced the delete → `Conflict`.
async fn cmd_delete_repo(client: &BuzzClient, repo_id: &str) -> Result<(), CliError> {
    let head = current_repo(client, repo_id).await?;
    let owner_hex = head.pubkey.to_hex();

    let builder = build_delete_announcement(&head, Timestamp::now())?;
    let event = client.sign_event(builder)?;
    let event_id = event.id.to_hex();
    let raw = client.submit_event(event).await?;
    parse_write_response(&raw, "delete event was dominated; a newer head exists")?;

    // Post-submit verification: re-query to confirm the head is gone.
    if let Some(survivor) = fetch_own_repo_announcement(client, repo_id).await? {
        return Err(CliError::Conflict(format!(
            "repository {repo_id:?} still exists (head at {}); a concurrent write raced the delete",
            survivor.created_at.as_secs()
        )));
    }

    println!(
        "{}",
        serde_json::json!({
            "deleted": true,
            "id": repo_id,
            "address": format!("{KIND_GIT_REPO_ANNOUNCEMENT}:{owner_hex}:{repo_id}"),
            "event_id": event_id,
        })
    );
    Ok(())
}

/// Bind (or rebind) a repository to a channel — the fix path for issue
/// #3527's permanently-404 repos. Publishes a read-modify-write update of
/// the caller's own kind:30617 with exactly one `buzz-channel` tag; all
/// other metadata (protections, name, description, future tags) is
/// preserved by the same machinery `repos protect` uses.
///
/// The UUID is validated for *shape* only — deliberately. Channel existence
/// and the caller's membership are the relay's authority at git-access
/// time; a CLI-side network pre-check would just be TOCTOU with extra
/// latency.
async fn cmd_bind_repo(client: &BuzzClient, repo_id: &str, channel: &str) -> Result<(), CliError> {
    let event = current_repo(client, repo_id).await?;
    let builder =
        build_updated_repo_announcement(&event, RepoChange::BindChannel(channel.to_string()))?;
    submit_repo_update(client, builder).await
}

pub async fn dispatch(cmd: crate::ReposCmd, client: &BuzzClient) -> Result<(), CliError> {
    use crate::{ReposCmd, ReposProtectCmd};
    match cmd {
        ReposCmd::Create {
            id,
            name,
            description,
            clone_urls,
            web,
            relays,
            channel,
        } => {
            cmd_create_repo(
                client,
                &id,
                name.as_deref(),
                description.as_deref(),
                &clone_urls,
                web.as_deref(),
                &relays,
                channel.as_deref(),
            )
            .await
        }
        ReposCmd::Get { id, owner } => cmd_get_repo(client, &id, owner.as_deref()).await,
        ReposCmd::List { owner, limit } => cmd_list_repos(client, owner.as_deref(), limit).await,
        ReposCmd::Bind { id, channel } => cmd_bind_repo(client, &id, &channel).await,
        ReposCmd::Delete { id } => cmd_delete_repo(client, &id).await,
        ReposCmd::Protect(command) => match command {
            ReposProtectCmd::List { id } => cmd_protect_list(client, &id).await,
            ReposProtectCmd::Set {
                id,
                ref_pattern,
                push,
                no_force_push,
                no_delete,
                require_patch,
            } => {
                cmd_protect_set(
                    client,
                    &id,
                    &ref_pattern,
                    push,
                    no_force_push,
                    no_delete,
                    require_patch,
                )
                .await
            }
            ReposProtectCmd::Remove { id, ref_pattern } => {
                cmd_protect_remove(client, &id, &ref_pattern).await
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

    use super::{
        build_create_announcement, build_delete_announcement, build_protection_tag,
        build_updated_repo_announcement, protection_rules_json, validate_write_response,
        RepoChange,
    };

    fn signed_repo(tags: Vec<Tag>, content: &str, created_at: u64) -> nostr::Event {
        signed_repo_with_keys(&Keys::generate(), tags, content, created_at)
    }

    fn signed_repo_with_keys(
        keys: &Keys,
        tags: Vec<Tag>,
        content: &str,
        created_at: u64,
    ) -> nostr::Event {
        EventBuilder::new(Kind::Custom(30617), content)
            .tags(tags)
            .custom_created_at(Timestamp::from(created_at))
            .sign_with_keys(keys)
            .expect("sign repository event")
    }

    fn tag(parts: &[&str]) -> Tag {
        Tag::parse(parts.iter().copied()).expect("valid test tag")
    }

    #[test]
    fn protection_update_preserves_metadata_and_replaces_only_matching_pattern() {
        let existing = signed_repo(
            vec![
                tag(&["d", "demo"]),
                tag(&["name", "Demo"]),
                tag(&["buzz-channel", "channel-id"]),
                tag(&["future-metadata", "preserve-me"]),
                tag(&["auth", &"a".repeat(64), "kind=30617", &"b".repeat(128)]),
                tag(&["buzz-protect", "refs/heads/main", "push:member"]),
                tag(&["buzz-protect", "refs/tags/*", "no-delete"]),
            ],
            "repository content",
            100,
        );
        let replacement = build_protection_tag("refs/heads/main", Some("admin"), true, true, false)
            .expect("valid replacement");

        let updated = build_updated_repo_announcement(
            &existing,
            RepoChange::SetProtection(Box::new(replacement)),
        )
        .expect("build update")
        .sign_with_keys(&Keys::generate())
        .expect("sign update");

        assert_eq!(updated.content, "repository content");
        assert_eq!(updated.created_at.as_secs(), 101);
        assert!(!updated
            .tags
            .iter()
            .any(|tag| tag.as_slice().first().map(String::as_str) == Some("auth")));
        assert!(updated
            .tags
            .iter()
            .any(|tag| tag.as_slice() == ["buzz-channel", "channel-id"]));
        assert!(updated
            .tags
            .iter()
            .any(|tag| tag.as_slice() == ["future-metadata", "preserve-me"]));
        assert!(updated.tags.iter().any(|tag| {
            tag.as_slice()
                == [
                    "buzz-protect",
                    "refs/heads/main",
                    "push:admin",
                    "no-force-push",
                    "no-delete",
                ]
        }));
        assert!(updated
            .tags
            .iter()
            .any(|tag| { tag.as_slice() == ["buzz-protect", "refs/tags/*", "no-delete"] }));
        assert_eq!(
            updated
                .tags
                .iter()
                .filter(|tag| {
                    let values = tag.as_slice();
                    values.first().map(String::as_str) == Some("buzz-protect")
                        && values.get(1).map(String::as_str) == Some("refs/heads/main")
                })
                .count(),
            1
        );
    }

    #[test]
    fn protection_remove_preserves_other_patterns() {
        let existing = signed_repo(
            vec![
                tag(&["d", "demo"]),
                tag(&["buzz-protect", "refs/heads/main", "no-delete"]),
                tag(&["buzz-protect", "refs/heads/release", "push:owner"]),
            ],
            "",
            10,
        );

        let updated = build_updated_repo_announcement(
            &existing,
            RepoChange::RemoveProtection("refs/heads/main".into()),
        )
        .expect("build removal")
        .sign_with_keys(&Keys::generate())
        .expect("sign removal");

        assert!(!updated
            .tags
            .iter()
            .any(|tag| tag.as_slice().get(1).map(String::as_str) == Some("refs/heads/main")));
        assert!(updated
            .tags
            .iter()
            .any(|tag| { tag.as_slice() == ["buzz-protect", "refs/heads/release", "push:owner"] }));
    }

    #[test]
    fn protection_set_requires_at_least_one_rule() {
        assert!(build_protection_tag("refs/heads/main", None, false, false, false).is_err());
    }

    #[test]
    fn protection_update_rejects_malformed_existing_rules() {
        let existing = signed_repo(
            vec![
                tag(&["d", "demo"]),
                tag(&["buzz-protect", "refs/heads/main"]),
            ],
            "",
            10,
        );
        let replacement =
            build_protection_tag("refs/heads/release", Some("admin"), false, false, false)
                .expect("valid replacement");

        let error = build_updated_repo_announcement(
            &existing,
            RepoChange::SetProtection(Box::new(replacement)),
        )
        .expect_err("malformed existing rule must fail closed");

        assert!(error
            .to_string()
            .contains("repository contains invalid protection rules"));
    }

    #[test]
    fn protection_update_enforces_repository_rule_limit() {
        let mut tags = vec![tag(&["d", "demo"])];
        for index in 0..50 {
            tags.push(tag(&[
                "buzz-protect",
                &format!("refs/heads/branch-{index}"),
                "push:member",
            ]));
        }
        let existing = signed_repo(tags, "", 10);
        let replacement =
            build_protection_tag("refs/heads/main", Some("admin"), false, false, false)
                .expect("valid replacement");

        let error = build_updated_repo_announcement(
            &existing,
            RepoChange::SetProtection(Box::new(replacement)),
        )
        .expect_err("the 51st rule must be rejected");

        assert!(error.to_string().contains("exceeds max 50"));
    }

    #[test]
    fn protection_list_keeps_unknown_rules_visible() {
        let existing = signed_repo(
            vec![
                tag(&["d", "demo"]),
                tag(&[
                    "buzz-protect",
                    "refs/heads/main",
                    "push:admin",
                    "future-rule",
                ]),
            ],
            "",
            10,
        );

        let json = protection_rules_json(&existing).expect("list protections");
        assert_eq!(json["repo_id"], "demo");
        assert_eq!(json["protections"][0]["ref"], "refs/heads/main");
        assert_eq!(
            json["protections"][0]["rules"],
            serde_json::json!(["push:admin", "future-rule"])
        );
        assert_eq!(json["validation_error"], serde_json::Value::Null);
    }

    #[test]
    fn protection_list_surfaces_malformed_rules_for_recovery() {
        let existing = signed_repo(
            vec![
                tag(&["d", "demo"]),
                tag(&["buzz-protect", "refs/heads/main"]),
            ],
            "",
            10,
        );

        let json = protection_rules_json(&existing).expect("list malformed protections");
        assert_eq!(json["protections"][0]["ref"], "refs/heads/main");
        assert!(json["validation_error"]
            .as_str()
            .is_some_and(|error| error.contains("needs pattern + at least one rule")));
    }

    #[test]
    fn bind_channel_replaces_duplicates_and_preserves_everything_else() {
        let channel = uuid::Uuid::new_v4().to_string();
        let existing = signed_repo(
            vec![
                tag(&["d", "demo"]),
                tag(&["name", "Demo"]),
                // Two stale bindings — e.g. from a buggy or vanilla client.
                tag(&["buzz-channel", "old-and-broken"]),
                tag(&["buzz-channel", &uuid::Uuid::new_v4().to_string()]),
                tag(&["auth", &"a".repeat(64), "kind=30617", &"b".repeat(128)]),
                tag(&["buzz-protect", "refs/heads/main", "push:admin"]),
                tag(&["future-metadata", "preserve-me"]),
            ],
            "repository content",
            100,
        );

        let updated =
            build_updated_repo_announcement(&existing, RepoChange::BindChannel(channel.clone()))
                .expect("build bind update")
                .sign_with_keys(&Keys::generate())
                .expect("sign bind update");

        assert_eq!(updated.content, "repository content");
        assert_eq!(updated.created_at.as_secs(), 101);
        // Exactly one binding remains, and it is the requested one.
        let bindings: Vec<_> = updated
            .tags
            .iter()
            .filter(|tag| tag.as_slice().first().map(String::as_str) == Some("buzz-channel"))
            .collect();
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].as_slice(), ["buzz-channel", channel.as_str()]);
        // Auth stripped (relay re-stamps); everything else preserved.
        assert!(!updated
            .tags
            .iter()
            .any(|tag| tag.as_slice().first().map(String::as_str) == Some("auth")));
        assert!(updated
            .tags
            .iter()
            .any(|tag| tag.as_slice() == ["buzz-protect", "refs/heads/main", "push:admin"]));
        assert!(updated
            .tags
            .iter()
            .any(|tag| tag.as_slice() == ["future-metadata", "preserve-me"]));
        assert!(updated
            .tags
            .iter()
            .any(|tag| tag.as_slice() == ["name", "Demo"]));
    }

    #[test]
    fn bind_channel_adds_binding_to_unbound_repo() {
        let channel = uuid::Uuid::new_v4().to_string();
        let existing = signed_repo(vec![tag(&["d", "demo"])], "", 10);

        let updated =
            build_updated_repo_announcement(&existing, RepoChange::BindChannel(channel.clone()))
                .expect("build bind update")
                .sign_with_keys(&Keys::generate())
                .expect("sign bind update");

        assert!(updated
            .tags
            .iter()
            .any(|tag| tag.as_slice() == ["buzz-channel", channel.as_str()]));
    }

    #[test]
    fn bind_channel_rejects_malformed_uuid() {
        let existing = signed_repo(vec![tag(&["d", "demo"])], "", 10);

        let error =
            build_updated_repo_announcement(&existing, RepoChange::BindChannel("nope".into()))
                .expect_err("malformed channel id must not build an update");

        assert!(matches!(error, crate::error::CliError::Usage(_)));
    }

    /// Issue #3527: `repos create --channel` must emit exactly one
    /// `buzz-channel` tag so the primary create command stops producing
    /// repos the relay 404s forever.
    #[test]
    fn create_with_channel_emits_exactly_one_binding_tag() {
        let channel = uuid::Uuid::new_v4().to_string();
        let event = build_create_announcement(
            "demo",
            Some("Demo"),
            None,
            &["https://relay.example/git/owner/demo".to_string()],
            None,
            &[],
            Some(&channel),
        )
        .expect("build create announcement")
        .sign_with_keys(&Keys::generate())
        .expect("sign create announcement");

        assert_eq!(event.kind, Kind::Custom(30617));
        let bindings: Vec<_> = event
            .tags
            .iter()
            .filter(|tag| tag.as_slice().first().map(String::as_str) == Some("buzz-channel"))
            .collect();
        assert_eq!(bindings.len(), 1, "exactly one buzz-channel tag");
        assert_eq!(bindings[0].as_slice(), ["buzz-channel", channel.as_str()]);
        // The standard metadata still rides along.
        assert!(event.tags.iter().any(|tag| tag.as_slice() == ["d", "demo"]));
        assert!(event
            .tags
            .iter()
            .any(|tag| tag.as_slice() == ["name", "Demo"]));
    }

    #[test]
    fn create_without_channel_emits_no_binding_tag() {
        let event = build_create_announcement("demo", None, None, &[], None, &[], None)
            .expect("build create announcement")
            .sign_with_keys(&Keys::generate())
            .expect("sign create announcement");

        assert!(
            !event
                .tags
                .iter()
                .any(|tag| tag.as_slice().first().map(String::as_str) == Some("buzz-channel")),
            "no --channel means no binding tag (vanilla NIP-34 stays possible)"
        );
    }

    #[test]
    fn create_rejects_malformed_channel_uuid() {
        let error = build_create_announcement("demo", None, None, &[], None, &[], Some("nope"))
            .expect_err("malformed channel id must not build an announcement");
        assert!(matches!(error, crate::error::CliError::Usage(_)));
    }

    // ── repos delete (NIP-09 kind:5 coordinate tombstone) ────────────────────

    /// The tombstone must be a kind:5 carrying exactly one `a` tag addressing
    /// the head's own coordinate — and no `e` tag. An `e` tag would route the
    /// relay to its per-event delete path and leave the live 30617 row (the
    /// git ACL) alive.
    #[test]
    fn delete_emits_a_tag_only_kind5_for_the_head_coordinate() {
        let keys = Keys::generate();
        let head = signed_repo_with_keys(
            &keys,
            vec![tag(&["d", "demo"]), tag(&["name", "Demo"])],
            "repository content",
            100,
        );

        let tombstone = build_delete_announcement(&head, Timestamp::from(1_000u64))
            .expect("build tombstone")
            .sign_with_keys(&keys)
            .expect("sign tombstone");

        assert_eq!(tombstone.kind, Kind::Custom(5));
        assert_eq!(tombstone.content, "");
        let a_tags: Vec<_> = tombstone
            .tags
            .iter()
            .filter(|tag| tag.as_slice().first().map(String::as_str) == Some("a"))
            .collect();
        assert_eq!(a_tags.len(), 1, "exactly one coordinate");
        assert_eq!(
            a_tags[0].as_slice(),
            ["a", &format!("30617:{}:demo", keys.public_key().to_hex())]
        );
        assert!(
            !tombstone
                .tags
                .iter()
                .any(|tag| tag.as_slice().first().map(String::as_str) == Some("e")),
            "an e tag would leave the announcement alive"
        );
    }

    /// NIP-09 scopes an a-tag deletion to versions at or before the
    /// tombstone's own `created_at`, so a tombstone older than the observed
    /// head is a silent no-op at the relay.
    #[test]
    fn delete_timestamp_uses_later_of_wall_clock_and_after_head() {
        let cases = [
            ("stale head", 100, 1_000, 1_000),
            ("head equal to now", 1_000, 1_000, 1_001),
            ("future head", 1_500, 1_000, 1_501),
        ];

        for (name, head_ts, now, expected) in cases {
            let head = signed_repo(vec![tag(&["d", "demo"])], "", head_ts);
            let tombstone = build_delete_announcement(&head, Timestamp::from(now))
                .expect("build tombstone")
                .sign_with_keys(&Keys::generate())
                .expect("sign tombstone");

            assert_eq!(tombstone.created_at.as_secs(), expected, "case: {name}");
        }
    }

    #[test]
    fn delete_rejects_head_without_a_d_tag() {
        let head = signed_repo(vec![tag(&["name", "Demo"])], "", 10);

        let error = build_delete_announcement(&head, Timestamp::from(1_000u64))
            .expect_err("a coordinate needs the d tag");

        assert!(error.to_string().contains("missing its d tag"));
    }

    #[test]
    fn delete_rejects_overflowing_head_timestamp() {
        let head = signed_repo(vec![tag(&["d", "demo"])], "", u64::MAX);

        let error = build_delete_announcement(&head, Timestamp::from(1_000u64))
            .expect_err("maximum timestamp cannot be advanced");

        assert!(matches!(
            error,
            crate::error::CliError::Other(ref message)
                if message == "repository timestamp cannot be advanced"
        ));
    }

    /// `buzz repos delete --id <other-owner-repo>` is unreachable by
    /// construction: the coordinate comes from the head the CLI read back,
    /// which is queried `authors: [self]`. This pins the invariant that the
    /// signer and the coordinate pubkey are the same key.
    #[test]
    fn delete_coordinate_always_matches_the_signing_identity() {
        let owner = Keys::generate();
        let head = signed_repo_with_keys(&owner, vec![tag(&["d", "demo"])], "", 10);

        let tombstone = build_delete_announcement(&head, Timestamp::from(1_000u64))
            .expect("build tombstone")
            .sign_with_keys(&owner)
            .expect("sign tombstone");

        let coord = tombstone
            .tags
            .iter()
            .find_map(|tag| {
                let values = tag.as_slice();
                (values.first().map(String::as_str) == Some("a"))
                    .then(|| values.get(1).cloned())
                    .flatten()
            })
            .expect("coordinate tag");
        assert_eq!(
            coord.split(':').nth(1),
            Some(tombstone.pubkey.to_hex().as_str())
        );
    }

    #[test]
    fn duplicate_write_response_is_a_conflict() {
        let error = validate_write_response(
            r#"{"event_id":"abc","accepted":true,"message":"duplicate: superseded"}"#,
        )
        .expect_err("dominated writes must not report success");

        assert!(matches!(error, crate::error::CliError::Conflict(_)));
    }

    #[test]
    fn successful_write_response_is_normalized() {
        let output = validate_write_response(
            r#"{"event_id":"abc","accepted":true,"message":"saved","extra":"ignored"}"#,
        )
        .expect("accepted write");

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&output).expect("normalized JSON"),
            serde_json::json!({
                "event_id": "abc",
                "accepted": true,
                "message": "saved",
            })
        );
    }
}
