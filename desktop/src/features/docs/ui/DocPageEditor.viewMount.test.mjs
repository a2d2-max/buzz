/**
 * Regression tests for DocPageEditor's editor-view lifecycle.
 *
 * TipTap v3 creates the `Editor` object before `<EditorContent>` attaches its
 * ProseMirror view, and `editor.view` access (`dom`, `focus`, …) throws until
 * then. The one-time setup effect used to run `editor.view.dom.setAttribute`
 * as soon as `editor` was non-null, which crashed "New page" to the app error
 * boundary whenever the view was not attached yet. These tests pin:
 *
 *   1. Rendering with a view-less editor must not throw; the setup parks
 *      itself and runs once a usable editor (a remount, or the replacement
 *      instance useEditor creates for a view-less one) is available.
 *   2. A fresh empty page opens in rich mode with the body input labeled via
 *      editorProps (no `view.dom` mutation) and autofocuses the title.
 *   3. Rich → source → rich switching unmounts/remounts <EditorContent>
 *      without touching a dead view.
 *   4. A page whose markdown the rich editor cannot keep opens in source
 *      mode and autofocuses the textarea without ever needing the view.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

// Editor instances created while rendering, captured via Editor.prototype.mount
// (the constructor mounts to a detached element, so every instance passes
// through it exactly once before any React effect runs).
const capturedEditors = [];
let realMount;

before(async () => {
  const zeroRect = {
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
    x: 0,
    y: 0,
  };
  // ProseMirror measures ranges when focusing/scrolling; jsdom leaves these
  // unimplemented.
  dom.window.Range.prototype.getBoundingClientRect = () => zeroRect;
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.assign(globalThis, {
    cancelAnimationFrame: (id) => clearTimeout(id),
    ClipboardEvent: dom.window.Event,
    DOMParser: dom.window.DOMParser,
    CustomEvent: dom.window.CustomEvent,
    document: dom.window.document,
    Element: dom.window.Element,
    Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    window: dom.window,
  });

  const { Editor } = await import("@tiptap/core");
  realMount = Editor.prototype.mount;
  Editor.prototype.mount = function capturingMount(el) {
    if (!capturedEditors.includes(this)) capturedEditors.push(this);
    return realMount.call(this, el);
  };
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  capturedEditors.length = 0;
});

after(async () => {
  if (realMount) {
    const { Editor } = await import("@tiptap/core");
    Editor.prototype.mount = realMount;
  }
  dom.window.close();
});

function makePage(overrides = {}) {
  return {
    author: "a".repeat(64),
    body: "",
    createdAt: 0,
    deleted: false,
    eventCreatedAt: 0,
    eventId: "e".repeat(64),
    id: "page-under-test",
    order: 0,
    parentId: null,
    title: "",
    updatedAt: 0,
    ...overrides,
  };
}

async function renderEditor(pageOverrides = {}, { sabotage } = {}) {
  const React = await import("react");
  const utils = await import("@testing-library/react");
  const { DocPageEditor } = await import("./DocPageEditor.tsx");
  const children = [
    React.createElement(DocPageEditor, {
      autoFocus: true,
      key: "editor",
      onAutosaveState: () => {},
      onSave: async () => {},
      page: makePage(pageOverrides),
    }),
  ];
  if (sabotage) {
    // Rendered before DocPageEditor so its effect runs first — after
    // <EditorContent> attached the view but before DocPageEditor's own
    // setup effect, reproducing the "editor without a view" window.
    function Sabotage() {
      React.useEffect(() => {
        sabotage(capturedEditors.at(-1));
      }, []);
      return null;
    }
    children.unshift(React.createElement(Sabotage, { key: "sabotage" }));
  }
  const rendered = utils.render(
    React.createElement(React.Fragment, null, ...children),
  );
  return { ...utils, rendered };
}

test("render survives an editor whose view detached before setup ran", async () => {
  // The crash scenario: DocPageEditor's setup effect runs while the editor
  // object exists but its ProseMirror view is gone (`editor.view` access
  // throws, and `isDestroyed` reports true). The old code threw
  // `[tiptap error]: The editor view is not available…` out of this render.
  // The fixed setup parks itself instead; useEditor then replaces the
  // view-less editor and the setup runs against the replacement.
  let viewlessDuringEffects = false;
  const { screen } = await renderEditor(
    {},
    {
      sabotage: (editor) => {
        editor?.unmount();
        viewlessDuringEffects = editor?.isDestroyed === true;
      },
    },
  );

  assert.equal(
    viewlessDuringEffects,
    true,
    "precondition: the editor must have been view-less when effects ran",
  );
  assert.ok(
    capturedEditors.length >= 2,
    "useEditor should have replaced the view-less editor",
  );
  // The deferred setup ran on the replacement editor: autofocus for an
  // untitled page landed on the title input, and rich mode is live again.
  assert.equal(
    dom.window.document.activeElement?.dataset.testid,
    "doc-title-input",
  );
  assert.ok(screen.getByTestId("doc-body-input"));
  assert.equal(screen.queryByTestId("doc-editor-lossy-notice"), null);
});

test("fresh empty page opens rich mode, labels the body, focuses the title", async () => {
  const { screen } = await renderEditor();

  // The body label comes from editorProps at view creation — not from a
  // post-hoc `editor.view.dom.setAttribute`.
  const body = screen.getByTestId("doc-body-input");
  assert.equal(body.getAttribute("contenteditable"), "true");
  assert.equal(
    dom.window.document.activeElement?.dataset.testid,
    "doc-title-input",
  );
  assert.equal(
    screen
      .getByRole("button", { name: "Rich text" })
      .getAttribute("aria-pressed"),
    "true",
  );
});

test("rich → source → rich mode switch remounts the view without throwing", async () => {
  const { fireEvent, screen } = await renderEditor({
    body: "# Hello\n\nWorld",
    title: "Guide",
  });

  fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
  const textarea = screen.getByTestId("doc-source-input");
  assert.match(textarea.value, /# Hello/);
  assert.equal(screen.queryByTestId("doc-body-input"), null);

  fireEvent.click(screen.getByRole("button", { name: "Rich text" }));
  assert.ok(screen.getByTestId("doc-body-input"));
  assert.equal(screen.queryByTestId("doc-source-input"), null);
});

test("unsupported markdown opens source mode and focuses the textarea", async () => {
  const { screen } = await renderEditor({
    body: "| a | b |\n| --- | --- |\n| 1 | 2 |",
    title: "Tables",
  });

  // Source mode never renders <EditorContent>; the setup must not wait for a
  // view mount that will never happen.
  assert.equal(
    dom.window.document.activeElement?.dataset.testid,
    "doc-source-input",
  );
  assert.match(
    screen.getByTestId("doc-editor-lossy-notice").textContent ?? "",
    /tables/,
  );
});
