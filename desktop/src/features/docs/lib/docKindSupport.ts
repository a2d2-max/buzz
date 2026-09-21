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

import {
  createDedicatedKindSupport,
  DEDICATED_KIND_RECHECK_MS,
  isUnknownKindRejection,
} from "@/shared/lib/dedicatedKindSupport";

export { DEDICATED_KIND_RECHECK_MS, isUnknownKindRejection };

// Keep the exact legacy key so existing 30623 verdicts survive this refactor.
const docKindSupport = createDedicatedKindSupport(
  "docs:dedicated-kind-rejected:",
);

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
  return docKindSupport.markedUnsupported(relayUrl, nowMs);
}

/** Records that `relayUrl` rejected a kind-30623 publish just now. */
export function markDedicatedDocKindRejected(
  relayUrl: string,
  nowMs: number,
): void {
  docKindSupport.markRejected(relayUrl, nowMs);
}

/** Clears the verdict after `relayUrl` accepted a kind-30623 publish. */
export function markDedicatedDocKindAccepted(relayUrl: string): void {
  docKindSupport.markAccepted(relayUrl);
}
