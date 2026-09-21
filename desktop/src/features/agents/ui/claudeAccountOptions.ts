/**
 * Pure logic for the per-agent "Claude account" picker, kept out of the
 * dialog so it can be unit-tested without rendering.
 *
 * The picker has two synthetic entries:
 * - "Default (app login)" — no stored account; the Claude CLI uses whatever
 *   login the desktop itself has.
 * - "Custom (env var)" — the effective env (agent, persona, or global) carries
 *   a hand-typed token under the runtime's OAuth token env var. Offered
 *   INSTEAD of Default while that env var is present, because the CLI would
 *   read it either way; the only route back to the app login is deleting the
 *   env var where it lives.
 *
 * Both synthetic entries submit as `claudeAccountId: null`; picking a stored
 * account submits its id. The spawn writes the picked account's token after
 * the user env, so an account wins over a stale manual token.
 */
import type { AcpRuntimeCatalogEntry, ClaudeAccount } from "@/shared/api/types";

import type { PersonaDropdownOption } from "./agentConfigOptions";

export const DEFAULT_CLAUDE_ACCOUNT_VALUE = "__default_claude_account__";
export const CUSTOM_ENV_CLAUDE_ACCOUNT_VALUE = "__custom_env_claude_account__";

const DEFAULT_LABEL = "Default (app login)";
const CUSTOM_ENV_LABEL = "Custom (env var)";
const REMOVED_LABEL = "Removed account";
const PENDING_LABEL = "Loading account…";

/**
 * The stored accounts, or `null` while the list is unknown (still loading, or
 * the query failed). `null` must never be read as "no accounts": a saved
 * selection is then "pending", not "removed".
 */
export type ClaudeAccountList =
  | readonly Pick<ClaudeAccount, "id" | "label">[]
  | null;

/** True when `envVars` carries a non-blank token under `tokenEnvVar`. */
export function hasManualClaudeToken(
  envVars: Readonly<Record<string, string>>,
  tokenEnvVar: string | null,
): boolean {
  if (!tokenEnvVar) {
    return false;
  }
  return (envVars[tokenEnvVar] ?? "").trim().length > 0;
}

export function buildClaudeAccountOptions({
  accounts,
  currentAccountId,
  hasManualToken,
}: {
  accounts: ClaudeAccountList;
  currentAccountId: string | null;
  hasManualToken: boolean;
}): PersonaDropdownOption[] {
  const known = accounts ?? [];
  const options: PersonaDropdownOption[] = [
    hasManualToken
      ? { label: CUSTOM_ENV_LABEL, value: CUSTOM_ENV_CLAUDE_ACCOUNT_VALUE }
      : { label: DEFAULT_LABEL, value: DEFAULT_CLAUDE_ACCOUNT_VALUE },
    ...known.map((account) => ({
      label: account.label,
      value: account.id,
    })),
  ];
  if (
    currentAccountId &&
    !known.some((account) => account.id === currentAccountId)
  ) {
    // Keep the saved selection representable so the dropdown never shows a
    // blank trigger. Only a list that actually arrived can call it removed.
    options.push({
      label: accounts ? REMOVED_LABEL : PENDING_LABEL,
      value: currentAccountId,
    });
  }
  return options;
}

export function claudeAccountSelectionValue({
  currentAccountId,
  hasManualToken,
}: {
  currentAccountId: string | null;
  hasManualToken: boolean;
}): string {
  if (currentAccountId) {
    return currentAccountId;
  }
  return hasManualToken
    ? CUSTOM_ENV_CLAUDE_ACCOUNT_VALUE
    : DEFAULT_CLAUDE_ACCOUNT_VALUE;
}

export function claudeAccountIdFromSelection(value: string): string | null {
  if (
    value === DEFAULT_CLAUDE_ACCOUNT_VALUE ||
    value === CUSTOM_ENV_CLAUDE_ACCOUNT_VALUE
  ) {
    return null;
  }
  return value;
}

/**
 * Tri-state update payload: `undefined` = don't send (unchanged), `null` =
 * clear, `string` = set. Mirrors the "send only what changed" convention of
 * the other fields in the edit dialog.
 */
export function resolveClaudeAccountUpdate({
  selectionValue,
  initialAccountId,
}: {
  selectionValue: string;
  initialAccountId: string | null;
}): string | null | undefined {
  const next = claudeAccountIdFromSelection(selectionValue);
  return next === initialAccountId ? undefined : next;
}

/**
 * The `claudeAccountId` to submit for the prospective runtime. When the
 * runtime reads no OAuth token the picker is hidden and a stored account is
 * dead weight that would keep labelling the row — clear it, but only once the
 * catalog has actually said what the runtime is (`runtimeKnown`); an unloaded
 * catalog must never turn into a destructive write.
 */
export function resolveClaudeAccountSubmission({
  tokenEnvVar,
  runtimeKnown,
  selectionValue,
  initialAccountId,
}: {
  tokenEnvVar: string | null;
  runtimeKnown: boolean;
  selectionValue: string;
  initialAccountId: string | null;
}): string | null | undefined {
  if (tokenEnvVar) {
    return resolveClaudeAccountUpdate({ selectionValue, initialAccountId });
  }
  return runtimeKnown && initialAccountId ? null : undefined;
}

/**
 * Label for the agent list row; `null` when the agent uses the app login or
 * while the list is unknown.
 */
export function resolveClaudeAccountLabel(
  claudeAccountId: string | null,
  accounts: ClaudeAccountList,
): string | null {
  if (!claudeAccountId || !accounts) {
    return null;
  }
  return (
    accounts.find((account) => account.id === claudeAccountId)?.label ??
    REMOVED_LABEL
  );
}

/**
 * Catalog entry for an agent's effective command: command path first, then
 * id — the same dual match the edit dialog uses when it opens.
 */
export function findRuntimeForCommand<
  T extends Pick<AcpRuntimeCatalogEntry, "id" | "command">,
>(
  runtimes: readonly T[],
  agentCommand: string | undefined | null,
): T | undefined {
  // A record can reach here without a command (older rows, and agents whose
  // harness was never resolved); matching nothing beats throwing inside render.
  const wanted = agentCommand?.trim();
  if (!wanted) return undefined;
  return (
    runtimes.find((runtime) => runtime.command?.trim() === wanted) ??
    runtimes.find((runtime) => runtime.id === wanted)
  );
}
