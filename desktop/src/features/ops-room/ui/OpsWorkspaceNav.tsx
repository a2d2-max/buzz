import { Boxes, CircleDot, MessageSquareText } from "lucide-react";

import type { OpsRoomProjection } from "../opsProjection";

const INTERACTIVE_SIZE = { minHeight: 44, minWidth: 44 } as const;

type OpsWorkspaceNavProps = {
  onSelectChannel: (id: string) => void;
  onSelectThread: (id: string) => void;
  workspace: OpsRoomProjection["workspace"];
};

function EmptyRecords() {
  return (
    <p className="px-3 py-4 text-center text-xs text-muted-foreground">
      기록 없음
    </p>
  );
}

export function OpsWorkspaceNav({
  onSelectChannel,
  onSelectThread,
  workspace,
}: OpsWorkspaceNavProps) {
  return (
    <section
      aria-labelledby="ops-workspaces-heading"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-background"
      data-testid="ops-workspace-nav"
    >
      <header className="flex items-center gap-2 border-border/60 border-b px-3 py-3">
        <Boxes className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="text-sm font-semibold" id="ops-workspaces-heading">
          작업 범위
        </h2>
      </header>
      <div className="buzz-content-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
        <p className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          워크스페이스
        </p>
        {workspace.channels.length === 0 ? (
          <EmptyRecords />
        ) : (
          <ul className="space-y-1">
            {workspace.channels.map((channel) => {
              const selected = channel.id === workspace.selectedChannelId;
              return (
                <li key={channel.id}>
                  <button
                    aria-current={selected ? "page" : undefined}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none aria-[current=page]:bg-primary/10 aria-[current=page]:text-foreground"
                    data-ops-interactive
                    onClick={() => onSelectChannel(channel.id)}
                    style={INTERACTIVE_SIZE}
                    type="button"
                  >
                    <CircleDot
                      className={
                        selected
                          ? "h-3.5 w-3.5 shrink-0 text-primary"
                          : "h-3.5 w-3.5 shrink-0 text-muted-foreground"
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {channel.label}
                    </span>
                    <span className="text-2xs tabular-nums text-muted-foreground">
                      {channel.count}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <p className="mt-4 px-2 pb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          작업 스레드
        </p>
        {workspace.threads.length === 0 ? (
          <EmptyRecords />
        ) : (
          <ul className="space-y-1">
            {workspace.threads.map((thread) => {
              const selected = thread.id === workspace.selectedThreadId;
              return (
                <li key={thread.id}>
                  <button
                    aria-current={selected ? "page" : undefined}
                    className="group flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none aria-[current=page]:bg-primary/10"
                    data-ops-interactive
                    onClick={() => onSelectThread(thread.id)}
                    style={INTERACTIVE_SIZE}
                    type="button"
                  >
                    <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground group-aria-[current=page]:text-primary" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {thread.title}
                      </span>
                      <span className="mt-0.5 block truncate text-2xs text-muted-foreground">
                        {thread.status} · 세션 {thread.sessionCount}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
