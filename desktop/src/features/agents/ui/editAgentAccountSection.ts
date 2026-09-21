import type { AcpRuntimeCatalogEntry } from "@/shared/api/types";
import { BRAND_NAME } from "@/shared/constants/brand";

/** The catalog facts the account section is projected from. */
export type AccountSectionFacts = Pick<
  AcpRuntimeCatalogEntry,
  | "oauthTokenEnvVar"
  | "supportsCodexAccounts"
  | "dataHome"
  | "accountUnsupportedReason"
>;

export type AccountSectionModel = {
  claudePicker: boolean;
  codexPicker: boolean;
  /**
   * Set when neither picker applies: the section then renders a disabled
   * "Account" field carrying this sentence instead of disappearing. Null
   * exactly when a picker is shown.
   */
  unsupportedReason: string | null;
  /** Whether the spawn gives this agent its own data home (memory). */
  memoryIsolated: boolean;
  memoryNote: string;
};

const UNKNOWN_RUNTIME_REASON =
  "Pick a runtime first — which accounts apply depends on it.";
const GENERIC_UNSUPPORTED_REASON = `This harness signs in on its own. ${BRAND_NAME} accounts apply only to Claude Code and Codex runtimes.`;

function memoryNoteFor(runtime: AccountSectionFacts | undefined): {
  memoryIsolated: boolean;
  memoryNote: string;
} {
  switch (runtime?.dataHome) {
    case "hermes_profile":
      return {
        memoryIsolated: true,
        memoryNote:
          "Memory: this agent keeps its own Hermes profile (memories, sessions, state) — separate from other agents, and kept when you change its account or model.",
      };
    case "codex_home":
      return {
        memoryIsolated: true,
        memoryNote:
          "Memory: this agent keeps its own Codex home (sessions, history) — separate from other agents, and kept when you change its account or model.",
      };
    case "none":
      return {
        memoryIsolated: false,
        memoryNote:
          "Memory: shared with other agents on this machine through the runtime's default home — per-agent isolation is not available for this runtime yet.",
      };
    default:
      return {
        memoryIsolated: false,
        memoryNote: "Memory: depends on the runtime you pick.",
      };
  }
}

/**
 * Pure projection of the edit dialog's account section from catalog facts.
 * Every runtime gets the section: a picker where an account can be honored,
 * otherwise the catalog's reason in a disabled field (never hidden). Pickers
 * gate on capabilities, never on a harness id.
 */
export function accountSectionModel(
  runtime: AccountSectionFacts | undefined,
): AccountSectionModel {
  const memory = memoryNoteFor(runtime);
  if (runtime === undefined) {
    return {
      claudePicker: false,
      codexPicker: false,
      unsupportedReason: UNKNOWN_RUNTIME_REASON,
      ...memory,
    };
  }
  const claudePicker = runtime.oauthTokenEnvVar !== null;
  const codexPicker = runtime.supportsCodexAccounts;
  return {
    claudePicker,
    codexPicker,
    unsupportedReason:
      claudePicker || codexPicker
        ? null
        : (runtime.accountUnsupportedReason ?? GENERIC_UNSUPPORTED_REASON),
    ...memory,
  };
}
