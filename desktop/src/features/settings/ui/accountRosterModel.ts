/**
 * Pure logic for the "agents on this account" roster in
 * Settings → Agents → Claude accounts / Codex accounts.
 *
 * An account row owns the reverse of the per-agent picker: the picker asks
 * "which account does this agent run on", the roster asks "which agents run
 * on this account" and moves or restarts them together. That question has no
 * stored answer — it is derived by filtering the managed-agent list on
 * `claudeAccountId` / `codexAccountId`, so nothing here writes a second copy
 * of the binding.
 *
 * Grouping mirrors the Edit dialog: one line per definition (persona), not
 * per record. A definition runs one managed-agent record per community, so a
 * per-record list would repeat the same name several times and a move would
 * look like it only took on one of them. Every action therefore fans out to
 * each record in the group, exactly like `instanceAccountUpdates` does.
 *
 * The move reuses the per-agent picker's option list and update builder
 * rather than growing a third copy: same sentinels, same "unknown list is not
 * an empty list" rule, same one-narrow-patch submission.
 */
import { DEFAULT_CLAUDE_ACCOUNT_VALUE } from "@/features/agents/ui/claudeAccountOptions";
import { buildInlineAccountUpdate } from "@/features/agents/ui/inlineAgentAccountPicker";
import type { ManagedAgent, UpdateManagedAgentInput } from "@/shared/api/types";

export type RosterProvider = "claude" | "codex";

/**
 * "Move back to the default login". The Claude and Codex pickers share this
 * sentinel already (see `codexAccountOptions`), so the roster shares it too
 * instead of minting a third one.
 */
export const ROSTER_MOVE_DEFAULT_VALUE = DEFAULT_CLAUDE_ACCOUNT_VALUE;
/** The unpicked dropdown state; never submits anything. */
export const ROSTER_MOVE_NONE_VALUE = "";

export type RosterInstance = {
  pubkey: string;
  /** A live local process. Only these are Stop targets. */
  running: boolean;
  /**
   * Running, or deployed on a remote backend. This is what the row reports,
   * so a deployed remote agent is never labelled "stopped".
   */
  active: boolean;
  /**
   * Only a local record has a process this app can start or stop. A remote
   * ("provider") record reports `deployed`/`not_deployed` and is roster-
   * visible for the move, but never a start/stop target.
   */
  local: boolean;
};

export type AccountAgentGroup = {
  /** List key: the definition id, or `agent:<pubkey>` for an unlinked record. */
  key: string;
  name: string;
  instances: RosterInstance[];
  /** Records that are running or deployed — the number the row shows. */
  activeCount: number;
};

export type RosterAgent = Pick<
  ManagedAgent,
  | "pubkey"
  | "name"
  | "personaId"
  | "claudeAccountId"
  | "codexAccountId"
  | "status"
  | "backend"
>;

/** Accounts of one kind, or `null` while the list is unknown (loading/failed). */
export type RosterAccountList = readonly { id: string; label: string }[] | null;

function boundAccountId(agent: RosterAgent, provider: RosterProvider) {
  return provider === "claude" ? agent.claudeAccountId : agent.codexAccountId;
}

/** The definitions bound to `accountId`, name-sorted, instances folded in. */
export function buildAccountAgentRoster({
  agents,
  provider,
  accountId,
}: {
  agents: readonly RosterAgent[];
  provider: RosterProvider;
  accountId: string;
}): AccountAgentGroup[] {
  const groups = new Map<string, AccountAgentGroup>();
  for (const agent of agents) {
    if (boundAccountId(agent, provider) !== accountId) {
      continue;
    }
    const key = agent.personaId ?? `agent:${agent.pubkey}`;
    const running = agent.status === "running";
    const instance: RosterInstance = {
      pubkey: agent.pubkey,
      running,
      active: running || agent.status === "deployed",
      local: agent.backend.type === "local",
    };
    const existing = groups.get(key);
    if (existing) {
      existing.instances.push(instance);
      existing.activeCount += instance.active ? 1 : 0;
      continue;
    }
    groups.set(key, {
      key,
      name: agent.name,
      instances: [instance],
      activeCount: instance.active ? 1 : 0,
    });
  }
  return [...groups.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key),
  );
}

