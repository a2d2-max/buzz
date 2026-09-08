import * as React from "react";

import { useAddClaudeAccountMutation } from "@/features/agents/useClaudeAccounts";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Spinner } from "@/shared/ui/spinner";
import { Textarea } from "@/shared/ui/textarea";

/**
 * "Add account" flow for Settings → Agents → Claude accounts.
 *
 * The pasted `claude setup-token` result is a secret: it lives in this
 * component's local state and nowhere else, is handed straight to the
 * mutation (which stores it in the OS keychain), and is dropped on **every**
 * close path — Cancel, Escape, overlay click, and success. Nothing here logs
 * it, and the backend only ever hands back a `…last4` hint.
 */
export function AddClaudeAccountDialog({
  onOpenChange,
  open,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fieldId = React.useId();
  const labelInputId = `add-claude-account-label-${fieldId}`;
  const tokenInputId = `add-claude-account-token-${fieldId}`;
  const [label, setLabel] = React.useState("");
  const [token, setToken] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const add = useAddClaudeAccountMutation();
  const isPending = add.isPending;
  const resetAdd = add.reset;

  // Single drop point for the secret: whichever way the dialog closed, the
  // token does not survive it — neither in local state nor in the mutation's
  // retained `variables`.
  React.useEffect(() => {
    if (open) {
      return;
    }
    setToken("");
    setError(null);
    resetAdd();
  }, [open, resetAdd]);

  const canSubmit =
    !isPending && label.trim().length > 0 && token.trim().length > 0;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    setError(null);
    try {
      await add.mutateAsync({ label: label.trim(), token: token.trim() });
      setLabel("");
      setToken("");
      onOpenChange(false);
    } catch (err) {
      // Keep the dialog open so the pasted token isn't lost on a retryable
      // failure (bad token, keychain locked).
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        // A close mid-write would leave the user without the result of the
        // add they already committed to; Escape and the overlay wait too.
        if (!nextOpen && isPending) {
          return;
        }
        onOpenChange(nextOpen);
      }}
      open={open}
    >
      <DialogContent
        className="max-w-lg"
        data-testid="add-claude-account-dialog"
      >
        <DialogHeader>
          <DialogTitle>Add Claude account</DialogTitle>
          <DialogDescription>
            Name the subscription and paste its token. The token is stored in
            the OS keychain and never shown again.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-5" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor={labelInputId}
            >
              Label
            </label>
            <Input
              autoComplete="off"
              disabled={isPending}
              id={labelInputId}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. Work"
              value={label}
            />
          </div>

          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor={tokenInputId}
            >
              Token
            </label>
            <Textarea
              autoComplete="off"
              className="font-mono text-xs"
              disabled={isPending}
              id={tokenInputId}
              onChange={(event) => setToken(event.target.value)}
              placeholder="sk-ant-oat01-…"
              rows={4}
              spellCheck={false}
              value={token}
            />
            <p className="text-xs text-muted-foreground">
              Run <code className="font-mono text-xs">claude setup-token</code>{" "}
              in a terminal that is logged in to that subscription and paste the
              token here.
            </p>
          </div>

          {error ? (
            <p
              className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-sm text-destructive"
              data-testid="add-claude-account-error"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              disabled={isPending}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              data-testid="add-claude-account-submit"
              disabled={!canSubmit}
              type="submit"
            >
              {isPending ? (
                <Spinner aria-hidden className="h-4 w-4 border-2" />
              ) : null}
              Add account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
