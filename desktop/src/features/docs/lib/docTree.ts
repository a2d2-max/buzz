import type { DocPage } from "./docPageCodec";

export type DocTreeNode = {
  page: DocPage;
  children: DocTreeNode[];
  depth: number;
};

/** Orders two versions of the same page: newer relay `created_at` wins, then the larger event id. */
export function compareDocPageVersions(a: DocPage, b: DocPage): number {
  if (a.eventCreatedAt !== b.eventCreatedAt) {
    return a.eventCreatedAt - b.eventCreatedAt;
  }
  if (a.eventId === b.eventId) return 0;
  return a.eventId < b.eventId ? -1 : 1;
}

/**
 * Collapses every version of every page (any author) into the single newest
 * version per page id. Tombstones take part like any other version, so a
 * newer delete hides the page and a newer edit resurrects it.
 */
export function pickLatestDocPages(
  pages: Iterable<DocPage>,
): Map<string, DocPage> {
  const latest = new Map<string, DocPage>();
  for (const page of pages) {
    const current = latest.get(page.id);
    if (!current || compareDocPageVersions(page, current) > 0) {
      latest.set(page.id, page);
    }
  }
  return latest;
}

/** Sibling order: `order` ascending, then title, then id for a stable tie-break. */
export function compareDocSiblings(a: DocPage, b: DocPage): number {
  if (a.order !== b.order) return a.order - b.order;
  const byTitle = a.title.localeCompare(b.title);
  if (byTitle !== 0) return byTitle;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Builds the nested page tree from flat pages.
 *
 * - Tombstones are dropped; their children surface at the root.
 * - A parent that does not exist (or is deleted) is treated as "no parent".
 * - Parent cycles are broken at the member with the smallest id, which becomes
 *   a root; every other member keeps its parent link, so nothing disappears.
 */
export function buildDocTree(pages: Iterable<DocPage>): DocTreeNode[] {
  const live = new Map<string, DocPage>();
  for (const page of pages) {
    if (!page.deleted) live.set(page.id, page);
  }

  const effectiveParent = new Map<string, string | null>();
  const visitState = new Map<string, "visiting" | "done">();
  for (const start of live.values()) {
    if (visitState.get(start.id) === "done") continue;
    const path: string[] = [];
    let current: DocPage | undefined = start;
    while (current && visitState.get(current.id) !== "done") {
      if (visitState.get(current.id) === "visiting") {
        const cycle = path.slice(path.indexOf(current.id));
        const cycleRoot = cycle.reduce((min, id) => (id < min ? id : min));
        effectiveParent.set(cycleRoot, null);
        break;
      }
      visitState.set(current.id, "visiting");
      path.push(current.id);
      const parentId: string | null =
        current.parentId !== null && live.has(current.parentId)
          ? current.parentId
          : null;
      effectiveParent.set(current.id, parentId);
      current = parentId === null ? undefined : live.get(parentId);
    }
    for (const id of path) visitState.set(id, "done");
  }

  const childrenByParent = new Map<string | null, DocPage[]>();
  for (const page of live.values()) {
    const parentId = effectiveParent.get(page.id) ?? null;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(page);
    childrenByParent.set(parentId, siblings);
  }

  const build = (parentId: string | null, depth: number): DocTreeNode[] =>
    (childrenByParent.get(parentId) ?? [])
      .sort(compareDocSiblings)
      .map((page) => ({
        page,
        depth,
        children: build(page.id, depth + 1),
      }));
  return build(null, 0);
}

/** Depth-first flattening in display order. */
export function flattenDocTree(nodes: DocTreeNode[]): DocTreeNode[] {
  const out: DocTreeNode[] = [];
  const walk = (list: DocTreeNode[]) => {
    for (const node of list) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

export function findDocTreeNode(
  nodes: DocTreeNode[],
  id: string,
): DocTreeNode | null {
  for (const node of nodes) {
    if (node.page.id === id) return node;
    const found = findDocTreeNode(node.children, id);
    if (found) return found;
  }
  return null;
}

/** Ids of every page below `id` (excluding `id` itself). */
export function collectDescendantIds(
  nodes: DocTreeNode[],
  id: string,
): Set<string> {
  const target = findDocTreeNode(nodes, id);
  const ids = new Set<string>();
  if (!target) return ids;
  for (const node of flattenDocTree(target.children)) ids.add(node.page.id);
  return ids;
}

/**
 * Sort key for a page appended after `level` — the pages the tree actually
 * renders at that level (pass a node's children or the roots), so orphans
 * that surfaced there count too.
 */
export function nextOrderAfter(level: Iterable<DocPage>): number {
  let max: number | null = null;
  for (const page of level) {
    if (page.deleted) continue;
    max = max === null ? page.order : Math.max(max, page.order);
  }
  return max === null ? 0 : max + 1;
}

/**
 * Applies one incoming version to the id→page map. Returns the same map
 * instance when the version is stale or already known, so callers that key
 * on identity (React state, react-query) skip a render.
 */
export function applyDocPageVersion(
  pages: Map<string, DocPage>,
  incoming: DocPage,
): Map<string, DocPage> {
  const current = pages.get(incoming.id);
  if (current && compareDocPageVersions(incoming, current) <= 0) return pages;
  const next = new Map(pages);
  next.set(incoming.id, incoming);
  return next;
}

/** How far ahead of the local clock a version may sit before we stop chasing it. */
export const DOC_MAX_CLOCK_SKEW_SECONDS = 300;

/**
 * `created_at` for a new version: the current time, bumped past the newest
 * version we already know so a skewed clock can never publish an edit that
 * loses last-write-wins to the copy it was based on. Returns `null` when the
 * known version is stamped further ahead than `maxSkewSeconds`: chasing it
 * would ratchet every later edit into the future, so the caller must surface
 * the skew instead of publishing.
 */
export function nextDocEventCreatedAt(
  nowSeconds: number,
  lastKnownSeconds: number | undefined,
  maxSkewSeconds = DOC_MAX_CLOCK_SKEW_SECONDS,
): number | null {
  if (lastKnownSeconds === undefined) return nowSeconds;
  const next = Math.max(nowSeconds, lastKnownSeconds + 1);
  return next > nowSeconds + maxSkewSeconds ? null : next;
}

/**
 * New `order` for `siblings[index]` after moving it one slot up (-1) or down
 * (+1); `null` when already at that edge. Uses the gap between neighbours so a
 * reorder is a single republish of the moved page. When neighbouring orders
 * collide the page steps just past the neighbour instead of between them.
 */
export function reorderedSiblingOrder(
  siblings: readonly DocPage[],
  index: number,
  direction: -1 | 1,
): number | null {
  if (index < 0 || index >= siblings.length) return null;
  if (direction === -1) {
    if (index === 0) return null;
    const previous = siblings[index - 1];
    if (index === 1) return previous.order - 1;
    const beforePrevious = siblings[index - 2];
    const midpoint = (beforePrevious.order + previous.order) / 2;
    return midpoint > beforePrevious.order && midpoint < previous.order
      ? midpoint
      : previous.order - 1;
  }
  const last = siblings.length - 1;
  if (index === last) return null;
  const next = siblings[index + 1];
  if (index + 1 === last) return next.order + 1;
  const afterNext = siblings[index + 2];
  const midpoint = (next.order + afterNext.order) / 2;
  return midpoint > next.order && midpoint < afterNext.order
    ? midpoint
    : next.order + 1;
}

/** The rendered level (roots, or a parent's children) that contains `id`. */
export function findDocTreeSiblings(
  nodes: DocTreeNode[],
  id: string,
): DocTreeNode[] | null {
  if (nodes.some((node) => node.page.id === id)) return nodes;
  for (const node of nodes) {
    const found = findDocTreeSiblings(node.children, id);
    if (found) return found;
  }
  return null;
}

/** Pages from the root down to `id` inclusive; empty when `id` is not in the tree. */
export function findDocTreePath(nodes: DocTreeNode[], id: string): DocPage[] {
  for (const node of nodes) {
    if (node.page.id === id) return [node.page];
    const below = findDocTreePath(node.children, id);
    if (below.length > 0) return [node.page, ...below];
  }
  return [];
}
