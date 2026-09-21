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

import { LOGIN_COMMAND_GUIDANCE } from "./codexLoginFlow";
import { CodexLoginStatus } from "./CodexLoginStatus";
import { useCodexAccountLogin } from "./useCodexAccountLogin";

/** A chatgpt account that was just added and still needs its sign-in. */
type PendingLogin = {
  id: string;
  label: string;
  /** Terminal fallback; null when the backend could not build it. */
  command: string | null;
};

/**
 * "Add account" flow for Settings → Agents → Codex accounts.
 *
 * Two kinds:
 * - **API key** — the pasted key is a secret with the same lifecycle contract
 *   as the Claude dialog's token: local state only, handed straight to the
 *   mutation (OS keychain), dropped on every close path.
 * - **ChatGPT login** — no secret here at all. The account gets its own
 *   `CODEX_HOME` directory; after the add, this dialog moves to a sign-in
 *   step that runs `codex login` for that directory in the app (the browser
 *   part stays with the user), with the terminal command as a fallback —
 *   without that step the account cannot start an agent.
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
  // Set after a successful chatgpt add: the dialog switches to the sign-in
  // step instead of closing, so the login step cannot be missed.
  const [pendingLogin, setPendingLogin] = React.useState<PendingLogin | null>(
    null,
  );
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
    setPendingLogin(null);
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
        // The account exists now; a missing fallback command must not read
        // as a failed add.
        const command = await getCodexLoginCommand(account.id).catch(
          () => null,
        );
        setPendingLogin({ id: account.id, label: account.label, command });
        return;
      }
      onOpenChange(false);
    } catch (err) {
      // Keep the dialog open so the pasted key isn't lost on a retryable
      // failure (bad key, keychain locked).
      setError(err instanceof Error ? err.message : String(err));
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
        {pendingLogin ? (
          <CodexLoginStep
            onDone={() => onOpenChange(false)}
            pending={pendingLogin}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add Codex account</DialogTitle>
              <DialogDescription>
                Name the OpenAI login agents can run on. An API key is stored in
                the OS keychain and never shown again; a ChatGPT login gets its
                own directory you sign in once, right after adding.
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
                  After adding, sign the account in from here: the app runs{" "}
                  <code className="font-mono text-xs">codex login</code> for
                  this account's own directory and your browser does the rest.
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

/**
 * Step two for a chatgpt account: sign it in. "Log in now" runs the CLI in
 * the app; the terminal command stays available as a fallback, with the
 * reason it must be pasted as is. Closing the dialog does not stop a running
 * login — the account row keeps showing it.
 */
function CodexLoginStep({
  onDone,
  pending,
}: {
  onDone: () => void;
  pending: PendingLogin;
}) {
  const [showCommand, setShowCommand] = React.useState(false);
  const login = useCodexAccountLogin(pending.id);
  const running = login.view?.running ?? false;
  const signedIn = login.view?.tone === "success";

  async function copyLoginCommand() {
    if (!pending.command) {
      return;
    }
    try {
      await navigator.clipboard.writeText(pending.command);
      toast("Login command copied — paste it as is into a terminal.");
    } catch {
      toast.error("Couldn't copy — select the command text instead.");
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Sign in {pending.label}</DialogTitle>
        <DialogDescription>
          The account was added. Sign its directory in with ChatGPT once; the
          browser opens for the account choice and password, and agents on this
          account can start after that.
        </DialogDescription>
      </DialogHeader>
      {login.startError ? (
        <p
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-sm text-destructive"
          data-testid="add-codex-account-login-error"
          role="alert"
        >
          Couldn't start the login — {login.startError}
        </p>
      ) : null}
      {login.view ? (
        <CodexLoginStatus
          accountId={pending.id}
          authUrl={login.session?.authUrl ?? null}
          cancelPending={login.cancelPending}
          onCancel={login.cancel}
          view={login.view}
        />
      ) : null}
      {pending.command ? (
        <div className="space-y-2">
          <button
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            data-testid="add-codex-account-show-command"
            onClick={() => setShowCommand((current) => !current)}
            type="button"
          >
            {showCommand
              ? "Hide the terminal command"
              : "Prefer a terminal? Show the command"}
          </button>
          {showCommand ? (
            <>
              <code
                className="block overflow-x-auto whitespace-pre rounded-lg bg-muted px-3 py-2 font-mono text-xs"
                data-testid="add-codex-account-login-command"
              >
                {pending.command}
              </code>
              <p className="text-xs text-muted-foreground">
                {LOGIN_COMMAND_GUIDANCE}
              </p>
              <Button
                className="h-7 px-3 text-xs"
                onClick={copyLoginCommand}
                size="sm"
                type="button"
                variant="outline"
              >
                Copy command
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      <DialogFooter>
        <Button
          data-testid="add-codex-account-done"
          onClick={onDone}
          type="button"
          variant={signedIn ? "default" : "outline"}
        >
          {signedIn ? "Done" : "Later"}
        </Button>
        {signedIn ? null : (
          <Button
            data-testid="add-codex-account-login-now"
            disabled={login.startPending || running}
            onClick={login.start}
            type="button"
          >
            {login.startPending || running ? (
              <Spinner aria-hidden className="h-4 w-4 border-2" />
            ) : null}
            {running ? "Waiting for the browser…" : "Log in now"}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
