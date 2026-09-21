import * as React from "react";
import { Plus } from "lucide-react";

import { useCodexAccountsQuery } from "@/features/agents/useCodexAccounts";
import { Button } from "@/shared/ui/button";
import { isMacPlatform } from "@/shared/lib/platform";

import { AddCodexAccountDialog } from "./AddCodexAccountDialog";
import { CodexAccountRow } from "./CodexAccountRow";
import { ImportOrcaCodexAccountsDialog } from "./ImportOrcaCodexAccountsDialog";
import { SettingsOptionGroup } from "./SettingsOptionGroup";

/**
 * "Codex accounts" card for Settings → Agents — the OpenAI sibling of
 * `ClaudeAccountsSettingsCard`. An API-key account keeps its key in the OS
 * keychain; a ChatGPT-login account keeps its login in an app-managed
 * directory instead. Agents pick an account in their own settings; this card
 * only manages the list (add, rename, test, remove, login command).
 */
export function CodexAccountsSettingsCard() {
  const [addOpen, setAddOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const accountsQuery = useCodexAccountsQuery();
  const accounts = accountsQuery.data ?? [];

  return (
    <SettingsOptionGroup
      data-testid="settings-codex-accounts"
      description="OpenAI logins Codex agents can run on. Add one here or import an existing Orca login, then choose it per agent."
      headerAction={
        <div className="flex gap-2">
          {isMacPlatform() ? (
            <Button
              data-testid="codex-accounts-import-orca"
              onClick={() => setImportOpen(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              Import from Orca
            </Button>
          ) : null}
          <Button
            data-testid="codex-accounts-add-button"
            onClick={() => setAddOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus className="h-4 w-4" />
            Add account
          </Button>
        </div>
      }
      title="Codex accounts"
    >
      <div className="divide-y divide-border/55">
        {accountsQuery.isLoading ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">
            Loading accounts…
          </div>
        ) : accounts.length > 0 ? (
          accounts.map((account) => (
            <CodexAccountRow account={account} key={account.id} />
          ))
        ) : (
          <div
            className="px-4 py-4 text-sm text-muted-foreground"
            data-testid="codex-accounts-empty"
          >
            No accounts yet. Add one to run agents on a different OpenAI login.
          </div>
        )}

        {accountsQuery.error instanceof Error ? (
          <p
            className="bg-destructive/10 px-4 py-4 text-sm text-destructive"
            data-testid="codex-accounts-error"
            role="alert"
          >
            {accountsQuery.error.message}
          </p>
        ) : null}
      </div>

      <AddCodexAccountDialog onOpenChange={setAddOpen} open={addOpen} />
      <ImportOrcaCodexAccountsDialog
        onOpenChange={setImportOpen}
        open={importOpen}
      />
    </SettingsOptionGroup>
  );
}
