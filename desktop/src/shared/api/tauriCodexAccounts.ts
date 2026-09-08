import { invokeTauri } from "@/shared/api/tauri";
import type {
  CodexAccount,
  CodexAccountTestResult,
  CodexAuthKind,
  RemoveCodexAccountResult,
} from "@/shared/api/types";

/** Wire shape (snake_case). Never carries the API key itself. */
type RawCodexAccount = {
  id: string;
  label: string;
  created_at: string;
  token_hint?: string;
  auth_kind?: CodexAuthKind | null;
};

type RawRemoveCodexAccountResult = {
  detached_agent_pubkeys?: string[];
  warning?: string | null;
};

function fromRawCodexAccount(account: RawCodexAccount): CodexAccount {
  return {
    id: account.id,
    label: account.label,
    createdAt: account.created_at,
    tokenHint: account.token_hint ?? "",
    // A record without a kind cannot spawn; "chatgpt" renders it most
    // conservatively (no key hint, login command visible).
    authKind: account.auth_kind ?? "chatgpt",
  };
}

/** All stored Codex accounts. API keys stay in the OS keyring. */
export async function listCodexAccounts(): Promise<CodexAccount[]> {
  const raw = await invokeTauri<RawCodexAccount[]>("list_codex_accounts");
  return raw.map(fromRawCodexAccount);
}

/**
 * Store a Codex account under `label`. This is the only call that ever
 * carries the API key; the response holds just a `…last4` hint. For
 * `chatgpt` accounts there is no key — the login happens later, in a
 * terminal, against the account's own directory.
 */
export async function addCodexAccount(input: {
  label: string;
  authKind: CodexAuthKind;
  apiKey?: string;
}): Promise<CodexAccount> {
  const raw = await invokeTauri<RawCodexAccount>("add_codex_account", {
    label: input.label,
    authKind: input.authKind,
    apiKey: input.apiKey ?? null,
  });
  return fromRawCodexAccount(raw);
}

export async function renameCodexAccount(
  id: string,
  label: string,
): Promise<CodexAccount> {
  const raw = await invokeTauri<RawCodexAccount>("rename_codex_account", {
    id,
    label,
  });
  return fromRawCodexAccount(raw);
}

/**
 * Remove the account, its keyring key, and its Codex directory. Agents that
 * pointed at it are switched back to the app login by the backend.
 */
export async function removeCodexAccount(
  id: string,
): Promise<RemoveCodexAccountResult> {
  const raw = await invokeTauri<RawRemoveCodexAccountResult>(
    "remove_codex_account",
    { id },
  );
  return {
    detachedAgentPubkeys: raw.detached_agent_pubkeys ?? [],
    warning: raw.warning ?? null,
  };
}

/** Prove the account works under the exact env the spawn would use. */
export async function testCodexAccount(
  id: string,
): Promise<CodexAccountTestResult> {
  return invokeTauri<CodexAccountTestResult>("test_codex_account", { id });
}

/** The one-time `CODEX_HOME=… codex login` command for a chatgpt account. */
export async function getCodexLoginCommand(id: string): Promise<string> {
  return invokeTauri<string>("get_codex_login_command", { id });
}
