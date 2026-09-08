import * as React from "react";
import { toast } from "sonner";

import { useAddCodexAccountMutation } from "@/features/agents/useCodexAccounts";
import { getCodexLoginCommand } from "@/shared/api/tauriCodexAccounts";
import type { CodexAuthKind } from "@/shared/api/types";
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
 * "Add account" flow for Settings → Agents → Codex accounts.
 *
 * Two kinds:
 * - **API key** — the pasted key is a secret with the same lifecycle contract
 *   as the Claude dialog's token: local state only, handed straight to the
 *   mutation (OS keychain), dropped on every close path.
 * - **ChatGPT login** — no secret here at all. The account gets its own
 *   `CODEX_HOME` directory; after the add, this dialog shows the one-time
 *   `codex login` command to run in a terminal, because without that step the
 *   account cannot start an agent.
 */
export function AddCodexAccountDialog({
  onOpenChange,
  open,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fieldId = React.useId();
  const labelInputId = `add-codex-account-label-${fieldId}`;
  const keyInputId = `add-codex-account-key-${fieldId}`;
  const kindGroupId = `add-codex-account-kind-${fieldId}`;
  const [label, setLabel] = React.useState("");
  const [authKind, setAuthKind] = React.useState<CodexAuthKind>("api_key");
  const [apiKey, setApiKey] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  // Set after a successful chatgpt add: the dialog switches to the "run this
  // command" step instead of closing, so the login step cannot be missed.
  const [loginCommand, setLoginCommand] = React.useState<string | null>(null);
  const add = useAddCodexAccountMutation();
  const isPending = add.isPending;
  const resetAdd = add.reset;

  // Single drop point for the secret: whichever way the dialog closed, the
  // key does not survive it.
  React.useEffect(() => {
    if (open) {
      return;
    }
    setApiKey("");
    setError(null);
    setLoginCommand(null);
    resetAdd();
  }, [open, resetAdd]);

  const canSubmit =
    !isPending &&
    label.trim().length > 0 &&
    (authKind === "chatgpt" || apiKey.trim().length > 0);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    setError(null);
    try {
      const account = await add.mutateAsync({
        label: label.trim(),
        authKind,
        apiKey: authKind === "api_key" ? apiKey.trim() : undefined,
      });
      setLabel("");
      setApiKey("");
      if (authKind === "chatgpt") {
        setLoginCommand(await getCodexLoginCommand(account.id));
        return;
      }
      onOpenChange(false);
    } catch (err) {
      // Keep the dialog open so the pasted key isn't lost on a retryable
      // failure (bad key, keychain locked).
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function copyLoginCommand() {
    if (!loginCommand) {
      return;
    }
    try {
      await navigator.clipboard.writeText(loginCommand);
      toast("Login command copied.");
    } catch {
      toast.error("Couldn't copy — select the command text instead.");
    }
  }

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen && isPending) {
          return;
        }
        onOpenChange(nextOpen);
      }}
      open={open}
    >
      <DialogContent
        className="max-w-lg"
        data-testid="add-codex-account-dialog"
      >
        {loginCommand ? (
          <>
            <DialogHeader>
              <DialogTitle>Log the account in</DialogTitle>
              <DialogDescription>
                The account was added. Run this once in a terminal to sign its
                directory in with ChatGPT; agents on this account can start
                after that.
              </DialogDescription>
            </DialogHeader>
            <code
              className="block overflow-x-auto whitespace-pre rounded-lg bg-muted px-3 py-2 font-mono text-xs"
              data-testid="add-codex-account-login-command"
            >
              {loginCommand}
            </code>
            <DialogFooter>
              <Button
                onClick={copyLoginCommand}
                type="button"
                variant="outline"
              >
                Copy command
              </Button>
              <Button
                data-testid="add-codex-account-done"
                onClick={() => onOpenChange(false)}
                type="button"
              >
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add Codex account</DialogTitle>
              <DialogDescription>
                Name the OpenAI login agents can run on. An API key is stored in
                the OS keychain and never shown again; a ChatGPT login gets its
                own directory you sign in once from a terminal.
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

              <fieldset className="space-y-1.5" disabled={isPending}>
                <legend className="text-sm font-medium text-foreground">
                  Sign-in method
                </legend>
                <div className="flex gap-4" role="radiogroup">
                  {(
                    [
                      ["api_key", "API key"],
                      ["chatgpt", "ChatGPT login"],
                    ] as const
                  ).map(([kind, kindLabel]) => (
                    <label
                      className="flex items-center gap-1.5 text-sm"
                      key={kind}
                    >
                      <input
                        checked={authKind === kind}
                        data-testid={`add-codex-account-kind-${kind}`}
                        name={kindGroupId}
                        onChange={() => setAuthKind(kind)}
                        type="radio"
                        value={kind}
                      />
                      {kindLabel}
                    </label>
                  ))}
                </div>
              </fieldset>

              {authKind === "api_key" ? (
                <div className="space-y-1.5">
                  <label
                    className="text-sm font-medium text-foreground"
                    htmlFor={keyInputId}
                  >
                    API key
                  </label>
                  <Textarea
                    autoComplete="off"
                    className="font-mono text-xs"
                    disabled={isPending}
                    id={keyInputId}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="sk-…"
                    rows={4}
                    spellCheck={false}
                    value={apiKey}
                  />
                  <p className="text-xs text-muted-foreground">
                    Create a key at platform.openai.com → API keys, or run{" "}
                    <code className="font-mono text-xs">
                      codex login --with-api-key
                    </code>{" "}
                    and paste the same key here.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  After adding, you'll get a one-time{" "}
                  <code className="font-mono text-xs">codex login</code> command
                  to run in a terminal for this account's own directory.
                </p>
              )}

              {error ? (
                <p
                  className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-sm text-destructive"
                  data-testid="add-codex-account-error"
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
                  data-testid="add-codex-account-submit"
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
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
