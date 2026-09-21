/**
 * React Query hooks for the stored Claude accounts (Settings → Agents →
 * Claude accounts, and the per-agent picker in the edit dialog).
 *
 * One stable query key so every consumer shares the list; mutations patch
 * the cache from the response and invalidate for a background reread.
 * Removing an account also invalidates the managed-agents list, because the
 * backend detaches the account from every agent that referenced it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  addClaudeAccount,
  getClaudeLoginCommand,
  listClaudeAccounts,
  removeClaudeAccount,
  renameClaudeAccount,
  testClaudeAccount,
} from "@/shared/api/tauriClaudeAccounts";
import type { ClaudeAccount, ClaudeAuthKind } from "@/shared/api/types";

import { managedAgentsQueryKey } from "./hooks";

export const claudeAccountsQueryKey = ["claudeAccounts"] as const;

export function useClaudeAccountsQuery(options?: { enabled?: boolean }) {
  return useQuery({
    enabled: options?.enabled ?? true,
    queryKey: claudeAccountsQueryKey,
    queryFn: listClaudeAccounts,
    // Only this app mutates the list; a reread after each mutation is enough.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useAddClaudeAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      label: string;
      authKind: ClaudeAuthKind;
      token?: string;
    }) => addClaudeAccount(input),
    onSuccess: (account) => {
      queryClient.setQueryData<ClaudeAccount[]>(
        claudeAccountsQueryKey,
        (current) => [...(current ?? []), account],
      );
      return queryClient.invalidateQueries({
        queryKey: claudeAccountsQueryKey,
      });
    },
    onError: () =>
      queryClient.invalidateQueries({ queryKey: claudeAccountsQueryKey }),
  });
}

export function useClaudeLoginCommandMutation() {
  return useMutation({
    mutationFn: (id: string) => getClaudeLoginCommand(id),
  });
}

export function useRenameClaudeAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; label: string }) =>
      renameClaudeAccount(input.id, input.label),
    onSuccess: (account) => {
      queryClient.setQueryData<ClaudeAccount[]>(
        claudeAccountsQueryKey,
        (current) =>
          (current ?? []).map((existing) =>
            existing.id === account.id ? account : existing,
          ),
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: claudeAccountsQueryKey }),
  });
}

export function useRemoveClaudeAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => removeClaudeAccount(id),
    onSuccess: (_result, id) => {
      queryClient.setQueryData<ClaudeAccount[]>(
        claudeAccountsQueryKey,
        (current) => (current ?? []).filter((account) => account.id !== id),
      );
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: claudeAccountsQueryKey }),
        queryClient.invalidateQueries({ queryKey: managedAgentsQueryKey }),
      ]);
    },
  });
}

export function useTestClaudeAccountMutation() {
  return useMutation({
    mutationFn: (id: string) => testClaudeAccount(id),
  });
}
