/**
 * Live end-to-end probe for the Docs surface against a REAL buzz-relay.
 *
 * Mounts the production `DocsScreen` (real hook, real `relayClient`) in jsdom
 * and stands in only for the Tauri shell: the websocket plugin is bridged to
 * Node's WebSocket, and identity/signing use a throwaway nostr key. A second
 * raw client plays "someone else". Scenarios:
 *   2. Two identities edit one page: the stale save is refused with the
 *      conflict banner; "Keep mine" then publishes on top of theirs.
 *   3. The socket drops while someone else publishes a page; after the
 *      reconnect the page shows up in the tree.
 *   4. A page with a GFM table (published by another client) opens as
 *      markdown source, and an edit keeps the table intact on the relay.
 *
 * Usage (from desktop/, relay listening on RELAY_URL):
 *   RELAY_URL=ws://localhost:3100 node --import ./test-loader.mjs \
 *     --experimental-strip-types scripts/docs-relay-live.mjs
 */
import { JSDOM } from "jsdom";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

const RELAY_URL = process.env.RELAY_URL ?? "ws://localhost:3100";
const now = () => Math.floor(Date.now() / 1_000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const NodeWebSocket = globalThis.WebSocket;

// ── jsdom globals (same shape as the DocsScreen unit test) ──────────────────
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
class NoopObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
}
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
// The relay client reaches the socket through the Tauri plugin (stubbed
// below); keep Node's WebSocket as the transport, not jsdom's.
globalThis.WebSocket = NodeWebSocket;
dom.window.WebSocket = NodeWebSocket;

// ── Tauri shell stand-in ────────────────────────────────────────────────────
const aliceKey = generateSecretKey();
const alicePubkey = getPublicKey(aliceKey);
const sockets = new Map();
let nextSocketId = 1;
let nextCallbackId = 1;
const unmocked = [];
globalThis.__TAURI_INTERNALS__ = {
  transformCallback: () => nextCallbackId++,
  invoke: async (command, args = {}) => {
    switch (command) {
      case "get_relay_ws_url":
        return RELAY_URL;
      case "get_relay_http_url":
        return RELAY_URL.replace(/^ws/, "http");
      case "get_media_proxy_port":
        return 0;
      case "get_identity":
        return { pubkey: alicePubkey, display_name: "Alice" };
      case "create_auth_event":
        return JSON.stringify(
          finalizeEvent(
            {
              kind: 22242,
              created_at: now(),
              tags: [
                ["relay", args.relayUrl],
                ["challenge", args.challenge],
              ],
              content: "",
            },
            aliceKey,
          ),
        );
      case "sign_event":
        return JSON.stringify(
          finalizeEvent(
            {
              kind: args.kind,
              created_at: args.createdAt ?? now(),
              tags: args.tags,
              content: args.content,
            },
            aliceKey,
          ),
        );
      case "plugin:websocket|connect": {
        const id = nextSocketId++;
        const ws = new NodeWebSocket(args.url);
        const channel = args.onMessage;
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = () => reject(new Error("socket error"));
        });
        ws.onmessage = (message) =>
          channel.onmessage({ type: "Text", data: String(message.data) });
        ws.onclose = (event) =>
          channel.onmessage({
            type: "Close",
            data: { code: event.code, reason: event.reason },
          });
        sockets.set(id, ws);
        return id;
      }
      case "plugin:websocket|send":
        sockets.get(args.id)?.send(args.message.data);
        return null;
      case "plugin:websocket|disconnect":
        sockets.get(args.id)?.close();
        sockets.delete(args.id);
        return null;
      default:
        unmocked.push(command);
        throw new Error(`unmocked tauri command: ${command}`);
    }
  },
};
dom.window.__TAURI_INTERNALS__ = globalThis.__TAURI_INTERNALS__;

