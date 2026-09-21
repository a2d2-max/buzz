/**
 * Editor-level coverage: a page the rich editor cannot carry opens as markdown
 * source (both the syntax scan and the parser comparison are exercised), and
 * a failed save leaves a durable draft behind that a later success clears.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(() => {
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  Object.assign(globalThis, {
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    ClipboardEvent: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    DOMParser: dom.window.DOMParser,
    document: dom.window.document,
    Element: dom.window.Element,
    Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: dom.window.localStorage,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    Range: dom.window.Range,
    requestAnimationFrame: (callback) =>
      setTimeout(() => callback(Date.now()), 0),
    ResizeObserver: class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
    window: dom.window,
  });
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  dom.window.localStorage.clear();
});

after(() => dom.window.close());

function makePage(body, overrides = {}) {
  return {
    id: "page-1",
    author: "a".repeat(64),
    eventId: "e1".padEnd(64, "0"),
    eventCreatedAt: 100,
    title: "Title",
    body,
    parentId: null,
    order: 0,
    createdAt: 1,
    updatedAt: 2,
    deleted: false,
    ...overrides,
  };
}

async function mountEditor(page, { onSave } = {}) {
  const React = await import("react");
  const { render } = await import("@testing-library/react");
  const { DocPageEditor } = await import("./DocPageEditor.tsx");
  const states = [];
  const view = render(
    React.createElement(DocPageEditor, {
      onAutosaveState: (state) => states.push(state),
      onSave: onSave ?? (async () => {}),
      page,
    }),
  );
  return { states, view };
}

test("a page with a table opens as markdown source, not in the rich editor", async () => {
  const { waitFor } = await import("@testing-library/react");
  const { view } = await mountEditor(
    makePage("| a | b |\n|---|---|\n| 1 | 2 |"),
  );
  await waitFor(() => view.getByTestId("doc-source-input"));
  assert.equal(view.queryByTestId("doc-body-input"), null);
  assert.ok(
    view.getByTestId("doc-editor-lossy-notice").textContent.includes("tables"),
  );
  assert.equal(
    view.getByTestId("doc-source-input").value.includes("| a | b |"),
    true,
  );
});

test("a table the syntax scan misses is still caught by comparing the editor's echo", async () => {
  const { waitFor } = await import("@testing-library/react");
  // No leading pipes: the regex does not match, the parser comparison must.
  const { view } = await mountEditor(makePage("a | b\n--- | ---\n1 | 2"));
  await waitFor(() => view.getByTestId("doc-source-input"));
  assert.ok(view.getByTestId("doc-editor-lossy-notice"));
});

test("a plain page opens in the rich editor", async () => {
  const { waitFor } = await import("@testing-library/react");
  const { view } = await mountEditor(makePage("# Heading\n\nplain text"));
  await waitFor(() => view.getByTestId("doc-body-input"));
  assert.equal(view.queryByTestId("doc-source-input"), null);
  assert.equal(view.queryByTestId("doc-editor-lossy-notice"), null);
});

test("an escaped directive stays exact in source mode and rich mode recovers after removal", async () => {
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const databaseId = "11111111-2222-4333-8444-555555555555";
  const valid = `:::db ${databaseId}`;
  const mixed = `${valid}\n\n\\:::db ${databaseId}`;
  const saves = [];
  const first = await mountEditor(makePage(mixed), {
    onSave: async (draft) => saves.push(draft),
  });
  const source = await waitFor(() =>
    first.view.getByTestId("doc-source-input"),
  );
  assert.equal(source.value, mixed);
  assert.match(
    first.view.getByTestId("doc-editor-lossy-notice").textContent,
    /escaped database directives/,
  );

  fireEvent.change(source, { target: { value: valid } });
  fireEvent.click(first.view.getByRole("button", { name: "Rich text" }));
  await waitFor(() => first.view.getByTestId("doc-body-input"));
  assert.ok(first.view.container.querySelector("[data-doc-database-node]"));
  fireEvent.click(first.view.getByRole("button", { name: "Markdown" }));
  const normalized = first.view.getByTestId("doc-source-input");
  assert.equal(normalized.value.trim(), valid);
  fireEvent.focusOut(normalized);
  await waitFor(() => assert.equal(saves.length, 1));
  assert.equal(saves[0].body.trim(), valid);
  first.view.unmount();

  const second = await mountEditor(makePage(saves[0].body));
  await waitFor(() => second.view.getByTestId("doc-body-input"));
  assert.ok(second.view.container.querySelector("[data-doc-database-node]"));
  assert.equal(second.view.queryByTestId("doc-editor-lossy-notice"), null);
});

test("a failed save leaves a localStorage draft; the next successful save clears it", async () => {
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const { docDraftBackupKey } = await import("../lib/docDraftBackup.ts");
  let shouldFail = true;
  const saves = [];
  const { view, states } = await mountEditor(makePage("plain"), {
    onSave: async (draft) => {
      saves.push(draft);
      if (shouldFail) throw new Error("relay down");
    },
  });
  const title = await waitFor(() => view.getByTestId("doc-title-input"));
  fireEvent.change(title, { target: { value: "Renamed" } });
  fireEvent.focusOut(title);
  await waitFor(() => assert.equal(states.at(-1), "error"));
  const stored = JSON.parse(
    dom.window.localStorage.getItem(docDraftBackupKey("page-1")),
  );
  assert.equal(stored.title, "Renamed");
  assert.equal(stored.body, "plain");

  shouldFail = false;
  fireEvent.focusOut(title);
  await waitFor(() => assert.equal(states.at(-1), "saved"));
  assert.equal(
    dom.window.localStorage.getItem(docDraftBackupKey("page-1")),
    null,
  );
  assert.equal(saves.length, 2);
});

test("a recovered draft is offered on mount and restored on request", async () => {
  const { fireEvent, waitFor } = await import("@testing-library/react");
  const { docDraftBackupKey } = await import("../lib/docDraftBackup.ts");
  dom.window.localStorage.setItem(
    docDraftBackupKey("page-1"),
    JSON.stringify({ title: "Draft title", body: "draft body", savedAt: 5 }),
  );
  const saves = [];
  const { view } = await mountEditor(makePage("published body"), {
    onSave: async (draft) => {
      saves.push(draft);
    },
  });
  await waitFor(() => view.getByTestId("doc-draft-backup"));
  fireEvent.click(view.getByRole("button", { name: "Restore draft" }));
  assert.equal(view.getByTestId("doc-title-input").value, "Draft title");
  fireEvent.focusOut(view.getByTestId("doc-title-input"));
  await waitFor(() => assert.equal(saves.length, 1));
  assert.equal(saves[0].title, "Draft title");
  assert.equal(saves[0].body, "draft body");
});

test("StrictMode remount keeps the source editor save scheduler alive", async () => {
  const React = await import("react");
  const { render, fireEvent, waitFor } = await import("@testing-library/react");
  const { DocPageEditor } = await import("./DocPageEditor.tsx");
  const saves = [];
  const view = render(
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(DocPageEditor, {
        page: makePage("| a | b |\n|---|---|\n| 1 | 2 |"),
        onAutosaveState: () => {},
        onSave: async (draft) => saves.push(draft),
      }),
    ),
  );
  const source = await waitFor(() => view.getByTestId("doc-source-input"));
  fireEvent.change(source, { target: { value: "saved after effect replay" } });
  fireEvent.focusOut(source);
  await waitFor(() => assert.equal(saves.length, 1));
  assert.equal(saves[0].body, "saved after effect replay");
});
