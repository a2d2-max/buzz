import * as React from "react";

import { classifyOpsBridgeError } from "../opsBridge";
import { dormantPageRequestSchema } from "../opsDormantContracts";
import { useOpsGlobalCollections } from "../opsGlobalCollections";
import {
  opsSearchRequest,
  reconcileOpsWorkSelection,
} from "../opsGlobalProjection";
import type { CompleteOpsCollectionRequest } from "../opsPagedCollection";
import { useOpsOverviewCollections } from "../opsOverviewCollections";
import { useOpsSnapshot } from "../hooks";
import { projectOpsRoom } from "../opsProjection";
import { opsLayoutForWidth, useOpsWindowSize } from "../opsWindowSize";
import type { OpsSelection } from "../types";
import {
  createHashOpsNavigationPort,
  opsRouteNeedsNormalization,
  type OpsNavigationPort,
  type OpsRouteState,
} from "../opsRouteState";
import { OpsArtifactsView } from "./OpsArtifactsView";
import { OpsWorkspaceScreen } from "./OpsWorkspaceScreen";
import { OpsRoomView } from "./OpsRoomView";
import {
  OpsConnectionsView,
  OpsKnowledgeView,
  OpsRoutingView,
  OpsSafetyView,
} from "./OpsSourceViews";
import {
  OpsCollectionState,
  OpsHomeView,
  OpsWorkView,
} from "./OpsHomeWorkViews";
import {
  OpsGlobalRouteBoundary,
  opsSourceConnectionState,
  opsSourceRoutePending,
  opsWorkRouteMode,
} from "./OpsGlobalRouteBoundary";

export { OpsRoomView } from "./OpsRoomView";
export {
  opsGlobalStateNoticeMessages,
  opsSourceConnectionState,
  opsSourceRoutePending,
  opsWorkRouteMode,
} from "./OpsGlobalRouteBoundary";

