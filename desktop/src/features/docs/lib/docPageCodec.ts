import type { RelayEvent } from "@/shared/api/types";
import {
  COMMUNITY_DOC_D_PREFIX,
  COMMUNITY_DOC_TAG,
  KIND_COMMUNITY_DOC,
  KIND_COMMUNITY_DOC_LEGACY,
} from "@/shared/constants/kinds";
import { DOC_PAGE_ID_PATTERN } from "@/shared/lib/docsPageLink";

export {
  COMMUNITY_DOC_TAG,
  KIND_COMMUNITY_DOC,
  KIND_COMMUNITY_DOC_LEGACY,
} from "@/shared/constants/kinds";

/**
 * Every kind a doc page may arrive on: the dedicated kind first, then the
 * legacy shared NIP-78 kind that pre-migration pages still sit on. Reads
 * (history scan, `#d` re-read, live subscription) must cover both until the
 * legacy window is retired; writes use `KIND_COMMUNITY_DOC` only.
 */
export const COMMUNITY_DOC_QUERY_KINDS: readonly number[] = [
  KIND_COMMUNITY_DOC,
  KIND_COMMUNITY_DOC_LEGACY,
];

/** JSON body of a page event (kind 30623, d="doc:<uuid>", t="community-doc"). */
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
  /**
   * Kind the version arrived on. `KIND_COMMUNITY_DOC_LEGACY` marks a
   * pre-migration page: still authoritative when newest, but the migration
   * pass republishes it onto the dedicated kind.
   */
  eventKind: number;
  deleted: boolean;
};

/**
 * Page ids ride in the `/docs/$pageId` route, so they must be single
 * alphanumeric tokens: no dots (`.`/`..` path segments), no slashes, no
 * leading punctuation. UUIDs pass; anything a hostile publisher could use to
 * shape a URL does not.
 */
/** The id rule lives with the link parser so both agree on what a page id is. */
const PAGE_ID_PATTERN = DOC_PAGE_ID_PATTERN;

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
  if (
    event.kind !== KIND_COMMUNITY_DOC &&
    event.kind !== KIND_COMMUNITY_DOC_LEGACY
  ) {
    return null;
  }
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
    eventKind: event.kind,
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

/** True when the two would render and sort identically; timestamps are ignored. */
export function docPageContentEquals(
  a: DocPageContent,
  b: DocPageContent,
): boolean {
  return (
    a.title === b.title &&
    a.body === b.body &&
    a.parentId === b.parentId &&
    a.order === b.order &&
    (a.icon ?? undefined) === (b.icon ?? undefined) &&
    Boolean(a.deleted) === Boolean(b.deleted)
  );
}

/** UTF-8 size of the event content the page would be published with. */
export function measureDocPageContentBytes(
  page: DocPageContent & { id: string },
): number {
  return new TextEncoder().encode(buildDocPageEventInput(page).content).length;
}

/**
 * Unsigned event input for `signRelayEvent`; `createdAt` is chosen by the
 * caller. `kind` defaults to the dedicated kind; the write path passes
 * `KIND_COMMUNITY_DOC_LEGACY` for a relay that rejects 30623 as unknown
 * (see `docKindSupport.ts`).
 */
export function buildDocPageEventInput(
  page: DocPageContent & { id: string },
  kind: number = KIND_COMMUNITY_DOC,
): {
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
    kind,
    content: JSON.stringify(content),
    tags: [
      ["d", docPageDTag(page.id)],
      ["t", COMMUNITY_DOC_TAG],
    ],
  };
}