/**
 * Drop selected keys that are no longer in the roster. A move empties the
 * account, and a stale key would otherwise let the next bulk action fire at
 * a group that is not on screen.
 */
export function pruneRosterSelection(
  selectedKeys: readonly string[],
  groups: readonly AccountAgentGroup[],
): string[] {
  const present = new Set(groups.map((group) => group.key));
  return selectedKeys.filter((key) => present.has(key));
}

export function toggleRosterSelection(
  selectedKeys: readonly string[],
  key: string,
): string[] {
  return selectedKeys.includes(key)
    ? selectedKeys.filter((selected) => selected !== key)
    : [...selectedKeys, key];
}

function selectedGroups(
  groups: readonly AccountAgentGroup[],
  selectedKeys: readonly string[],
): AccountAgentGroup[] {
  const wanted = new Set(selectedKeys);
  return groups.filter((group) => wanted.has(group.key));
}

/**
 * One narrow `update_managed_agent` patch per record, built by the same
 * helper the per-agent picker uses. The caller submits the returned patches
 * to the atomic account-batch command, so a target equal to the current
 * account drops out without creating a partial multi-instance update.
 */
export function rosterMoveUpdates({
  groups,
  selectedKeys,
  provider,
  currentAccountId,
  targetValue,
}: {
  groups: readonly AccountAgentGroup[];
  selectedKeys: readonly string[];
  provider: RosterProvider;
  currentAccountId: string;
  targetValue: string;
}): UpdateManagedAgentInput[] {
  if (targetValue === ROSTER_MOVE_NONE_VALUE) {
    return [];
  }
  return selectedGroups(groups, selectedKeys).flatMap((group) =>
    group.instances.flatMap((instance) => {
      const input = buildInlineAccountUpdate({
        pubkey: instance.pubkey,
        provider,
        selectionValue: targetValue,
        initialAccountId: currentAccountId,
      });
      return input ? [input] : [];
    }),
  );
}

/** Local records in the selection that are not running yet. */
export function rosterStartTargets(
  groups: readonly AccountAgentGroup[],
  selectedKeys: readonly string[],
): string[] {
  return selectedGroups(groups, selectedKeys)
    .flatMap((group) => group.instances)
    .filter((instance) => instance.local && !instance.running)
    .map((instance) => instance.pubkey);
}

/** Local records in the selection that are running. */
export function rosterStopTargets(
  groups: readonly AccountAgentGroup[],
  selectedKeys: readonly string[],
): string[] {
  return selectedGroups(groups, selectedKeys)
    .flatMap((group) => group.instances)
    .filter((instance) => instance.local && instance.running)
    .map((instance) => instance.pubkey);
}

/**
 * Move targets: the default login plus every other account of this kind.
 *
 * Returns `null` when the account list has not arrived. An unknown list must
 * never render as "Default is your only option" — the owner would read that
 * as a real choice and unbind the agents.
 */
export function rosterMoveOptions({
  accounts,
  currentAccountId,
}: {
  accounts: RosterAccountList;
  currentAccountId: string;
}): { value: string; label: string }[] | null {
  if (accounts === null) {
    return null;
  }
  return [
    { value: ROSTER_MOVE_NONE_VALUE, label: "Move to…" },
    { value: ROSTER_MOVE_DEFAULT_VALUE, label: "Default (app login)" },
    ...accounts
      .filter((account) => account.id !== currentAccountId)
      .map((account) => ({ value: account.id, label: account.label })),
  ];
}

/**
 * Keep the picked target representable. A target that left the list (its
 * account was removed while the roster was open) must fall back to "Move
 * to…", or Move would write a dead account id that no spawn can resolve.
 */
export function resolveRosterMoveTarget(
  targetValue: string,
  options: { value: string }[] | null,
): string {
  if (options === null) {
    return ROSTER_MOVE_NONE_VALUE;
  }
  return options.some((option) => option.value === targetValue)
    ? targetValue
    : ROSTER_MOVE_NONE_VALUE;
}

/** Header line — also the screen-reader summary for the disclosure button. */
export function rosterSummary(groups: readonly AccountAgentGroup[]): string {
  if (groups.length === 0) {
    return "No agents on this account";
  }
  // Both halves count agents, not records: "2 agents · 1 running" must not
  // mean "one of two agents has one running record".
  const active = groups.filter((group) => group.activeCount > 0).length;
  const noun = groups.length === 1 ? "agent" : "agents";
  return active > 0
    ? `${groups.length} ${noun} on this account · ${active} running`
    : `${groups.length} ${noun} on this account`;
}

