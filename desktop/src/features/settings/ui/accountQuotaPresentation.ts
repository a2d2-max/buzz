/**
 * What an account row should show for its remaining subscription quota.
 *
 * The decision lives here rather than in the component so it can be tested
 * against the same function the row renders from. The rule the tests exist to
 * hold: an unknown reading must never be presented as a measured one — "we
 * could not ask" and "0% used" look identical on a meter and mean opposite
 * things.
 */
import type { AccountQuota, QuotaWindow } from "@/shared/api/types";

/** Above this share of a window, the row reads as a warning. */
export const WARN_PERCENT = 75;
/** Above this, it reads as spent. */
export const CRITICAL_PERCENT = 90;

export type QuotaTone = "normal" | "warning" | "critical";

export type QuotaRow = {
  /** Stable list key — the provider's own window name. */
  key: string;
  /** The row's whole accessible name; the bar beside it stays decorative. */
  sentence: string;
  /** Clamped 0–100, or `null` when the provider reported no number. */
  percent: number | null;
  tone: QuotaTone;
};

export type QuotaPresentation =
  | { kind: "pending"; text: string }
  | { kind: "note"; tone: "muted" | "warning"; text: string }
  | {
      kind: "windows";
      plan: string | null;
      limitReached: boolean;
      rows: QuotaRow[];
    };

export function quotaTone(
  percent: number | null,
  limitReached: boolean,
): QuotaTone {
  if (limitReached || (percent !== null && percent >= CRITICAL_PERCENT)) {
    return "critical";
  }
  if (percent !== null && percent >= WARN_PERCENT) {
    return "warning";
  }
  return "normal";
}

/** One readable line per window — the row's only accessible name. */
export function windowSentence(window: QuotaWindow): string {
  const used =
    window.usedPercent === null
      ? "usage unknown"
      : `${Math.round(window.usedPercent)}% used`;
  return window.resetsAt
    ? `${window.label}: ${used}, resets ${window.resetsAt}`
    : `${window.label}: ${used}`;
}

function clampPercent(percent: number | null): number | null {
  if (percent === null || Number.isNaN(percent)) {
    return null;
  }
  return Math.min(100, Math.max(0, percent));
}

export function quotaPresentation(input: {
  label: string;
  pending: boolean;
  quota: AccountQuota | undefined;
}): QuotaPresentation {
  if (input.pending) {
    return { kind: "pending", text: "Checking remaining quota…" };
  }
  if (!input.quota) {
    return {
      kind: "note",
      tone: "muted",
      text: `Remaining quota is unavailable for ${input.label}.`,
    };
  }
  const { quota } = input;

  if (quota.state === "needs_login") {
    return {
      kind: "note",
      tone: "warning",
      text: quota.message
        ? `Sign in again to read remaining quota — ${quota.message}`
        : "Sign in again to read remaining quota.",
    };
  }
  if (quota.state === "not_applicable" || quota.state === "unavailable") {
    return {
      kind: "note",
      tone: "muted",
      text: quota.message ?? "Remaining quota is unavailable.",
    };
  }

  const limitReached = quota.state === "limit_reached";
  // A provider that answered "ok" with nothing to show is a contract change,
  // not an idle account; say so instead of rendering an empty meter.
  if (quota.windows.length === 0) {
    return {
      kind: "note",
      tone: "muted",
      text: quota.message ?? "Remaining quota is unavailable.",
    };
  }
  return {
    kind: "windows",
    plan: quota.plan,
    limitReached,
    rows: quota.windows.map((window) => {
      const percent = clampPercent(window.usedPercent);
      return {
        key: window.label,
        sentence: windowSentence(window),
        percent,
        tone: quotaTone(percent, limitReached),
      };
    }),
  };
}
