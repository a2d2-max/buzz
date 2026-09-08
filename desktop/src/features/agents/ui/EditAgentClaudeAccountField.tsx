import {
  buildClaudeAccountOptions,
  type ClaudeAccountList,
  claudeAccountIdFromSelection,
} from "./claudeAccountOptions";
import { PersonaDropdownField } from "./PersonaDropdownField";

function hintFor({
  accounts,
  accountsError,
  hasManualToken,
  selectedAccountId,
  tokenEnvVar,
}: {
  accounts: ClaudeAccountList;
  accountsError: boolean;
  hasManualToken: boolean;
  selectedAccountId: string | null;
  tokenEnvVar: string;
}): string {
  if (accountsError) {
    return "Couldn't load Claude accounts — check Settings → Agents → Claude accounts.";
  }
  if (accounts === null) {
    return "Loading Claude accounts…";
  }
  if (accounts.length === 0 && !hasManualToken) {
    return "Add accounts under Settings → Agents → Claude accounts to run this agent on another subscription.";
  }
  if (hasManualToken && selectedAccountId) {
    return `The selected account overrides the ${tokenEnvVar} value in the agent, persona, or global environment variables.`;
  }
  if (hasManualToken) {
    return `Using the ${tokenEnvVar} value from the agent, persona, or global environment variables. Remove it there to use the app's own login.`;
  }
  return "Which Claude subscription this agent signs in with.";
}

/**
 * "Claude account" picker for the agent edit dialog. Rendered only when the
 * prospective runtime reads an OAuth token env var (see
 * `AcpRuntimeCatalogEntry.oauthTokenEnvVar`). Pure presentation: the dialog
 * owns the selection and the submit contract (`claudeAccountOptions.ts`).
 */
export function EditAgentClaudeAccountField({
  accounts,
  accountsError,
  currentAccountId,
  disabled,
  hasManualToken,
  onValueChange,
  tokenEnvVar,
  value,
}: {
  accounts: ClaudeAccountList;
  /** The list query failed (as opposed to still loading — `accounts === null`). */
  accountsError: boolean;
  currentAccountId: string | null;
  disabled: boolean;
  hasManualToken: boolean;
  onValueChange: (value: string) => void;
  tokenEnvVar: string;
  value: string;
}) {
  const options = buildClaudeAccountOptions({
    accounts,
    currentAccountId,
    hasManualToken,
  });
  const hint = hintFor({
    accounts,
    accountsError,
    hasManualToken,
    selectedAccountId: claudeAccountIdFromSelection(value),
    tokenEnvVar,
  });

  return (
    <div className="space-y-1.5">
      <label
        className="text-sm font-medium text-foreground"
        htmlFor="edit-agent-claude-account"
      >
        Claude account
      </label>
      <PersonaDropdownField
        disabled={disabled}
        id="edit-agent-claude-account"
        onValueChange={onValueChange}
        options={options}
        placeholder="Choose an account"
        value={value}
      />
      <p
        className="text-xs text-muted-foreground"
        data-testid="edit-agent-claude-account-hint"
      >
        {hint}
      </p>
    </div>
  );
}
