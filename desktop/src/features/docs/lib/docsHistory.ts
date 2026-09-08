import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_COMMUNITY_DOC } from "@/shared/constants/kinds";

import { type DocPage, parseDocPageEvent } from "./docPageCodec";

/** Rows per REQ. The relay clamps at 1000 (`DEFAULT_MAX_PAGE_LIMIT`), so this is the ceiling. */
export const DOCS_HISTORY_PAGE_LIMIT = 1_000;
/** Hard stop on how many pages one load walks, so a huge community bounds the scan. */
export const DOCS_HISTORY_MAX_PAGES = 30;

export type DocsHistoryResult = {
  pages: DocPage[];
  /** True when the scan stopped before the window was exhausted: some pages may be missing. */
  truncated: boolean;
  /** Kind-30078 rows inspected, docs or not. */
  scanned: number;
};

/**
 * Loads every community-doc page version by walking the whole kind-30078
 * window with the `until` time cursor (or the part of it at or after `since`
 * for an incremental refresh).
 *
 * This depends on one relay property: a `kinds`-only REQ for 30078 drops no
 * SQL row after the fact. That holds today because 30078 sits in none of the
 * post-filter gates (`AUTHOR_ONLY_KINDS`, `P_GATED_KINDS`,
 * `RESULT_GATED_KINDS` in buzz-core's kind.rs) and is global-only, so a page
 * shorter than `limit` really is the end of the window. If the docs kind is
 * ever added to one of those gates, short pages stop meaning "exhausted" and
 * this scan must switch to a cursor that survives post-filtering.
 *
 * The relay applies `#t` in memory *after* the SQL `LIMIT` (only `#d`/`#e`/`#p`
 * are pushed down), and kind 30078 is shared with read-state and every other
 * per-user setting blob. A single `#t`-filtered REQ therefore returns only the
 * docs that happen to sit inside the newest 1000 rows — and a short reply
 * cannot even tell us whether the window was exhausted. Asking for the kind
 * alone makes `limit` exact again: a short page means the window is done, and
 * every row's `created_at` is visible to advance the cursor. The `t` filter
 * is applied here, per event.
 *
 * `until` is inclusive, so boundary rows come back twice; `seen` dedupes them.
 * A full page whose oldest row does not move the cursor means more than a page
 * of rows share one second — the WS filter has no `(created_at, id)` cursor to
 * escape that, so the scan reports `truncated` rather than spinning.
 */
export async function fetchDocPagesToExhaustion({
  fetchEvents,
  maxPages = DOCS_HISTORY_MAX_PAGES,
  pageLimit = DOCS_HISTORY_PAGE_LIMIT,
  since,
}: {
  fetchEvents: (filter: RelaySubscriptionFilter) => Promise<RelayEvent[]>;
  maxPages?: number;
  pageLimit?: number;
  /** Inclusive lower bound for an incremental scan; omit for a full one. */
  since?: number;
}): Promise<DocsHistoryResult> {
  const pages: DocPage[] = [];
  const seen = new Set<string>();
  let until: number | undefined;
  let truncated = false;
  let scanned = 0;

  for (let pageIndex = 0; ; pageIndex += 1) {
    if (pageIndex >= maxPages) {
      truncated = true;
      break;
    }
    const batch = await fetchEvents({
      kinds: [KIND_COMMUNITY_DOC],
      limit: pageLimit,
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
    });

    let oldest = Number.POSITIVE_INFINITY;
    let added = 0;
    for (const event of batch) {
      if (event.created_at < oldest) oldest = event.created_at;
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      added += 1;
      scanned += 1;
      const page = parseDocPageEvent(event);
      if (page) pages.push(page);
    }

    if (batch.length < pageLimit) break;
    if ((until !== undefined && oldest >= until) || added === 0) {
      truncated = true;
      break;
    }
    until = oldest;
  }

  return { pages, truncated, scanned };
}
