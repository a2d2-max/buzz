import type { AccountQuota } from "@/shared/api/types";

import {
  type QuotaRow,
  type QuotaTone,
  quotaPresentation,
} from "./accountQuotaPresentation";

const BAR_TONE: Record<QuotaTone, string> = {
  normal: "bg-foreground/40",
  warning: "bg-amber-500",
  critical: "bg-destructive",
};

function QuotaWindowRow({ row }: { row: QuotaRow }) {
  return (
    <li className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{row.sentence}</span>
      <span
        aria-hidden
        className="h-1 w-full overflow-hidden rounded-full bg-muted"
      >
        {row.percent === null ? null : (
          <span
            className={`block h-full rounded-full ${BAR_TONE[row.tone]}`}
            style={{ width: `${row.percent}%` }}
          />
        )}
      </span>
    </li>
  );
}

/**
 * Remaining subscription quota for one account row in Settings → Agents.
 *
 * Presentation only — `quotaPresentation` decides what this shows, so the
 * "unknown is never drawn as zero" rule is covered by unit tests against the
 * same function this renders from. The bars are decorative: each window's
 * sentence is its single accessible name, so a screen reader makes one stop
 * per window rather than two.
 */
export function AccountQuotaMeter({
  label,
  pending,
  quota,
}: {
  /** The account's display name, used to disambiguate the status text. */
  label: string;
  pending: boolean;
  quota: AccountQuota | undefined;
}) {
  const presentation = quotaPresentation({ label, pending, quota });

  if (presentation.kind === "pending") {
    return (
      <p className="mt-2 text-xs text-muted-foreground" role="status">
        {presentation.text}
      </p>
    );
  }
  if (presentation.kind === "note") {
    return (
      <p
        className={
          presentation.tone === "warning"
            ? "mt-2 text-xs text-amber-600 dark:text-amber-400"
            : "mt-2 text-xs text-muted-foreground"
        }
        data-testid="account-quota-note"
      >
        {presentation.text}
      </p>
    );
  }

  return (
    <div className="mt-2 space-y-1.5">
      {presentation.plan ? (
        <p className="text-2xs uppercase tracking-wide text-muted-foreground">
          {presentation.plan} plan
        </p>
      ) : null}
      {presentation.limitReached ? (
        <p
          className="text-xs font-medium text-destructive"
          data-testid="account-quota-limit-reached"
        >
          Out of quota — agents on this account cannot start yet.
        </p>
      ) : null}
      <ul className="space-y-1.5">
        {presentation.rows.map((row) => (
          <QuotaWindowRow key={row.key} row={row} />
        ))}
      </ul>
    </div>
  );
}