export function OpsRoomScreen({
  navigation: providedNavigation,
  showSectionNavigation = true,
}: {
  navigation?: OpsNavigationPort;
  showSectionNavigation?: boolean;
}) {
  const defaultNavigation = React.useRef<OpsNavigationPort | null>(null);
  defaultNavigation.current ??= createHashOpsNavigationPort();
  const navigation = providedNavigation ?? defaultNavigation.current;
  useOpsWindowSize();
  const [routeState, setRouteState] = React.useState<OpsRouteState>(() =>
    navigation.readOpsState(),
  );
  React.useEffect(() => {
    if (
      !providedNavigation &&
      opsRouteNeedsNormalization(window.location.hash)
    ) {
      navigation.replaceOpsState(routeState);
    }
  }, [navigation, providedNavigation, routeState]);
  const selection = React.useMemo(
    () => ({
      channel: routeState.channel,
      thread: routeState.thread,
      limit: 100,
    }),
    [routeState],
  );
  const { mutationsDisabled, refetch, snapshot, state, watchState } =
    useOpsSnapshot(selection);
  const projection = React.useMemo(
    () => (snapshot ? projectOpsRoom(snapshot) : null),
    [snapshot],
  );
  const globalActive = [
    "home",
    "work",
    "knowledge",
    "connections",
    "routing",
    "safety",
  ].includes(routeState.view);
  const requestedGlobalModules = React.useMemo(() => {
    if (routeState.view === "knowledge") return ["evidence"] as const;
    if (routeState.view === "connections") return ["sessions"] as const;
    if (routeState.view === "routing") return ["audit"] as const;
    if (routeState.view === "safety")
      return ["approval_index", "audit"] as const;
    return undefined;
  }, [routeState.view]);
  const [selectedWorkId, setSelectedWorkId] = React.useState<string | null>(
    null,
  );
  const [searchRequest, setSearchRequest] =
    React.useState<CompleteOpsCollectionRequest<"search"> | null>(null);
  const global = useOpsGlobalCollections({
    active: globalActive,
    invalidationRevision: 0,
    requestedModules: requestedGlobalModules
      ? [...requestedGlobalModules]
      : undefined,
    searchRequest,
    selectedWorkId,
  });
  const overview = useOpsOverviewCollections({
    activeModules:
      routeState.view === "knowledge"
        ? ["research"]
        : routeState.view === "connections"
          ? ["repositories"]
          : [],
    capabilities: global.capabilities,
    refreshCapabilities: global.refreshCapabilities,
  });

  React.useEffect(() => {
    if (global.states.work_items?.status !== "ready") return;
    setSelectedWorkId((current) =>
      reconcileOpsWorkSelection(current, global.collections.workItems),
    );
  }, [global.collections.workItems, global.states.work_items?.status]);

  React.useEffect(() => {
    const sync = () => setRouteState(navigation.readOpsState());
    return navigation.subscribe(sync);
  }, [navigation]);

  React.useEffect(() => {
    const canonical = navigation.readOpsState();
    if (
      canonical.view !== routeState.view ||
      canonical.channel !== routeState.channel ||
      canonical.thread !== routeState.thread
    )
      setRouteState(canonical);
  }, [navigation, routeState]);

  const select = React.useCallback(
    (next: Required<OpsSelection>) =>
      navigation.pushOpsState({
        channel: next.channel,
        thread: next.thread,
        view: routeState.view,
      }),
    [navigation, routeState.view],
  );

  const selectChannel = React.useCallback(
    (channel: string) =>
      select({ channel, thread: null, limit: selection.limit }),
    [select, selection.limit],
  );
  const selectThread = React.useCallback(
    (thread: string) =>
      select({ channel: selection.channel, thread, limit: selection.limit }),
    [select, selection.channel, selection.limit],
  );

  const [layout, setLayout] = React.useState(() =>
    opsLayoutForWidth(window.innerWidth),
  );
  React.useEffect(() => {
    const update = () => setLayout(opsLayoutForWidth(window.innerWidth));
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const sourceView = ["knowledge", "connections", "routing", "safety"].includes(
    routeState.view,
  );
  const globalConnectionState = sourceView
    ? opsSourceConnectionState(
        global.capabilities !== undefined,
        global.capabilityError,
        state,
      )
    : global.error
      ? classifyOpsBridgeError(global.error)
      : state;
  const sourcePending = opsSourceRoutePending(
    global.capabilities,
    global.capabilityError,
  );
  const workRouteMode = opsWorkRouteMode(
    selectedWorkId,
    global.collections.workItems,
    global.states.work_items,
  );
  const content =
    routeState.view === "artifacts" ? (
      <OpsArtifactsView connectionState={state} disabled={mutationsDisabled} />
    ) : routeState.view === "room" ? (
      <OpsRoomView
        connectionState={state}
        onRetry={() => void refetch()}
        onSelectChannel={selectChannel}
        onSelectThread={selectThread}
        projection={projection}
        watchState={watchState}
      />
    ) : routeState.view === "home" ? (
      <OpsGlobalRouteBoundary
        connectionState={globalConnectionState}
        onRetry={() => {
          void Promise.allSettled([refetch(), global.refetch()]);
        }}
        pending={global.pending}
        states={global.states}
      >
        <OpsHomeView
          collections={global.collections}
          onOpenWork={(id) => {
            setSelectedWorkId(id);
            navigation.pushOpsState({ ...routeState, view: "work" });
          }}
          refreshed={global.refreshed}
          states={global.states}
        />
      </OpsGlobalRouteBoundary>
    ) : routeState.view === "work" ? (
      <OpsGlobalRouteBoundary
        connectionState={globalConnectionState}
        onRetry={() => {
          void Promise.allSettled([refetch(), global.refetch()]);
        }}
        pending={global.pending}
        states={global.states}
      >
        {workRouteMode === "selected" && selectedWorkId ? (
          <OpsWorkView
            collections={global.collections}
            layout={layout}
            mutationsDisabled={mutationsDisabled}
            onSearch={(scope) => {
              const request = opsSearchRequest(scope.q, scope.kind, scope.work);
              const validated = dormantPageRequestSchema.safeParse({
                ...request,
                cursor: null,
                page_size: 100,
              });
              if (!validated.success) return false;
              setSearchRequest(request);
              return true;
            }}
            onSelectWork={(id) => {
              setSelectedWorkId(id);
              setSearchRequest(null);
            }}
            selectedWorkId={selectedWorkId}
            states={global.states}
          />
        ) : workRouteMode === "updating" ? (
          <p className="p-6 text-sm text-muted-foreground">
            Work selection is updating.
          </p>
        ) : workRouteMode === "empty" ? (
          <p className="p-6 text-sm text-muted-foreground">
            No work is active.
          </p>
        ) : (
          <OpsCollectionState
            label="Work"
            state={
              global.states.work_items?.status === "not_requested"
                ? { status: "pending" }
                : (global.states.work_items ?? { status: "pending" })
            }
          />
        )}
      </OpsGlobalRouteBoundary>
    ) : routeState.view === "knowledge" ? (
      <OpsGlobalRouteBoundary
        connectionState={globalConnectionState}
        onRetry={() =>
          void Promise.allSettled([
            refetch(),
            global.refetch(),
            overview.refetch(),
          ])
        }
        pending={sourcePending}
        showNotices={false}
        states={global.states}
      >
        <OpsKnowledgeView
          evidence={global.states.evidence ?? { status: "pending" }}
          onRetryEvidence={() => void global.refetchModule("evidence")}
          onRetryResearch={() => void overview.refetch()}
          research={overview.research}
        />
      </OpsGlobalRouteBoundary>
    ) : routeState.view === "connections" ? (
      <OpsGlobalRouteBoundary
        connectionState={globalConnectionState}
        onRetry={() =>
          void Promise.allSettled([
            refetch(),
            global.refetch(),
            overview.refetch(),
          ])
        }
        pending={sourcePending}
        showNotices={false}
        states={global.states}
      >
        <OpsConnectionsView
          connections={
            snapshot?.module_states.connections ?? { status: "unavailable" }
          }
          health={
            snapshot?.health ?? {
              hub: "degraded",
              orca: "unavailable",
              codex: "unavailable",
            }
          }
          onRetryRepositories={() => void overview.refetch()}
          onRetrySessions={() => void global.refetchModule("sessions")}
          repositories={overview.repositories}
          sessions={global.states.sessions ?? { status: "pending" }}
        />
      </OpsGlobalRouteBoundary>
    ) : routeState.view === "routing" ? (
      <OpsGlobalRouteBoundary
        connectionState={globalConnectionState}
        onRetry={() => void Promise.allSettled([refetch(), global.refetch()])}
        pending={sourcePending}
        showNotices={false}
        states={global.states}
      >
        <OpsRoutingView
          audit={global.states.audit ?? { status: "pending" }}
          onOpenWorkflows={navigation.openWorkflows}
          onRetryAudit={() => void global.refetchModule("audit")}
          workflowRouting={
            snapshot?.module_states.workflow_routing ?? {
              status: "unavailable",
            }
          }
        />
      </OpsGlobalRouteBoundary>
    ) : routeState.view === "safety" ? (
      <OpsGlobalRouteBoundary
        connectionState={globalConnectionState}
        onRetry={() => void Promise.allSettled([refetch(), global.refetch()])}
        pending={sourcePending}
        showNotices={false}
        states={global.states}
      >
        <OpsSafetyView
          approvals={global.states.approval_index ?? { status: "pending" }}
          audit={global.states.audit ?? { status: "pending" }}
          moduleStates={{ ...snapshot?.module_states, ...global.states }}
          mutationsDisabled={mutationsDisabled}
          onRetryApprovals={() => void global.refetchModule("approval_index")}
          onRetryAudit={() => void global.refetchModule("audit")}
        />
      </OpsGlobalRouteBoundary>
    ) : (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {routeState.view} is available as a read-only Ops section.
      </div>
    );
  return (
    <OpsWorkspaceScreen
      layout={layout}
      navigation={navigation}
      showSectionNavigation={showSectionNavigation}
      state={routeState}
    >
      {content}
    </OpsWorkspaceScreen>
  );
}
