import {
  Bot,
  CheckCircle2,
  ClipboardCheck,
  Cpu,
  FileText,
  HelpCircle,
  ShieldAlert,
} from "lucide-react";
import type * as React from "react";

import { artifactRepresentationForKind } from "../artifactReader";
import type { OpsProjectedContext } from "../opsProjection";

type OpsContextPanelProps = {
  context: OpsProjectedContext;
  onOpenArtifact: (
    artifact: OpsProjectedContext["artifacts"][number],
    trigger: HTMLButtonElement,
  ) => void;
};

const INTERACTIVE_SIZE = { minHeight: 44, minWidth: 44 } as const;

function EmptyRecords() {
  return <p className="py-2 text-xs text-muted-foreground">기록 없음</p>;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    active: "활성",
    done: "완료",
    held: "승인 필요",
    in_progress: "진행 중",
    ready: "준비됨",
    running: "실행 중",
    waiting: "대기",
  };
  return labels[status] ?? status;
}

function ContextSection({
  children,
  icon,
  title,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <section className="border-border/50 border-b px-3 py-3 last:border-b-0">
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold">
        <span className="text-muted-foreground">{icon}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

export function OpsContextPanel({
  context,
  onOpenArtifact,
}: OpsContextPanelProps) {
  return (
    <section
      aria-labelledby="ops-context-heading"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-background"
      data-testid="ops-context"
    >
      <header className="flex items-center gap-2 border-border/60 border-b px-3 py-3">
        <ClipboardCheck className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="text-sm font-semibold" id="ops-context-heading">
          작업 컨텍스트
        </h2>
      </header>
      <div className="buzz-content-scrollbar min-h-0 flex-1 overflow-y-auto">
        <ContextSection
          icon={<CheckCircle2 className="h-4 w-4" />}
          title="작업 항목"
        >
          {context.workItem ? (
            <div>
              <p className="break-words text-sm font-medium [overflow-wrap:anywhere]">
                {context.workItem.title}
              </p>
              <div className="mt-1 flex items-center justify-between gap-2 text-2xs text-muted-foreground">
                <span>{statusLabel(context.workItem.status)}</span>
                {context.workItem.progress !== null ? (
                  <span className="tabular-nums">
                    {Math.round(context.workItem.progress)}%
                  </span>
                ) : null}
              </div>
              {context.workItem.progress !== null ? (
                <div
                  aria-label={`진행률 ${Math.round(context.workItem.progress)}%`}
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={Math.round(context.workItem.progress)}
                  className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                >
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{
                      width: `${Math.max(0, Math.min(100, context.workItem.progress))}%`,
                    }}
                  />
                </div>
              ) : null}
            </div>
          ) : (
            <EmptyRecords />
          )}
        </ContextSection>

        <ContextSection icon={<Cpu className="h-4 w-4" />} title="실행 환경">
          {context.provider ? (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
              <dt className="text-muted-foreground">Provider</dt>
              <dd className="truncate font-medium">
                {context.provider.provider}
              </dd>
              <dt className="text-muted-foreground">Model</dt>
              <dd className="truncate font-medium">{context.provider.model}</dd>
              <dt className="text-muted-foreground">Effort</dt>
              <dd className="truncate font-medium">
                {context.provider.effort ?? "—"}
              </dd>
              <dt className="text-muted-foreground">상태</dt>
              <dd className="truncate font-medium">
                {statusLabel(context.provider.status)}
              </dd>
            </dl>
          ) : (
            <EmptyRecords />
          )}
        </ContextSection>

        <ContextSection icon={<Bot className="h-4 w-4" />} title="세션">
          {context.sessions.length === 0 ? (
            <EmptyRecords />
          ) : (
            <ul className="space-y-2">
              {context.sessions.map((session) => (
                <li
                  className="rounded-lg bg-muted/40 px-2.5 py-2"
                  key={session.id}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium">
                      {session.title}
                    </span>
                    <span className="shrink-0 text-2xs text-muted-foreground">
                      {statusLabel(session.health)}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-2xs text-muted-foreground">
                    {session.agent}
                    {session.activity ? ` · ${session.activity}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </ContextSection>

        <ContextSection
          icon={<ClipboardCheck className="h-4 w-4" />}
          title="체크리스트"
        >
          {context.checklist.length === 0 ? (
            <EmptyRecords />
          ) : (
            <ul className="space-y-1.5">
              {context.checklist.map((item) => (
                <li className="flex items-start gap-2 text-xs" key={item.id}>
                  <span className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-sm border border-border" />
                  <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
                    {item.title}
                  </span>
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {statusLabel(item.status)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </ContextSection>

        <ContextSection icon={<HelpCircle className="h-4 w-4" />} title="결정">
          {context.decisions.length === 0 ? (
            <EmptyRecords />
          ) : (
            <ul className="space-y-2">
              {context.decisions.map((decision) => (
                <li
                  className="rounded-lg border border-border/60 px-2.5 py-2"
                  key={decision.id}
                >
                  <p className="text-xs font-medium">{decision.title}</p>
                  <p className="mt-1 break-words text-2xs text-muted-foreground [overflow-wrap:anywhere]">
                    {decision.question}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </ContextSection>

        <ContextSection icon={<ShieldAlert className="h-4 w-4" />} title="승인">
          {context.approvals.length === 0 ? (
            <EmptyRecords />
          ) : (
            <ul className="space-y-2">
              {context.approvals.map((approval) => (
                <li
                  className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2"
                  key={approval.id}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium">
                      {approval.actionKind}
                    </span>
                    <span className="shrink-0 text-2xs font-medium text-amber-600 dark:text-amber-400">
                      {statusLabel(approval.status)}
                    </span>
                  </div>
                  {approval.holdReason ? (
                    <p className="mt-1 break-words font-mono text-2xs text-muted-foreground [overflow-wrap:anywhere]">
                      {approval.holdReason}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </ContextSection>

        <ContextSection
          icon={<FileText className="h-4 w-4" />}
          title="아티팩트"
        >
          {context.artifacts.length === 0 ? (
            <EmptyRecords />
          ) : (
            <ul className="space-y-2">
              {context.artifacts.map((artifact) => {
                const readable =
                  artifactRepresentationForKind(artifact.kind) !== null;
                return (
                  <li className="rounded-lg bg-muted/40" key={artifact.id}>
                    {readable ? (
                      <button
                        aria-label={`${artifact.title} 아티팩트 열기`}
                        className="flex w-full min-w-0 flex-col items-start justify-center rounded-lg px-2.5 py-2 text-left hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                        data-ops-interactive
                        onClick={(event) =>
                          onOpenArtifact(artifact, event.currentTarget)
                        }
                        style={INTERACTIVE_SIZE}
                        type="button"
                      >
                        <span className="break-words text-xs font-medium [overflow-wrap:anywhere]">
                          {artifact.title}
                        </span>
                        <span className="mt-1 text-2xs text-muted-foreground">
                          {artifact.kind} · v{artifact.version} ·{" "}
                          {statusLabel(artifact.status)}
                        </span>
                      </button>
                    ) : (
                      <div className="px-2.5 py-2">
                        <p className="break-words text-xs font-medium [overflow-wrap:anywhere]">
                          {artifact.title}
                        </p>
                        <p className="mt-1 text-2xs text-muted-foreground">
                          {artifact.kind} · 네이티브 텍스트 읽기 미지원
                        </p>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </ContextSection>
      </div>
    </section>
  );
}
