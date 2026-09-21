import { invokeTauri } from "@/shared/api/tauri";
import type { AccountQuota } from "@/shared/api/types";

/**
 * How much of a stored Claude or Codex account's subscription is left.
 *
 * The backend reads each provider through the path that already owns its
 * credentials, so nothing secret crosses this call in either direction — the
 * response is percentages, window names, and reset phrasing only.
 *
 * A provider that cannot be reached comes back as an `unavailable` reading
 * rather than a rejected promise; only a genuine lookup failure (unknown id)
 * rejects. Callers must render `state` and never treat a missing number as 0.
 */
export async function fetchAccountQuota(id: string): Promise<AccountQuota> {
  return invokeTauri<AccountQuota>("account_quota", { id });
}
