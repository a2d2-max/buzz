import type { CodexLoginSession } from "@/shared/api/types";

/** How often the UI asks the backend about a running login. */
export const CODEX_LOGIN_POLL_MS = 1000;

/**
 * Shown next to the copy-command fallback. The command itself already names
 * the CLI by full path and uses straight quotes; this tells the reader why
 * retyping it is the thing that breaks.
 */
export const LOGIN_COMMAND_GUIDANCE =
  "Paste it as is. It names the Codex CLI by full path (so a codex shell function or alias cannot add flags to it) and uses straight quotes only. Retyping the quotes turns them into smart quotes and leaves the shell waiting at dquote>.";

export type CodexLoginTone = "neutral" | "success" | "error";

/** Pure projection of a login session for the row and the add dialog. */
export type CodexLoginView = {
  /** The CLI is still waiting on the browser; offer Cancel. */
  running: boolean;
  /** Process containment failed; the existing session must be stopped again. */
  retryStopping: boolean;
  tone: CodexLoginTone;
  headline: string;
  /** One scrubbed line from the CLI, when it has one. */
  detail: string | null;
  /** The CLI printed its sign-in URL; offer to open it (browser did not open). */
  offerSignInLink: boolean;
  /** Fires the post-login refresh (Test + readiness) exactly once per session. */
  justFinishedOk: boolean;
};

export function describeCodexLogin(
  session: CodexLoginSession | null | undefined,
): CodexLoginView | null {
  if (!session) {
    return null;
  }
  const base = {
    running: false,
    retryStopping: false,
    detail: session.message,
    offerSignInLink: false,
    justFinishedOk: false,
  };
  switch (session.state) {
    case "running":
      return {
        ...base,
        running: true,
        tone: "neutral",
        headline: "Waiting for you to finish signing in in the browser…",
        offerSignInLink: session.authUrl !== null,
      };
    case "succeeded":
      return {
        ...base,
        tone: "success",
        headline: "Signed in — checking the account works.",
        justFinishedOk: true,
      };
    case "failed":
      return session.finishedAt === null
        ? {
            ...base,
            retryStopping: true,
            tone: "error",
            headline: "Sign-in could not be fully stopped.",
          }
        : { ...base, tone: "error", headline: "Sign-in failed." };
    case "cancelled":
      return { ...base, tone: "neutral", headline: "Sign-in cancelled." };
    case "timed_out":
      return { ...base, tone: "error", headline: "Sign-in timed out." };
  }
}

/** React Query `refetchInterval`: poll only while a login is running. */
export function codexLoginPollInterval(
  session: CodexLoginSession | null | undefined,
): number | false {
  return session?.state === "running" ? CODEX_LOGIN_POLL_MS : false;
}

/**
 * Fence a delayed poll by the backend's unique session generation. A
 * cancel followed by a restart may leave the old IPC request in flight; its
 * terminal snapshot must never replace the new running session in the cache.
 */
export function acceptCodexLoginPoll(
  activeGeneration: string | null,
  current: CodexLoginSession | null,
  polled: CodexLoginSession | null,
): CodexLoginSession | null {
  if (activeGeneration && polled && polled.generation !== activeGeneration) {
    return current;
  }
  return polled;
}
