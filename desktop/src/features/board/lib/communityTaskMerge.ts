import type { RelayEvent } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import {
  type CommunityTaskContent,
  type CommunityTaskRevision,
  communityTaskIdFromDTag,
  parseCommunityTaskEvent,
} from "./communityTaskCodec";

/** A card as the board renders it: the winning revision plus its identity. */
export type CommunityTask = CommunityTaskContent & {
  /** The uuid from the d-tag. Two creators may claim one uuid; see `key`. */
  id: string;
  /**
   * `author:id` — the identity the board keys on. A card belongs to the
   * pubkey that created it, so a second creator publishing under the same
   * uuid gets a second card rather than a say over this one.
   */
  key: string;
  /** Who signed the revision on display — the author or one of the assignees. */
  signer: string;
  eventId: string;
  eventCreatedAt: number;
};

/**
 * Newest-first: by the card's own `updatedAt`, then the event's `created_at`,
 * then event id so two clients always agree on a tie.
 */
export function compareCommunityTaskRevisions(
  a: CommunityTaskRevision,
  b: CommunityTaskRevision,
): number {
  if (a.content.updatedAt !== b.content.updatedAt) {
    return b.content.updatedAt - a.content.updatedAt;
  }
  if (a.eventCreatedAt !== b.eventCreatedAt) {
    return b.eventCreatedAt - a.eventCreatedAt;
  }
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

function newestSignedBy(
  revisions: readonly CommunityTaskRevision[],
  signers: ReadonlySet<string>,
): CommunityTaskRevision | null {
  let newest: CommunityTaskRevision | null = null;
  for (const revision of revisions) {
    if (!signers.has(revision.signer)) continue;
    if (
      newest === null ||
      compareCommunityTaskRevisions(revision, newest) < 0
    ) {
      newest = revision;
    }
  }
  return newest;
}

/**
 * The signers whose revisions count for one lineage: the author, plus
 * everyone the newest honored revision assigns, repeated until the set stops
 * growing. Growing-only makes the loop terminate and keeps the result
 * independent of the order the relay returned events in.
 */
export function honoredCommunityTaskSigners(
  author: string,
  revisions: readonly CommunityTaskRevision[],
): Set<string> {
  const honored = new Set([author]);
  for (;;) {
    const newest = newestSignedBy(revisions, honored);
    if (newest === null) return honored;
    const before = honored.size;
    for (const assignee of newest.content.assignees) honored.add(assignee);
    if (honored.size === before) return honored;
  }
}

export function communityTaskKey(author: string, id: string): string {
  return `${author}:${id}`;
}

/**
 * Collapses the revisions of one lineage — every revision that claims
 * `author` for card `id` — into the card to show, or null when the card is
 * gone or the lineage cannot be trusted.
 *
 * - The lineage is trusted only if `author` actually signed a revision;
 *   anyone can *claim* an author in JSON, only the author can sign as one.
 * - The author's tombstone retires the card outright, even if an assignee
 *   published a newer revision. An assignee's tombstone is ignored.
 * - Among the remaining revisions, only signers in the honored set (author +
 *   assignees, see `honoredCommunityTaskSigners`) count, and the newest wins.
 *
 * Revisions for other lineages or other ids are ignored, so a stranger who
 * publishes the same uuid under their own name neither overwrites nor deletes
 * this card — they merely get a card of their own.
 */
export function resolveCommunityTaskLineage(
  author: string,
  id: string,
  revisions: readonly CommunityTaskRevision[],
): CommunityTask | null {
  const lineage = revisions.filter(
    (revision) => revision.id === id && revision.content.author === author,
  );
  const own = newestSignedBy(lineage, new Set([author]));
  if (own === null || own.content.deleted) return null;

  const live = lineage.filter((revision) => !revision.content.deleted);
  const honored = honoredCommunityTaskSigners(author, live);
  const newest = newestSignedBy(live, honored);
  if (newest === null) return null;
  return {
    ...newest.content,
    author,
    id,
    key: communityTaskKey(author, id),
    signer: newest.signer,
    eventId: newest.eventId,
    eventCreatedAt: newest.eventCreatedAt,
  };
}

/** Every live card the relay events describe, in no particular order. */
export function mergeCommunityTaskEvents(
  events: readonly RelayEvent[],
): CommunityTask[] {
  const byLineage = new Map<
    string,
    { author: string; id: string; revisions: CommunityTaskRevision[] }
  >();
  for (const event of events) {
    const revision = parseCommunityTaskEvent(event);
    if (!revision) continue;
    const key = communityTaskKey(revision.content.author, revision.id);
    const group = byLineage.get(key);
    if (group) group.revisions.push(revision);
    else {
      byLineage.set(key, {
        author: revision.content.author,
        id: revision.id,
        revisions: [revision],
      });
    }
  }
  const tasks: CommunityTask[] = [];
  for (const { author, id, revisions } of byLineage.values()) {
    const task = resolveCommunityTaskLineage(author, id, revisions);
    if (task) tasks.push(task);
  }
  return tasks;
}

/** The JSON body a revision of `task` starts from, without the display-only identity fields. */
export function communityTaskContentOf(
  task: CommunityTask,
): CommunityTaskContent {
  const content: CommunityTaskContent = {
    author: task.author,
    title: task.title,
    body: task.body,
    status: task.status,
    assignees: task.assignees,
    order: task.order,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
  if (task.due !== undefined) content.due = task.due;
  return content;
}

export function canEditCommunityTask(
  task: Pick<CommunityTask, "author" | "assignees">,
  viewerPubkey: string | null | undefined,
): boolean {
  if (!viewerPubkey) return false;
  const viewer = normalizePubkey(viewerPubkey);
  return task.author === viewer || task.assignees.includes(viewer);
}

export function canDeleteCommunityTask(
  task: Pick<CommunityTask, "author">,
  viewerPubkey: string | null | undefined,
): boolean {
  return (
    Boolean(viewerPubkey) && task.author === normalizePubkey(viewerPubkey ?? "")
  );
}

function eventDTag(event: RelayEvent): string | null {
  const tag = event.tags.find((entry) => entry[0] === "d");
  return typeof tag?.[1] === "string" ? tag[1] : null;
}

/**
 * Folds one relay event into the cached event list. The relay keeps one
 * event per (signer, d-tag), so a newer event for the same key replaces the
 * cached one; an older or duplicate arrival — a live echo of something the
 * history fetch already returned — leaves the array untouched, by reference,
 * so React Query consumers do not re-render for nothing.
 */
export function upsertCommunityTaskEvent(
  events: readonly RelayEvent[],
  incoming: RelayEvent,
): RelayEvent[] {
  const dTag = eventDTag(incoming);
  if (dTag === null || communityTaskIdFromDTag(dTag) === null) {
    return events as RelayEvent[];
  }
  const signer = normalizePubkey(incoming.pubkey);
  const index = events.findIndex(
    (event) =>
      normalizePubkey(event.pubkey) === signer && eventDTag(event) === dTag,
  );
  if (index === -1) return [...events, incoming];
  const existing = events[index];
  const newer =
    incoming.created_at > existing.created_at ||
    (incoming.created_at === existing.created_at && incoming.id < existing.id);
  if (!newer) return events as RelayEvent[];
  const next = [...events];
  next[index] = incoming;
  return next;
}

/**
 * The newest `created_at` this signer has used for this card, or undefined
 * if they never published one. The relay only compares a replacement with
 * the *same* signer's previous event, and rejects anything more than
 * fifteen minutes off its own clock — so the floor for the next event is
 * the signer's own previous one, never another member's (whose clock may
 * be skewed).
 */
export function latestOwnCommunityTaskEventCreatedAt(
  events: readonly RelayEvent[],
  id: string,
  signer: string,
): number | undefined {
  const normalizedSigner = normalizePubkey(signer);
  let latest: number | undefined;
  for (const event of events) {
    if (normalizePubkey(event.pubkey) !== normalizedSigner) continue;
    const dTag = eventDTag(event);
    if (dTag === null || communityTaskIdFromDTag(dTag) !== id) continue;
    if (latest === undefined || event.created_at > latest) {
      latest = event.created_at;
    }
  }
  return latest;
}
