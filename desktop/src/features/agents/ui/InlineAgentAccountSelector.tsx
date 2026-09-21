import * as React from "react";
import { Bot, SquareTerminal } from "lucide-react";
import { toast } from "sonner";

import {
  useAcpRuntimesQuery,
  useUpdateManagedAgentMutation,
} from "@/features/agents/hooks";
import { useClaudeAccountsQuery } from "@/features/agents/useClaudeAccounts";
import { useCodexAccountsQuery } from "@/features/agents/useCodexAccounts";
import type { ManagedAgent } from "@/shared/api/types";

import {
  buildInlineAccountControls,
  buildInlineAccountUpdate,
  isInlineAccountQueryBlocking,
  type InlineAccountProvider,
} from "./inlineAgentAccountPicker";
import { findRuntimeForCommand } from "./claudeAccountOptions";

export function InlineAgentAccountSelector({ agent }: { agent: ManagedAgent }) {
  const runtimes = useAcpRuntimesQuery({
    enabled: agent.backend?.type === "local",
  });
  const runtime = findRuntimeForCommand(
    runtimes.data ?? [],
    agent.agentCommand,
  );
  const supportsClaude = runtime?.oauthTokenEnvVar != null;
  const supportsCodex = runtime?.supportsCodexAccounts ?? false;
  const claudeAccounts = useClaudeAccountsQuery({ enabled: supportsClaude });
  const codexAccounts = useCodexAccountsQuery({ enabled: supportsCodex });
  const update = useUpdateManagedAgentMutation();
  const [pending, setPending] = React.useState<{
    provider: InlineAccountProvider;
    value: string;
  } | null>(null);

  if (agent.backend?.type !== "local") return null;
  const controls = buildInlineAccountControls({
    agentCommand: agent.agentCommand,
    claudeAccountId: agent.claudeAccountId,
    codexAccountId: agent.codexAccountId,
    envVars: agent.envVars,
    runtimes: runtimes.data ?? [],
    claudeAccounts: claudeAccounts.data ?? null,
    codexAccounts: codexAccounts.data ?? null,
  });
  if (controls.length === 0) return null;

  async function save(provider: InlineAccountProvider, value: string) {
    const initialAccountId =
      provider === "claude" ? agent.claudeAccountId : agent.codexAccountId;
    const input = buildInlineAccountUpdate({
      pubkey: agent.pubkey,
      provider,
      selectionValue: value,
      initialAccountId,
    });
    if (!input) return;
    setPending({ provider, value });
    try {
      await update.mutateAsync(input);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not change the account.",
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {controls.map((control) => {
        const Icon = control.provider === "claude" ? Bot : SquareTerminal;
        const accountQuery =
          control.provider === "claude" ? claudeAccounts : codexAccounts;
        const accountQueryEnabled =
          control.provider === "claude" ? supportsClaude : supportsCodex;
        const value =
          pending?.provider === control.provider
            ? pending.value
            : control.value;
        return (
          <label
            className="flex min-w-0 items-center gap-1.5 text-muted-foreground"
            key={control.provider}
          >
            <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
            <span className="sr-only">
              {control.label} for {agent.name}
            </span>
            <select
              aria-label={`${control.label} for ${agent.name}`}
              className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 text-2xs text-foreground shadow-xs outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
              data-testid={`inline-${control.provider}-account-${agent.pubkey}`}
              disabled={
                update.isPending ||
                isInlineAccountQueryBlocking({
                  enabled: accountQueryEnabled,
                  isPending: accountQuery.isPending,
                  isError: accountQuery.isError,
                })
              }
              onChange={(event) => {
                void save(control.provider, event.target.value);
              }}
              onClick={(event) => event.stopPropagation()}
              value={value}
            >
              {control.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </div>
  );
}
