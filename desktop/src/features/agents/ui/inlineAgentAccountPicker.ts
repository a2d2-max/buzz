import type {
  AcpRuntimeCatalogEntry,
  ClaudeAccount,
  CodexAccount,
  UpdateManagedAgentInput,
} from "@/shared/api/types";

import {
  buildClaudeAccountOptions,
  claudeAccountIdFromSelection,
  claudeAccountSelectionValue,
  findRuntimeForCommand,
  hasManualClaudeToken,
} from "./claudeAccountOptions";
import {
  buildCodexAccountOptions,
  codexAccountIdFromSelection,
  codexAccountSelectionValue,
  hasManualCodexAuth,
} from "./codexAccountOptions";

export type InlineAccountProvider = "claude" | "codex";

export type InlineAccountControl = {
  provider: InlineAccountProvider;
  label: string;
  value: string;
  options: ReturnType<typeof buildClaudeAccountOptions>;
};

export function isInlineAccountQueryBlocking({
  enabled,
  isPending,
  isError,
}: {
  enabled: boolean;
  isPending: boolean;
  isError: boolean;
}): boolean {
  return enabled && (isPending || isError);
}

type RuntimeCapability = Pick<
  AcpRuntimeCatalogEntry,
  "id" | "command" | "oauthTokenEnvVar" | "supportsCodexAccounts"
>;

export function buildInlineAccountControls({
  agentCommand,
  claudeAccountId,
  codexAccountId,
  envVars,
  runtimes,
  claudeAccounts,
  codexAccounts,
}: {
  agentCommand: string;
  claudeAccountId: string | null;
  codexAccountId: string | null;
  envVars: Readonly<Record<string, string>>;
  runtimes: readonly RuntimeCapability[];
  claudeAccounts: readonly ClaudeAccount[] | null;
  codexAccounts: readonly CodexAccount[] | null;
}): InlineAccountControl[] {
  const runtime = findRuntimeForCommand(runtimes, agentCommand);
  if (!runtime) return [];
  const controls: InlineAccountControl[] = [];
  if (runtime.oauthTokenEnvVar) {
    const hasManualToken = hasManualClaudeToken(
      envVars,
      runtime.oauthTokenEnvVar,
    );
    controls.push({
      provider: "claude",
      label: "Claude account",
      value: claudeAccountSelectionValue({
        currentAccountId: claudeAccountId,
        hasManualToken,
      }),
      options: buildClaudeAccountOptions({
        accounts: claudeAccounts,
        currentAccountId: claudeAccountId,
        hasManualToken,
      }),
    });
  }
  if (runtime.supportsCodexAccounts) {
    const hasManualToken = hasManualCodexAuth(envVars);
    controls.push({
      provider: "codex",
      label: "Codex account",
      value: codexAccountSelectionValue({
        currentAccountId: codexAccountId,
        hasManualToken,
      }),
      options: buildCodexAccountOptions({
        accounts: codexAccounts,
        currentAccountId: codexAccountId,
        hasManualToken,
      }),
    });
  }
  return controls;
}

export function buildInlineAccountUpdate({
  pubkey,
  provider,
  selectionValue,
  initialAccountId,
}: {
  pubkey: string;
  provider: InlineAccountProvider;
  selectionValue: string;
  initialAccountId: string | null;
}): UpdateManagedAgentInput | null {
  const next =
    provider === "claude"
      ? claudeAccountIdFromSelection(selectionValue)
      : codexAccountIdFromSelection(selectionValue);
  if (next === initialAccountId) return null;
  return provider === "claude"
    ? { pubkey, claudeAccountId: next }
    : { pubkey, codexAccountId: next };
}
