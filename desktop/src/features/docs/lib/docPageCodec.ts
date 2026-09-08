import type { RelayEvent } from "@/shared/api/types";
import {
  COMMUNITY_DOC_D_PREFIX,
  COMMUNITY_DOC_TAG,
  KIND_COMMUNITY_DOC,
} from "@/shared/constants/kinds";

export {
  COMMUNITY_DOC_TAG,
  KIND_COMMUNITY_DOC,
} from "@/shared/constants/kinds";

/** JSON body of a page event (kind 30078, d="doc:<uuid>", t="community-doc"). */
export type DocPageContent = {
  title: string;
  /** Markdown source. */
  body: string;
  /** Parent page id, or `null` for a top-level page. */
  parentId: string | null;
  /** Sibling sort key; lower renders first. */
  order: number;
  /** Optional emoji shown next to the title. */
  icon?: string;
  /** Unix milliseconds. */
  createdAt: number;
  /** Unix milliseconds. */
  updatedAt: number;
  /** Tombstone marker. Only literal `true` counts. */
  deleted?: boolean;
};

/** One resolved page version, carrying the relay event it came from. */
export type DocPage = DocPageContent & {
  id: string;
  /** Pubkey that signed this version (not necessarily the page creator). */
  author: string;
  eventId: string;
  /** Relay `created_at` (unix seconds) — the last-write-wins key. */
  eventCreatedAt: number;
  deleted: boolean;
};

/**
 * Page ids ride in the `/docs/$pageId` route, so they must be single
 * alphanumeric tokens: no dots (`.`/`..` path segments), no slashes, no
 * leading punctuation. UUIDs pass; anything a hostile publisher could use to
 * shape a URL does not.
 */
const PAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function docPageDTag(id: string): string {
  return `${COMMUNITY_DOC_D_PREFIX}${id}`;
}

/** Extracts the page id from a `doc:<id>` d-tag; `null` for anything else. */
export function docPageIdFromDTag(dTag: string): string | null {
  if (!dTag.startsWith(COMMUNITY_DOC_D_PREFIX)) return null;
  const id = dTag.slice(COMMUNITY_DOC_D_PREFIX.length);
  return PAGE_ID_PATTERN.test(id) ? id : null;
}

export function createDocPageId(): string {
  return crypto.randomUUID();
}

function finiteNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Decodes a relay event into a page. Returns `null` for events that are not
 * community docs or whose content is malformed; optional fields fall back to
 * safe defaults so one sloppy publisher cannot hide a page from everyone.
 */
export function parseDocPageEvent(event: RelayEvent): DocPage | null {
  if (event.kind !== KIND_COMMUNITY_DOC) return null;
  const dTags = event.tags.filter((tag) => tag[0] === "d");
  if (dTags.length !== 1) return null;
  const id = docPageIdFromDTag(dTags[0][1] ?? "");
  if (!id) return null;
  const tagged = event.tags.some(
    (tag) => tag[0] === "t" && tag[1] === COMMUNITY_DOC_TAG,
  );
  if (!tagged) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const content = raw as Record<string, unknown>;
  if (typeof content.title !== "string") return null;
  if (typeof content.body !== "string") return null;
  if (
    content.parentId !== null &&
    content.parentId !== undefined &&
    typeof content.parentId !== "string"
  ) {
    return null;
  }
  const order = content.order === undefined ? 0 : content.order;
  if (typeof order !== "number" || !Number.isFinite(order)) return null;

  const fallbackMs = event.created_at * 1_000;
  const parentId =
    typeof content.parentId === "string" &&
    content.parentId.length > 0 &&
    content.parentId !== id
      ? content.parentId
      : null;
  const page: DocPage = {
    id,
    author: event.pubkey,
    eventId: event.id,
    eventCreatedAt: event.created_at,
    title: content.title,
    body: content.body,
    parentId,
    order,
    createdAt: finiteNumberOr(content.createdAt, fallbackMs),
    updatedAt: finiteNumberOr(content.updatedAt, fallbackMs),
    deleted: content.deleted === true,
  };
  if (typeof content.icon === "string" && content.icon.length > 0) {
    page.icon = content.icon;
  }
  return page;
}

/** Unsigned event input for `signRelayEvent`; `createdAt` is chosen by the caller. */
export function buildDocPageEventInput(page: DocPageContent & { id: string }): {
  kind: number;
  content: string;
  tags: string[][];
} {
  const content: Record<string, unknown> = {
    title: page.title,
    body: page.body,
    parentId: page.parentId,
    order: page.order,
    ...(page.icon ? { icon: page.icon } : {}),
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    ...(page.deleted ? { deleted: true } : {}),
  };
  return {
    kind: KIND_COMMUNITY_DOC,
    content: JSON.stringify(content),
    tags: [
      ["d", docPageDTag(page.id)],
      ["t", COMMUNITY_DOC_TAG],
    ],
  };
}
