import type { RelayEvent } from "@/shared/api/types";
import {
  COMMUNITY_TASK_D_TAG_PREFIX,
  COMMUNITY_TASK_T_TAG,
  KIND_COMMUNITY_TASK,
} from "@/shared/constants/kinds";
import { normalizePubkey } from "@/shared/lib/pubkey";

export const COMMUNITY_TASK_STATUSES = ["todo", "doing", "done"] as const;
export type CommunityTaskStatus = (typeof COMMUNITY_TASK_STATUSES)[number];

/**
 * The JSON body of one `community-task:<id>` event.
 *
 * A card is a NIP-33 replaceable event, and replaceable events are keyed by
 * (signer, kind, d-tag) — so when an assignee edits a card they cannot
 * overwrite the creator's event, they publish a second one under their own
 * key. `author` names the creator so every reader can tell whose lineage a
 * revision belongs to; see `communityTaskMerge.ts` for how the revisions of
 * several signers collapse into one card.
 */
export type CommunityTaskContent = {
  /** Creator's hex pubkey. Every revision, whoever signs it, carries it. */
  author: string;
  title: string;
  /** Markdown. */
  body: string;
  status: CommunityTaskStatus;
  /** Lowercase hex pubkeys, de-duplicated. */
  assignees: string[];
  /** Unix seconds (local midnight of the chosen day). */
  due?: number;
  /** Position inside a column; lower sorts first. */
  order: number;
  /** Unix seconds; set once, preserved by every revision. */
  createdAt: number;
  /** Unix seconds; bumped by every revision. */
  updatedAt: number;
  /** Tombstone. Only honored when the signer is `author`. */
  deleted?: true;
};

/** One signed revision of a card, as it arrived from the relay. */
export type CommunityTaskRevision = {
  id: string;
  content: CommunityTaskContent;
  /** Lowercase hex pubkey of the event signer. */
  signer: string;
  eventId: string;
  eventCreatedAt: number;
};

const HEX_PUBKEY = /^[0-9a-f]{64}$/;
const TASK_ID = /^[A-Za-z0-9._:-]{1,128}$/;
export const COMMUNITY_TASK_TITLE_MAX_LENGTH = 256;

export function isCommunityTaskStatus(
  value: unknown,
): value is CommunityTaskStatus {
  return (
    typeof value === "string" &&
    (COMMUNITY_TASK_STATUSES as readonly string[]).includes(value)
  );
}

export function isValidCommunityTaskId(id: string): boolean {
  return TASK_ID.test(id);
}

export function isHexPubkey(value: string): boolean {
  return HEX_PUBKEY.test(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function unixSeconds(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? Math.floor(number) : null;
}

/** Lowercases, de-duplicates, and drops anything that is not a hex pubkey. */
export function normalizeCommunityTaskAssignees(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const pubkey = normalizePubkey(entry);
    if (HEX_PUBKEY.test(pubkey)) seen.add(pubkey);
  }
  return [...seen];
}

/**
 * Validates a decoded JSON body. Returns null when a required field is
 * missing or of the wrong shape; a malformed optional field (`due`,
 * `assignees` entries) is dropped rather than hiding the whole card.
 */
export function parseCommunityTaskContent(
  value: unknown,
): CommunityTaskContent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.author !== "string") return null;
  const author = normalizePubkey(candidate.author);
  if (!HEX_PUBKEY.test(author)) return null;
  if (typeof candidate.title !== "string") return null;
  if (!isCommunityTaskStatus(candidate.status)) return null;
  const order = finiteNumber(candidate.order);
  const createdAt = unixSeconds(candidate.createdAt);
  const updatedAt = unixSeconds(candidate.updatedAt);
  if (order === null || createdAt === null || updatedAt === null) return null;
  const content: CommunityTaskContent = {
    author,
    title: candidate.title,
    body: typeof candidate.body === "string" ? candidate.body : "",
    status: candidate.status,
    assignees: normalizeCommunityTaskAssignees(candidate.assignees),
    order,
    createdAt,
    updatedAt,
  };
  const due = unixSeconds(candidate.due);
  if (due !== null) content.due = due;
  if (candidate.deleted === true) content.deleted = true;
  return content;
}

/** Fixed key order so two equal cards serialize to the same bytes. */
export function serializeCommunityTaskContent(
  content: CommunityTaskContent,
): string {
  const wire: Record<string, unknown> = {
    title: content.title,
    body: content.body,
    status: content.status,
    assignees: content.assignees,
  };
  if (content.due !== undefined) wire.due = content.due;
  wire.order = content.order;
  wire.createdAt = content.createdAt;
  wire.updatedAt = content.updatedAt;
  if (content.deleted === true) wire.deleted = true;
  wire.author = content.author;
  return JSON.stringify(wire);
}

export function communityTaskDTag(id: string): string {
  return `${COMMUNITY_TASK_D_TAG_PREFIX}${id}`;
}

export function communityTaskIdFromDTag(dTag: string): string | null {
  if (!dTag.startsWith(COMMUNITY_TASK_D_TAG_PREFIX)) return null;
  const id = dTag.slice(COMMUNITY_TASK_D_TAG_PREFIX.length);
  return isValidCommunityTaskId(id) ? id : null;
}

/** The tag set every card event carries: its d-tag plus the board-wide t-tag. */
export function communityTaskTags(id: string): string[][] {
  return [
    ["d", communityTaskDTag(id)],
    ["t", COMMUNITY_TASK_T_TAG],
  ];
}

export function newCommunityTaskId(): string {
  return crypto.randomUUID();
}

function singleDTag(event: RelayEvent): string | null {
  const dTags = event.tags.filter((tag) => tag[0] === "d");
  // Exactly one d-tag, like the relay's own NIP-RS cardinality rule: a second
  // one would make the replaceable key ambiguous.
  if (dTags.length !== 1) return null;
  const value = dTags[0][1];
  return typeof value === "string" ? value : null;
}

/** Decodes a relay event into a revision, or null if it is not a valid card. */
export function parseCommunityTaskEvent(
  event: RelayEvent,
): CommunityTaskRevision | null {
  if (event.kind !== KIND_COMMUNITY_TASK) return null;
  const dTag = singleDTag(event);
  if (dTag === null) return null;
  const id = communityTaskIdFromDTag(dTag);
  if (id === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(event.content);
  } catch {
    return null;
  }
  const content = parseCommunityTaskContent(json);
  if (!content) return null;
  return {
    id,
    content,
    signer: normalizePubkey(event.pubkey),
    eventId: event.id,
    eventCreatedAt: event.created_at,
  };
}

/**
 * A clock reading that is guaranteed to sort after `previous`. Replaceable
 * events and the card's own `updatedAt` are both last-writer-wins, so a
 * revision written from a lagging clock must still land after the one it
 * replaces.
 */
export function nextMonotonicSeconds(
  nowSeconds: number,
  previous: number | undefined,
): number {
  const floor = previous === undefined ? 0 : previous + 1;
  return Math.max(Math.floor(nowSeconds), floor);
}

/**
 * The tombstone that retires a card. Text and assignees are blanked so the
 * relay keeps nothing but the card's identity and its timestamps.
 */
export function tombstoneCommunityTaskContent(
  content: CommunityTaskContent,
  nowSeconds: number,
): CommunityTaskContent {
  return {
    author: content.author,
    title: "",
    body: "",
    status: content.status,
    assignees: [],
    order: content.order,
    createdAt: content.createdAt,
    updatedAt: nextMonotonicSeconds(nowSeconds, content.updatedAt),
    deleted: true,
  };
}
