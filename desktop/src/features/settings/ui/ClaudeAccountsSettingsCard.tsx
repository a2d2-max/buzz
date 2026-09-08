import * as React from "react";
import { Plus } from "lucide-react";

import { useClaudeAccountsQuery } from "@/features/agents/useClaudeAccounts";
import { Button } from "@/shared/ui/button";

import { AddClaudeAccountDialog } from "./AddClaudeAccountDialog";
import { ClaudeAccountRow } from "./ClaudeAccountRow";
import { SettingsOptionGroup } from "./SettingsOptionGroup";

/**
 * "Claude accounts" card for Settings → Agents.
 *
 * The owner can hold several Claude Code subscriptions; each one is stored
 * here once under a name, with its OAuth token in the OS keychain. Agents
 * then pick an account in their own settings — this card only manages the
 * list (add, rename, test, remove).
 */
export function ClaudeAccountsSettingsCard() {
  const [addOpen, setAddOpen] = React.useState(false);
  const accountsQuery = useClaudeAccountsQuery();
  const accounts = accountsQuery.data ?? [];

  return (
    <SettingsOptionGroup
      data-testid="settings-claude-accounts"
      description="Claude Code subscriptions agents can run on. Each agent picks one in its settings; the token stays in the OS keychain."
      headerAction={
        <Button
          data-testid="claude-accounts-add-button"
          onClick={() => setAddOpen(true)}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus className="h-4 w-4" />
          Add account
        </Button>
      }
      title="Claude accounts"
    >
      <div className="divide-y divide-border/55">
        {accountsQuery.isLoading ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">
            Loading accounts…
          </div>
        ) : accounts.length > 0 ? (
          accounts.map((account) => (
            <ClaudeAccountRow account={account} key={account.id} />
          ))
        ) : (
          <div
            className="px-4 py-4 text-sm text-muted-foreground"
            data-testid="claude-accounts-empty"
          >
            No accounts yet. Add one to run agents on a different Claude
            subscription.
          </div>
        )}

        {accountsQuery.error instanceof Error ? (
          <p
            className="bg-destructive/10 px-4 py-4 text-sm text-destructive"
            data-testid="claude-accounts-error"
            role="alert"
          >
            {accountsQuery.error.message}
          </p>
        ) : null}
      </div>

      <AddClaudeAccountDialog onOpenChange={setAddOpen} open={addOpen} />
    </SettingsOptionGroup>
  );
}
