/**
 * Per-relay memory of whether the relay accepts the dedicated doc kind
 * (30623).
 *
 * The production community relay may be a stock Buzz relay that predates the
 * dedicated kind; its ingest rejects unknown kinds with OK false
 * `restricted: unknown event kind` (see `required_scope_for_kind` in
 * buzz-relay's ingest.rs). NIP-11 does not advertise supported kinds, so the
 * only reliable probe is the write itself: publish on 30623 first, and when
 * the relay answers "unknown event kind", remember that relay as
 * legacy-only and republish on the shared NIP-78 kind (30078).
 *
 * The verdict is keyed by relay URL in localStorage so it survives app
 * restarts and community switches, and it expires after
 * {@link DEDICATED_KIND_RECHECK_MS} so a relay that gets upgraded is
 * re-probed (one extra rejected publish per interval at worst). There is no
 * module-level cache: every read goes to localStorage, so nothing here needs
 * a `resetCommunityState()` hook.
 */

const STORAGE_KEY_PREFIX = "docs:dedicated-kind-rejected:";

/** How long a "relay rejected 30623" verdict is trusted before re-probing. */
export const DEDICATED_KIND_RECHECK_MS = 24 * 60 * 60 * 1_000;

/**
 * True when `error` is the relay's "I do not know this kind" rejection —
 * the OK false message surfaces verbatim as the publish error. Matched
 * loosely so upstream wording drift ("restricted: unknown event kind" today)
 * does not silently break the fallback; anything else (auth, rate limit,
 * size, timeout) must NOT flip the relay to legacy writes.
 */
export function isUnknownKindRejection(error: unknown): boolean {
  return error instanceof Error && /unknown (event )?kind/i.test(error.message);
}

function storageKey(relayUrl: string): string {
  return `${STORAGE_KEY_PREFIX}${relayUrl}`;
}

function readRejectedAtMs(relayUrl: string): number | null {
  try {
    const raw = window.localStorage.getItem(storageKey(relayUrl));
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    // Storage unavailable (private window, blocked): behave as if the relay
    // was never marked — the write path re-probes and re-marks per session.
    return null;
  }
}

/**
 * True while a "rejected" verdict for this relay is still fresh: writes go
 * to the legacy kind and the migration pass must not run. Once the verdict
 * expires this returns false, so the next write re-probes 30623 (and a
 * failure re-marks the relay via {@link markDedicatedDocKindRejected}).
 */
export function dedicatedDocKindMarkedUnsupported(
  relayUrl: string,
  nowMs: number,
): boolean {
  const rejectedAtMs = readRejectedAtMs(relayUrl);
  return (
    rejectedAtMs !== null && nowMs - rejectedAtMs < DEDICATED_KIND_RECHECK_MS
  );
}

/** Records that `relayUrl` rejected a kind-30623 publish just now. */
export function markDedicatedDocKindRejected(
  relayUrl: string,
  nowMs: number,
): void {
  try {
    window.localStorage.setItem(storageKey(relayUrl), String(nowMs));
  } catch {
    // Best-effort: without storage the verdict lasts only this write, and
    // the next publish probes again.
  }
}

/** Clears the verdict after `relayUrl` accepted a kind-30623 publish. */
export function markDedicatedDocKindAccepted(relayUrl: string): void {
  try {
    window.localStorage.removeItem(storageKey(relayUrl));
  } catch {
    // Best-effort, same as above.
  }
}
