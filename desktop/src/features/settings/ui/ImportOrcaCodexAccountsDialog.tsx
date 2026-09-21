import * as React from "react";
import { toast } from "sonner";

import {
  useImportOrcaCodexAccountsMutation,
  useOrcaCodexAccountsQuery,
} from "@/features/agents/useCodexAccounts";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Spinner } from "@/shared/ui/spinner";
import { BRAND_NAME } from "@/shared/constants/brand";

export function ImportOrcaCodexAccountsDialog({
  onOpenChange,
  open,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const accounts = useOrcaCodexAccountsQuery({ enabled: open });
  const importAccounts = useImportOrcaCodexAccountsMutation();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (!open) {
      setSelected(new Set());
      importAccounts.reset();
    }
  }, [open, importAccounts.reset]);

  async function submit() {
    if (selected.size === 0) return;
    try {
      const result = await importAccounts.mutateAsync([...selected]);
      const skipped = result.skippedExistingCount;
      const labelConflicts = result.skippedLabelConflicts;
      toast(
        `Imported ${result.imported.length} Codex account${result.imported.length === 1 ? "" : "s"}${skipped > 0 ? `; skipped ${skipped} already imported` : ""}${labelConflicts.length > 0 ? `; skipped duplicate ${labelConflicts.join(", ")}` : ""}.`,
      );
      onOpenChange(false);
    } catch {
      return;
    }
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next && importAccounts.isPending) return;
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent
        className="max-w-lg"
        data-testid="import-orca-codex-dialog"
      >
        <DialogHeader>
          <DialogTitle>Import Codex accounts from Orca</DialogTitle>
          <DialogDescription>
            {BRAND_NAME} keeps a read-only reference to each selected Orca
            login. The original account files stay in Orca.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border">
          {accounts.isLoading ? (
            <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
              <Spinner aria-hidden className="h-4 w-4" /> Loading Orca accounts…
            </div>
          ) : accounts.data?.length ? (
            accounts.data.map((account) => (
              <label
                className="flex items-start gap-3 px-3 py-3 text-sm"
                key={account.id}
              >
                <input
                  aria-label={`Import ${account.email}`}
                  checked={selected.has(account.id) || account.alreadyImported}
                  className="mt-0.5"
                  disabled={account.alreadyImported || importAccounts.isPending}
                  onChange={(event) => {
                    setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(account.id);
                      else next.delete(account.id);
                      return next;
                    });
                  }}
                  type="checkbox"
                />
                <span className="min-w-0">
                  <span className="block truncate font-medium">
                    {account.email}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {account.alreadyImported
                      ? "Already imported"
                      : (account.workspaceLabel ?? "ChatGPT login")}
                  </span>
                </span>
              </label>
            ))
          ) : accounts.isSuccess ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">
              No Codex accounts were found in Orca.
            </p>
          ) : null}
        </div>
        {accounts.error instanceof Error ? (
          <p className="text-sm text-destructive" role="alert">
            {accounts.error.message}
          </p>
        ) : null}
        {importAccounts.error instanceof Error ? (
          <p className="text-sm text-destructive" role="alert">
            {importAccounts.error.message}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            disabled={importAccounts.isPending}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={selected.size === 0 || importAccounts.isPending}
            onClick={() => void submit()}
            type="button"
          >
            {importAccounts.isPending ? (
              <Spinner aria-hidden className="h-4 w-4" />
            ) : null}
            Import selected
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
