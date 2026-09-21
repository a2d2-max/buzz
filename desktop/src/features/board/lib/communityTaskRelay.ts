import { relayClient } from "@/shared/api/relayClient";
import type { LiveSubscriptionReadiness } from "@/shared/api/relayClientShared";
import { signRelayEvent } from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import {
  COMMUNITY_TASK_T_TAG,
  KIND_COMMUNITY_TASK,
} from "@/shared/constants/kinds";
import {
  type CommunityTaskContent,
  communityTaskDTag,
  communityTaskIdFromDTag,
  communityTaskTags,
  serializeCommunityTaskContent,
} from "./communityTaskCodec";

/**
 * Rows per history page. Well under the relay's 1,000-row clamp (NIP-11
 * `max_limit`), so a page that comes back full unambiguously means "there
 * may be more" and a short page means "that was the last one".
 */
export const COMMUNITY_TASK_HISTORY_PAGE_LIMIT = 500;
/** Hard stop on paging: 20,000 app-data rows is more than any board needs. */
export const COMMUNITY_TASK_HISTORY_MAX_PAGES = 40;

/** Whether an event's single d-tag names a card, without decoding the body. */
export function isCommunityTaskEvent(event: RelayEvent): boolean {
  if (event.kind !== KIND_COMMUNITY_TASK) return false;
  const dTags = event.tags.filter((tag) => tag[0] === "d");
  return (
    dTags.length === 1 &&
    typeof dTags[0][1] === "string" &&
    communityTaskIdFromDTag(dTags[0][1]) !== null
  );
}

/** The last row of a relay page in relay order (`created_at DESC, id ASC`). */
function pageTail(events: readonly RelayEvent[]): RelayEvent | null {
  let tail: RelayEvent | null = null;
  for (const event of events) {
    if (
      tail === null ||
      event.created_at < tail.created_at ||
      (event.created_at === tail.created_at && event.id > tail.id)
    ) {
      tail = event;
    }
  }
  return tail;
}

/**
 * Every card event on the active relay, from every signer.
 *
 * The relay only pushes `kinds`, `authors`, `#d`, `#e` and `#p` into SQL; a
 * `#t` filter is applied *after* the row limit. One `#t` request would
 * therefore return the newest N kind:30078 rows of the community — mostly
 * read-state and sidebar blobs — minus everything that is not a card, and
 * cards older than that window would silently vanish. So history is read as
 * plain kind:30078 pages, walked to the end with the relay's keyset cursor,
 * and the cards are picked out here by d-tag. The `t` tag still earns its
 * keep on the live subscription, where there is no limit to fall behind.
 */
export function fetchCommunityTaskEvents(): Promise<RelayEvent[]> {
  return fetchCommunityTaskAppData(isCommunityTaskEvent);
}

/** Bounded app-data history walk shared by tasks and their field definitions. */
export async function fetchCommunityTaskAppData(
  accept: (event: RelayEvent) => boolean,
): Promise<RelayEvent[]> {
  const cards: RelayEvent[] = [];
  const seen = new Set<string>();
  let cursor: { until: number; before_id: string } | undefined;
  for (let page = 0; page < COMMUNITY_TASK_HISTORY_MAX_PAGES; page += 1) {
    const events = await relayClient.fetchEvents({
      kinds: [KIND_COMMUNITY_TASK],
      limit: COMMUNITY_TASK_HISTORY_PAGE_LIMIT,
      ...cursor,
    });
    for (const event of events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      if (accept(event)) cards.push(event);
    }
    const tail = pageTail(events);
    if (tail === null || events.length < COMMUNITY_TASK_HISTORY_PAGE_LIMIT) {
      return cards;
    }
    // A full page that hands back the cursor we sent cannot be walked past;
    // pretending it was the last page would drop every older card. Fail
    // loudly so the board shows an error rather than a quietly short list.
    if (cursor?.until === tail.created_at && cursor.before_id === tail.id) {
      throw new Error(
        "Could not load tasks: the relay's history cursor did not advance.",
      );
    }
    cursor = { until: tail.created_at, before_id: tail.id };
  }
  throw new Error(
    "Could not load tasks: the history limit was reached. Narrow the community history before retrying.",
  );
}

/** Every signer's current event for one card — at most one row per signer. */
const CARD_EVENTS_LIMIT = 100;

/**
 * What the relay currently holds for one card, from every signer. Unlike
 * `#t`, a `#d` filter on a NIP-33 kind is pushed into SQL, so this is one
 * cheap, exact query — the right tool for reconciling a card after a write.
 */
export function fetchCommunityTaskCardEvents(
  id: string,
): Promise<RelayEvent[]> {
  return relayClient.fetchEvents({
    kinds: [KIND_COMMUNITY_TASK],
    "#d": [communityTaskDTag(id)],
    limit: CARD_EVENTS_LIMIT,
  });
}

/**
 * Signs one revision with the app identity (the same Tauri `sign_event`
 * path the other kind:30078 writers use) and publishes it. Resolves with the
 * signed event so the caller can fold it into its cache without waiting for
 * the relay to echo it back.
 */
export async function publishCommunityTaskRevision({
  content,
  createdAt,
  id,
}: {
  content: CommunityTaskContent;
  createdAt: number;
  id: string;
}): Promise<RelayEvent> {
  const event = await signRelayEvent({
    kind: KIND_COMMUNITY_TASK,
    content: serializeCommunityTaskContent(content),
    createdAt,
    tags: communityTaskTags(id),
  });
  await relayClient.publishEvent(
    event,
    "Timed out saving the task.",
    "Failed to save the task.",
  );
  return event;
}

/**
 * Live card events from every signer. Resolves with the unsubscribe. The
 * `#t` filter is safe here: a live subscription has no row limit for the
 * relay's post-filter to fall behind.
 */
export function subscribeCommunityTaskEvents(
  onEvent: (event: RelayEvent) => void,
  onReady?: (readiness: LiveSubscriptionReadiness) => void,
): Promise<() => Promise<void>> {
  return relayClient.subscribeLive(
    { kinds: [KIND_COMMUNITY_TASK], "#t": [COMMUNITY_TASK_T_TAG], limit: 0 },
    onEvent,
    onReady,
  );
}
