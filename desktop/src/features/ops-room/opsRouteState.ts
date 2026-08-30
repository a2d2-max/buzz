export const OPS_VIEWS = [
  "home",
  "work",
  "artifacts",
  "knowledge",
  "connections",
  "routing",
  "safety",
  "room",
] as const;

export type OpsView = (typeof OPS_VIEWS)[number];

export type OpsRouteState = {
  channel: string | null;
  thread: string | null;
  view: OpsView;
};

export type OpsNavigationPort = {
  pushOpsState: (state: OpsRouteState) => void;
  replaceOpsState: (state: OpsRouteState) => void;
  subscribe: (listener: () => void) => () => void;
  openAgents?: () => void;
  openProjects?: () => void;
  openWorkflows?: () => void;
  openSettings?: () => void;
  readOpsState: () => OpsRouteState;
};

export type OpsRouterSearch = {
  channel?: string;
  thread?: string;
  view?: string;
};

type OpsRouterNavigateOptions = {
  replace: boolean;
  resetScroll: false;
  search: {
    channel: string | undefined;
    thread: string | undefined;
    view: OpsView;
  };
};

type HashNavigationTarget = Pick<
  Window,
  "addEventListener" | "history" | "location" | "removeEventListener"
>;

function cleanSelection(value: string | null): string | null {
  return value?.trim() || null;
}

export function isOpsView(value: string | null): value is OpsView {
  return value !== null && OPS_VIEWS.includes(value as OpsView);
}

export function parseOpsRouteState(hash: string): OpsRouteState {
  const value = hash.startsWith("#") ? hash.slice(1) : hash;
  const parsed = new URL(value || "/ops", "http://ops.local");
  if (parsed.pathname !== "/ops") {
    return { channel: null, thread: null, view: "room" };
  }
  const view = parsed.searchParams.get("view");
  return {
    channel: cleanSelection(parsed.searchParams.get("channel")),
    thread: cleanSelection(parsed.searchParams.get("thread")),
    view: isOpsView(view) ? view : "room",
  };
}

export function serializeOpsRouteState(state: OpsRouteState): string {
  const params = new URLSearchParams({ view: state.view });
  if (state.channel) params.set("channel", state.channel);
  if (state.thread) params.set("thread", state.thread);
  return `#/ops?${params.toString()}`;
}

export function opsRouteNeedsNormalization(hash: string): boolean {
  return hash !== serializeOpsRouteState(parseOpsRouteState(hash));
}

export function createRouterOpsNavigationPort({
  navigate,
  openAgents,
  openProjects,
  openSettings,
  openWorkflows,
  readSearch,
}: {
  navigate: (options: OpsRouterNavigateOptions) => unknown;
  openAgents?: () => void;
  openProjects?: () => void;
  openSettings?: () => void;
  openWorkflows?: () => void;
  readSearch: () => OpsRouterSearch;
}): OpsNavigationPort {
  const readOpsState = (): OpsRouteState => {
    const search = readSearch();
    const rawView = search.view ?? null;
    return {
      channel: cleanSelection(search.channel ?? null),
      thread: cleanSelection(search.thread ?? null),
      view: isOpsView(rawView) ? rawView : "room",
    };
  };
  const write = (state: OpsRouteState, replace: boolean) => {
    void navigate({
      replace,
      resetScroll: false,
      search: {
        channel: state.channel ?? undefined,
        thread: state.thread ?? undefined,
        view: state.view,
      },
    });
  };
  return {
    openAgents,
    openProjects,
    openSettings,
    openWorkflows,
    pushOpsState: (state) => write(state, false),
    readOpsState,
    replaceOpsState: (state) => write(state, true),
    subscribe: () => () => {},
  };
}

export function normalizeOpsNavigation(
  navigation: OpsNavigationPort,
  rawView: string | undefined,
): void {
  if (!isOpsView(rawView ?? null)) {
    navigation.replaceOpsState(navigation.readOpsState());
  }
}

export function normalizeHashOpsNavigation(
  navigation: OpsNavigationPort,
  hash: string,
): void {
  if (opsRouteNeedsNormalization(hash)) {
    navigation.replaceOpsState(parseOpsRouteState(hash));
  }
}

export function createHashOpsNavigationPort(
  target: HashNavigationTarget = window,
): OpsNavigationPort {
  const subscribers = new Set<() => void>();
  const publish = () => {
    for (const subscriber of subscribers) subscriber();
  };
  return {
    pushOpsState(state) {
      target.history.pushState(null, "", serializeOpsRouteState(state));
      publish();
    },
    replaceOpsState(state) {
      target.history.replaceState(null, "", serializeOpsRouteState(state));
    },
    subscribe(listener) {
      subscribers.add(listener);
      target.addEventListener("hashchange", listener);
      target.addEventListener("popstate", listener);
      return () => {
        subscribers.delete(listener);
        target.removeEventListener("hashchange", listener);
        target.removeEventListener("popstate", listener);
      };
    },
    readOpsState() {
      return parseOpsRouteState(target.location.hash);
    },
  };
}
