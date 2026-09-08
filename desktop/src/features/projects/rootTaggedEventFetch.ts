import { relayClient } from "@/shared/api/relayClient";
import type { RelayEvent } from "@/shared/api/types";

type FetchEventsInput = Parameters<(typeof relayClient)["fetchEvents"]>[0];

export type FetchEvents = (filter: FetchEventsInput) => Promise<RelayEvent[]>;

const PAGE_LIMIT = 500;

/**
 * The relay clamps every REQ page to this many rows regardless of the
 * requested `limit` (`DEFAULT_MAX_PAGE_LIMIT` in `crates/buzz-db/src/event.rs`).
 * A single second denser than this is unreachable through NIP-01 pagination,
 * so the loop below reports it as an error instead of silently dropping rows.
 */
const RELAY_MAX_PAGE_LIMIT = 1_000;

/** Root ids per relay query. Each id adds one JSONB containment clause to the
 * relay's SQL, so batches are kept small enough to stay cheap while still
 * collapsing typical projects into a single query. */
const ROOT_ID_CHUNK_SIZE = 100;

export type RootTaggedEventFetchInput = {
  fetchEvents?: FetchEvents;
  kinds: number[];
  /** Event ids the wanted events reference through an `e` tag. */
  rootIds: string[];
  signal?: AbortSignal;
  /** Names for the error raised when one second is denser than a relay page. */
  subject: { history: string; rows: string };
};

/**
 * Loads every event of the given kinds that references one of the given
 * roots, paginating to exhaustion instead of trusting a bounded window.
 *
 * The filter deliberately carries ONLY constraints the relay pushes into SQL
 * before applying `LIMIT`: kinds, `#e`, `until`, `limit` (see
 * `filter_fully_pushable` in `crates/buzz-relay/src/handlers/req.rs`). Tag
 * filters like `#t`/`#a` are post-filtered in Rust AFTER the SQL `LIMIT`, so
 * including them would make a short page meaningless — the newest N candidate
 * rows could all be post-filtered away while older matches remain, and the
 * loop would declare exhaustion having seen nothing. Callers that need a
 * tag-level narrowing (assignment labels, say) filter locally on the result.
 *
 * Pagination uses an inclusive `until` cursor with id-level dedupe. The relay
 * orders `(created_at DESC, id ASC)`, so a full page whose oldest timestamp
 * equals the cursor means a single second denser than the page: the loop
 * escalates `limit` to the relay's hard page clamp once, and if the second is
 * denser than even that, throws — the caller surfaces a failed section
 * instead of silently losing rows. NIP-01 filters cannot express the relay's
 * composite `(created_at, id)` keyset cursor, so this is the strongest
 * client-only guarantee available.
 */
export async function fetchRootTaggedEvents({
  fetchEvents = relayClient.fetchEvents.bind(relayClient),
  kinds,
  rootIds,
  signal,
  subject,
}: RootTaggedEventFetchInput): Promise<RelayEvent[]> {
  if (rootIds.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < rootIds.length; i += ROOT_ID_CHUNK_SIZE) {
    chunks.push(rootIds.slice(i, i + ROOT_ID_CHUNK_SIZE));
  }
  const pages = await Promise.all(
    chunks.map((chunk) =>
      fetchChunkExhaustively(kinds, chunk, fetchEvents, signal, subject),
    ),
  );
  const seen = new Map<string, RelayEvent>();
  for (const page of pages) {
    for (const event of page) {
      if (!seen.has(event.id)) seen.set(event.id, event);
    }
  }
  return [...seen.values()];
}

async function fetchChunkExhaustively(
  kinds: number[],
  rootIds: string[],
  fetchEvents: FetchEvents,
  signal: AbortSignal | undefined,
  subject: RootTaggedEventFetchInput["subject"],
): Promise<RelayEvent[]> {
  const seen = new Map<string, RelayEvent>();
  let limit = PAGE_LIMIT;
  let until: number | undefined;
  for (;;) {
    // Leaving the surface cancels its queries; stop queuing pages behind the
    // next surface's fetches.
    signal?.throwIfAborted();
    const page = await fetchEvents({
      kinds,
      "#e": rootIds,
      limit,
      ...(until === undefined ? {} : { until }),
    });
    for (const event of page) {
      if (!seen.has(event.id)) seen.set(event.id, event);
    }
    // Only SQL-pushed constraints are in the filter, so a short page is a
    // true end-of-results signal.
    if (page.length < limit) break;
    const oldest = Math.min(...page.map((event) => event.created_at));
    if (until === undefined || oldest < until) {
      until = oldest;
      continue;
    }
    // Full page and the inclusive cursor cannot advance: every row shares
    // the cursor second. Widen to the relay's hard clamp so the whole second
    // fits in one page; beyond that, no NIP-01 filter can reach the rest.
    if (limit < RELAY_MAX_PAGE_LIMIT) {
      limit = RELAY_MAX_PAGE_LIMIT;
      continue;
    }
    throw new Error(
      `Could not load ${subject.history}: more than a full relay page of ` +
        `${subject.rows} share one timestamp.`,
    );
  }
  return [...seen.values()];
}
