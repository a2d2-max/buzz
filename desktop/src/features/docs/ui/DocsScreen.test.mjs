/**
 * Screen-level coverage for the one seam the lib tests cannot see: the editor's
 * save must reach `updatePage` with the version it was based on. Remove the
 * `{ baseEventId }` at the DocsScreen call site (or the argument in
 * DocPagePane) and the first assertion here fails — the edit would publish
 * over a version the author never saw.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

const AUTHOR_ME = "a".repeat(64);
const AUTHOR_THEM = "b".repeat(64);
const PAGE_ID = "3f0c2b1a-7d4e-4c9a-9b1e-2a6f8d5c4e10";
const TEST_RELAY_URL = "ws://test-relay.example";

let nextEventSerial = 0;

function docEvent({ id, eventId, author, createdAt, content }) {
  return {
    id: eventId.padEnd(64, "0"),
    pubkey: author,
    created_at: createdAt,
    kind: 30623,
    tags: [
      ["d", `doc:${id}`],
      ["t", "community-doc"],
    ],
    content: JSON.stringify({
      title: "Original",
      body: "",
      parentId: null,
      order: 0,
      createdAt: 1,
      updatedAt: 2,
      ...content,
    }),
    sig: "f".repeat(128),
  };
}

// V1 has an empty body so the page opens straight into the editor.
const V1 = docEvent({
  id: PAGE_ID,
  eventId: "v1",
  author: AUTHOR_ME,
  createdAt: 1_000,
  content: {},
});
const V2 = docEvent({
  id: PAGE_ID,
  eventId: "v2",
  author: AUTHOR_THEM,
  createdAt: 1_100,
  content: { title: "Theirs", body: "their body" },
});
const OTHER_PAGE_ID = "9d2e4c6a-1b3f-4a5c-8e7d-0f1a2b3c4d5e";
// A body the way an imported page carries it: an in-app link to another page,
// an external link, and a footnote reference.
const LINKED = docEvent({
  id: PAGE_ID,
  eventId: "linked",
  author: AUTHOR_THEM,
  createdAt: 1_200,
  content: {
    title: "Linked",
    body: [
      `Go to [Next](/#/docs/${OTHER_PAGE_ID}) or [Elsewhere](https://example.com/#/docs/${OTHER_PAGE_ID}).`,
      "",
      "A claim[^1].",
      "",
      "[^1]: The footnote.",
    ].join("\n"),
  },
});

class NoopObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
}

before(() => {
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.assign(globalThis, {
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    ClipboardEvent: dom.window.Event,
    DOMParser: dom.window.DOMParser,
    document: dom.window.document,
    fetch: async () =>
      new Response("{}", {
        headers: { "Content-Type": "application/nostr+json" },
      }),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IntersectionObserver: NoopObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: dom.window.localStorage,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: (callback) =>
      setTimeout(() => callback(Date.now()), 0),
    ResizeObserver: NoopObserver,
    self: dom.window,
    window: dom.window,
  });
  // DOM constructors Radix / React / ProseMirror reference without a window
  // prefix (same bulk copy the inbox screen test uses).
  for (const key of Object.getOwnPropertyNames(dom.window)) {
    if (
      !(key in globalThis) &&
      (key.startsWith("HTML") ||
        key.startsWith("SVG") ||
        [
          "Element",
          "DOMRect",
          "DOMRectReadOnly",
          "Node",
          "NodeFilter",
          "NodeList",
          "NamedNodeMap",
          "Event",
          "CustomEvent",
          "MouseEvent",
          "KeyboardEvent",
          "FocusEvent",
          "InputEvent",
          "PointerEvent",
          "Text",
          "Comment",
          "DocumentFragment",
          "Range",
          "Selection",
        ].includes(key))
    ) {
      const value = dom.window[key];
      if (value !== undefined) globalThis[key] = value;
    }
  }
  globalThis.__TAURI_INTERNALS__ = {
    invoke: (command, args) => {
      if (command === "sign_event") {
        nextEventSerial += 1;
        return Promise.resolve(
          JSON.stringify({
            id: `signed${nextEventSerial}`.padEnd(64, "0"),
            pubkey: AUTHOR_ME,
            created_at: args.createdAt ?? Math.floor(Date.now() / 1_000),
            kind: args.kind,
            tags: args.tags,
            content: args.content,
            sig: "f".repeat(128),
          }),
        );
      }
      if (command === "get_relay_ws_url") {
        return Promise.resolve(TEST_RELAY_URL);
      }
      return Promise.reject(new Error(`unmocked: ${command}`));
    },
    transformCallback: () => 1,
  };
  dom.window.__TAURI_INTERNALS__ = globalThis.__TAURI_INTERNALS__;
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

async function mountDocsScreen({
  history,
  lookupFailure = null,
  pageId,
  routerEntries = ["/docs"],
  routerIndex,
  versionsByDTag,
}) {
  const React = await import("react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const {
    RouterContextProvider,
    createMemoryHistory,
    createRootRoute,
    createRouter,
  } = await import("@tanstack/react-router");
  const { render } = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { TooltipProvider } = await import("@/shared/ui/tooltip");
  const { DocsScreen } = await import("./DocsScreen.tsx");

  const published = [];
  const originals = {
    fetchEvents: relayClient.fetchEvents,
    publishEvent: relayClient.publishEvent,
    subscribeLive: relayClient.subscribeLive,
    subscribeToReconnects: relayClient.subscribeToReconnects,
  };
  let lookupAttempts = 0;
  relayClient.fetchEvents = async (filter) => {
    const dTags = filter["#d"];
    if (dTags) {
      lookupAttempts += 1;
      if (lookupFailure && lookupAttempts <= lookupFailure.times) {
        throw new Error(lookupFailure.message);
      }
      return versionsByDTag[dTags[0]] ?? [];
    }
    return history;
  };
  relayClient.publishEvent = async (event) => {
    published.push(event);
  };
  relayClient.subscribeLive = async (_filter, _onEvent, onReady) => {
    onReady?.("eose");
    return async () => {};
  };
  relayClient.subscribeToReconnects = () => () => {};

  // A real router over memory history: link clicks and "Go back" are asserted
  // on the history it moves, not on a stubbed navigation callback.
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({
      initialEntries: routerEntries,
      initialIndex: routerIndex,
    }),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: 0, retry: false } },
  });
  // Links in a page body carry a hover tooltip, which needs the provider the
  // app root supplies.
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(
          RouterContextProvider,
          { router },
          React.createElement(DocsScreen, { pageId }),
        ),
      ),
    ),
  );
  return {
    published,
    router,
    view,
    restore() {
      view.unmount();
      client.clear();
      Object.assign(relayClient, originals);
    },
  };
}

test("an edit based on an older version is refused, then published only after 'Keep mine'", async () => {
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const docs = await mountDocsScreen({
    history: [V1],
    pageId: PAGE_ID,
    versionsByDTag: { [`doc:${PAGE_ID}`]: [V1, V2] },
  });
  try {
    const title = await waitFor(() => docs.view.getByTestId("doc-title-input"));
    fireEvent.change(title, { target: { value: "mine" } });
    fireEvent.click(docs.view.getByTestId("doc-finish-edit"));

    await waitFor(() => docs.view.getByTestId("doc-remote-change"));
    assert.equal(
      docs.published.length,
      0,
      "a save based on v1 must not publish over v2",
    );
    assert.ok(
      docs.view
        .getByTestId("doc-save-status")
        .textContent.includes("Save failed"),
    );
    assert.ok(
      docs.view.queryByTestId("doc-title-input"),
      "Done must not leave the editor while the save is refused",
    );

    fireEvent.click(docs.view.getByRole("button", { name: "Keep mine" }));
    await waitFor(() => assert.equal(docs.published.length, 1));
    const content = JSON.parse(docs.published[0].content);
    assert.equal(content.title, "mine");
    assert.ok(docs.published[0].created_at > V2.created_at, "rebased onto v2");
    await waitFor(() =>
      assert.equal(docs.view.queryByTestId("doc-remote-change"), null),
    );
  } finally {
    docs.restore();
  }
});

test("a failed page lookup asks to try again instead of declaring the page missing", async () => {
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const docs = await mountDocsScreen({
    history: [],
    lookupFailure: { message: "relay timeout", times: 1 },
    pageId: PAGE_ID,
    versionsByDTag: { [`doc:${PAGE_ID}`]: [V2] },
  });
  try {
    const retry = await waitFor(() =>
      docs.view.getByRole("button", { name: "Try again" }),
    );
    assert.equal(
      docs.view.queryByText(/doesn't exist or was deleted/),
      null,
      "an unanswered lookup is not a missing page",
    );
    fireEvent.click(retry);
    await waitFor(() => docs.view.getByTestId("doc-page-view"));
  } finally {
    docs.restore();
  }
});

test("a page the relay really does not hold is reported missing after the lookup", async () => {
  const { waitFor } = await import("@testing-library/react");
  const docs = await mountDocsScreen({
    history: [],
    pageId: "nope",
    versionsByDTag: {},
  });
  try {
    await waitFor(() => docs.view.getByText(/doesn't exist or was deleted/));
  } finally {
    docs.restore();
  }
});

test("a Docs link in the page body moves the app to that page instead of leaving it", async () => {
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const docs = await mountDocsScreen({
    history: [LINKED],
    pageId: PAGE_ID,
    versionsByDTag: { [`doc:${PAGE_ID}`]: [LINKED] },
  });
  try {
    await waitFor(() => docs.view.getByTestId("doc-page-view"));
    const link = docs.view.getByRole("link", { name: "Next" });
    const browserDefaultKept = fireEvent.click(link);
    assert.equal(
      browserDefaultKept,
      false,
      "the click must be taken over: the webview would open it in a new window",
    );
    await waitFor(() =>
      assert.equal(
        docs.router.history.location.pathname,
        `/docs/${OTHER_PAGE_ID}`,
      ),
    );
  } finally {
    docs.restore();
  }
});

test("Cmd+click on a Docs link keeps the anchor's own behaviour", async () => {
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const docs = await mountDocsScreen({
    history: [LINKED],
    pageId: PAGE_ID,
    versionsByDTag: { [`doc:${PAGE_ID}`]: [LINKED] },
  });
  try {
    await waitFor(() => docs.view.getByTestId("doc-page-view"));
    const link = docs.view.getByRole("link", { name: "Next" });
    assert.equal(fireEvent.click(link, { metaKey: true }), true);
    assert.equal(fireEvent.click(link, { ctrlKey: true }), true);
    assert.equal(fireEvent.click(link, { button: 1 }), true);
    assert.equal(docs.router.history.location.pathname, "/docs");
  } finally {
    docs.restore();
  }
});

test("the same route on another host stays an external link", async () => {
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const docs = await mountDocsScreen({
    history: [LINKED],
    pageId: PAGE_ID,
    versionsByDTag: { [`doc:${PAGE_ID}`]: [LINKED] },
  });
  try {
    await waitFor(() => docs.view.getByTestId("doc-page-view"));
    const link = docs.view.getByRole("link", { name: "Elsewhere" });
    assert.equal(link.getAttribute("target"), "_blank");
    assert.equal(fireEvent.click(link), true);
    assert.equal(docs.router.history.location.pathname, "/docs");
  } finally {
    docs.restore();
  }
});

test("a footnote reference scrolls within the page instead of changing the route", async () => {
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const docs = await mountDocsScreen({
    history: [LINKED],
    pageId: PAGE_ID,
    versionsByDTag: { [`doc:${PAGE_ID}`]: [LINKED] },
  });
  const scrolledTo = [];
  const previousScrollIntoView =
    dom.window.HTMLElement.prototype.scrollIntoView;
  dom.window.HTMLElement.prototype.scrollIntoView = function record() {
    scrolledTo.push(this.id);
  };
  try {
    await waitFor(() => docs.view.getByTestId("doc-page-view"));
    const reference = docs.view.container.querySelector("a[data-footnote-ref]");
    assert.ok(reference, "remark-gfm renders the footnote reference");
    assert.notEqual(
      reference.getAttribute("target"),
      "_blank",
      "an in-page fragment must not be handed to the new-window path",
    );
    assert.equal(fireEvent.click(reference), false);
    assert.deepEqual(scrolledTo, ["user-content-fn-1"]);
    assert.equal(docs.router.history.location.pathname, "/docs");
  } finally {
    dom.window.HTMLElement.prototype.scrollIntoView = previousScrollIntoView;
    docs.restore();
  }
});

test("a missing page names itself and offers the way back to where the link was", async () => {
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const docs = await mountDocsScreen({
    history: [],
    pageId: "nope",
    routerEntries: [`/docs/${PAGE_ID}`, "/docs/nope"],
    routerIndex: 1,
    versionsByDTag: {},
  });
  try {
    await waitFor(() => docs.view.getByText(/doesn't exist or was deleted/));
    assert.ok(
      docs.view.getByTestId("docs-placeholder").textContent.includes("nope"),
      "the notice must say which page it could not find",
    );
    fireEvent.click(docs.view.getByRole("button", { name: "Go back" }));
    await waitFor(() =>
      assert.equal(docs.router.history.location.pathname, `/docs/${PAGE_ID}`),
    );
  } finally {
    docs.restore();
  }
});
