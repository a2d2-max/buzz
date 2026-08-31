import { PanelRightOpen, X } from "lucide-react";
import * as React from "react";

import {
  artifactRepresentationForKind,
  type OpsArtifactSelection,
} from "../artifactReader";
import type { OpsRoomProjection } from "../opsProjection";
import { opsLayoutForWidth, type OpsResponsiveLayout } from "../opsWindowSize";
import type { OpsConnectionState as ConnectionState } from "../types";
import { OpsArtifactReader } from "./OpsArtifactReader";
import { OpsConnectionState } from "./OpsConnectionState";
import { OpsContextPanel } from "./OpsContextPanel";
import { OpsSessionTree } from "./OpsSessionTree";
import { OpsTimeline } from "./OpsTimeline";
import { OpsWorkspaceNav } from "./OpsWorkspaceNav";

const INTERACTIVE_SIZE = { minHeight: 44, minWidth: 44 } as const;
const MOBILE_TABS = ["workspace", "sessions", "timeline", "context"] as const;
type MobileTab = (typeof MOBILE_TABS)[number];

const MOBILE_TAB_LABELS: Record<MobileTab, string> = {
  workspace: "작업",
  sessions: "세션",
  timeline: "타임라인",
  context: "컨텍스트",
};
const DESKTOP_GRID_COLUMNS =
  "minmax(160px, 0.85fr) minmax(176px, 0.9fr) minmax(288px, 1.75fr) minmax(192px, 1fr)";
const DESKTOP_GRID_MINIMUM_WIDTH = 160 + 176 + 288 + 192 + 3 * 12;

