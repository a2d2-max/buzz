import { ChevronLeft, ChevronRight, FileCheck2, X } from "lucide-react";
import * as React from "react";

import {
  type OpsArtifactSelection,
  loadOpsArtifactText,
  useOpsArtifact,
} from "../artifactReader";
import { OpsArtifactError, OpsBridgeContractError } from "../opsBridge";

const INTERACTIVE_SIZE = { minHeight: 44, minWidth: 44 } as const;
const TEXT_PAGE_CHARS = 64 * 1024;

type OpsArtifactReaderProps = {
  artifact: OpsArtifactSelection;
  loadArtifact?: typeof loadOpsArtifactText;
  onClose: () => void;
  returnFocus: HTMLElement | null;
};

function usePrivateOpaqueObjectUrl(
  content: ReturnType<typeof useOpsArtifact>["data"],
  error: unknown,
): void {
  React.useEffect(() => {
    if (content?.source !== "opaque" || error) return;
    const objectUrl = URL.createObjectURL(content.blob);
    return () => URL.revokeObjectURL(objectUrl);
  }, [content, error]);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function errorCopy(error: unknown): { body: string; title: string } {
  if (error instanceof OpsArtifactError) {
    switch (error.code) {
      case "artifact_read_denied":
        return {
          title: "읽기 권한이 없습니다",
          body: "이 아티팩트는 현재 공개 읽기 정책에서 허용되지 않습니다.",
        };
      case "artifact_integrity_mismatch":
        return {
          title: "무결성 검증에 실패했습니다",
          body: "다운로드한 내용이 고정된 다이제스트와 일치하지 않습니다.",
        };
      case "artifact_version_not_found":
        return {
          title: "요청한 버전을 찾을 수 없습니다",
          body: "목록을 새로고침한 뒤 최신 버전을 다시 선택하세요.",
        };
      case "artifact_not_found":
        return {
          title: "아티팩트를 찾을 수 없습니다",
          body: "이 항목은 더 이상 공개 읽기 목록에 없습니다.",
        };
      case "artifact_media_unsupported":
        return {
          title: "지원하지 않는 형식입니다",
          body: "현재 네이티브 텍스트 리더에서 이 형식을 열 수 없습니다.",
        };
      case "artifact_too_large":
        return {
          title: "아티팩트가 너무 큽니다",
          body: "안전한 로컬 읽기 한도를 초과했습니다.",
        };
      default:
        return {
          title: "아티팩트를 열 수 없습니다",
          body: "요청이 유효하지 않아 읽기를 중단했습니다.",
        };
    }
  }
  if (error instanceof OpsBridgeContractError) {
    return {
      title: "안전 검증에 실패했습니다",
      body: "네이티브 브리지 응답이 아티팩트 계약과 일치하지 않습니다.",
    };
  }
  return {
    title: "아티팩트를 불러오지 못했습니다",
    body: "연결 상태를 확인한 뒤 다시 시도하세요.",
  };
}

export function OpsArtifactReader({
  artifact,
  loadArtifact = loadOpsArtifactText,
  onClose,
  returnFocus,
}: OpsArtifactReaderProps) {
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const query = useOpsArtifact(artifact, loadArtifact);
  const [page, setPage] = React.useState(0);
  usePrivateOpaqueObjectUrl(query.data, query.error);

  React.useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      const focusable = dialog
        ? Array.from(
            dialog.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
            ),
          )
        : [];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog?.focus({ preventScroll: true });
        return;
      }
      const active = document.activeElement;
      if (active === dialog || !dialog?.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (returnFocus?.isConnected) {
        returnFocus.focus({ preventScroll: true });
      }
    };
  }, [onClose, returnFocus]);

  const pageCount = query.data
    ? Math.max(1, Math.ceil(query.data.text.length / TEXT_PAGE_CHARS))
    : 1;
  const safePage = Math.min(page, pageCount - 1);
  const visibleText = query.data?.text.slice(
    safePage * TEXT_PAGE_CHARS,
    (safePage + 1) * TEXT_PAGE_CHARS,
  );
  const failure = query.error ? errorCopy(query.error) : null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center overflow-hidden bg-background/75 p-2 backdrop-blur-xs sm:p-4">
      <div
        aria-label={artifact.title}
        aria-modal="true"
        className="flex max-h-[calc(100dvh-1rem)] w-[min(52rem,calc(100vw-1rem))] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl outline-hidden sm:max-h-[calc(100dvh-2rem)] sm:w-[min(52rem,calc(100vw-2rem))]"
        data-bounded="true"
        data-testid="ops-artifact-reader"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="flex min-w-0 items-center gap-3 border-border/60 border-b px-3 py-2">
          <FileCheck2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{artifact.title}</h2>
            <p className="text-2xs text-muted-foreground">
              읽기 전용 네이티브 아티팩트
            </p>
          </div>
          <button
            aria-label="아티팩트 닫기"
            className="flex shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            data-ops-interactive
            onClick={onClose}
            style={INTERACTIVE_SIZE}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="buzz-content-scrollbar min-h-0 min-w-0 flex-1 overflow-auto p-3 sm:p-4">
          {query.isPending ? (
            <div
              className="flex min-h-40 items-center justify-center text-sm text-muted-foreground"
              role="status"
            >
              {query.progress
                ? `불러오는 중 · ${formatBytes(query.progress.loaded)} / ${formatBytes(query.progress.total)}`
                : "아티팩트를 안전하게 불러오는 중…"}
            </div>
          ) : failure ? (
            <div
              className="mx-auto flex min-h-40 max-w-md flex-col items-center justify-center text-center"
              role="alert"
            >
              <p className="text-sm font-semibold">{failure.title}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                {failure.body}
              </p>
              <button
                className="mt-4 rounded-lg border border-border px-3 text-xs font-medium hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                data-ops-interactive
                onClick={() => void query.refetch()}
                style={INTERACTIVE_SIZE}
                type="button"
              >
                다시 시도
              </button>
            </div>
          ) : query.data ? (
            <div className="min-w-0">
              <div
                className="mb-3 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-2xs text-emerald-700 dark:text-emerald-300"
                data-testid="ops-artifact-verification"
              >
                {query.data.source === "opaque"
                  ? "보안 스트림 검증됨"
                  : "인라인 검증됨"}{" "}
                · v{artifact.version} · {query.data.mime} ·{" "}
                {formatBytes(query.data.totalSize)}
              </div>
              <pre className="min-w-0 whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 font-mono text-xs leading-5 [overflow-wrap:anywhere]">
                {visibleText}
              </pre>
            </div>
          ) : null}
        </div>

        {query.data && pageCount > 1 ? (
          <footer className="flex items-center justify-between gap-3 border-border/60 border-t px-3 py-2">
            <button
              aria-label="이전 아티팩트 페이지"
              className="flex items-center justify-center rounded-lg hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
              data-ops-interactive
              disabled={safePage === 0}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              style={INTERACTIVE_SIZE}
              type="button"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-2xs tabular-nums text-muted-foreground">
              {safePage + 1} / {pageCount}
            </span>
            <button
              aria-label="다음 아티팩트 페이지"
              className="flex items-center justify-center rounded-lg hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
              data-ops-interactive
              disabled={safePage >= pageCount - 1}
              onClick={() =>
                setPage((current) => Math.min(pageCount - 1, current + 1))
              }
              style={INTERACTIVE_SIZE}
              type="button"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
