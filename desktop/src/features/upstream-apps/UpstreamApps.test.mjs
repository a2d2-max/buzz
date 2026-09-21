import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

Object.assign(globalThis, {
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  MutationObserver: dom.window.MutationObserver,
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  self: dom.window,
  window: dom.window,
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);
dom.window.requestAnimationFrame = globalThis.requestAnimationFrame;
dom.window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
dom.window.matchMedia = () => ({
  addEventListener() {},
  matches: false,
  removeEventListener() {},
});
dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
  bottom: 680,
  height: 600,
  left: 260,
  right: 1060,
  top: 80,
  width: 800,
  x: 260,
  y: 80,
});

const ipc = {
  availability: ["affine"],
  calls: [],
  probe: async ({ session }) => session,
  async invoke(command, args) {
    this.calls.push({ args, command });
    if (command === "get_upstream_app_availability") {
      if (this.availability instanceof Error) throw this.availability;
      return this.availability;
    }
    if (command === "probe_upstream_app") return this.probe(args);
    if (command === "go_back_upstream_app") return null;
    if (command === "sync_upstream_app") return null;
    throw new Error(`unmocked Tauri command: ${command}`);
  },
};

globalThis.__TAURI_INTERNALS__ = {
  invoke: (command, args) => ipc.invoke(command, args),
  transformCallback: () => 1,
};
dom.window.__TAURI_INTERNALS__ = globalThis.__TAURI_INTERNALS__;

let React;
let act;
let createRoot;
let createMemoryHistory;
let createRootRoute;
let createRouter;
let RouterProvider;
let SidebarProvider;
let UpstreamAppScreen;
let UpstreamSidebarEntries;

before(async () => {
  React = await import("react");
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
    await import("@tanstack/react-router"));
  ({ SidebarProvider } = await import("@/shared/ui/sidebar.tsx"));
  ({ UpstreamAppScreen } = await import("./UpstreamAppScreen.tsx"));
  ({ UpstreamSidebarEntries } = await import("./UpstreamSidebarEntries.tsx"));
});

afterEach(() => {
  ipc.availability = ["affine"];
  ipc.calls = [];
  ipc.probe = async ({ session }) => session;
});

after(() => dom.window.close());

async function renderSidebar() {
  const rootRoute = createRootRoute({
    component: () =>
      React.createElement(
        SidebarProvider,
        null,
        React.createElement(UpstreamSidebarEntries),
      ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(RouterProvider, { router }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    container,
    buttons: () => [...container.querySelectorAll("button")],
    async settle() {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function renderScreen(product = "affine") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(UpstreamAppScreen, { product }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  return {
    container,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("the sidebar renders only upstream products configured by the native host", async () => {
  ipc.availability = ["affine", "plane"];
  const view = await renderSidebar();
  await view.settle();
  const entries = view.buttons().filter((button) => button.dataset.testid);
  assert.deepEqual(
    entries.map((button) => button.dataset.testid),
    ["open-docs-view", "open-board-view"],
  );
  assert.match(entries[0].textContent, /AFFiNE Docs/);
  assert.match(entries[1].textContent, /Plane Board/);
  await view.unmount();
});

test("a direct route explains that an unconfigured product is unavailable without mounting a WebView", async () => {
  ipc.availability = [];
  const view = await renderScreen();
  assert.match(
    view.container.textContent,
    /AFFiNE Docs isn’t available in this app/,
  );
  assert.equal(
    ipc.calls.some(({ command }) => command === "sync_upstream_app"),
    false,
  );
  await view.unmount();
});

test("an unreachable configured product shows a retry state without mounting a WebView", async () => {
  ipc.probe = async () => {
    throw new Error(
      "AFFiNE isn’t responding. Check the service, then try again.",
    );
  };
  const view = await renderScreen();
  assert.match(view.container.textContent, /AFFiNE isn’t responding/);
  assert.equal(
    ipc.calls.some(
      ({ args, command }) => command === "sync_upstream_app" && args.bounds,
    ),
    false,
  );
  await view.unmount();
});

test("the host back action targets the currently mounted upstream session", async () => {
  const view = await renderScreen();
  const back = [...view.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Back",
  );
  assert.ok(back);

  await act(async () => back.click());

  const probe = ipc.calls.find(
    ({ command }) => command === "probe_upstream_app",
  );
  const navigation = ipc.calls.find(
    ({ command }) => command === "go_back_upstream_app",
  );
  assert.ok(probe);
  assert.deepEqual(navigation, {
    args: { session: probe.args.session },
    command: "go_back_upstream_app",
  });
  await view.unmount();
});