function useOpsResponsiveLayout(): OpsResponsiveLayout {
  const [layout, setLayout] = React.useState(() =>
    opsLayoutForWidth(window.innerWidth),
  );

  React.useEffect(() => {
    const update = () => setLayout(opsLayoutForWidth(window.innerWidth));
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return layout;
}

function useReducedMotionPreference(): boolean {
  const [reduced, setReduced] = React.useState(
    () =>
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );

  React.useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReduced(query.matches);
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  return reduced;
}

function MainPane({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 min-w-0" data-testid="ops-main-pane">
      {children}
    </div>
  );
}

type OpsRoomViewProps = {
  connectionState: ConnectionState;
  onRetry: () => void;
  onSelectChannel: (id: string) => void;
  onSelectThread: (id: string) => void;
  projection: OpsRoomProjection | null;
  watchState: "enabled" | "disabled_compatibility";
};

export function OpsRoomView({
  connectionState,
  onRetry,
  onSelectChannel,
  onSelectThread,
  projection,
  watchState,
}: OpsRoomViewProps) {
  const layout = useOpsResponsiveLayout();
  const reducedMotion = useReducedMotionPreference();
  const [mobileTab, setMobileTab] = React.useState<MobileTab>("timeline");
  const [contextOpen, setContextOpen] = React.useState(false);
  const [selectedArtifact, setSelectedArtifact] =
    React.useState<OpsArtifactSelection | null>(null);
  const [selectedSessionId, setSelectedSessionId] = React.useState<
    string | null
  >(() => {
    if (!projection) return null;
    const canonicalThread = projection.workspace.selectedThreadId;
    return (
      projection.sessions.find(({ id }) => id === canonicalThread)?.id ??
      projection.sessions[0]?.id ??
      null
    );
  });
  const previousThreadId = React.useRef(
    projection?.workspace.selectedThreadId ?? null,
  );
  const contextTriggerRef = React.useRef<HTMLButtonElement>(null);
  const contextDrawerRef = React.useRef<HTMLDivElement>(null);
  const artifactTriggerRef = React.useRef<HTMLButtonElement>(null);

  const closeContext = React.useCallback(() => {
    setContextOpen(false);
    contextTriggerRef.current?.focus({ preventScroll: true });
  }, []);

  React.useEffect(() => {
    if (!contextOpen) return;
    contextDrawerRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('[data-testid="ops-artifact-reader"]')) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeContext();
        return;
      }
      if (event.key !== "Tab") return;
      const drawer = contextDrawerRef.current;
      const focusable = drawer
        ? Array.from(
            drawer.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          )
        : [];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        drawer?.focus({ preventScroll: true });
      } else if (
        document.activeElement === drawer ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeContext, contextOpen]);

  const openArtifact = React.useCallback(
    (
      artifact: OpsRoomProjection["context"]["artifacts"][number],
      trigger: HTMLButtonElement,
    ) => {
      const representation = artifactRepresentationForKind(artifact.kind);
      if (!representation) return;
      artifactTriggerRef.current = trigger;
      setSelectedArtifact({ ...artifact, representation });
    },
    [],
  );

  React.useEffect(() => {
    const canonicalThread = projection?.workspace.selectedThreadId ?? null;
    const canonicalThreadChanged = canonicalThread !== previousThreadId.current;
    previousThreadId.current = canonicalThread;

    setSelectedSessionId((currentId) => {
      if (!projection) return null;
      const matchingId = projection.sessions.find(
        ({ id }) => id === canonicalThread,
      )?.id;
      if (canonicalThreadChanged) {
        return matchingId ?? projection.sessions[0]?.id ?? null;
      }
      if (currentId && projection.sessions.some(({ id }) => id === currentId)) {
        return currentId;
      }
      return matchingId ?? projection.sessions[0]?.id ?? null;
    });
  }, [projection]);

  const stateOnly = connectionState !== "ready" && connectionState !== "stale";

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden [overflow-wrap:anywhere]"
      data-reduced-motion={reducedMotion ? "true" : "false"}
      data-testid="ops-room-view"
    >
      <h1 className="sr-only">Agent Room</h1>
      <OpsConnectionState onRetry={onRetry} state={connectionState} />
      {watchState === "disabled_compatibility" && projection ? (
        <div
          className="flex items-center gap-2 border-amber-500/30 border-b bg-amber-500/10 px-4 py-2 text-xs text-amber-800 dark:text-amber-200"
          data-testid="ops-watch-compatibility"
          role="status"
        >
          실시간 동기화를 사용할 수 없어 마지막으로 읽은 Ops 데이터를
          표시합니다.
        </div>
      ) : null}
      {stateOnly || !projection ? null : (
        <main className="min-h-0 min-w-0 flex-1 overflow-hidden p-3">
          {layout === "desktop" ? (
            <div
              className="grid h-full min-h-0 min-w-0 max-w-full gap-3 overflow-hidden"
              data-minimum-width={DESKTOP_GRID_MINIMUM_WIDTH}
              data-testid="ops-desktop-grid"
              style={{
                gridTemplateColumns: DESKTOP_GRID_COLUMNS,
                maxWidth: "100%",
              }}
            >
              <MainPane>
                <OpsWorkspaceNav
                  onSelectChannel={onSelectChannel}
                  onSelectThread={onSelectThread}
                  workspace={projection.workspace}
                />
              </MainPane>
              <MainPane>
                <OpsSessionTree
                  onSelect={setSelectedSessionId}
                  selectedSessionId={selectedSessionId}
                  sessions={projection.sessions}
                />
              </MainPane>
              <MainPane>
                <OpsTimeline items={projection.timeline} />
              </MainPane>
              <MainPane>
                <OpsContextPanel
                  context={projection.context}
                  onOpenArtifact={openArtifact}
                />
              </MainPane>
            </div>
          ) : layout === "compact" ? (
            <div className="grid h-full min-h-0 grid-cols-[minmax(15rem,0.9fr)_minmax(22rem,2fr)] gap-3">
              <MainPane>
                <div className="grid min-h-0 min-w-0 flex-1 grid-rows-2 gap-3">
                  <OpsWorkspaceNav
                    onSelectChannel={onSelectChannel}
                    onSelectThread={onSelectThread}
                    workspace={projection.workspace}
                  />
                  <OpsSessionTree
                    onSelect={setSelectedSessionId}
                    selectedSessionId={selectedSessionId}
                    sessions={projection.sessions}
                  />
                </div>
              </MainPane>
              <MainPane>
                <div className="relative flex min-h-0 min-w-0 flex-1">
                  <OpsTimeline items={projection.timeline} />
                  <button
                    aria-label="컨텍스트 열기"
                    className="absolute right-3 top-3 z-10 flex items-center justify-center rounded-lg border border-border bg-background/95 text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                    data-ops-interactive
                    onClick={() => setContextOpen(true)}
                    ref={contextTriggerRef}
                    style={INTERACTIVE_SIZE}
                    type="button"
                  >
                    <PanelRightOpen className="h-4 w-4" />
                  </button>
                </div>
              </MainPane>
            </div>
          ) : (
            <div className="flex h-full min-h-0 flex-col gap-2">
              <div
                aria-label="Agent Room 화면"
                className="grid grid-cols-4 gap-1 rounded-xl border border-border/70 bg-background p-1"
                role="tablist"
              >
                {MOBILE_TABS.map((tab) => (
                  <button
                    aria-selected={mobileTab === tab}
                    className="flex items-center justify-center rounded-lg px-1 text-xs font-medium transition-colors hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none aria-[selected=true]:bg-primary/10 aria-[selected=true]:text-primary"
                    data-ops-interactive
                    key={tab}
                    onClick={() => setMobileTab(tab)}
                    role="tab"
                    style={INTERACTIVE_SIZE}
                    type="button"
                  >
                    {MOBILE_TAB_LABELS[tab]}
                  </button>
                ))}
              </div>
              <MainPane>
                {mobileTab === "workspace" ? (
                  <OpsWorkspaceNav
                    onSelectChannel={onSelectChannel}
                    onSelectThread={onSelectThread}
                    workspace={projection.workspace}
                  />
                ) : mobileTab === "sessions" ? (
                  <OpsSessionTree
                    onSelect={setSelectedSessionId}
                    selectedSessionId={selectedSessionId}
                    sessions={projection.sessions}
                  />
                ) : mobileTab === "context" ? (
                  <OpsContextPanel
                    context={projection.context}
                    onOpenArtifact={openArtifact}
                  />
                ) : (
                  <OpsTimeline items={projection.timeline} />
                )}
              </MainPane>
            </div>
          )}
        </main>
      )}

      {layout === "compact" && contextOpen && projection ? (
        <div className="fixed inset-0 z-50">
          <button
            aria-label="컨텍스트 바깥 영역 닫기"
            className="absolute inset-0 bg-background/70 backdrop-blur-xs motion-reduce:transition-none"
            data-ops-interactive
            onClick={closeContext}
            style={INTERACTIVE_SIZE}
            tabIndex={-1}
            type="button"
          />
          <div
            aria-label="작업 컨텍스트"
            aria-modal="true"
            className="absolute inset-y-0 right-0 flex w-[min(25rem,88vw)] flex-col border-border border-l bg-background p-3 shadow-2xl outline-hidden transition-transform motion-reduce:transition-none"
            ref={contextDrawerRef}
            role="dialog"
            tabIndex={-1}
          >
            <button
              aria-label="컨텍스트 닫기"
              className="mb-2 ml-auto flex items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              data-ops-interactive
              onClick={closeContext}
              style={INTERACTIVE_SIZE}
              type="button"
            >
              <X className="h-4 w-4" />
            </button>
            <OpsContextPanel
              context={projection.context}
              onOpenArtifact={openArtifact}
            />
          </div>
        </div>
      ) : null}

      {selectedArtifact ? (
        <OpsArtifactReader
          artifact={selectedArtifact}
          onClose={() => setSelectedArtifact(null)}
          returnFocus={artifactTriggerRef.current}
        />
      ) : null}
    </div>
  );
}
