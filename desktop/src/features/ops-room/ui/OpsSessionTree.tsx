import { Bot, GitBranch } from "lucide-react";
import * as React from "react";

import type { OpsProjectedSession } from "../opsProjection";

const INTERACTIVE_SIZE = { minHeight: 44, minWidth: 44 } as const;

type OpsSessionTreeProps = {
  onSelect: (id: string) => void;
  selectedSessionId: string | null;
  sessions: OpsProjectedSession[];
};

function healthClass(health: string): string {
  if (health === "active" || health === "ready") return "bg-emerald-500";
  if (health === "waiting" || health === "idle") return "bg-amber-500";
  return "bg-muted-foreground";
}

export function OpsSessionTree({
  onSelect,
  selectedSessionId,
  sessions,
}: OpsSessionTreeProps) {
  const initialId =
    sessions.find((session) => session.id === selectedSessionId)?.id ??
    sessions[0]?.id ??
    null;
  const [rovingId, setRovingId] = React.useState<string | null>(initialId);
  const refs = React.useRef(new Map<string, HTMLButtonElement>());

  React.useEffect(() => {
    setRovingId((currentId) => {
      const selectedIsValid =
        selectedSessionId !== null &&
        sessions.some(({ id }) => id === selectedSessionId);
      if (selectedIsValid) return selectedSessionId;
      if (currentId && sessions.some(({ id }) => id === currentId)) {
        return currentId;
      }
      return sessions[0]?.id ?? null;
    });
  }, [selectedSessionId, sessions]);

  const moveFocus = (currentIndex: number, delta: number) => {
    if (sessions.length === 0) return;
    const nextIndex = Math.min(
      sessions.length - 1,
      Math.max(0, currentIndex + delta),
    );
    const next = sessions[nextIndex];
    setRovingId(next.id);
    refs.current.get(next.id)?.focus({ preventScroll: true });
  };

  return (
    <section
      aria-labelledby="ops-session-tree-heading"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-background"
      data-testid="ops-session-tree"
    >
      <header className="flex items-center gap-2 border-border/60 border-b px-3 py-3">
        <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="text-sm font-semibold" id="ops-session-tree-heading">
          에이전트 세션
        </h2>
      </header>
      <div className="buzz-content-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
        {sessions.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            기록 없음
          </p>
        ) : (
          <div aria-label="에이전트 세션" className="relative" role="tree">
            <div
              aria-hidden
              className="absolute bottom-3 left-[1.15rem] top-3 w-px bg-border/80"
            />
            {sessions.map((session, index) => {
              const selected = session.id === selectedSessionId;
              return (
                <button
                  aria-level={session.depth + 1}
                  aria-selected={selected}
                  className="relative flex w-full items-center gap-2 rounded-lg py-2 pr-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none aria-[selected=true]:bg-primary/10"
                  data-ops-interactive
                  key={session.id}
                  onClick={() => onSelect(session.id)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      moveFocus(index, 1);
                    } else if (event.key === "ArrowUp") {
                      event.preventDefault();
                      moveFocus(index, -1);
                    } else if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(session.id);
                    }
                  }}
                  ref={(element) => {
                    if (element) refs.current.set(session.id, element);
                    else refs.current.delete(session.id);
                  }}
                  role="treeitem"
                  style={{
                    ...INTERACTIVE_SIZE,
                    paddingLeft: 10 + session.depth * 16,
                  }}
                  tabIndex={session.id === rovingId ? 0 : -1}
                  type="button"
                >
                  <span className="relative z-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border bg-background">
                    <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-sm font-medium">
                        {session.title}
                      </span>
                      <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                        {session.sourceLabel}
                      </span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
                      <span
                        aria-hidden
                        className={`h-1.5 w-1.5 rounded-full ${healthClass(session.health)}`}
                      />
                      <span className="truncate">
                        {session.activity ?? session.health}
                      </span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
