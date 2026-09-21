/** How long an unknown-kind verdict is trusted before the relay is probed again. */
export const DEDICATED_KIND_RECHECK_MS = 24 * 60 * 60 * 1_000;

/** Matches only the relay rejection that means the published kind is unknown. */
export function isUnknownKindRejection(error: unknown): boolean {
  return error instanceof Error && /unknown (event )?kind/i.test(error.message);
}

export type DedicatedKindSupport = {
  markedUnsupported: (relayUrl: string, nowMs: number) => boolean;
  markRejected: (relayUrl: string, nowMs: number) => void;
  markAccepted: (relayUrl: string) => void;
};

/**
 * Builds persistent, per-relay support tracking for one dedicated event kind.
 *
 * Callers choose a distinct storage prefix for every kind whose support can
 * differ. Storage failures degrade to probing the dedicated kind again; they
 * never turn an unrelated publish error into a legacy write.
 */
export function createDedicatedKindSupport(
  storageKeyPrefix: string,
): DedicatedKindSupport {
  const storageKey = (relayUrl: string) => `${storageKeyPrefix}${relayUrl}`;

  const readRejectedAtMs = (relayUrl: string): number | null => {
    try {
      const raw = window.localStorage.getItem(storageKey(relayUrl));
      if (raw === null) return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  };

  return {
    markedUnsupported: (relayUrl, nowMs) => {
      const rejectedAtMs = readRejectedAtMs(relayUrl);
      return (
        rejectedAtMs !== null &&
        nowMs - rejectedAtMs < DEDICATED_KIND_RECHECK_MS
      );
    },
    markRejected: (relayUrl, nowMs) => {
      try {
        window.localStorage.setItem(storageKey(relayUrl), String(nowMs));
      } catch {
        // Best effort: an unavailable store means the next write probes again.
      }
    },
    markAccepted: (relayUrl) => {
      try {
        window.localStorage.removeItem(storageKey(relayUrl));
      } catch {
        // Best effort: a stale verdict expires and is probed again after 24 h.
      }
    },
  };
}
