import * as React from "react";
import { EllipsisVertical } from "lucide-react";
import { toast } from "sonner";

import { useAccountQuotaQuery } from "@/features/agents/useAccountQuota";
import {
  useRemoveClaudeAccountMutation,
  useRenameClaudeAccountMutation,
  useTestClaudeAccountMutation,
} from "@/features/agents/useClaudeAccounts";
import type { ClaudeAccount } from "@/shared/api/types";
import { getClaudeLoginCommand } from "@/shared/api/tauriClaudeAccounts";
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
import { ClaudeLoginStatus } from "./ClaudeLoginStatus";
import { useClaudeAccountLogin } from "./useClaudeAccountLogin";

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
 * One stored Claude subscription in Settings → Agents → Claude accounts.
 *
 * The row never sees the token — only the `…last4` hint the backend returns.
 * Rename and Remove are inline (no dialog) so the surrounding list keeps its
 * place, and Remove spells out its blast radius before it runs: agents bound
 * to this account fall back to the app's own Claude login.
 */
export function ClaudeAccountRow({ account }: { account: ClaudeAccount }) {
  const [editing, setEditing] = React.useState(false);
  const [draftLabel, setDraftLabel] = React.useState(account.label);
  const [confirmingRemove, setConfirmingRemove] = React.useState(false);
  const labelInputRef = React.useRef<HTMLInputElement>(null);
  const removeCancelRef = React.useRef<HTMLButtonElement>(null);
  const removeWarningId = React.useId();

  // Each row owns its mutation instances so concurrent rows track their own
  // pending / result state independently.
  const rename = useRenameClaudeAccountMutation();
  const remove = useRemoveClaudeAccountMutation();
  const test = useTestClaudeAccountMutation();
  // Reads when the settings panel mounts this row; a removed account unmounts
  // it, so a late reading can never land on a row that is gone.
  const quota = useAccountQuotaQuery(account.id);
  const testMutate = test.mutate;
  const login = useClaudeAccountLogin(account.id, {
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
  // take focus itself. Focus lands on Cancel (the safe action); the dialog
  // role + description announce the warning once, without a second stop.
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
    // this row, and the detached-agents toast is the user's only signal that
    // running agents need a restart — it must not depend on staying mounted.
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

  async function copyLoginCommand() {
    try {
      const command = await getClaudeLoginCommand(account.id);
      await navigator.clipboard.writeText(command);
      toast("Login command copied.");
    } catch (error) {
      toast.error(errorText(error, "Couldn't copy the login command."));
    }
  }

  function signIn() {
    login.start();
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
      data-testid={`claude-account-${account.id}`}
    >
      {editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={`Rename ${account.label}`}
            className="h-8 min-w-0 flex-1"
            data-testid={`claude-account-rename-input-${account.id}`}
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
              data-testid={`claude-account-rename-save-${account.id}`}
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
            <span className="rounded-full bg-muted px-2 py-0.5 text-2xs text-muted-foreground">
              {account.authKind === "config_dir"
                ? "Browser login"
                : "Setup token"}
            </span>
            {account.tokenHint ? (
              <span
                className="font-mono text-xs text-muted-foreground"
                data-testid={`claude-account-hint-${account.id}`}
              >
                {account.tokenHint}
              </span>
            ) : null}
          </div>
          <div className="ml-auto flex shrink-0 items-center justify-end gap-1">
            <Button
              aria-label={`Test ${account.label}`}
              className="h-7 px-3 text-xs"
              data-testid={`claude-account-test-${account.id}`}
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
                  data-testid={`claude-account-menu-${account.id}`}
                  type="button"
                >
                  <EllipsisVertical className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                onCloseAutoFocus={(event) => event.preventDefault()}
              >
                {account.authKind === "config_dir" ? (
                  <>
                    <DropdownMenuItem
                      data-testid={`claude-account-sign-in-${account.id}`}
                      disabled={
                        login.startPending || (login.view?.running ?? false)
                      }
                      onSelect={signIn}
                    >
                      Sign in
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={copyLoginCommand}>
                      Copy login command
                    </DropdownMenuItem>
                  </>
                ) : null}
                <DropdownMenuItem
                  data-testid={`claude-account-rename-${account.id}`}
                  onSelect={startRename}
                >
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  data-testid={`claude-account-remove-${account.id}`}
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
            provider="claude"
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
          data-testid={`claude-account-test-result-${account.id}`}
          role="status"
        >
          {testResult.ok ? "Works" : "Failed"} — {testResult.message}
        </p>
      ) : null}

      {login.startError ? (
        <p
          className="mt-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-sm text-destructive"
          data-testid={`claude-account-login-error-${account.id}`}
          role="alert"
        >
          Couldn't start the login — {login.startError}
        </p>
      ) : null}
      {login.view ? (
        <ClaudeLoginStatus
          accountId={account.id}
          authUrl={login.session?.authUrl ?? null}
          cancelPending={login.cancelPending}
          onCancel={login.cancel}
          view={login.view}
        />
      ) : null}
      {testError ? (
        <p
          className="mt-2 text-sm text-destructive"
          data-testid={`claude-account-test-error-${account.id}`}
          role="alert"
        >
          Failed — {testError}
        </p>
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
            data-testid={`claude-account-remove-warning-${account.id}`}
            id={removeWarningId}
          >
            Remove “{account.label}”? Agents using this account switch back to
            the app's own Claude login and will need a restart.
            {account.authKind === "config_dir"
              ? " Its app-owned login directory is deleted too."
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
              data-testid={`claude-account-remove-confirm-${account.id}`}
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
          data-testid={`claude-account-rename-error-${account.id}`}
          role="alert"
        >
          {renameError}
        </p>
      ) : null}
      {removeError ? (
        <p
          className="mt-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-sm text-destructive"
          data-testid={`claude-account-remove-error-${account.id}`}
          role="alert"
        >
          {removeError}
        </p>
      ) : null}
    </div>
  );
}
