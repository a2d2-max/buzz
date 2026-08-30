import { Search, X } from "lucide-react";
import * as React from "react";

import { cn } from "@/shared/lib/cn";
import type { CompleteOpsCollectionState } from "../opsPagedCollection";
import type { OpsGlobalCollectionStates } from "../opsGlobalCollections";
import {
  type OpsGlobalCollections,
  type OpsSearchKind,
  projectOpsHome,
  projectOpsWork,
} from "../opsGlobalProjection";

const TARGET_SIZE = { minHeight: 44, minWidth: 44 } as const;
const WORK_TABS = ["Plan", "Attention", "Evidence"] as const;
type WorkTab = (typeof WORK_TABS)[number];

function StatusPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-border px-2 py-0.5 text-2xs uppercase tracking-[0.12em] text-muted-foreground">
      {children}
    </span>
  );
}

function SignalList({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <section aria-label={label} className="min-w-0">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </h2>
      <div className="relative space-y-px border-[#C8FF45]/70 border-l pl-4 before:absolute before:-left-1 before:top-0 before:h-2 before:w-2 before:rounded-full before:bg-[#C8FF45]">
        {children}
      </div>
    </section>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <p className="py-3 text-sm text-muted-foreground">{children}</p>;
}

export function OpsCollectionState<T>({
  label,
  onRetry,
  state,
}: {
  label: string;
  onRetry?: () => void;
  state:
    | CompleteOpsCollectionState<T>
    | { status: "disconnected" }
    | { status: "not_requested" }
    | { status: "pending" };
}) {
  if (state.status === "not_requested") return null;
  if (state.status === "pending") {
    return (
      <p className="p-4 text-sm text-muted-foreground">{label} is loading.</p>
    );
  }
  if (state.status === "unavailable") {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {label} is unavailable.
      </p>
    );
  }
  if (state.status === "disconnected") {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        <p>{label} is disconnected.</p>
        {onRetry ? (
          <button
            className="mt-2 min-h-11 rounded-lg border border-border px-3 text-foreground"
            onClick={onRetry}
            type="button"
          >
            Retry {label}
          </button>
        ) : null}
      </div>
    );
  }
  if (state.status === "contract_invalid") {
    return (
      <p className="p-4 text-sm text-destructive">
        {label} contract is invalid.
      </p>
    );
  }
  if (state.status === "retry_required") {
    return (
      <div className="p-4 text-sm text-amber-300">
        <p>{label} changed again. Retry required.</p>
        {onRetry ? (
          <button
            className="mt-2 min-h-11 rounded-lg border border-border px-3 text-foreground"
            onClick={onRetry}
            type="button"
          >
            Retry {label}
          </button>
        ) : null}
      </div>
    );
  }
  if (state.items.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No {label.toLowerCase()} is active.
      </p>
    );
  }
  return null;
}

