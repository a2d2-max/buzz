import * as React from "react";
import { toast } from "sonner";

import { useAddClaudeAccountMutation } from "@/features/agents/useClaudeAccounts";
import { getClaudeLoginCommand } from "@/shared/api/tauriClaudeAccounts";
import type { ClaudeAuthKind } from "@/shared/api/types";
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

import { addClaudeAccountAndLoadLoginCommand } from "./addClaudeAccountFlow";
import { BRAND_NAME } from "@/shared/constants/brand";
import { ClaudeLoginStatus } from "./ClaudeLoginStatus";
import { useClaudeAccountLogin } from "./useClaudeAccountLogin";

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
  const kindGroupId = `add-claude-account-kind-${fieldId}`;
  const [label, setLabel] = React.useState("");
  const [authKind, setAuthKind] = React.useState<ClaudeAuthKind>("setup_token");
  const [token, setToken] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loginCommand, setLoginCommand] = React.useState<string | null>(null);
  const [createdConfigAccountId, setCreatedConfigAccountId] = React.useState<
    string | null
  >(null);
  const [isLoadingCommand, setIsLoadingCommand] = React.useState(false);
  const add = useAddClaudeAccountMutation();
  const isPending = add.isPending || isLoadingCommand;
  const resetAdd = add.reset;
  const login = useClaudeAccountLogin(createdConfigAccountId ?? "", {
    enabled: createdConfigAccountId !== null,
    onSucceeded: () => toast.success("Signed in."),
  });

  React.useEffect(() => {
    if (open) return;
    setToken("");
    setError(null);
    setLoginCommand(null);
    setCreatedConfigAccountId(null);
    setIsLoadingCommand(false);
    resetAdd();
  }, [open, resetAdd]);

  const canSubmit =
    !isPending &&
    label.trim().length > 0 &&
    (authKind === "config_dir" || token.trim().length > 0);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    try {
      const result = await addClaudeAccountAndLoadLoginCommand(
        {
          label: label.trim(),
          authKind,
          token: authKind === "setup_token" ? token.trim() : undefined,
        },
        add.mutateAsync,
        getClaudeLoginCommand,
      );
      setLabel("");
      setToken("");
      if (authKind === "config_dir") {
        setCreatedConfigAccountId(result.account.id);
        setLoginCommand(result.loginCommand);
        if (result.loginCommandError) {
          setError(
            `The account was added, but its login command could not be loaded: ${result.loginCommandError}`,
          );
        }
        return;
      }
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function retryLoginCommand() {
    if (!createdConfigAccountId || isLoadingCommand) return;
    setError(null);
    setIsLoadingCommand(true);
    try {
      setLoginCommand(await getClaudeLoginCommand(createdConfigAccountId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsLoadingCommand(false);
    }
  }

  async function copyLoginCommand() {
    if (!loginCommand) return;
    try {
      await navigator.clipboard.writeText(loginCommand);
      toast("Login command copied.");
    } catch {
      toast.error("Couldn't copy — select the command text instead.");
    }
  }

  /**
   * Let the app run the login instead of the owner. On failure the copyable
   * command is still on screen, so the manual path stays available.
   */
  function signInNow() {
    if (!createdConfigAccountId || login.startPending) return;
    setError(null);
    login.start();
  }

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen && isPending) return;
        onOpenChange(nextOpen);
      }}
      open={open}
    >
      <DialogContent
        className="max-w-lg"
        data-testid="add-claude-account-dialog"
      >
        {loginCommand || createdConfigAccountId ? (
          <>
            <DialogHeader>
              <DialogTitle>Log the account in</DialogTitle>
              <DialogDescription>
                The account has its own Claude directory. Sign in and your
                browser opens — finish there. Or run the command yourself.
              </DialogDescription>
            </DialogHeader>
            {loginCommand ? (
              <code
                className="block overflow-x-auto whitespace-pre rounded-lg bg-muted px-3 py-2 font-mono text-xs"
                data-testid="add-claude-account-login-command"
              >
                {loginCommand}
              </code>
            ) : null}
            {error ? (
              <p
                className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-sm text-destructive"
                data-testid="add-claude-account-error"
                role="alert"
              >
                {error}
              </p>
            ) : null}
            {login.startError ? (
              <p
                className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-sm text-destructive"
                data-testid="add-claude-account-login-error"
                role="alert"
              >
                {login.startError} — copy the command and run it yourself.
              </p>
            ) : null}
            {login.view && createdConfigAccountId ? (
              <ClaudeLoginStatus
                accountId={createdConfigAccountId}
                authUrl={login.session?.authUrl ?? null}
                cancelPending={login.cancelPending}
                onCancel={login.cancel}
                view={login.view}
              />
            ) : null}
            <DialogFooter>
              {loginCommand ? (
                <Button
                  onClick={copyLoginCommand}
                  type="button"
                  variant="outline"
                >
                  Copy command
                </Button>
              ) : (
                <Button
                  disabled={isLoadingCommand}
                  onClick={() => void retryLoginCommand()}
                  type="button"
                  variant="outline"
                >
                  {isLoadingCommand ? (
                    <Spinner aria-hidden className="h-4 w-4 border-2" />
                  ) : null}
                  Retry command
                </Button>
              )}
              <Button
                data-testid="add-claude-account-sign-in"
                disabled={
                  !createdConfigAccountId ||
                  login.startPending ||
                  (login.view?.running ?? false)
                }
                onClick={signInNow}
                type="button"
              >
                {login.startPending ? (
                  <Spinner aria-hidden className="h-4 w-4 border-2" />
                ) : null}
                Sign in
              </Button>
              <Button
                data-testid="add-claude-account-done"
                onClick={() => onOpenChange(false)}
                type="button"
                variant="outline"
              >
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add Claude account</DialogTitle>
              <DialogDescription>
                Use a setup token, or give this account a dedicated directory
                and sign in once through Claude's browser flow.
              </DialogDescription>
            </DialogHeader>
            <form className="space-y-5" onSubmit={handleSubmit}>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor={labelInputId}>
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
                <legend className="text-sm font-medium">Sign-in method</legend>
                <div className="flex gap-4">
                  {(
                    [
                      ["setup_token", "Setup token"],
                      ["config_dir", "Browser login"],
                    ] as const
                  ).map(([kind, kindLabel]) => (
                    <label
                      className="flex items-center gap-1.5 text-sm"
                      key={kind}
                    >
                      <input
                        checked={authKind === kind}
                        data-testid={`add-claude-account-kind-${kind}`}
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
              {authKind === "setup_token" ? (
                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor={tokenInputId}>
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
                    Run{" "}
                    <code className="font-mono text-xs">
                      claude setup-token
                    </code>{" "}
                    and paste the result. It stays in the OS keychain.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  After adding, run the one-time login command shown here.{" "}
                  {BRAND_NAME}
                  stores only the dedicated directory path.
                </p>
              )}
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
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
