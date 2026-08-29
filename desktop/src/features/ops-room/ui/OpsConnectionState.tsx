import { AlertTriangle, LoaderCircle, RefreshCw, Unplug } from "lucide-react";

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
    description: "Buzz와 Hub의 Ops 계약 버전을 맞춘 뒤 다시 여세요.",
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
    <div className="flex min-h-56 flex-1 flex-col items-center justify-center px-6 text-center">
      <Unplug className="mb-4 h-7 w-7 text-muted-foreground" />
      <h2 className="text-base font-semibold">{copy.title}</h2>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        {copy.description}
      </p>
      {state === "disconnected" ? (
        <button
          className="mt-5 inline-flex items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          data-ops-interactive
          onClick={onRetry}
          style={INTERACTIVE_SIZE}
          type="button"
        >
          <RefreshCw className="h-4 w-4" />
          다시 연결
        </button>
      ) : null}
    </div>
  );
}
