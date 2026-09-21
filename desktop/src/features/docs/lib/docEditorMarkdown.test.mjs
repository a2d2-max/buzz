/**
 * Round-trip coverage for the Docs editor configuration.
 *
 * A page body is markdown that goes through the *production* composer hook
 * (`useRichTextEditor`) on every edit. The chat composer deliberately has no
 * heading node and no image node, so without `documentMode` and the
 * `DocImageNode` extension a `# Title` would flatten to plain text and an
 * `![alt](url)` would vanish on the first autosave. These tests mount the real
 * hook in jsdom and check both that the document configuration preserves each
 * construct and that the chat configuration does not — so a refactor that
 * quietly drops either option fails here instead of eating someone's page.
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
    ClipboardEvent: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    DOMParser: dom.window.DOMParser,
    document: dom.window.document,
    Element: dom.window.Element,
    Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    Range: dom.window.Range,
    ResizeObserver: class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    window: dom.window,
  });
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

/** Mounts the production hook with the given options; returns its API. */
async function mountEditor(options) {
  const React = await import("react");
  const { act, render, waitFor } = await import("@testing-library/react");
  const { EditorContent } = await import("@tiptap/react");
  const { useRichTextEditor } = await import(
    "@/features/messages/lib/useRichTextEditor"
  );

  let api = null;
  function Harness() {
    const instance = useRichTextEditor(options);
    api = instance;
    return instance.editor
      ? React.createElement(EditorContent, { editor: instance.editor })
      : null;
  }
  await act(async () => {
    render(React.createElement(Harness));
  });
  await waitFor(() =>
    assert.ok(api?.editor?.isInitialized, "editor never emitted `create`"),
  );
  return {
    async roundTrip(markdown) {
      await act(async () => {
        api.setContent(markdown);
      });
      return api.getMarkdown();
    },
  };
}

async function mountDocsEditor() {
  const { DocImageNode } = await import("./docImageNode.ts");
  const { DocDatabaseNode } = await import("./docDatabaseNode.ts");
  return mountEditor({
    documentMode: true,
    extraExtensions: [DocImageNode, DocDatabaseNode],
  });
}

test("document mode keeps headings, lists, code, links, images and quotes", async () => {
  const editor = await mountDocsEditor();
  const source = [
    "# Onboarding",
    "",
    "Welcome to **Buzz**.",
    "",
    "## Steps",
    "",
    "- install",
    "- run",
    "",
    "1. first",
    "2. second",
    "",
    "```sh",
    "just relay",
    "```",
    "",
    "See [the docs](https://example.com/docs).",
    "",
    "![Logo](https://example.com/logo.png)",
    "",
    "> remember to sign your commits",
  ].join("\n");

  const output = await editor.roundTrip(source);

  assert.equal(output, source);
});

test("document mode: a second round trip is stable", async () => {
  const editor = await mountDocsEditor();
  const once = await editor.roundTrip("# Title\n\n![a](https://x.test/a.png)");
  const twice = await editor.roundTrip(once);
  assert.equal(twice, once);
});

test("chat configuration flattens headings — documentMode is load-bearing", async () => {
  const editor = await mountEditor({});
  const output = await editor.roundTrip("# Title\n\nbody");
  assert.equal(output.includes("# Title"), false);
  assert.ok(output.includes("Title"), "heading text itself survives");
});

test("without DocImageNode an image is dropped — the extension is load-bearing", async () => {
  const editor = await mountEditor({ documentMode: true });
  const output = await editor.roundTrip(
    "before\n\n![Logo](https://example.com/logo.png)\n\nafter",
  );
  assert.equal(output.includes("logo.png"), false);
});

test("document mode keeps backslashes inside fenced and inline code", async () => {
  const editor = await mountDocsEditor();
  const source = [
    "```sh",
    "docker run \\",
    "  --rm image",
    "```",
    "",
    "Match with `grep -E '\\[a-z\\]\\*'` or `\\d+`.",
  ].join("\n");
  assert.equal(await editor.roundTrip(source), source);
});

test("document mode keeps h5/h6 headings", async () => {
  const editor = await mountDocsEditor();
  const source = "##### Five\n\n###### Six";
  assert.equal(await editor.roundTrip(source), source);
});

test("document mode keeps escaped literals; chat mode still unescapes them", async () => {
  const source = "literal \\*not emphasis\\* and \\[not a link\\]";
  const docs = await mountDocsEditor();
  assert.equal(await docs.roundTrip(source), source);
  const chat = await mountEditor({});
  assert.equal(
    await chat.roundTrip(source),
    "literal *not emphasis* and [not a link]",
  );
});

test("document mode still writes soft line breaks as plain newlines outside code", async () => {
  const editor = await mountDocsEditor();
  const source = "first line\nsecond line";
  assert.equal(await editor.roundTrip(source), source);
});

test("document mode preserves valid database atoms and leaves escaped fenced and nested lookalikes literal", async () => {
  const editor = await mountDocsEditor();
  const databaseId = "11111111-2222-4333-8444-555555555555";
  const source = [
    "# Plan",
    "",
    `:::db ${databaseId}`,
    "",
    "Adjacent prose.",
    "",
    `:::db ${databaseId} missing_view`,
    "",
    "![Diagram](https://example.com/diagram.png)",
    "",
    `- :::db ${databaseId}`,
    "",
    "```text",
    `:::db ${databaseId} board`,
    "```",
    "",
    "~~~text",
    `:::db ${databaseId}`,
    "~~~",
  ].join("\n");
  const once = await editor.roundTrip(source);
  const normalized = source.replaceAll("~~~", "```");
  assert.equal(once, normalized);
  assert.equal(await editor.roundTrip(once), once);
});

test("document mode separates a leading database atom from adjacent blocks", async () => {
  const editor = await mountDocsEditor();
  const databaseId = "11111111-2222-4333-8444-555555555555";
  const cases = [
    [
      `:::db ${databaseId}\nAdjacent *prose*`,
      `:::db ${databaseId}\n\nAdjacent *prose*`,
    ],
    [
      `:::db ${databaseId}\n![Diagram](https://example.com/diagram.png)`,
      `:::db ${databaseId}\n\n![Diagram](https://example.com/diagram.png)`,
    ],
    [
      `:::db ${databaseId}\n:::db ${databaseId} board`,
      `:::db ${databaseId}\n\n:::db ${databaseId} board`,
    ],
  ];
  for (const [source, expected] of cases) {
    assert.equal(await editor.roundTrip(source), expected);
  }
  assert.equal(
    await editor.roundTrip(`Before\n:::db ${databaseId}`),
    `Before\n:::db ${databaseId}`,
  );
});
