import { invokeTauri } from "@/shared/api/tauri";
import type {
  ClaudeAccount,
  ClaudeAccountTestResult,
  RemoveClaudeAccountResult,
} from "@/shared/api/types";

/** Wire shape (snake_case). Never carries the token itself. */
type RawClaudeAccount = {
  id: string;
  label: string;
  created_at: string;
  token_hint?: string;
};

type RawRemoveClaudeAccountResult = {
  detached_agent_pubkeys?: string[];
  warning?: string | null;
};

function fromRawClaudeAccount(account: RawClaudeAccount): ClaudeAccount {
  return {
    id: account.id,
    label: account.label,
    createdAt: account.created_at,
    tokenHint: account.token_hint ?? "",
  };
}

/** All stored Claude accounts. Tokens stay in the OS keyring. */
export async function listClaudeAccounts(): Promise<ClaudeAccount[]> {
  const raw = await invokeTauri<RawClaudeAccount[]>("list_claude_accounts");
  return raw.map(fromRawClaudeAccount);
}

/**
 * Store a `claude setup-token` result under `label`. This is the only call
 * that ever carries the token; the response holds just a `…last4` hint.
 */
export async function addClaudeAccount(input: {
  label: string;
  token: string;
}): Promise<ClaudeAccount> {
  const raw = await invokeTauri<RawClaudeAccount>("add_claude_account", {
    label: input.label,
    token: input.token,
  });
  return fromRawClaudeAccount(raw);
}

export async function renameClaudeAccount(
  id: string,
  label: string,
): Promise<ClaudeAccount> {
  const raw = await invokeTauri<RawClaudeAccount>("rename_claude_account", {
    id,
    label,
  });
  return fromRawClaudeAccount(raw);
}

/**
 * Remove the account and its token. Agents that pointed at it are switched
 * back to the app login by the backend and reported here.
 */
export async function removeClaudeAccount(
  id: string,
): Promise<RemoveClaudeAccountResult> {
  const raw = await invokeTauri<RawRemoveClaudeAccountResult>(
    "remove_claude_account",
    { id },
  );
  return {
    detachedAgentPubkeys: raw.detached_agent_pubkeys ?? [],
    warning: raw.warning ?? null,
  };
}

/** Round-trip the stored token through the Claude CLI (`claude -p ping`). */
export async function testClaudeAccount(
  id: string,
): Promise<ClaudeAccountTestResult> {
  return invokeTauri<ClaudeAccountTestResult>("test_claude_account", { id });
}
