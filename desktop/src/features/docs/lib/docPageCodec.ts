import { parseDocBlobReference } from "./docBlobReference";
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

/** Versioned, base64 encoded BlockSuite document state. Markdown is its preview. */
export type AffineDocPayload = { version: 1 | 2 | 3; data: string };

/** Validate the bounded envelope before an editor attempts to decode it. */
export function isAffineDocPayload(
  value: unknown,
  maxInlineLength = 262144,
): value is AffineDocPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (data.version === 3) {
    if (typeof data.data !== "string" || data.data.length > 4096) return false;
    try {
      parseDocBlobReference(data.data);
      return true;
    } catch {
      return false;
    }
  }
  return (
    (data.version === 1 || data.version === 2) &&
    typeof data.data === "string" &&
    data.data.length > 0 &&
    data.data.length <= maxInlineLength &&
    data.data.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(data.data)
  );
}

/** JSON body of a page event (kind 30623, d="doc:<uuid>", t="community-doc"). */
export type DocPageContent = {
  title: string;
  /** Markdown source. */
  body: string;
  /** Lossless editor state; never drop when publishing tree or metadata changes. */
  affine?: AffineDocPayload;
  /**
   * CRDT lineage created by a delete. Restores and later edits carry it so a
   * stale pre-delete author head cannot be merged back into the document.
   */
  affineEpoch?: string;
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
  /** Keep unsupported heads visible and refuse writes instead of falling back to old content. */
  unsupportedEditor?: boolean;
  /** Multiple structured branches could not be combined without data loss. */
  structuredMergeConflict?: boolean;
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
  const unsupportedEditor =
    content.affine !== undefined && !isAffineDocPayload(content.affine);
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
    ...(unsupportedEditor ? { unsupportedEditor: true } : {}),
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
  if (
    typeof content.affineEpoch === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      content.affineEpoch,
    )
  ) {
    page.affineEpoch = content.affineEpoch.toLowerCase();
  }
  if (isAffineDocPayload(content.affine))
    page.affine = {
      version: content.affine.version,
      data: content.affine.data,
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
    a.affine?.version === b.affine?.version &&
    a.affine?.data === b.affine?.data &&
    a.affineEpoch === b.affineEpoch &&
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
    ...(page.affine ? { affine: page.affine } : {}),
    ...(page.affineEpoch ? { affineEpoch: page.affineEpoch } : {}),
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
