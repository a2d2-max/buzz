import {
  AlertTriangle,
  CircleCheck,
  Clock3,
  LoaderCircle,
  RefreshCw,
  Unplug,
} from "lucide-react";

import type { OpsConnectionState as ConnectionState } from "../types";

const INTERACTIVE_SIZE = { minHeight: 44, minWidth: 44 } as const;

type OpsConnectionStateProps = {
  onRetry: () => void;
  state: ConnectionState;
};

const STATE_COPY: Record<
  Exclude<ConnectionState, "ready" | "stale" | "loading">,
  { title: string; description: string }
> = {
  disconnected: {
    title: "Hub에 연결할 수 없습니다",
    description: "Local Ops Hub를 확인한 뒤 다시 시도하세요.",
  },
  not_configured: {
    title: "Local Ops Hub가 설정되지 않았습니다",
    description: "Hub가 준비되면 이 화면에서 자동으로 작업 상태를 읽습니다.",
  },
  version_mismatch: {
    title: "Ops 계약 버전이 맞지 않습니다",
    description: "RAOU와 Local Ops Hub의 계약 버전을 맞춘 뒤 다시 여세요.",
  },
  contract_invalid: {
    title: "Ops 데이터 계약을 확인할 수 없습니다",
    description: "검증되지 않은 데이터는 표시하지 않았습니다.",
  },
};

export function OpsConnectionState({
  onRetry,
  state,
}: OpsConnectionStateProps) {
  if (state === "ready") return null;
  if (state === "stale") {
    return (
      <div
        className="flex items-center gap-2 border-amber-500/30 border-b bg-amber-500/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-200"
        role="status"
      >
        <AlertTriangle className="h-4 w-4 shrink-0" />
        연결이 끊겨 마지막 동기화 상태를 표시합니다.
      </div>
    );
  }
  if (state === "loading") {
    return (
      <div className="flex min-h-56 flex-1 flex-col items-center justify-center gap-3 text-center">
        <LoaderCircle className="h-6 w-6 animate-spin text-muted-foreground motion-reduce:animate-none" />
        <p className="text-sm font-medium">운영 데이터를 불러오는 중</p>
      </div>
    );
  }

  const copy = STATE_COPY[state];
  return (
    <div className="flex min-h-56 flex-1 items-center justify-center overflow-y-auto px-5 py-8 sm:px-8">
      <section
        className="w-full max-w-xl overflow-hidden rounded-xl border border-border/80 bg-card text-left shadow-sm"
        data-testid="ops-connection-card"
      >
        <header className="flex items-center justify-between gap-4 border-border/70 border-b px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/60 text-muted-foreground">
              <Unplug className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Local workspace
              </p>
              <p className="mt-0.5 truncate text-sm font-medium">Agent room</p>
            </div>
          </div>
          <span className="shrink-0 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
            연결 대기
          </span>
        </header>
        <div className="px-5 py-5 sm:px-6 sm:py-6">
          <h2 className="text-lg font-semibold tracking-tight">{copy.title}</h2>
          <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
            {copy.description}
          </p>
          <div className="mt-5 divide-y divide-border/60 rounded-lg border border-border/70 bg-background/40 px-4">
            <div className="flex items-center gap-3 py-3 text-sm">
              <CircleCheck className="h-4 w-4 shrink-0 text-primary" />
              <span className="flex-1">RAOU 작업공간과 에이전트 룸</span>
              <span className="text-xs text-muted-foreground">준비됨</span>
            </div>
            <div className="flex items-center gap-3 py-3 text-sm">
              <Clock3 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="flex-1">Hub 작업·세션·아티팩트 피드</span>
              <span className="text-xs text-muted-foreground">대기 중</span>
            </div>
          </div>
          {state === "disconnected" || state === "not_configured" ? (
            <button
              className="mt-5 inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-background/60 px-4 py-2 text-sm font-medium transition-colors hover:border-primary/40 hover:bg-primary/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              data-ops-interactive
              onClick={onRetry}
              style={INTERACTIVE_SIZE}
              type="button"
            >
              <RefreshCw className="h-4 w-4" />
              연결 다시 확인
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
