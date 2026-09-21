import * as React from "react";
import { ChevronRight } from "lucide-react";
import { toast } from "sonner";

import {
  useManagedAgentsQuery,
  useStartManagedAgentMutation,
  useStopManagedAgentMutation,
  useUpdateManagedAgentAccountsBatchMutation,
} from "@/features/agents/hooks";
import {
  agentPresenceStartBlockReason,
  useAgentAvailabilityLookup,
} from "@/features/agents/lib/useAgentAvailability";
import { clearActiveTurnsForAgentOnStop } from "@/features/agents/managedAgentRuntimeHooks";
import { isInlineAccountQueryBlocking } from "@/features/agents/ui/inlineAgentAccountPicker";
import { useClaudeAccountsQuery } from "@/features/agents/useClaudeAccounts";
import { useCodexAccountsQuery } from "@/features/agents/useCodexAccounts";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Spinner } from "@/shared/ui/spinner";

import {
  type AccountAgentGroup,
  type RosterProvider,
  ROSTER_MOVE_NONE_VALUE,
  batchOutcomeMessage,
  buildAccountAgentRoster,
  buildRosterJobs,
  guardedStartRunner,
  groupInstanceSummary,
  pruneRosterSelection,
  resolveRosterMoveTarget,
  rosterMoveOptions,
  rosterMoveUpdates,
  rosterStartTargets,
  rosterStopTargets,
  rosterSummary,
  runRosterJobs,
  toggleRosterSelection,
  turnClearingStopRunner,
} from "./accountRosterModel";

type BusyAction = "move" | "start" | "stop";

/**
 * "Agents on this account" — the roster under one account row in
 * Settings → Agents.
 *
 * Reverse of the per-agent account picker: pick several agents here and move,
 * start, or stop them together. That matters when an account runs out of
 * quota — every agent on it is stuck at once, and moving them one dialog at a
 * time is the slow path this replaces.
 *
 * Bulk does not mean looser rules. Start goes through the same relay-presence
 * guard every other Start entry point uses (a stopped record is not proof that
 * no body is running), Stop clears the agent's active-turn badges, and an
 * account list that has not arrived blocks the move instead of quietly
 * offering "Default" as if it were the only choice. Account moves commit all
 * selected records in one registry snapshot; process start/stop jobs continue
 * past failures and report their partial outcome.
 */
