import assert from "node:assert/strict";
import { test, before, after, afterEach } from "node:test";
import { JSDOM } from "jsdom";
import { createRecoveryJournal } from "../../../../../docs-editor/src/recoveryJournal.ts";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
before(() => {
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  globalThis.__TAURI_INTERNALS__ = {
    invoke: async (command) => {
      if (command === "get_relay_ws_url") return "ws://test-relay.example";
      if (command === "get_identity")
        return { pubkey: "a".repeat(64), display_name: "Tester" };
      throw Error(`Unexpected command: ${command}`);
    },
  };
  dom.window.__TAURI_INTERNALS__ = globalThis.__TAURI_INTERNALS__;
});
afterEach(async () => {
  (await import("@testing-library/react")).cleanup();
  localStorage.clear();
});
after(() => dom.window.close());
const page = {
  id: "6f900cf3-8904-47f2-bba5-f210167b9a21",
  title: "Original",
  body: "Markdown",
  eventId: "base",
  affine: { version: 1, data: "AQID" },
};
const draft = {
  title: "Edited",
  body: "Preview",
  affine: { version: 1, data: "BAUG" },
};
async function mount(onSave = async () => {}) {
  const React = await import("react");
  const { render, act, waitFor } = await import("@testing-library/react");
  const { AffineDocEditor } = await import("./AffineDocEditor.tsx");
  const ref = React.createRef();
  const states = [];
  const outbound = [];
  const ui = render(
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(AffineDocEditor, {
        page,
        onSave,
        onAutosaveState: (state) => states.push(state),
        ref,
      }),
    ),
  );
  await waitFor(() => assert.ok(ui.container.querySelector("iframe")));
  // Flush the effect for the committed frame before simulating its ready event.
  await act(async () => {});
  const frame = ui.container.querySelector("iframe");
  const nonce = new URL(frame.src).hash.slice(1);
  let journal;
  frame.contentWindow.postMessage = (message) => {
    outbound.push(message);
    if (message.type === "init")
      journal ??= createRecoveryJournal(localStorage, message.backupKey, nonce);
    if (message.type === "saved")
      journal.acknowledge(message.revision, message.data);
    if (message.type === "snapshot")
      queueMicrotask(() =>
        messageFromFrame({
          type: "draft",
          draft,
          requestId: message.requestId,
          changed: false,
        }),
      );
  };
  function messageFromFrame(message, overrides = {}) {
    if (
      message.type === "draft" &&
      !Object.keys(overrides).length &&
      (!message.nonce || message.nonce === nonce)
    ) {
      if (message.changed) journal.record(message.draft);
      else journal.preview(message.draft, journal.revision);
    }
    window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        origin: "http://localhost",
        source: frame.contentWindow,
        data: {
          protocol: "a2d2.docs.editor.v1",
          nonce,
          revision: journal?.revision ?? 0,
          ...message,
        },
        ...overrides,
      }),
    );
  }
  await act(async () => messageFromFrame({ type: "ready" }));
  await act(async () => messageFromFrame({ type: "mounted" }));
  return { ...ui, ref, states, outbound, act, messageFromFrame, journal };
}
test("only the expected frame, origin and nonce can schedule signed saves", async () => {
  const saved = [];
  const ui = await mount(async (value) => saved.push(value));
  assert.equal(ui.outbound[0].type, "init");
  assert.match(ui.outbound[0].backupKey, /test-relay\.example/);
  await ui.act(async () => {
    ui.messageFromFrame(
      { type: "draft", draft, changed: true },
      { origin: "https://other.example" },
    );
    ui.messageFromFrame(
      { type: "draft", draft, changed: true },
      { source: window },
    );
    ui.messageFromFrame({
      type: "draft",
      draft,
      changed: true,
      nonce: "wrong",
    });
  });
  assert.equal(localStorage.length, 0);
  assert.equal(saved.length, 0);
  await ui.act(async () =>
    ui.messageFromFrame({ type: "draft", draft, changed: true }),
  );
  assert.equal(
    JSON.parse(localStorage.getItem(ui.outbound[0].backupKey)).affine.data,
    draft.affine.data,
  );
  await ui.act(async () => assert.equal(await ui.ref.current.flush(), true));
  assert.deepEqual(saved, [draft]);
  assert.equal(localStorage.getItem(ui.outbound[0].backupKey), null);
});
test("failed signed saves retain structured recovery state", async () => {
  const ui = await mount(async () => {
    throw Error("relay offline");
  });
  await ui.act(async () => assert.equal(await ui.ref.current.flush(), false));
  assert.deepEqual(
    JSON.parse(localStorage.getItem(ui.outbound[0].backupKey)).affine,
    draft.affine,
  );
  assert.match(ui.container.textContent, /relay offline/);
});

test("a save completing before the newer draft message preserves the iframe journal", async () => {
  let release;
  let started = false;
  const ui = await mount(async () => {
    started = true;
    await new Promise((resolve) => {
      release = resolve;
    });
  });
  const { waitFor } = await import("@testing-library/react");
  let completion;
  await ui.act(async () => {
    completion = ui.ref.current.flush();
  });
  await waitFor(() => assert.equal(started, true));
  const newer = {
    ...draft,
    title: "Newer",
    affine: { version: 1, data: "BwgJ" },
  };
  ui.journal.record(newer);
  await ui.act(async () => {
    release();
    assert.equal(await completion, true);
  });
  assert.equal(
    JSON.parse(localStorage.getItem(ui.outbound[0].backupKey)).affine.data,
    newer.affine.data,
  );
});

test("untrusted database messages cannot open the community database panel", async () => {
  const ui = await mount();
  const message = {
    type: "open-database",
    databaseId: "11111111-2222-4333-8444-555555555555",
    viewId: null,
    blockId: "block",
  };
  await ui.act(async () => {
    ui.messageFromFrame(message, { origin: "https://other.example" });
    ui.messageFromFrame(message, { source: window });
    ui.messageFromFrame({ ...message, nonce: "old-frame" });
    ui.messageFromFrame({ ...message, databaseId: "not-an-id" });
    ui.messageFromFrame({ ...message, viewId: "../other" });
    ui.messageFromFrame({ ...message, blockId: "" });
  });
  assert.equal(
    ui.queryByRole("region", { name: "Linked database editor" }),
    null,
  );
});