/** Per-line detail: how many records the group's actions would touch. */
export function groupInstanceSummary(group: AccountAgentGroup): string {
  const parts: string[] = [];
  if (group.instances.length > 1) {
    parts.push(`${group.instances.length} instances`);
  }
  if (group.activeCount > 0) {
    parts.push(`${group.activeCount} running`);
  } else if (group.instances.some((instance) => instance.local)) {
    parts.push("stopped");
  }
  return parts.join(" · ");
}

/**
 * Result line for a bulk action. Each record is written on its own, so a
 * partial failure is the normal case and must be said out loud rather than
 * reported as a plain success.
 */
export function batchOutcomeMessage({
  verbPast,
  verbBase,
  succeeded,
  failed,
  firstError,
}: {
  /** e.g. "Moved" / "Started" / "Stopped". */
  verbPast: string;
  /** e.g. "move" / "start" / "stop", for the all-failed sentence. */
  verbBase: string;
  succeeded: number;
  failed: number;
  firstError: string | null;
}): string {
  const agents = (count: number) =>
    `${count} ${count === 1 ? "agent" : "agents"}`;
  if (failed === 0) {
    return `${verbPast} ${agents(succeeded)}.`;
  }
  const reason = firstError ? ` — ${firstError}` : "";
  if (succeeded === 0) {
    return `Couldn't ${verbBase} ${agents(failed)}${reason}`;
  }
  return `${verbPast} ${agents(succeeded)}, ${failed} failed${reason}`;
}

/** Runs one record's part of a bulk action. */
export type RosterRunner = (pubkey: string) => Promise<void>;

/**
 * Start, gated on relay presence.
 *
 * `blockReason` is the caller's `agentPresenceStartBlockReason` read — kept a
 * parameter so this stays pure, and so the refusal is testable without a
 * relay. A stopped record is not proof that no body is running, and this
 * runner must refuse before `start` is ever called.
 */
export function guardedStartRunner({
  blockReason,
  start,
}: {
  blockReason: (pubkey: string) => string | undefined;
  start: RosterRunner;
}): RosterRunner {
  return async (pubkey) => {
    const reason = blockReason(pubkey);
    if (reason) {
      throw new Error(reason);
    }
    await start(pubkey);
  };
}

/**
 * Stop, followed by clearing the agent's active-turn badges. Every other
 * local Stop path does both; a stop without the clear leaves a "working"
 * badge the agent can no longer retract.
 */
export function turnClearingStopRunner({
  stop,
  clearTurns,
}: {
  stop: RosterRunner;
  clearTurns: (pubkey: string) => void;
}): RosterRunner {
  return async (pubkey) => {
    await stop(pubkey);
    clearTurns(pubkey);
  };
}

/**
 * One job per selected group, skipping groups with nothing to do. Jobs are
 * per-agent, not per-record, so a partial failure is reported in the units
 * the roster shows.
 */
export function buildRosterJobs({
  groups,
  selectedKeys,
  targetsOf,
  run,
}: {
  groups: readonly AccountAgentGroup[];
  selectedKeys: readonly string[];
  targetsOf: (
    groups: readonly AccountAgentGroup[],
    selectedKeys: readonly string[],
  ) => string[];
  run: RosterRunner;
}): (() => Promise<void>)[] {
  return selectedGroups(groups, selectedKeys).flatMap((group) => {
    const pubkeys = targetsOf(groups, [group.key]);
    if (pubkeys.length === 0) {
      return [];
    }
    return [
      async () => {
        for (const pubkey of pubkeys) {
          await run(pubkey);
        }
      },
    ];
  });
}

/** Run every job, keeping going past a failure and remembering the first one. */
export async function runRosterJobs(
  jobs: readonly (() => Promise<void>)[],
): Promise<{ succeeded: number; failed: number; firstError: string | null }> {
  let succeeded = 0;
  let failed = 0;
  let firstError: string | null = null;
  for (const job of jobs) {
    try {
      await job();
      succeeded += 1;
    } catch (error) {
      failed += 1;
      firstError ??=
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : null;
    }
  }
  return { succeeded, failed, firstError };
}