export function AccountAgentRoster({
  accountId,
  accountLabel,
  provider,
}: {
  accountId: string;
  accountLabel: string;
  provider: RosterProvider;
}) {
  const agentsQuery = useManagedAgentsQuery();
  const claudeAccounts = useClaudeAccountsQuery({
    enabled: provider === "claude",
  });
  const codexAccounts = useCodexAccountsQuery({
    enabled: provider === "codex",
  });
  const updateAccounts = useUpdateManagedAgentAccountsBatchMutation();
  const start = useStartManagedAgentMutation();
  const stop = useStopManagedAgentMutation();

  const [expanded, setExpanded] = React.useState(false);
  const [selectedKeys, setSelectedKeys] = React.useState<readonly string[]>([]);
  const [moveTarget, setMoveTarget] = React.useState(ROSTER_MOVE_NONE_VALUE);
  const [busy, setBusy] = React.useState<BusyAction | null>(null);
  const selectAllId = React.useId();
  const panelId = React.useId();

  const groups = React.useMemo(
    () =>
      buildAccountAgentRoster({
        agents: agentsQuery.data ?? [],
        provider,
        accountId,
      }),
    [agentsQuery.data, provider, accountId],
  );

  // A move empties the account, so the roster shrinks under the selection.
  // Dropping the vanished keys keeps the next bulk action aimed only at rows
  // that are still on screen.
  React.useEffect(() => {
    setSelectedKeys((current) => {
      const next = pruneRosterSelection(current, groups);
      return next.length === current.length ? current : next;
    });
  }, [groups]);

  // Presence is the Start authority, so it is read for exactly the records on
  // screen — and only while the list is open, which is the only time Start
  // exists.
  const rosterPubkeys = React.useMemo(
    () => groups.flatMap((group) => group.instances.map((i) => i.pubkey)),
    [groups],
  );
  const { getAvailability } = useAgentAvailabilityLookup(rosterPubkeys, {
    enabled: expanded && rosterPubkeys.length > 0,
  });

  const accountsQuery = provider === "claude" ? claudeAccounts : codexAccounts;
  // `null`, not `[]`: a list that has not arrived is not an empty list.
  const accounts = accountsQuery.data ?? null;
  const accountsBlocking = isInlineAccountQueryBlocking({
    enabled: true,
    isPending: accountsQuery.isPending,
    isError: accountsQuery.isError,
  });
  const moveOptions = rosterMoveOptions({
    accounts,
    currentAccountId: accountId,
  });
  const effectiveMoveTarget = resolveRosterMoveTarget(moveTarget, moveOptions);
  const startTargets = rosterStartTargets(groups, selectedKeys);
  const stopTargets = rosterStopTargets(groups, selectedKeys);
  const allSelected =
    groups.length > 0 && selectedKeys.length === groups.length;
  const someSelected = selectedKeys.length > 0;

  async function runJobs(
    jobs: readonly (() => Promise<void>)[],
    action: BusyAction,
    verbPast: string,
    verbBase: string,
    successSuffix = "",
  ) {
    if (jobs.length === 0) {
      return;
    }
    setBusy(action);
    const outcome = await runRosterJobs(jobs);
    setBusy(null);
    const message = batchOutcomeMessage({ verbPast, verbBase, ...outcome });
    if (outcome.failed > 0) {
      toast.error(message);
      return;
    }
    toast.success(`${message}${successSuffix}`);
  }

  async function moveSelected() {
    const updates = rosterMoveUpdates({
      groups,
      selectedKeys,
      provider,
      currentAccountId: accountId,
      targetValue: effectiveMoveTarget,
    });
    if (updates.length === 0) return;
    setBusy("move");
    try {
      await updateAccounts.mutateAsync({ updates });
      setMoveTarget(ROSTER_MOVE_NONE_VALUE);
      toast.success(
        `Moved ${selectedKeys.length} ${selectedKeys.length === 1 ? "agent" : "agents"}. Running agents restart to pick up the new account.`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "Couldn't move the selected agents.",
      );
    } finally {
      setBusy(null);
    }
  }

  function startSelected() {
    const jobs = buildRosterJobs({
      groups,
      selectedKeys,
      targetsOf: rosterStartTargets,
      // Same authority as every other Start entry point: a record this app
      // believes is stopped may still have a body present on the relay, and
      // starting a second one is the failure this prevents.
      run: guardedStartRunner({
        blockReason: (pubkey) =>
          agentPresenceStartBlockReason(false, getAvailability(pubkey)),
        start: async (pubkey) => {
          await start.mutateAsync(pubkey);
        },
      }),
    });
    void runJobs(jobs, "start", "Started", "start");
  }

  function stopSelected() {
    const jobs = buildRosterJobs({
      groups,
      selectedKeys,
      targetsOf: rosterStopTargets,
      run: turnClearingStopRunner({
        stop: async (pubkey) => {
          await stop.mutateAsync(pubkey);
        },
        clearTurns: clearActiveTurnsForAgentOnStop,
      }),
    });
    void runJobs(jobs, "stop", "Stopped", "stop");
  }

  if (agentsQuery.isPending) {
    return null;
  }
  if (agentsQuery.isError) {
    // "No agents" would be a lie: the list never arrived.
    return (
      <p
        className="mt-2 text-2xs text-destructive"
        data-testid={`account-roster-error-${accountId}`}
        role="alert"
      >
        Couldn't load the agents on this account.
      </p>
    );
  }

  const summary = rosterSummary(groups);
  if (groups.length === 0) {
    return (
      <p
        className="mt-2 text-2xs text-muted-foreground"
        data-testid={`account-roster-empty-${accountId}`}
      >
        {summary}
      </p>
    );
  }

  return (
    <div className="mt-2">
      <button
        aria-controls={panelId}
        aria-expanded={expanded}
        className="flex items-center gap-1 rounded-md text-2xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        data-testid={`account-roster-toggle-${accountId}`}
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <ChevronRight
          aria-hidden
          className={`h-3.5 w-3.5 transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
        />
        {summary}
      </button>

      {expanded ? (
        <div
          aria-busy={busy !== null}
          className="mt-2 space-y-2 rounded-lg border border-border/60 p-2"
          data-testid={`account-roster-${accountId}`}
          id={panelId}
        >
          <div className="flex items-center gap-2 text-2xs text-muted-foreground">
            <Checkbox
              checked={
                allSelected ? true : someSelected ? "indeterminate" : false
              }
              data-testid={`account-roster-select-all-${accountId}`}
              disabled={busy !== null}
              id={selectAllId}
              onCheckedChange={(checked) =>
                setSelectedKeys(
                  checked === true ? groups.map((group) => group.key) : [],
                )
              }
            />
            <label htmlFor={selectAllId}>Select all on {accountLabel}</label>
          </div>

          <ul className="space-y-1">
            {groups.map((group) => (
              <RosterLine
                accountId={accountId}
                busy={busy !== null}
                group={group}
                key={group.key}
                onToggle={() =>
                  setSelectedKeys((current) =>
                    toggleRosterSelection(current, group.key),
                  )
                }
                selected={selectedKeys.includes(group.key)}
              />
            ))}
          </ul>

          <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-2">
            <select
              aria-label={`Move the selected agents off ${accountLabel}`}
              className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 text-2xs text-foreground shadow-xs outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
              data-testid={`account-roster-move-target-${accountId}`}
              disabled={busy !== null || !someSelected || accountsBlocking}
              onChange={(event) => setMoveTarget(event.target.value)}
              value={effectiveMoveTarget}
            >
              {(
                moveOptions ?? [
                  { value: ROSTER_MOVE_NONE_VALUE, label: "Loading accounts…" },
                ]
              ).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <RosterActionButton
              busy={busy === "move"}
              disabled={
                busy !== null ||
                !someSelected ||
                accountsBlocking ||
                effectiveMoveTarget === ROSTER_MOVE_NONE_VALUE
              }
              label="Move"
              onClick={() => void moveSelected()}
              testId={`account-roster-move-${accountId}`}
            />
            <RosterActionButton
              busy={busy === "start"}
              disabled={busy !== null || startTargets.length === 0}
              label="Start"
              onClick={startSelected}
              testId={`account-roster-start-${accountId}`}
            />
            <RosterActionButton
              busy={busy === "stop"}
              disabled={busy !== null || stopTargets.length === 0}
              label="Stop"
              onClick={stopSelected}
              testId={`account-roster-stop-${accountId}`}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A bulk action button that announces its own in-flight state. */
function RosterActionButton({
  busy,
  disabled,
  label,
  onClick,
  testId,
}: {
  busy: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <Button
      aria-busy={busy}
      className="h-7 px-3 text-xs"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      size="sm"
      type="button"
      variant="outline"
    >
      {busy ? <Spinner aria-hidden className="h-3.5 w-3.5" /> : null}
      {busy ? `${label}…` : label}
    </Button>
  );
}

/** One selectable definition line. */
function RosterLine({
  accountId,
  busy,
  group,
  onToggle,
  selected,
}: {
  accountId: string;
  busy: boolean;
  group: AccountAgentGroup;
  onToggle: () => void;
  selected: boolean;
}) {
  const detail = groupInstanceSummary(group);
  const checkboxId = React.useId();
  return (
    <li className="flex min-w-0 items-center gap-2 text-xs">
      <Checkbox
        checked={selected}
        data-testid={`account-roster-agent-${accountId}-${group.key}`}
        disabled={busy}
        id={checkboxId}
        onCheckedChange={onToggle}
      />
      <label className="min-w-0 truncate" htmlFor={checkboxId}>
        {group.name}
      </label>
      {detail ? (
        <span className="shrink-0 text-2xs text-muted-foreground">
          {detail}
        </span>
      ) : null}
    </li>
  );
}
