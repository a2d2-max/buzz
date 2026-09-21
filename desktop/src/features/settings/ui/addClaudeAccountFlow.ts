import type { ClaudeAccount, ClaudeAuthKind } from "@/shared/api/types";

type AddClaudeAccountInput = {
  label: string;
  authKind: ClaudeAuthKind;
  token?: string;
};

type AddClaudeAccount = (
  input: AddClaudeAccountInput,
) => Promise<ClaudeAccount>;
type LoadLoginCommand = (id: string) => Promise<string>;

export type AddClaudeAccountFlowResult = {
  account: ClaudeAccount;
  loginCommand: string | null;
  loginCommandError: string | null;
};

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Keep a successful config-directory account creation authoritative even when
 * the follow-up, non-mutating login-command lookup fails. The caller can retry
 * that lookup with the returned account id without submitting another add.
 */
export async function addClaudeAccountAndLoadLoginCommand(
  input: AddClaudeAccountInput,
  addAccount: AddClaudeAccount,
  loadLoginCommand: LoadLoginCommand,
): Promise<AddClaudeAccountFlowResult> {
  const account = await addAccount(input);
  if (input.authKind !== "config_dir") {
    return { account, loginCommand: null, loginCommandError: null };
  }
  try {
    return {
      account,
      loginCommand: await loadLoginCommand(account.id),
      loginCommandError: null,
    };
  } catch (cause) {
    return {
      account,
      loginCommand: null,
      loginCommandError: errorMessage(cause),
    };
  }
}
