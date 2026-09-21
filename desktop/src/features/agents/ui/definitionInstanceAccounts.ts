import type { ManagedAgent } from "@/shared/api/types";

export type PersonaInstanceAccountUpdate = {
  claudeAccountId?: string | null;
  codexAccountId?: string | null;
};

/** The managed agents (one per community) that run a definition. */
export function instancesOfPersona<
  T extends Pick<ManagedAgent, "pubkey" | "personaId">,
>(agents: readonly T[], personaId: string | null): T[] {
  if (personaId === null) return [];
  return agents.filter((agent) => agent.personaId === personaId);
}

/**
 * Preserve account-picker tri-state semantics at the atomic batch boundary.
 * `undefined` means untouched; `null` means return to the app login.
 */
export function personaInstanceAccountUpdate(submissions: {
  claudeAccountId: string | null | undefined;
  codexAccountId: string | null | undefined;
}): PersonaInstanceAccountUpdate | null {
  const input: PersonaInstanceAccountUpdate = {};
  if (submissions.claudeAccountId !== undefined) {
    input.claudeAccountId = submissions.claudeAccountId;
  }
  if (submissions.codexAccountId !== undefined) {
    input.codexAccountId = submissions.codexAccountId;
  }
  return Object.keys(input).length === 0 ? null : input;
}
