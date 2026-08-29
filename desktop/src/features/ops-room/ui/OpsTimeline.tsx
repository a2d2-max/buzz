import { Activity, ChevronDown } from "lucide-react";

import type { OpsProjectedTimelineItem } from "../opsProjection";

const INTERACTIVE_SIZE = { minHeight: 44, minWidth: 44 } as const;

type OpsTimelineProps = {
  items: OpsProjectedTimelineItem[];
};

function displayTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function OpsTimeline({ items }: OpsTimelineProps) {
  return (
    <section
      aria-labelledby="ops-timeline-heading"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-background"
      data-testid="ops-timeline"
    >
      <header className="flex items-center gap-2 border-border/60 border-b px-3 py-3">
        <Activity className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="text-sm font-semibold" id="ops-timeline-heading">
          활동 타임라인
        </h2>
      </header>
      <div className="buzz-content-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            기록 없음
          </p>
        ) : (
          <ol className="relative ml-2 border-primary/30 border-l py-1">
            {items.map((item) => (
              <li className="relative pb-4 pl-5 last:pb-1" key={item.id}>
                <span
                  aria-hidden
                  className="absolute -left-[0.3125rem] top-4 h-2 w-2 rounded-full border-2 border-background bg-primary"
                />
                <article className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
                  <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-sm font-semibold">{item.verb}</span>
                    {item.outcome ? (
                      <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-2xs font-medium text-primary">
                        {item.outcome}
                      </span>
                    ) : null}
                    <time
                      className="ml-auto text-2xs tabular-nums text-muted-foreground"
                      dateTime={item.timestamp}
                    >
                      {displayTime(item.timestamp)}
                    </time>
                  </header>
                  <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="truncate">{item.author}</span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{item.sourceLabel}</span>
                  </div>
                  <details className="group mt-2">
                    <summary
                      className="flex cursor-pointer list-none items-center gap-1 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                      data-ops-interactive
                      style={INTERACTIVE_SIZE}
                    >
                      <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
                      세부 정보
                    </summary>
                    <p className="pb-2 text-sm leading-relaxed text-foreground">
                      {item.body}
                    </p>
                    {item.details.length > 0 ? (
                      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-border/50 border-t pt-2 text-2xs">
                        {item.details.map((detail) => (
                          <div className="contents" key={detail.label}>
                            <dt className="text-muted-foreground">
                              {detail.label}
                            </dt>
                            <dd className="min-w-0 break-words font-mono [overflow-wrap:anywhere]">
                              {detail.value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}
                  </details>
                </article>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
