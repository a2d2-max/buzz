/**
 * React Query hook for one account's remaining subscription quota
 * (Settings → Agents → Claude accounts / Codex accounts).
 *
 * Keyed per account so each row fetches once when the panel mounts and reuses
 * that reading while the panel stays open. Removing an account unmounts its
 * row, so a reading that lands late can never be painted onto a row that is
 * no longer there.
 */
import { useQuery } from "@tanstack/react-query";

import { fetchAccountQuota } from "@/shared/api/tauriAccountQuota";

/** Long enough that reopening the panel reuses the reading, short enough that
 *  a limit hit during a session still surfaces on the next open. */
const QUOTA_STALE_MS = 60_000;

export const accountQuotaQueryKey = (id: string) =>
  ["accountQuota", id] as const;

export function useAccountQuotaQuery(
  id: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    enabled: options?.enabled ?? true,
    queryKey: accountQuotaQueryKey(id),
    queryFn: () => fetchAccountQuota(id),
    staleTime: QUOTA_STALE_MS,
    // The backend already turns an unreachable provider into an `unavailable`
    // reading; a rejection here means the account itself is gone, and retrying
    // that would only stall the row.
    retry: false,
  });
}