export function OpsHomeView({
  collections,
  onOpenWork,
  refreshed = false,
  states,
}: {
  collections: OpsGlobalCollections;
  onOpenWork: (id: string) => void;
  refreshed?: boolean;
  states?: OpsGlobalCollectionStates;
}) {
  const pulse = projectOpsHome(collections);
  return (
    <main
      className="min-h-0 min-w-0 flex-1 overflow-auto px-4 py-5 sm:px-6"
      data-testid="ops-home-view"
    >
      <div className="mx-auto max-w-6xl">
        <div className="mb-5 flex min-w-0 items-end justify-between gap-4 border-border border-b pb-3">
          <div>
            <p className="text-2xs uppercase tracking-[0.18em] text-[#C8FF45]">
              Global operations
            </p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight">
              Operational pulse
            </h1>
          </div>
          {refreshed ? (
            <span className="text-xs text-amber-300" role="status">
              Collection refreshed
            </span>
          ) : null}
        </div>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.8fr)]">
          <div className="space-y-6">
            <SignalList label="Today's work">
              {states?.work_items && states.work_items.status !== "ready" ? (
                <OpsCollectionState label="Work" state={states.work_items} />
              ) : pulse.activeWork.length === 0 ? (
                <EmptyRow>No work is active.</EmptyRow>
              ) : (
                pulse.activeWork.map((item) => (
                  <button
                    className="flex min-h-11 w-full min-w-0 items-center justify-between gap-3 border-border border-b px-1 py-2 text-left hover:bg-muted/30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#C8FF45]"
                    key={item.id}
                    onClick={() => onOpenWork(item.id)}
                    type="button"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {item.title}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {Math.round(item.progress * 100)}% ·{" "}
                        {item.session_count} sessions
                      </span>
                    </span>
                    <StatusPill>{item.status}</StatusPill>
                  </button>
                ))
              )}
            </SignalList>
            <SignalList label="Attention">
              {states?.work_items && states.work_items.status !== "ready" ? (
                <OpsCollectionState label="Work" state={states.work_items} />
              ) : null}
              {states?.decisions && states.decisions.status !== "ready" ? (
                <OpsCollectionState
                  label="Decisions"
                  state={states.decisions}
                />
              ) : null}
              {states?.approval_index &&
              states.approval_index.status !== "ready" ? (
                <OpsCollectionState
                  label="Approvals"
                  state={states.approval_index}
                />
              ) : null}
              {pulse.attention.length === 0 &&
              (!states?.work_items || states.work_items.status === "ready") &&
              (!states?.decisions || states.decisions.status === "ready") &&
              (!states?.approval_index ||
                states.approval_index.status === "ready") ? (
                <EmptyRow>No attention is pending.</EmptyRow>
              ) : (
                pulse.attention.map((item) => (
                  <div
                    className="border-border border-b px-1 py-2"
                    key={item.id}
                  >
                    <p className="text-sm font-medium">
                      {"title" in item
                        ? item.title
                        : (item.hold_reason ?? item.action_kind)}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {"queue" in item
                        ? item.queue
                        : "risk_class" in item
                          ? item.risk_class.join(" · ")
                          : item.status}
                    </p>
                  </div>
                ))
              )}
            </SignalList>
          </div>
          <div className="space-y-6">
            <SignalList label="Active sessions">
              {states?.sessions && states.sessions.status !== "ready" ? (
                <OpsCollectionState label="Sessions" state={states.sessions} />
              ) : pulse.activeSessions.length === 0 ? (
                <EmptyRow>No sessions are active.</EmptyRow>
              ) : (
                pulse.activeSessions.map((session) => (
                  <div
                    className="border-border border-b px-1 py-2"
                    key={session.id}
                  >
                    <p className="text-sm font-medium">{session.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {session.source} · {session.activity} · {session.health}
                    </p>
                  </div>
                ))
              )}
            </SignalList>
            <SignalList label="Recent decisions">
              {states?.decisions && states.decisions.status !== "ready" ? (
                <OpsCollectionState
                  label="Decisions"
                  state={states.decisions}
                />
              ) : pulse.recentDecisions.length === 0 ? (
                <EmptyRow>No recent decisions.</EmptyRow>
              ) : (
                pulse.recentDecisions.map((entry) => (
                  <div
                    className="border-border border-b px-1 py-2"
                    key={entry.id}
                  >
                    <p className="text-sm">{entry.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {entry.queue} · {entry.status}
                    </p>
                  </div>
                ))
              )}
            </SignalList>
            <SignalList label="Recent evidence">
              {states?.evidence && states.evidence.status !== "ready" ? (
                <OpsCollectionState label="Evidence" state={states.evidence} />
              ) : pulse.recentEvidence.length === 0 ? (
                <EmptyRow>No recent evidence.</EmptyRow>
              ) : (
                pulse.recentEvidence.map((entry) => (
                  <div
                    className="border-border border-b px-1 py-2"
                    key={entry.id}
                  >
                    <p className="text-sm">{entry.kind}</p>
                    <p className="text-xs text-muted-foreground">
                      {entry.status}
                    </p>
                  </div>
                ))
              )}
            </SignalList>
            <SignalList label="Recent audit">
              {states?.audit && states.audit.status !== "ready" ? (
                <OpsCollectionState label="Audit" state={states.audit} />
              ) : pulse.recentAudit.length === 0 ? (
                <EmptyRow>No recent audit entries.</EmptyRow>
              ) : (
                pulse.recentAudit.map((entry) => (
                  <div
                    className="border-border border-b px-1 py-2"
                    key={entry.id}
                  >
                    <p className="text-sm">{entry.summary}</p>
                    <p className="text-xs text-muted-foreground">
                      {entry.kind}
                    </p>
                  </div>
                ))
              )}
            </SignalList>
          </div>
        </div>
      </div>
    </main>
  );
}

