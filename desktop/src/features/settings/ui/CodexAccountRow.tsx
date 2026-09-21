import * as React from "react";
import { EllipsisVertical } from "lucide-react";
import { toast } from "sonner";

import { useAccountQuotaQuery } from "@/features/agents/useAccountQuota";
import {
  useCodexLoginCommandMutation,
  useRemoveCodexAccountMutation,
  useRenameCodexAccountMutation,
  useTestCodexAccountMutation,
} from "@/features/agents/useCodexAccounts";
import type { CodexAccount } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Input } from "@/shared/ui/input";
import { Spinner } from "@/shared/ui/spinner";

import { AccountAgentRoster } from "./AccountAgentRoster";
import { AccountQuotaMeter } from "./AccountQuotaMeter";
import { CodexLoginStatus } from "./CodexLoginStatus";
import { useCodexAccountLogin } from "./useCodexAccountLogin";

function errorText(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
}

function detachedAccountsMessage(label: string, detachedCount: number) {
  const agents = detachedCount === 1 ? "agent" : "agents";
  return `Removed ${label}. ${detachedCount} ${agents} switched to the default login — restart them to apply.`;
}

/**
 * One stored Codex account in Settings → Agents → Codex accounts. Mirrors
 * `ClaudeAccountRow` (inline rename/remove, per-row mutations, spelled-out
 * remove blast radius); the Codex-only additions are for ChatGPT-login
 * accounts: "Log in" runs `codex login` for the account's own directory in
 * the app (the browser sign-in stays with the user) and re-tests the account
 * when it finishes; "Copy login command" is the terminal fallback.
 */
