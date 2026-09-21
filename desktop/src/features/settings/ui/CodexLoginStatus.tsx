import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";
import { Spinner } from "@/shared/ui/spinner";

import type { CodexLoginView } from "./codexLoginFlow";

const toneClass: Record<CodexLoginView["tone"], string> = {
  neutral: "text-muted-foreground",
  success: "text-emerald-600 dark:text-emerald-400",
  error: "text-destructive",
};

/**
 * Where an in-app Codex login stands, plus the two things the user can do
 * about it: open the sign-in page when the browser did not, and cancel.
 * Pure presentation over `describeCodexLogin`.
 */
export function CodexLoginStatus({
  accountId,
  authUrl,
  cancelPending,
  onCancel,
  view,
}: {
  accountId: string;
  authUrl: string | null;
  cancelPending: boolean;
  onCancel: () => void;
  view: CodexLoginView;
}) {
  async function openSignInPage() {
    if (!authUrl) {
      return;
    }
    try {
      await openUrl(authUrl);
    } catch {
      toast.error(
        "Couldn't open the browser — copy the login command instead.",
      );
    }
  }

  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-2 text-sm"
      data-testid={`codex-account-login-status-${accountId}`}
      role={view.tone === "error" ? "alert" : "status"}
    >
      {view.running ? (
        <Spinner aria-hidden className="h-3.5 w-3.5 shrink-0" />
      ) : null}
      <span className={toneClass[view.tone]}>
        {view.headline}
        {view.detail ? ` — ${view.detail}` : ""}
      </span>
      {view.running && view.offerSignInLink ? (
        <Button
          className="h-7 px-3 text-xs"
          data-testid={`codex-account-login-open-${accountId}`}
          onClick={openSignInPage}
          size="sm"
          type="button"
          variant="outline"
        >
          Open sign-in page
        </Button>
      ) : null}
      {view.running || view.retryStopping ? (
        <Button
          className="h-7 px-3 text-xs"
          data-testid={
            view.retryStopping
              ? `codex-account-login-retry-stop-${accountId}`
              : `codex-account-login-cancel-${accountId}`
          }
          disabled={cancelPending}
          onClick={onCancel}
          size="sm"
          type="button"
          variant="ghost"
        >
          {view.retryStopping ? "Retry stopping sign-in" : "Cancel"}
        </Button>
      ) : null}
    </div>
  );
}
