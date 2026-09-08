/**
 * Pure logic for the per-agent "Codex account" picker.
 *
 * The option-list/selection/tri-state machinery is identical to the Claude
 * picker's, so it is reused from `claudeAccountOptions.ts` (the functions are
 * generic over `{id, label}` accounts and both pickers share the synthetic
 * Default/Custom sentinels — the two selects live on different fields, so the
 * shared sentinel strings can never collide). Only what is genuinely
 * Codex-shaped lives here:
 *
 * - "Custom (env var)" is offered when the effective env carries a non-blank
 *   `OPENAI_API_KEY` *or* `CODEX_HOME` — the Codex CLI reads a login from
 *   either, so both count as a hand-typed override.
 * - The submission gate is the runtime's `supportsCodexAccounts` capability
 *   flag, not an env-var name.
 */
import type { CodexAccount } from "@/shared/api/types";

import {
  buildClaudeAccountOptions,
  claudeAccountIdFromSelection,
  claudeAccountSelectionValue,
  resolveClaudeAccountLabel,
  resolveClaudeAccountUpdate,
} from "./claudeAccountOptions";

/** Env vars the Codex CLI reads a login from; either one counts as manual. */
export const CODEX_MANUAL_AUTH_ENV_VARS = [
  "OPENAI_API_KEY",
  "CODEX_HOME",
] as const;

/**
 * The stored accounts, or `null` while the list is unknown (still loading, or
 * the query failed). `null` must never be read as "no accounts".
 */
export type CodexAccountList = readonly CodexAccount[] | null;

// Shared machinery, under this picker's own names — see the module doc.
export {
  claudeAccountIdFromSelection as codexAccountIdFromSelection,
  claudeAccountSelectionValue as codexAccountSelectionValue,
  buildClaudeAccountOptions as buildCodexAccountOptions,
  resolveClaudeAccountLabel as resolveCodexAccountLabel,
};

/** True when `envVars` carries a non-blank Codex login input. */
export function hasManualCodexAuth(
  envVars: Readonly<Record<string, string>>,
): boolean {
  return CODEX_MANUAL_AUTH_ENV_VARS.some(
    (key) => (envVars[key] ?? "").trim().length > 0,
  );
}

/**
 * The `codexAccountId` to submit for the prospective runtime. When the
 * runtime does not honor Codex accounts the picker is hidden and a stored
 * account is dead weight that would keep labelling the row — clear it, but
 * only once the catalog has actually said what the runtime is
 * (`runtimeKnown`); an unloaded catalog must never turn into a destructive
 * write. Mirrors `resolveClaudeAccountSubmission`.
 */
export function resolveCodexAccountSubmission({
  supportsCodexAccounts,
  runtimeKnown,
  selectionValue,
  initialAccountId,
}: {
  supportsCodexAccounts: boolean;
  runtimeKnown: boolean;
  selectionValue: string;
  initialAccountId: string | null;
}): string | null | undefined {
  if (supportsCodexAccounts) {
    return resolveClaudeAccountUpdate({ selectionValue, initialAccountId });
  }
  return runtimeKnown && initialAccountId ? null : undefined;
}
