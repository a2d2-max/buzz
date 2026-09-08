/**
 * Pins TipTap v3's view lifecycle contract that `isEditorViewMounted` (and
 * every consumer deferring work to the "mount" event) depends on:
 *
 *   - An editor can exist without a view (`element: null`, or after
 *     `unmount()`), and `editor.view.dom` access throws in that state.
 *   - State-only paths — tiptap-markdown's `getMarkdown` — keep working
 *     without a view, so autosave serialization is safe while unmounted.
 *
 * If a TipTap upgrade changes these semantics, this file fails before the
 * Docs editor does.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(() => {
  // tiptap-markdown parses initial markdown through DOM elements.
  Object.assign(globalThis, {
    document: dom.window.document,
    DOMParser: dom.window.DOMParser,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    window: dom.window,
  });
});

after(() => dom.window.close());

async function createViewlessEditor() {
  const { Editor } = await import("@tiptap/core");
  const { default: StarterKit } = await import("@tiptap/starter-kit");
  const { Markdown } = await import("tiptap-markdown");
  return new Editor({
    content: "# Hello\n\nWorld",
    // No element: the Editor object exists, the ProseMirror view does not —
    // the same state a consumer sees before <EditorContent> attaches (or in
    // the Docs surface's markdown-source mode, where it never attaches).
    element: null,
    extensions: [StarterKit, Markdown.configure({ html: false })],
  });
}

test("editor without a view: view access throws, isEditorViewMounted is false", async () => {
  const { isEditorViewMounted } = await import("./editorViewMounted.ts");
  const editor = await createViewlessEditor();

  assert.throws(() => editor.view.dom, /editor view is not available/i);
  assert.equal(isEditorViewMounted(editor), false);
  assert.equal(isEditorViewMounted(null), false);

  editor.destroy();
});

test("getMarkdown serializes without a view (autosave while unmounted)", async () => {
  const editor = await createViewlessEditor();

  const markdown = editor.storage.markdown.getMarkdown();
  assert.match(markdown, /# Hello/);

  editor.destroy();
});

test("mount and unmount flip isEditorViewMounted", async () => {
  const { isEditorViewMounted } = await import("./editorViewMounted.ts");
  const editor = await createViewlessEditor();

  editor.mount(dom.window.document.createElement("div"));
  assert.equal(isEditorViewMounted(editor), true);
  assert.equal(editor.view.dom.getAttribute("contenteditable"), "true");

  editor.unmount();
  assert.equal(isEditorViewMounted(editor), false);

  editor.destroy();
  assert.equal(isEditorViewMounted(editor), false);
});
