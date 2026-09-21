/**
 * In-app `codex login` for one chatgpt Codex account: start it, follow it
 * while the user finishes the sign-in in the browser, cancel it. Shared by
 * the account row and the add dialog, which share the query too — whichever
 * of them starts the login, the other sees it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { managedAgentsQueryKey } from "@/features/agents/hooks";
import {
  cancelCodexAccountLogin,
  pollCodexAccountLogin,
  startCodexAccountLogin,
} from "@/shared/api/tauriCodexAccounts";
import type { CodexLoginSession } from "@/shared/api/types";

import {
  acceptCodexLoginPoll,
  type CodexLoginView,
  codexLoginPollInterval,
  describeCodexLogin,
} from "./codexLoginFlow";

export function codexAccountLoginQueryKey(accountId: string) {
  return ["codexAccountLogin", accountId] as const;
}

function errorText(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
}

export function useCodexAccountLogin(
  accountId: string,
  options?: {
    /** Runs once per completed login (not for one found already finished). */
    onSucceeded?: () => void;
  },
) {
  const queryClient = useQueryClient();
  const queryKey = codexAccountLoginQueryKey(accountId);
  const activeGenerationRef = React.useRef<{
    accountId: string;
    generation: string | null;
  }>({ accountId, generation: null });
  if (activeGenerationRef.current.accountId !== accountId) {
    activeGenerationRef.current = { accountId, generation: null };
  }
  const session = useQuery({
    queryKey,
    queryFn: async () => {
      const polled = await pollCodexAccountLogin(accountId);
      const current =
        queryClient.getQueryData<CodexLoginSession | null>(queryKey) ?? null;
      const accepted = acceptCodexLoginPoll(
        activeGenerationRef.current.generation,
        current,
        polled,
      );
      if (!activeGenerationRef.current.generation && accepted) {
        activeGenerationRef.current.generation = accepted.generation;
      }
      return accepted;
    },
    // The backend is the source of truth; poll only while a login runs.
    refetchInterval: (query) => codexLoginPollInterval(query.state.data),
    refetchOnWindowFocus: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const start = useMutation({
    mutationFn: async () => {
      await queryClient.cancelQueries({ queryKey });
      return startCodexAccountLogin(accountId);
    },
    onSuccess: (snapshot) => {
      activeGenerationRef.current.generation = snapshot.generation;
      queryClient.setQueryData<CodexLoginSession | null>(queryKey, snapshot);
    },
  });
  const cancel = useMutation({
    mutationFn: async () => {
      await queryClient.cancelQueries({ queryKey });
      return cancelCodexAccountLogin(accountId);
    },
    onSuccess: (snapshot) => {
      if (snapshot) {
        queryClient.setQueryData<CodexLoginSession | null>(queryKey, snapshot);
      }
    },
  });

  // Fire the post-login refresh exactly once per completed login. A session
  // found already finished on mount is history, not an event.
  const onSucceededRef = React.useRef(options?.onSucceeded);
  onSucceededRef.current = options?.onSucceeded;
  const handledRef = React.useRef<{
    accountId: string;
    initialised: boolean;
    finishedAt: string | null;
  }>({ accountId, initialised: false, finishedAt: null });
  if (handledRef.current.accountId !== accountId) {
    handledRef.current = { accountId, initialised: false, finishedAt: null };
  }
  const data = session.data;
  React.useEffect(() => {
    if (data === undefined) {
      return;
    }
    const finishedAt = data?.finishedAt ?? null;
    const handled = handledRef.current;
    if (!handled.initialised) {
      handled.initialised = true;
      handled.finishedAt = finishedAt;
      return;
    }
    if (
      data?.state === "succeeded" &&
      finishedAt !== null &&
      finishedAt !== handled.finishedAt
    ) {
      handled.finishedAt = finishedAt;
      onSucceededRef.current?.();
      // Readiness ("needs codex login") of agents on this account changed.
      void queryClient.invalidateQueries({ queryKey: managedAgentsQueryKey });
    }
  }, [data, queryClient]);

  const view: CodexLoginView | null = describeCodexLogin(data);
  const startMutate = start.mutate;
  const cancelMutate = cancel.mutate;
  return {
    session: data ?? null,
    view,
    start: React.useCallback(() => startMutate(), [startMutate]),
    cancel: React.useCallback(() => cancelMutate(), [cancelMutate]),
    startPending: start.isPending,
    cancelPending: cancel.isPending,
    startError: start.error
      ? errorText(start.error, "Couldn't start the login.")
      : null,
    clearStartError: start.reset,
  };
}
