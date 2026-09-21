import { invokeTauri } from "@/shared/api/tauri";
import type {
  ClaudeAccount,
  ClaudeAccountTestResult,
  ClaudeAuthKind,
  CodexLoginSession,
  CodexLoginState,
  RemoveClaudeAccountResult,
} from "@/shared/api/types";

/** Wire shape (snake_case). Never carries the token itself. */
type RawClaudeAccount = {
  id: string;
  label: string;
  created_at: string;
  token_hint?: string;
  claude_auth_kind?: ClaudeAuthKind | null;
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
    authKind: account.claude_auth_kind ?? "setup_token",
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
  authKind: ClaudeAuthKind;
  token?: string;
}): Promise<ClaudeAccount> {
  const raw = await invokeTauri<RawClaudeAccount>("add_claude_account", {
    label: input.label,
    authKind: input.authKind,
    token: input.token ?? null,
  });
  return fromRawClaudeAccount(raw);
}

/** The one-time browser login command for a config-directory account. */
export async function getClaudeLoginCommand(id: string): Promise<string> {
  return invokeTauri<string>("get_claude_login_command", { id });
}

/**
 * Run that same one-time login: the app opens a terminal already pointed at
 * the account's directory, so the owner only finishes the browser sign-in.
 * Callers keep the copyable command as the fallback when this fails.
 */
type RawClaudeLoginSession = {
  generation: string;
  state: CodexLoginState;
  message?: string | null;
  auth_url?: string | null;
  started_at: string;
  finished_at?: string | null;
};

function fromRawClaudeLoginSession(
  raw: RawClaudeLoginSession,
): CodexLoginSession {
  return {
    generation: raw.generation,
    state: raw.state,
    message: raw.message ?? null,
    authUrl: raw.auth_url ?? null,
    startedAt: raw.started_at,
    finishedAt: raw.finished_at ?? null,
  };
}

export async function startClaudeAccountLogin(
  id: string,
): Promise<CodexLoginSession> {
  const raw = await invokeTauri<RawClaudeLoginSession>(
    "start_claude_account_login",
    { id },
  );
  return fromRawClaudeLoginSession(raw);
}

export async function pollClaudeAccountLogin(
  id: string,
): Promise<CodexLoginSession | null> {
  const raw = await invokeTauri<RawClaudeLoginSession | null>(
    "poll_claude_account_login",
    { id },
  );
  return raw ? fromRawClaudeLoginSession(raw) : null;
}

export async function cancelClaudeAccountLogin(
  id: string,
): Promise<CodexLoginSession | null> {
  const raw = await invokeTauri<RawClaudeLoginSession | null>(
    "cancel_claude_account_login",
    { id },
  );
  return raw ? fromRawClaudeLoginSession(raw) : null;
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
