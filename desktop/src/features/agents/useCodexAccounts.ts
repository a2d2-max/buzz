/**
 * React Query hooks for the stored Codex accounts (Settings → Agents →
 * Codex accounts, and the per-agent picker in the edit dialog). Mirrors
 * `useClaudeAccounts.ts`: one stable query key, cache patches from mutation
 * responses, and a managed-agents invalidation on remove because the backend
 * detaches the account from every agent that referenced it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  addCodexAccount,
  getCodexLoginCommand,
  importOrcaCodexAccounts,
  listOrcaCodexAccounts,
  listCodexAccounts,
  removeCodexAccount,
  renameCodexAccount,
  testCodexAccount,
} from "@/shared/api/tauriCodexAccounts";
import type { CodexAccount, CodexAuthKind } from "@/shared/api/types";

import { managedAgentsQueryKey } from "./hooks";

export const codexAccountsQueryKey = ["codexAccounts"] as const;
export const orcaCodexAccountsQueryKey = ["orcaCodexAccounts"] as const;

export function useCodexAccountsQuery(options?: { enabled?: boolean }) {
  return useQuery({
    enabled: options?.enabled ?? true,
    queryKey: codexAccountsQueryKey,
    queryFn: listCodexAccounts,
    // Only this app mutates the list; a reread after each mutation is enough.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useOrcaCodexAccountsQuery(options?: { enabled?: boolean }) {
  return useQuery({
    enabled: options?.enabled ?? true,
    queryKey: orcaCodexAccountsQueryKey,
    queryFn: listOrcaCodexAccounts,
    staleTime: 0,
  });
}

export function useImportOrcaCodexAccountsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (accountIds: string[]) => importOrcaCodexAccounts(accountIds),
    onSuccess: (result) => {
      queryClient.setQueryData<CodexAccount[]>(
        codexAccountsQueryKey,
        (current) => [...(current ?? []), ...result.imported],
      );
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: codexAccountsQueryKey }),
        queryClient.invalidateQueries({ queryKey: orcaCodexAccountsQueryKey }),
      ]);
    },
  });
}

export function useAddCodexAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      label: string;
      authKind: CodexAuthKind;
      apiKey?: string;
    }) => addCodexAccount(input),
    onSuccess: (account) => {
      queryClient.setQueryData<CodexAccount[]>(
        codexAccountsQueryKey,
        (current) => [...(current ?? []), account],
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: codexAccountsQueryKey }),
  });
}

export function useRenameCodexAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; label: string }) =>
      renameCodexAccount(input.id, input.label),
    onSuccess: (account) => {
      queryClient.setQueryData<CodexAccount[]>(
        codexAccountsQueryKey,
        (current) =>
          (current ?? []).map((existing) =>
            existing.id === account.id ? account : existing,
          ),
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: codexAccountsQueryKey }),
  });
}

export function useRemoveCodexAccountMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => removeCodexAccount(id),
    onSuccess: (_result, id) => {
      queryClient.setQueryData<CodexAccount[]>(
        codexAccountsQueryKey,
        (current) => (current ?? []).filter((account) => account.id !== id),
      );
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: codexAccountsQueryKey }),
        queryClient.invalidateQueries({ queryKey: managedAgentsQueryKey }),
      ]);
    },
  });
}

export function useTestCodexAccountMutation() {
  return useMutation({
    mutationFn: (id: string) => testCodexAccount(id),
  });
}

export function useCodexLoginCommandMutation() {
  return useMutation({
    mutationFn: (id: string) => getCodexLoginCommand(id),
  });
}