function WorkPicker({
  onClose,
  onSelect,
  selectedWorkId,
  trigger,
  workItems,
}: {
  onClose: () => void;
  onSelect: (id: string) => void;
  selectedWorkId: string;
  trigger: React.RefObject<HTMLButtonElement | null>;
  workItems: OpsGlobalCollections["workItems"];
}) {
  const dialog = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const restoreTriggerFocus = () => {
      queueMicrotask(() => trigger.current?.focus({ preventScroll: true }));
    };
    dialog.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        restoreTriggerFocus();
        return;
      }
      if (event.key !== "Tab") return;
      const buttons = Array.from(
        dialog.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
      );
      if (buttons.length === 0) {
        event.preventDefault();
        dialog.current?.focus({ preventScroll: true });
        return;
      }
      const first = buttons[0];
      const last = buttons.at(-1) ?? first;
      if (document.activeElement === dialog.current) {
        event.preventDefault();
        first.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };
    const focusin = (event: FocusEvent) => {
      if (
        dialog.current &&
        event.target instanceof Node &&
        !dialog.current.contains(event.target)
      ) {
        queueMicrotask(() => {
          if (
            dialog.current &&
            !dialog.current.contains(document.activeElement)
          ) {
            dialog.current.focus({ preventScroll: true });
          }
        });
      }
    };
    window.addEventListener("keydown", keydown);
    document.addEventListener("focusin", focusin);
    return () => {
      window.removeEventListener("keydown", keydown);
      document.removeEventListener("focusin", focusin);
    };
  }, [onClose, trigger]);
  return (
    <div className="fixed inset-0 z-50 bg-background/80">
      <div
        aria-label="Choose work"
        aria-modal="true"
        className="absolute inset-y-0 left-0 flex w-[min(22rem,92vw)] flex-col border-border border-r bg-background p-3 outline-hidden"
        ref={dialog}
        role="dialog"
        tabIndex={-1}
      >
        <button
          aria-label="Close work picker"
          className="ml-auto flex items-center justify-center rounded-lg"
          onClick={() => {
            onClose();
            queueMicrotask(() =>
              trigger.current?.focus({ preventScroll: true }),
            );
          }}
          style={TARGET_SIZE}
          type="button"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="mt-2 min-h-0 overflow-auto">
          {workItems.map((item) => (
            <button
              aria-current={item.id === selectedWorkId ? "true" : undefined}
              className="flex min-h-11 w-full items-center border-border border-b px-2 text-left text-sm aria-[current=true]:border-l-2 aria-[current=true]:border-l-[#C8FF45] aria-[current=true]:bg-muted/40"
              key={item.id}
              onClick={() => {
                onSelect(item.id);
                onClose();
                queueMicrotask(() =>
                  trigger.current?.focus({ preventScroll: true }),
                );
              }}
              type="button"
            >
              {item.title}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function OpsWorkView({
  collections,
  layout,
  mutationsDisabled = false,
  onSearch,
  onSelectWork,
  selectedWorkId,
  states,
}: {
  collections: OpsGlobalCollections;
  layout: "desktop" | "compact" | "mobile";
  mutationsDisabled?: boolean;
  onSearch: (scope: {
    q: string;
    kind?: OpsSearchKind;
    work: string;
    sort: "rank_desc_then_observed_at_desc";
  }) => boolean | undefined;
  onSelectWork: (id: string) => void;
  selectedWorkId: string;
  states?: OpsGlobalCollectionStates;
}) {
  const [tab, setTab] = React.useState<WorkTab>("Plan");
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [kind, setKind] = React.useState<OpsSearchKind | "">("");
  const [searchError, setSearchError] = React.useState<
    "empty" | "rejected" | null
  >(null);
  const pickerTrigger = React.useRef<HTMLButtonElement>(null);
  const panel = React.useRef<HTMLDivElement>(null);
  const onTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: WorkTab,
  ) => {
    const currentIndex = WORK_TABS.indexOf(current);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % WORK_TABS.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + WORK_TABS.length) % WORK_TABS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = WORK_TABS.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const next = WORK_TABS[nextIndex];
    setTab(next);
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`#ops-work-tab-${next.toLowerCase()}`)
      ?.focus();
  };
  const detail = projectOpsWork(collections, selectedWorkId);
  if (!detail) {
    const workState = states?.work_items;
    if (workState && workState.status !== "ready") {
      return <OpsCollectionState label="Work" state={workState} />;
    }
    if (collections.workItems.length > 0) {
      return <EmptyRow>Work selection is updating.</EmptyRow>;
    }
    return <EmptyRow>No work is active.</EmptyRow>;
  }
  const list = (
    <aside className="min-h-0 overflow-auto border-border border-r">
      <p className="px-3 py-2 text-2xs uppercase tracking-[0.16em] text-muted-foreground">
        Complete work index
      </p>
      {collections.workItems.map((item) => (
        <button
          aria-current={item.id === selectedWorkId ? "true" : undefined}
          className="flex min-h-11 w-full min-w-0 items-center justify-between gap-2 border-border border-b px-3 text-left aria-[current=true]:border-l-2 aria-[current=true]:border-l-[#C8FF45] aria-[current=true]:bg-muted/30"
          key={item.id}
          onClick={() => onSelectWork(item.id)}
          type="button"
        >
          <span className="truncate text-sm">{item.title}</span>
          <span className="text-2xs text-muted-foreground">{item.status}</span>
        </button>
      ))}
    </aside>
  );
  return (
    <main
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="ops-work-view"
    >
      <header className="border-border border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {layout === "mobile" ? (
            <button
              className="shrink-0 rounded-lg border border-border px-3 text-sm"
              onClick={() => setPickerOpen(true)}
              ref={pickerTrigger}
              style={TARGET_SIZE}
              type="button"
            >
              Choose work
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <p className="text-2xs uppercase tracking-[0.16em] text-[#C8FF45]">
              {detail.workItem.project_id}
            </p>
            <h1 className="truncate text-lg font-semibold">
              {detail.workItem.title}
            </h1>
          </div>
        </div>
        <form
          className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(7rem,10rem)_auto] gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (query.length === 0) {
              setSearchError("empty");
              return;
            }
            const accepted = onSearch({
              q: query,
              ...(kind ? { kind } : {}),
              work: selectedWorkId,
              sort: "rank_desc_then_observed_at_desc",
            });
            if (accepted === false) {
              setSearchError("rejected");
              return;
            }
            setSearchError(null);
            setTab("Evidence");
            queueMicrotask(() => panel.current?.focus({ preventScroll: true }));
          }}
        >
          <input
            aria-label="Search work"
            className="min-h-11 min-w-0 rounded-lg border border-border bg-background px-3 text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-[#C8FF45]"
            onChange={(event) => setQuery(event.target.value)}
            type="search"
            value={query}
          />
          <select
            aria-label="Search kind"
            className="min-h-11 min-w-0 rounded-lg border border-border bg-background px-2 text-sm"
            onChange={(event) =>
              setKind(event.target.value as OpsSearchKind | "")
            }
            value={kind}
          >
            <option value="">All kinds</option>
            {[
              "work_item",
              "session",
              "checklist_item",
              "decision",
              "approval",
              "evidence",
              "audit",
              "artifact",
              "repository",
              "research",
            ].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <button
            className="flex items-center justify-center rounded-lg border border-border px-3 text-sm"
            style={TARGET_SIZE}
            type="submit"
          >
            <Search className="mr-1 h-4 w-4" /> Search
          </button>
        </form>
        {searchError ? (
          <p className="mt-1 text-xs text-amber-300" role="status">
            {searchError === "empty"
              ? "Enter a search query."
              : "Search input is not accepted."}
          </p>
        ) : null}
        {mutationsDisabled ? (
          <p className="mt-1 text-xs text-muted-foreground" role="status">
            Read-only: collection mutations are disabled.
          </p>
        ) : null}
      </header>
      <div
        className="grid grid-cols-3 border-border border-b p-1"
        role="tablist"
      >
        {WORK_TABS.map((candidate) => (
          <button
            aria-controls={`ops-work-panel-${candidate.toLowerCase()}`}
            aria-selected={tab === candidate}
            className="rounded-lg text-sm aria-[selected=true]:bg-muted aria-[selected=true]:text-[#C8FF45]"
            id={`ops-work-tab-${candidate.toLowerCase()}`}
            key={candidate}
            onClick={() => setTab(candidate)}
            onKeyDown={(event) => onTabKeyDown(event, candidate)}
            role="tab"
            style={TARGET_SIZE}
            tabIndex={tab === candidate ? 0 : -1}
            type="button"
          >
            {candidate}
          </button>
        ))}
      </div>
      <div
        className={cn(
          "grid min-h-0 flex-1",
          layout === "mobile"
            ? "grid-cols-1"
            : layout === "compact"
              ? "grid-cols-[minmax(13rem,0.7fr)_minmax(0,1.6fr)]"
              : "grid-cols-[minmax(15rem,0.7fr)_minmax(0,1.8fr)]",
        )}
      >
        {layout === "mobile" ? null : list}
        <div
          aria-live="polite"
          aria-labelledby={`ops-work-tab-${tab.toLowerCase()}`}
          className="min-h-0 overflow-auto p-4 outline-hidden focus-visible:ring-2 focus-visible:ring-[#C8FF45]"
          id={`ops-work-panel-${tab.toLowerCase()}`}
          ref={panel}
          role="tabpanel"
          tabIndex={-1}
        >
          {tab === "Plan" ? (
            <div className="space-y-6">
              <SignalList label="Sessions">
                {states?.sessions && states.sessions.status !== "ready" ? (
                  <OpsCollectionState
                    label="Sessions"
                    state={states.sessions}
                  />
                ) : detail.sessions.length === 0 ? (
                  <EmptyRow>No sessions for this work.</EmptyRow>
                ) : (
                  detail.sessions.map((session) => (
                    <div
                      className="border-border border-b py-2"
                      key={session.id}
                    >
                      <p className="text-sm font-medium">{session.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {session.source} · {session.activity} · {session.health}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {session.last_activity_at ?? "No recent activity"}
                      </p>
                    </div>
                  ))
                )}
              </SignalList>
              <SignalList label="Plan">
                {states?.checklist_items &&
                states.checklist_items.status !== "ready" ? (
                  <OpsCollectionState
                    label="Plan"
                    state={states.checklist_items}
                  />
                ) : detail.checklist.length === 0 ? (
                  <EmptyRow>No plan items for this work.</EmptyRow>
                ) : (
                  detail.checklist.map((item) => (
                    <div className="border-border border-b py-2" key={item.id}>
                      <p className="text-sm font-medium">
                        {item.key} · {item.title}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {item.stage ?? item.origin} · {item.status} · order{" "}
                        {item.order}
                      </p>
                      {item.next_action ? (
                        <p className="text-xs text-muted-foreground">
                          Next: {item.next_action}
                        </p>
                      ) : null}
                      {item.depends_on.length ? (
                        <p className="text-xs text-muted-foreground">
                          Depends on: {item.depends_on.join(" · ")}
                        </p>
                      ) : null}
                      {item.evidence_ids.length ? (
                        <p className="text-xs text-muted-foreground">
                          Evidence: {item.evidence_ids.join(" · ")}
                        </p>
                      ) : null}
                    </div>
                  ))
                )}
              </SignalList>
            </div>
          ) : tab === "Attention" ? (
            <div className="space-y-6">
              <SignalList label="Decisions">
                {states?.decisions && states.decisions.status !== "ready" ? (
                  <OpsCollectionState
                    label="Decisions"
                    state={states.decisions}
                  />
                ) : detail.decisions.length === 0 ? (
                  <EmptyRow>No decisions for this work.</EmptyRow>
                ) : (
                  detail.decisions.map((item) => (
                    <div className="border-border border-b py-2" key={item.id}>
                      <p className="text-sm font-medium">{item.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.question}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {item.options.join(" · ")}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {item.needed_input}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {item.impact}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {item.queue} · {item.status}
                      </p>
                    </div>
                  ))
                )}
              </SignalList>
              <SignalList label="Approvals">
                {states?.approval_index &&
                states.approval_index.status !== "ready" ? (
                  <OpsCollectionState
                    label="Approvals"
                    state={states.approval_index}
                  />
                ) : detail.approvals.length === 0 ? (
                  <EmptyRow>No approvals for this work.</EmptyRow>
                ) : (
                  detail.approvals.map((item) => (
                    <div className="border-border border-b py-2" key={item.id}>
                      <p className="text-sm font-medium">
                        {item.action_kind} · {item.status}
                      </p>
                      {item.hold_reason ? (
                        <p className="text-xs text-muted-foreground">
                          {item.hold_reason}
                        </p>
                      ) : null}
                      <p className="text-xs text-muted-foreground">
                        Risk: {item.risk_class.join(" · ")}
                      </p>
                    </div>
                  ))
                )}
              </SignalList>
            </div>
          ) : (
            <div className="space-y-6">
              <SignalList label="Evidence">
                {states?.evidence && states.evidence.status !== "ready" ? (
                  <OpsCollectionState
                    label="Evidence"
                    state={states.evidence}
                  />
                ) : detail.evidence.length === 0 ? (
                  <EmptyRow>No evidence for this work.</EmptyRow>
                ) : (
                  detail.evidence.map((item) => (
                    <div className="border-border border-b py-2" key={item.id}>
                      <p className="text-sm font-medium">
                        {item.kind} · {item.status}
                      </p>
                      {item.artifact_id && item.artifact_version !== null ? (
                        <p className="text-xs text-muted-foreground">
                          {item.artifact_id} v{item.artifact_version}
                        </p>
                      ) : null}
                      <p className="text-xs text-muted-foreground">
                        {item.observed_at}
                      </p>
                    </div>
                  ))
                )}
              </SignalList>
              <SignalList label="Audit">
                {states?.audit && states.audit.status !== "ready" ? (
                  <OpsCollectionState label="Audit" state={states.audit} />
                ) : detail.audit.length === 0 ? (
                  <EmptyRow>No audit entries for this work.</EmptyRow>
                ) : (
                  detail.audit.map((item) => (
                    <div className="border-border border-b py-2" key={item.id}>
                      <p className="text-sm">{item.summary}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.kind} · {item.observed_at}
                      </p>
                    </div>
                  ))
                )}
              </SignalList>
              {states?.search?.status ===
              "not_requested" ? null : states?.search ? (
                <SignalList label="Search results">
                  {states.search.status !== "ready" ? (
                    <OpsCollectionState label="Search" state={states.search} />
                  ) : detail.search.length === 0 ? (
                    <EmptyRow>No search results.</EmptyRow>
                  ) : (
                    detail.search.map((item) => (
                      <div
                        className="border-border border-b py-2"
                        key={item.id}
                      >
                        <p className="text-sm font-medium">{item.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {item.snippet}
                        </p>
                      </div>
                    ))
                  )}
                </SignalList>
              ) : detail.search.length ? (
                <SignalList label="Search results">
                  {detail.search.map((item) => (
                    <div className="border-border border-b py-2" key={item.id}>
                      <p className="text-sm font-medium">{item.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.snippet}
                      </p>
                    </div>
                  ))}
                </SignalList>
              ) : null}
            </div>
          )}
        </div>
      </div>
      {pickerOpen ? (
        <WorkPicker
          onClose={() => setPickerOpen(false)}
          onSelect={onSelectWork}
          selectedWorkId={selectedWorkId}
          trigger={pickerTrigger}
          workItems={collections.workItems}
        />
      ) : null}
    </main>
  );
}