export function CodexAccountRow({ account }: { account: CodexAccount }) {
  const [editing, setEditing] = React.useState(false);
  const [draftLabel, setDraftLabel] = React.useState(account.label);
  const [confirmingRemove, setConfirmingRemove] = React.useState(false);
  const labelInputRef = React.useRef<HTMLInputElement>(null);
  const removeCancelRef = React.useRef<HTMLButtonElement>(null);
  const removeWarningId = React.useId();

  // Each row owns its mutation instances so concurrent rows track their own
  // pending / result state independently.
  const rename = useRenameCodexAccountMutation();
  const remove = useRemoveCodexAccountMutation();
  const test = useTestCodexAccountMutation();
  // Reads when the settings panel mounts this row; a removed account unmounts
  // it, so a late reading can never land on a row that is gone.
  const quota = useAccountQuotaQuery(account.id);
  const loginCommand = useCodexLoginCommandMutation();
  const testMutate = test.mutate;
  const login = useCodexAccountLogin(account.id, {
    // A finished login proves nothing until the spawn env is exercised.
    onSucceeded: () => testMutate(account.id),
  });

  React.useEffect(() => {
    if (!editing) {
      return;
    }
    labelInputRef.current?.focus();
    labelInputRef.current?.select();
  }, [editing]);

  // The ••• menu suppresses its own focus return, so the confirmation must
  // take focus itself. Focus lands on Cancel (the safe action).
  React.useEffect(() => {
    if (confirmingRemove) {
      removeCancelRef.current?.focus();
    }
  }, [confirmingRemove]);

  function startRename() {
    rename.reset();
    setDraftLabel(account.label);
    setConfirmingRemove(false);
    setEditing(true);
  }

  function cancelRename() {
    rename.reset();
    setEditing(false);
  }

  function saveRename() {
    const nextLabel = draftLabel.trim();
    if (nextLabel.length === 0) {
      return;
    }
    if (nextLabel === account.label) {
      cancelRename();
      return;
    }
    rename.mutate(
      { id: account.id, label: nextLabel },
      { onSuccess: () => setEditing(false) },
    );
  }

  function cancelRemove() {
    remove.reset();
    setConfirmingRemove(false);
  }

  function cancelRemoveOnEscape(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelRemove();
    }
  }

  function confirmRemove() {
    // mutateAsync, not mutate's callbacks: the successful removal unmounts
    // this row, and the detached-agents toast must not depend on staying
    // mounted.
    const label = account.label;
    void remove
      .mutateAsync(account.id)
      .then((result) => {
        setConfirmingRemove(false);
        if (result.detachedAgentPubkeys.length > 0) {
          toast(
            detachedAccountsMessage(label, result.detachedAgentPubkeys.length),
          );
        }
        if (result.warning) {
          toast.warning(result.warning);
        }
      })
      .catch(() => {
        // Rendered from `remove.error` below; the confirmation stays open so
        // the user can retry.
        return undefined;
      });
  }

  function copyLoginCommand() {
    void loginCommand
      .mutateAsync(account.id)
      .then(async (command) => {
        await navigator.clipboard.writeText(command);
        toast("Login command copied — paste it as is into a terminal.");
      })
      .catch((err: unknown) => {
        toast.error(errorText(err, "Couldn't fetch the login command."));
      });
  }

  const renameError = rename.error
    ? errorText(rename.error, "Rename failed.")
    : null;
  const removeError = remove.error
    ? errorText(remove.error, "Remove failed.")
    : null;
  const testError = test.error ? errorText(test.error, "Test failed.") : null;
  const testResult = test.data ?? null;

  return (
    <div
      className="min-h-16 px-4 py-3.5 text-sm"
      data-testid={`codex-account-${account.id}`}
    >
      {editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={`Rename ${account.label}`}
            className="h-8 min-w-0 flex-1"
            data-testid={`codex-account-rename-input-${account.id}`}
            disabled={rename.isPending}
            onChange={(event) => setDraftLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                saveRename();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                cancelRename();
              }
            }}
            ref={labelInputRef}
            value={draftLabel}
          />
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              className="h-7 px-3 text-xs"
              disabled={rename.isPending}
              onClick={cancelRename}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              className="h-7 px-3 text-xs"
              data-testid={`codex-account-rename-save-${account.id}`}
              disabled={rename.isPending || draftLabel.trim().length === 0}
              onClick={saveRename}
              size="sm"
              type="button"
              variant="outline"
            >
              {rename.isPending ? (
                <Spinner aria-hidden className="h-3.5 w-3.5" />
              ) : null}
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p className="min-w-0 truncate font-medium">{account.label}</p>
            <span
              className="rounded-full bg-muted px-2 py-0.5 text-2xs text-muted-foreground"
              data-testid={`codex-account-kind-${account.id}`}
            >
              {account.authKind === "api_key" ? "API key" : "ChatGPT"}
            </span>
            {account.source === "orca" ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-2xs text-muted-foreground">
                Orca
              </span>
            ) : null}
            {account.tokenHint ? (
              <span
                className="font-mono text-xs text-muted-foreground"
                data-testid={`codex-account-hint-${account.id}`}
              >
                {account.tokenHint}
              </span>
            ) : null}
          </div>
          <div className="ml-auto flex shrink-0 items-center justify-end gap-1">
            {account.authKind === "chatgpt" ? (
              <Button
                aria-label={`Log in ${account.label}`}
                className="h-7 px-3 text-xs"
                data-testid={`codex-account-login-${account.id}`}
                disabled={login.startPending || (login.view?.running ?? false)}
                onClick={login.start}
                size="sm"
                type="button"
                variant="outline"
              >
                {login.startPending ? (
                  <Spinner aria-hidden className="h-3.5 w-3.5" />
                ) : null}
                Log in
              </Button>
            ) : null}
            <Button
              aria-label={`Test ${account.label}`}
              className="h-7 px-3 text-xs"
              data-testid={`codex-account-test-${account.id}`}
              disabled={test.isPending}
              onClick={() => test.mutate(account.id)}
              size="sm"
              type="button"
              variant="outline"
            >
              {test.isPending ? (
                <Spinner aria-hidden className="h-3.5 w-3.5" />
              ) : null}
              Test
            </Button>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <button
                  aria-label={`Open actions for ${account.label}`}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  data-testid={`codex-account-menu-${account.id}`}
                  type="button"
                >
                  <EllipsisVertical className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                onCloseAutoFocus={(event) => event.preventDefault()}
              >
                {account.authKind === "chatgpt" && account.source === "app" ? (
                  <DropdownMenuItem
                    data-testid={`codex-account-login-command-${account.id}`}
                    onSelect={copyLoginCommand}
                  >
                    Copy login command
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  data-testid={`codex-account-rename-${account.id}`}
                  onSelect={startRename}
                >
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  data-testid={`codex-account-remove-${account.id}`}
                  onSelect={() => {
                    remove.reset();
                    setEditing(false);
                    setConfirmingRemove(true);
                  }}
                >
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}

      {editing || confirmingRemove ? null : (
        <>
          <AccountQuotaMeter
            label={account.label}
            pending={quota.isPending}
            quota={quota.data}
          />
          <AccountAgentRoster
            accountId={account.id}
            accountLabel={account.label}
            provider="codex"
          />
        </>
      )}

      {testResult ? (
        <p
          className={
            testResult.ok
              ? "mt-2 text-sm text-emerald-600 dark:text-emerald-400"
              : "mt-2 text-sm text-destructive"
          }
          data-testid={`codex-account-test-result-${account.id}`}
          role="status"
        >
          {testResult.ok ? "Works" : "Failed"} — {testResult.message}
        </p>
      ) : null}
      {testError ? (
        <p
          className="mt-2 text-sm text-destructive"
          data-testid={`codex-account-test-error-${account.id}`}
          role="alert"
        >
          Failed — {testError}
        </p>
      ) : null}

      {login.startError ? (
        <p
          className="mt-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-sm text-destructive"
          data-testid={`codex-account-login-error-${account.id}`}
          role="alert"
        >
          Couldn't start the login — {login.startError}
        </p>
      ) : null}
      {login.view ? (
        <CodexLoginStatus
          accountId={account.id}
          authUrl={login.session?.authUrl ?? null}
          cancelPending={login.cancelPending}
          onCancel={login.cancel}
          view={login.view}
        />
      ) : null}

      {confirmingRemove ? (
        <div
          aria-describedby={removeWarningId}
          aria-label={`Remove ${account.label}?`}
          className="mt-2 space-y-2"
          role="alertdialog"
        >
          <p
            className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-sm text-amber-600 dark:text-amber-400"
            data-testid={`codex-account-remove-warning-${account.id}`}
            id={removeWarningId}
          >
            Remove “{account.label}”? Agents using this account switch back to
            the app's own Codex login and will need a restart.
            {account.authKind === "chatgpt"
              ? account.source === "app"
                ? " Its app-owned login directory is deleted too."
                : " The original Orca home is left unchanged."
              : ""}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              className="h-7 px-3 text-xs"
              disabled={remove.isPending}
              onClick={cancelRemove}
              onKeyDown={cancelRemoveOnEscape}
              ref={removeCancelRef}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              className="h-7 px-3 text-xs"
              data-testid={`codex-account-remove-confirm-${account.id}`}
              disabled={remove.isPending}
              onClick={confirmRemove}
              onKeyDown={cancelRemoveOnEscape}
              size="sm"
              type="button"
              variant="destructive"
            >
              {remove.isPending ? (
                <Spinner aria-hidden className="h-3.5 w-3.5" />
              ) : null}
              Remove
            </Button>
          </div>
        </div>
      ) : null}

      {renameError ? (
        <p
          className="mt-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-sm text-destructive"
          data-testid={`codex-account-rename-error-${account.id}`}
          role="alert"
        >
          {renameError}
        </p>
      ) : null}
      {removeError ? (
        <p
          className="mt-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-sm text-destructive"
          data-testid={`codex-account-remove-error-${account.id}`}
          role="alert"
        >
          {removeError}
        </p>
      ) : null}
    </div>
  );
}
