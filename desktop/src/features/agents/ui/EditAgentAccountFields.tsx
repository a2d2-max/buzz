/**
 * The edit dialog's provider-account pickers (Claude + Codex), extracted as
 * one state hook plus one render component so the dialog only wires them up.
 *
 * The dialog owns nothing account-shaped anymore: selections, account-list
 * queries, manual-env detection, and the tri-state submission values all live
 * here. `useEditAgentAccountSelections` must be called after the layered
 * `envVars` are derived (hooks only need a stable call order, not a
 * position). Selections reset themselves when the dialog opens or switches
 * agents — the same `[open, resetKey]` trigger as the dialog's own
 * field-reset effect — so the dialog has nothing to clean up.
 */
import * as React from "react";

import { useClaudeAccountsQuery } from "@/features/agents/useClaudeAccounts";
import { useCodexAccountsQuery } from "@/features/agents/useCodexAccounts";
import type { AcpRuntimeCatalogEntry, ManagedAgent } from "@/shared/api/types";

import {
  claudeAccountSelectionValue,
  hasManualClaudeToken,
  resolveClaudeAccountSubmission,
} from "./claudeAccountOptions";
import {
  codexAccountSelectionValue,
  hasManualCodexAuth,
  resolveCodexAccountSubmission,
} from "./codexAccountOptions";
import { EditAgentClaudeAccountField } from "./EditAgentClaudeAccountField";
import { EditAgentCodexAccountField } from "./EditAgentCodexAccountField";

export type EditAgentAccountSelections = ReturnType<
  typeof useEditAgentAccountSelections
>;

export function useEditAgentAccountSelections({
  agent,
  envVars,
  open,
  prospectiveRuntime,
  resetKey,
}: {
  agent: Pick<ManagedAgent, "claudeAccountId" | "codexAccountId">;
  /** The same layered env the spawn reads, so persona/global values count. */
  envVars: Readonly<Record<string, string>>;
  open: boolean;
  prospectiveRuntime:
    | Pick<AcpRuntimeCatalogEntry, "oauthTokenEnvVar" | "supportsCodexAccounts">
    | undefined;
  /** Identity of the edited agent (its pubkey); a switch drops selections. */
  resetKey: string;
}) {
  // `null` = untouched (derived from record + env).
  const [claudeSelection, setClaudeSelection] = React.useState<string | null>(
    null,
  );
  const [codexSelection, setCodexSelection] = React.useState<string | null>(
    null,
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is a plain string prop whose change (a different agent) must drop the selections; biome misreads destructured hook params as outer-scope values
  React.useEffect(() => {
    if (open) {
      setClaudeSelection(null);
      setCodexSelection(null);
    }
  }, [open, resetKey]);

  // Both pickers gate on a catalog capability, not a harness id.
  const claudeTokenEnvVar = prospectiveRuntime?.oauthTokenEnvVar ?? null;
  const supportsCodexAccounts =
    prospectiveRuntime?.supportsCodexAccounts ?? false;
  const claudeAccountsQuery = useClaudeAccountsQuery({
    enabled: open && claudeTokenEnvVar != null,
  });
  const codexAccountsQuery = useCodexAccountsQuery({
    enabled: open && supportsCodexAccounts,
  });

  const claudeManualToken = hasManualClaudeToken(envVars, claudeTokenEnvVar);
  const codexManualAuth = hasManualCodexAuth(envVars);
  const claudeValue =
    claudeSelection ??
    claudeAccountSelectionValue({
      currentAccountId: agent.claudeAccountId,
      hasManualToken: claudeManualToken,
    });
  const codexValue =
    codexSelection ??
    codexAccountSelectionValue({
      currentAccountId: agent.codexAccountId,
      hasManualToken: codexManualAuth,
    });

  /** Tri-state update fields for the save request (absent = untouched). */
  function submissions(): {
    claudeAccountId: string | null | undefined;
    codexAccountId: string | null | undefined;
  } {
    const runtimeKnown = prospectiveRuntime != null;
    return {
      claudeAccountId: resolveClaudeAccountSubmission({
        tokenEnvVar: claudeTokenEnvVar,
        runtimeKnown,
        selectionValue: claudeValue,
        initialAccountId: agent.claudeAccountId,
      }),
      codexAccountId: resolveCodexAccountSubmission({
        supportsCodexAccounts,
        runtimeKnown,
        selectionValue: codexValue,
        initialAccountId: agent.codexAccountId,
      }),
    };
  }

  return {
    agent,
    claudeAccountsQuery,
    claudeManualToken,
    claudeTokenEnvVar,
    claudeValue,
    codexAccountsQuery,
    codexManualAuth,
    codexValue,
    setClaudeSelection,
    setCodexSelection,
    submissions,
    supportsCodexAccounts,
  };
}

/** Renders whichever account picker the prospective runtime supports. */
export function EditAgentAccountFields({
  disabled,
  selections,
}: {
  disabled: boolean;
  selections: EditAgentAccountSelections;
}) {
  return (
    <>
      {selections.claudeTokenEnvVar ? (
        <EditAgentClaudeAccountField
          accounts={selections.claudeAccountsQuery.data ?? null}
          accountsError={selections.claudeAccountsQuery.isError}
          currentAccountId={selections.agent.claudeAccountId}
          disabled={disabled}
          hasManualToken={selections.claudeManualToken}
          onValueChange={selections.setClaudeSelection}
          tokenEnvVar={selections.claudeTokenEnvVar}
          value={selections.claudeValue}
        />
      ) : null}
      {selections.supportsCodexAccounts ? (
        <EditAgentCodexAccountField
          accounts={selections.codexAccountsQuery.data ?? null}
          accountsError={selections.codexAccountsQuery.isError}
          currentAccountId={selections.agent.codexAccountId}
          disabled={disabled}
          hasManualAuth={selections.codexManualAuth}
          onValueChange={selections.setCodexSelection}
          value={selections.codexValue}
        />
      ) : null}
    </>
  );
}
