// Docs 페이지 해석. desktop/src/features/docs/lib/docPageCodec.ts +
// docTree.ts 의 읽기 부분만 옮겨 왔다(쓰기·마이그레이션은 TV 범위 밖).
// 전용 kind 30623 우선, 이전 자리 30078 도 같이 읽고, 같은 페이지의 여러 판은
// relay created_at 최신 판이 이긴다(동률이면 event id 큰 쪽).

import type { NostrEvent } from "../../shared/lib/relay.ts";
import {
  COMMUNITY_DOC_D_PREFIX,
  COMMUNITY_DOC_TAG,
  KIND_COMMUNITY_DOC,
  KIND_COMMUNITY_DOC_LEGACY,
} from "../../shared/lib/kinds.ts";

export type DocPage = {
  id: string;
  title: string;
  /** 마크다운 원문. */
  body: string;
  parentId: string | null;
  order: number;
  icon?: string;
  deleted: boolean;
  eventId: string;
  eventCreatedAt: number;
  eventKind: number;
  author: string;
};

const PAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function docPageIdFromDTag(dTag: string): string | null {
  if (!dTag.startsWith(COMMUNITY_DOC_D_PREFIX)) return null;
  const id = dTag.slice(COMMUNITY_DOC_D_PREFIX.length);
  return PAGE_ID_PATTERN.test(id) ? id : null;
}

function finiteNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function parseDocPageEvent(event: NostrEvent): DocPage | null {
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

  const parentId =
    typeof content.parentId === "string" &&
    content.parentId.length > 0 &&
    content.parentId !== id
      ? content.parentId
      : null;
  const page: DocPage = {
    id,
    title: content.title,
    body: content.body,
    parentId,
    order: finiteNumberOr(content.order, 0),
    deleted: content.deleted === true,
    eventId: event.id,
    eventCreatedAt: event.created_at,
    eventKind: event.kind,
    author: event.pubkey,
  };
  if (typeof content.icon === "string" && content.icon.length > 0) {
    page.icon = content.icon;
  }
  return page;
}

/** 같은 페이지의 두 판을 비교: created_at 최신이 이기고, 동률이면 event id 큰 쪽. */
export function compareDocPageVersions(a: DocPage, b: DocPage): number {
  if (a.eventCreatedAt !== b.eventCreatedAt) {
    return a.eventCreatedAt - b.eventCreatedAt;
  }
  if (a.eventId === b.eventId) return 0;
  return a.eventId < b.eventId ? -1 : 1;
}

export type DocListEntry = DocPage & { depth: number };

/**
 * 이벤트 뭉치 → 목록에 보일 페이지(들여쓰기 깊이 포함).
 * 페이지별 최신 판만 남기고, 지워진 페이지는 빼고(그 자식은 루트로 올리고),
 * 형제끼리는 order → title → id 순으로 정렬해 트리를 펼친다.
 */
export function buildDocList(events: NostrEvent[]): DocListEntry[] {
  const latest = new Map<string, DocPage>();
  for (const event of events) {
    const page = parseDocPageEvent(event);
    if (!page) continue;
    const current = latest.get(page.id);
    if (!current || compareDocPageVersions(page, current) > 0) {
      latest.set(page.id, page);
    }
  }

  const alive = [...latest.values()].filter((page) => !page.deleted);
  const aliveIds = new Set(alive.map((page) => page.id));
  const childrenOf = new Map<string | null, DocPage[]>();
  for (const page of alive) {
    // 부모가 없거나 지워졌으면 루트로 올린다. 자기 조상으로 이어지는
    // 고리는 방문 표시(visited)로 끊는다.
    const parent =
      page.parentId && aliveIds.has(page.parentId) ? page.parentId : null;
    const siblings = childrenOf.get(parent) ?? [];
    siblings.push(page);
    childrenOf.set(parent, siblings);
  }

  const compareSiblings = (a: DocPage, b: DocPage): number => {
    if (a.order !== b.order) return a.order - b.order;
    const byTitle = a.title.localeCompare(b.title);
    if (byTitle !== 0) return byTitle;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };

  const result: DocListEntry[] = [];
  const visited = new Set<string>();
  const walk = (parent: string | null, depth: number): void => {
    const siblings = (childrenOf.get(parent) ?? []).sort(compareSiblings);
    for (const page of siblings) {
      if (visited.has(page.id)) continue;
      visited.add(page.id);
      result.push({ ...page, depth });
      walk(page.id, depth + 1);
    }
  };
  walk(null, 0);
  // 부모 고리에 갇혀 walk 가 못 닿은 페이지는 루트 취급으로 뒤에 붙인다.
  for (const page of alive.sort(compareSiblings)) {
    if (!visited.has(page.id)) {
      visited.add(page.id);
      result.push({ ...page, depth: 0 });
    }
  }
  return result;
}