// ── Raw client for "someone else" ───────────────────────────────────────────
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
class RawClient {
  constructor(secretKey) {
    this.sk = secretKey;
    this.pk = getPublicKey(secretKey);
    this.pending = new Map();
    this.subs = new Map();
    this.authed = deferred();
  }
  async open() {
    this.ws = new NodeWebSocket(RELAY_URL);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error("websocket error"));
    });
    this.ws.onmessage = (message) => this.handle(JSON.parse(message.data));
    await this.authed.promise;
  }
  handle([type, ...rest]) {
    if (type === "AUTH") {
      const event = finalizeEvent(
        {
          kind: 22242,
          created_at: now(),
          tags: [
            ["relay", RELAY_URL],
            ["challenge", rest[0]],
          ],
          content: "",
        },
        this.sk,
      );
      this.authId = event.id;
      this.send(["AUTH", event]);
    } else if (type === "OK") {
      const [id, ok, message] = rest;
      if (id === this.authId)
        return ok
          ? this.authed.resolve()
          : this.authed.reject(new Error(message));
      const waiter = this.pending.get(id);
      if (waiter) {
        this.pending.delete(id);
        ok ? waiter.resolve() : waiter.reject(new Error(message));
      }
    } else if (type === "EVENT") {
      this.subs.get(rest[0])?.events.push(rest[1]);
    } else if (type === "EOSE") {
      const sub = this.subs.get(rest[0]);
      if (sub) {
        this.subs.delete(rest[0]);
        this.send(["CLOSE", rest[0]]);
        sub.resolve(sub.events);
      }
    } else if (type === "CLOSED") {
      const sub = this.subs.get(rest[0]);
      if (sub) {
        this.subs.delete(rest[0]);
        sub.reject(new Error(rest[1]));
      }
    }
  }
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }
  publish(template) {
    const event = finalizeEvent(template, this.sk);
    return new Promise((resolve, reject) => {
      this.pending.set(event.id, { resolve: () => resolve(event), reject });
      this.send(["EVENT", event]);
    });
  }
  req(filter) {
    const subId = `s${Math.random().toString(36).slice(2, 10)}`;
    return new Promise((resolve, reject) => {
      this.subs.set(subId, { events: [], resolve, reject });
      this.send(["REQ", subId, filter]);
    });
  }
  close() {
    this.ws.close();
  }
}

// ── Production modules (loaded after the globals exist) ─────────────────────
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
const { cleanup, fireEvent, render, waitFor } = await import(
  "@testing-library/react"
);
const { buildDocPageEventInput, docPageDTag, parseDocPageEvent } = await import(
  "@/features/docs/lib/docPageCodec"
);
const { pickLatestDocPages } = await import("@/features/docs/lib/docTree");
const { relayClient } = await import("@/shared/api/relayClient");
const { DocsScreen } = await import("@/features/docs/ui/DocsScreen");

