import {
  type CodexAccountList,
  buildCodexAccountOptions,
  codexAccountIdFromSelection,
} from "./codexAccountOptions";
import { PersonaDropdownField } from "./PersonaDropdownField";

function hintFor({
  accounts,
  accountsError,
  hasManualAuth,
  selectedAccountId,
}: {
  accounts: CodexAccountList;
  accountsError: boolean;
  hasManualAuth: boolean;
  selectedAccountId: string | null;
}): string {
  if (accountsError) {
    return "Couldn't load Codex accounts — check Settings → Agents → Codex accounts.";
  }
  if (accounts === null) {
    return "Loading Codex accounts…";
  }
  if (accounts.length === 0 && !hasManualAuth) {
    return "Add accounts under Settings → Agents → Codex accounts to run this agent on another OpenAI login.";
  }
  if (hasManualAuth && selectedAccountId) {
    return "The selected account overrides the OPENAI_API_KEY / CODEX_HOME values in the agent, persona, or global environment variables.";
  }
  if (hasManualAuth) {
    return "Using the OPENAI_API_KEY / CODEX_HOME values from the agent, persona, or global environment variables. Remove them there to use the app's own login.";
  }
  return "Which OpenAI login this agent signs in with.";
}

/**
 * "Codex account" picker for the agent edit dialog. Rendered only when the
 * prospective runtime honors Codex accounts (see
 * `AcpRuntimeCatalogEntry.supportsCodexAccounts`). Pure presentation: the
 * dialog owns the selection and the submit contract
 * (`codexAccountOptions.ts`).
 */
export function EditAgentCodexAccountField({
  accounts,
  accountsError,
  currentAccountId,
  disabled,
  hasManualAuth,
  onValueChange,
  value,
}: {
  accounts: CodexAccountList;
  /** The list query failed (as opposed to still loading — `accounts === null`). */
  accountsError: boolean;
  currentAccountId: string | null;
  disabled: boolean;
  hasManualAuth: boolean;
  onValueChange: (value: string) => void;
  value: string;
}) {
  const options = buildCodexAccountOptions({
    accounts,
    currentAccountId,
    hasManualToken: hasManualAuth,
  });
  const hint = hintFor({
    accounts,
    accountsError,
    hasManualAuth,
    selectedAccountId: codexAccountIdFromSelection(value),
  });

  return (
    <div className="space-y-1.5">
      <label
        className="text-sm font-medium text-foreground"
        htmlFor="edit-agent-codex-account"
      >
        Codex account
      </label>
      <PersonaDropdownField
        disabled={disabled}
        id="edit-agent-codex-account"
        onValueChange={onValueChange}
        options={options}
        placeholder="Choose an account"
        value={value}
      />
      <p
        className="text-xs text-muted-foreground"
        data-testid="edit-agent-codex-account-hint"
      >
        {hint}
      </p>
    </div>
  );
}
