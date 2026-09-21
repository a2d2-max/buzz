import { invokeTauri } from "@/shared/api/tauri";
import type {
  CodexAccount,
  CodexAccountTestResult,
  CodexAuthKind,
  CodexLoginSession,
  CodexLoginState,
  ImportOrcaCodexAccountsResult,
  OrcaCodexAccount,
  RemoveCodexAccountResult,
} from "@/shared/api/types";

/** Wire shape (snake_case). Never carries the API key itself. */
type RawCodexAccount = {
  id: string;
  label: string;
  created_at: string;
  token_hint?: string;
  auth_kind?: CodexAuthKind | null;
  external_home?: string | null;
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
    source: account.external_home ? "orca" : "app",
  };
}

export async function listOrcaCodexAccounts(): Promise<OrcaCodexAccount[]> {
  return invokeTauri<OrcaCodexAccount[]>("list_orca_codex_accounts");
}

export async function importOrcaCodexAccounts(
  accountIds: string[],
): Promise<ImportOrcaCodexAccountsResult> {
  const raw = await invokeTauri<{
    imported: RawCodexAccount[];
    skippedExistingCount: number;
    skippedLabelConflicts: string[];
  }>("import_orca_codex_accounts", { accountIds });
  return {
    imported: raw.imported.map(fromRawCodexAccount),
    skippedExistingCount: raw.skippedExistingCount,
    skippedLabelConflicts: raw.skippedLabelConflicts,
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
 * `chatgpt` accounts there is no key — the login happens right after,
 * in the app, against the account's own directory.
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

/**
 * The one-time `CODEX_HOME=… <codex> login` command for a chatgpt account —
 * the copy-and-paste fallback. The CLI is named by full path and the
 * directory is single-quoted only when needed, so a `codex` shell function
 * or alias cannot intercept it and there are no double quotes to retype.
 */
export async function getCodexLoginCommand(id: string): Promise<string> {
  return invokeTauri<string>("get_codex_login_command", { id });
}

type RawCodexLoginSession = {
  generation: string;
  state: CodexLoginState;
  message?: string | null;
  auth_url?: string | null;
  started_at: string;
  finished_at?: string | null;
};

function fromRawCodexLoginSession(
  raw: RawCodexLoginSession,
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

/**
 * Run `codex login` for a chatgpt account inside the app: the CLI (by full
 * path) opens the browser against the account's own directory; the sign-in
 * itself stays with the user. Rejects when a login is already running or
 * something else holds the CLI's callback port.
 */
export async function startCodexAccountLogin(
  id: string,
): Promise<CodexLoginSession> {
  const raw = await invokeTauri<RawCodexLoginSession>(
    "start_codex_account_login",
    { id },
  );
  return fromRawCodexLoginSession(raw);
}

/** Current state of the account's login, or null when none was started. */
export async function pollCodexAccountLogin(
  id: string,
): Promise<CodexLoginSession | null> {
  const raw = await invokeTauri<RawCodexLoginSession | null>(
    "poll_codex_account_login",
    { id },
  );
  return raw ? fromRawCodexLoginSession(raw) : null;
}

/** Stop a running login (kills the CLI). Null when none was started. */
export async function cancelCodexAccountLogin(
  id: string,
): Promise<CodexLoginSession | null> {
  const raw = await invokeTauri<RawCodexLoginSession | null>(
    "cancel_codex_account_login",
    { id },
  );
  return raw ? fromRawCodexLoginSession(raw) : null;
}