const report = [];
const check = (label, ok, detail) => {
  report.push({ label, ok });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`,
  );
};
const docTemplate = ({ id, title, body, createdAt, order = 0 }) => {
  const input = buildDocPageEventInput({
    id,
    title,
    body,
    parentId: null,
    order,
    createdAt: createdAt * 1_000,
    updatedAt: createdAt * 1_000,
  });
  return {
    kind: input.kind,
    tags: input.tags,
    content: input.content,
    created_at: createdAt,
  };
};
const wait = (fn, timeout = 15_000) => waitFor(fn, { timeout });

const bob = new RawClient(generateSecretKey());
await bob.open();
const newestOf = async (id) => {
  const events = await bob.req({
    kinds: [30623, 30078],
    "#d": [docPageDTag(id)],
    limit: 200,
  });
  return pickLatestDocPages(events.map(parseDocPageEvent).filter(Boolean)).get(
    id,
  );
};

function mountScreen(pageId) {
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ["/docs"] }),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: 0, retry: false } },
  });
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        RouterContextProvider,
        { router },
        React.createElement(DocsScreen, { pageId }),
      ),
    ),
  );
  return {
    view,
    unmount() {
      view.unmount();
      client.clear();
      cleanup();
    },
  };
}

// ── Scenario 4: table page → source mode → edit keeps the table ─────────────
{
  const tableId = crypto.randomUUID();
  const tableBody = "| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter the table.";
  await bob.publish(
    docTemplate({
      id: tableId,
      title: "Table page",
      body: tableBody,
      createdAt: now(),
    }),
  );
  const screen = mountScreen(tableId);
  try {
    await wait(() => screen.view.getByTestId("doc-page-view"));
    fireEvent.click(screen.view.getByTestId("doc-start-edit"));
    const source = await wait(() =>
      screen.view.getByTestId("doc-source-input"),
    );
    const lossy = screen.view.queryByTestId("doc-editor-lossy-notice");
    check(
      "S4a table page opens as markdown source with the lossy notice",
      Boolean(lossy) && source.value.includes("| a | b |"),
      lossy?.textContent,
    );
    fireEvent.change(source, {
      target: { value: `${tableBody}\n\nEdited by Alice.` },
    });
    fireEvent.click(screen.view.getByTestId("doc-finish-edit"));
    await wait(() => screen.view.getByTestId("doc-page-view"));
    const newest = await newestOf(tableId);
    check(
      "S4b the edit reached the relay with the table intact",
      newest?.author === alicePubkey &&
        newest.body.includes("|---|---|") &&
        newest.body.includes("Edited by Alice."),
      `author ${newest?.author.slice(0, 8)}, body ${JSON.stringify(newest?.body).slice(0, 80)}`,
    );
  } finally {
    screen.unmount();
  }
}

// ── Scenario 2: conflict between two identities ─────────────────────────────
{
  const pageId = crypto.randomUUID();
  const base = now();
  await bob.publish(
    docTemplate({
      id: pageId,
      title: "Shared page",
      body: "",
      createdAt: base,
    }),
  );
  const screen = mountScreen(pageId);
  try {
    const title = await wait(() => screen.view.getByTestId("doc-title-input"));
    // Bob wins the race: a newer version lands while Alice is typing.
    const theirs = await bob.publish(
      docTemplate({
        id: pageId,
        title: "Theirs",
        body: "their body",
        createdAt: base + 2,
      }),
    );
    fireEvent.change(title, { target: { value: "mine" } });
    fireEvent.click(screen.view.getByTestId("doc-finish-edit"));
    await wait(() => screen.view.getByTestId("doc-remote-change"));
    const afterRefusal = await newestOf(pageId);
    check(
      "S2a stale save is refused: relay still holds Bob's version, banner shown",
      afterRefusal?.eventId === theirs.id &&
        Boolean(screen.view.queryByTestId("doc-title-input")),
      `newest by ${afterRefusal?.author.slice(0, 8)}`,
    );
    fireEvent.click(screen.view.getByRole("button", { name: "Keep mine" }));
    await wait(async () => {
      const newest = await newestOf(pageId);
      if (newest?.author !== alicePubkey) throw new Error("not yet");
    });
    const mine = await newestOf(pageId);
    check(
      "S2b 'Keep mine' publishes Alice's draft on top of Bob's version",
      mine?.title === "mine" && mine.eventCreatedAt > theirs.created_at,
      `title ${JSON.stringify(mine?.title)}, created_at ${mine?.eventCreatedAt} > ${theirs.created_at}`,
    );
  } finally {
    screen.unmount();
  }
}

// ── Scenario 3: socket drop, page published meanwhile, reconnect backfill ───
{
  const screen = mountScreen(undefined);
  try {
    await wait(() => screen.view.getByTestId("docs-tree"));
    await sleep(1_000);
    const socketsBefore = [...sockets.values()];
    // 1006 is reserved for abnormal closure and cannot be sent; 4000 is an
    // application code that still surfaces as a dropped socket.
    for (const ws of socketsBefore) ws.close(4000, "probe drop");
    const lostId = crypto.randomUUID();
    await bob.publish(
      docTemplate({
        id: lostId,
        title: "Published while offline",
        body: "x",
        createdAt: now(),
      }),
    );
    await wait(
      () => screen.view.getByTestId(`docs-tree-row-${lostId}`),
      30_000,
    );
    check(
      "S3 a page published during a socket drop appears after the reconnect",
      true,
      `sockets opened: ${nextSocketId - 1}`,
    );
  } catch (error) {
    check(
      "S3 a page published during a socket drop appears after the reconnect",
      false,
      String(error.message),
    );
  } finally {
    screen.unmount();
  }
}

bob.close();
relayClient.disconnect();
const failures = report.filter((entry) => !entry.ok).length;
console.log(`\n${report.length - failures}/${report.length} checks passed`);
if (unmocked.length)
  console.log("unmocked tauri commands:", [...new Set(unmocked)]);
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 200);
