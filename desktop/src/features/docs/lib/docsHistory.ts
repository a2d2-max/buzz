import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";

import {
  COMMUNITY_DOC_QUERY_KINDS,
  type DocPage,
  parseDocPageEvent,
} from "./docPageCodec";

/** Rows per REQ. The relay clamps at 1000 (`DEFAULT_MAX_PAGE_LIMIT`), so this is the ceiling. */
export const DOCS_HISTORY_PAGE_LIMIT = 1_000;
/** Hard stop on how many pages one load walks, so a huge community bounds the scan. */
export const DOCS_HISTORY_MAX_PAGES = 30;

export type DocsHistoryResult = {
  pages: DocPage[];
  /** True when the scan stopped before the window was exhausted: some pages may be missing. */
  truncated: boolean;
  /** Rows inspected across the doc kinds (30623 + legacy 30078), docs or not. */
  scanned: number;
  /**
   * Largest `created_at` among the inspected rows (docs or not), or
   * `undefined` when the scan saw nothing. Relay-validated time, so callers
   * can anchor an incremental follow-up on it without trusting a local clock.
   */
  newestSeen: number | undefined;
};

/**
 * Loads every community-doc page version by walking the doc-kind window
 * (the dedicated kind 30623 plus the legacy 30078 rows pre-migration pages
 * still sit on) with the `until` time cursor (or the part of it at or after
 * `since` for an incremental refresh).
 *
 * This depends on one relay property: a `kinds`-only REQ for these kinds
 * drops no SQL row after the fact. That holds today because neither kind sits
 * in any of the post-filter gates (`AUTHOR_ONLY_KINDS`, `P_GATED_KINDS`,
 * `RESULT_GATED_KINDS`, `SHARED_GATED_KINDS` in buzz-core's kind.rs — pinned
 * by `community_doc_sits_in_no_read_gate` there) and both are global-only, so
 * a page shorter than `limit` really is the end of the window. If a docs kind
 * is ever added to one of those gates, short pages stop meaning "exhausted"
 * and this scan must switch to a cursor that survives post-filtering.
 *
 * The relay applies `#t` in memory *after* the SQL `LIMIT` (only `#d`/`#e`/`#p`
 * are pushed down), and legacy kind 30078 is shared with read-state and every
 * other per-user setting blob. A single `#t`-filtered REQ therefore returns
 * only the docs that happen to sit inside the newest 1000 rows — and a short
 * reply cannot even tell us whether the window was exhausted. Asking for the
 * kinds alone makes `limit` exact again: a short page means the window is
 * done, and every row's `created_at` is visible to advance the cursor. The
 * `t` filter is applied here, per event. (The dedicated kind's window holds
 * only docs; the legacy rows keep the scan honest until they are retired.)
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
  let newestSeen: number | undefined;

  for (let pageIndex = 0; ; pageIndex += 1) {
    if (pageIndex >= maxPages) {
      truncated = true;
      break;
    }
    const batch = await fetchEvents({
      kinds: [...COMMUNITY_DOC_QUERY_KINDS],
      limit: pageLimit,
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
    });

    let oldest = Number.POSITIVE_INFINITY;
    let added = 0;
    for (const event of batch) {
      if (event.created_at < oldest) oldest = event.created_at;
      if (newestSeen === undefined || event.created_at > newestSeen) {
        newestSeen = event.created_at;
      }
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

  return { newestSeen, pages, scanned, truncated };
}
