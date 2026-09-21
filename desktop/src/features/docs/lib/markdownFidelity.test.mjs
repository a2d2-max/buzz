import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { JSDOM } from "jsdom";

import {
  compareRenderedMarkdown,
  scanUnsupportedMarkdown,
} from "./markdownFidelity.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
before(() => {
  Object.assign(globalThis, { DOMParser: dom.window.DOMParser });
});
after(() => dom.window.close());

test("scanUnsupportedMarkdown: tables, footnotes, task lists, html blocks", () => {
  assert.deepEqual(scanUnsupportedMarkdown("| a | b |\n|---|---|\n| 1 | 2 |"), [
    "tables",
  ]);
  assert.deepEqual(scanUnsupportedMarkdown("text[^1]\n\n[^1]: note"), [
    "footnotes",
  ]);
  assert.deepEqual(scanUnsupportedMarkdown("- [ ] todo\n- [x] done"), [
    "task lists",
  ]);
  assert.deepEqual(
    scanUnsupportedMarkdown("<details>\n<summary>x</summary>\n</details>"),
    ["HTML"],
  );
  assert.deepEqual(
    scanUnsupportedMarkdown("# fine\n\n- list\n\n```js\nx\n```\n\n![a](b)"),
    [],
  );
});

test("scanUnsupportedMarkdown: fenced code is not scanned", () => {
  assert.deepEqual(
    scanUnsupportedMarkdown("```\n| a | b |\n|---|---|\n- [ ] x\n<div>\n```"),
    [],
  );
});

test("scanUnsupportedMarkdown keeps escaped database directives in source mode", () => {
  const database = "11111111-2222-4333-8444-555555555555";
  assert.deepEqual(scanUnsupportedMarkdown(`\\:::db ${database}`), [
    "escaped database directives",
  ]);
  assert.deepEqual(
    scanUnsupportedMarkdown(`\`\`\`text\n\\:::db ${database}\n\`\`\``),
    [],
  );
});

test("compareRenderedMarkdown: identical structure and text is faithful", () => {
  const result = compareRenderedMarkdown(
    "<h1>Title</h1><p>Hello <strong>bold</strong></p>",
    "<h1>Title</h1><p>Hello <strong>bold</strong></p>",
  );
  assert.deepEqual(result, { faithful: true, reasons: [] });
});

test("compareRenderedMarkdown: lost block structure is reported by tag", () => {
  const result = compareRenderedMarkdown(
    "<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>",
    "<p>ab</p>",
  );
  assert.equal(result.faithful, false);
  assert.ok(result.reasons.includes("table"));
});

test("compareRenderedMarkdown: dropped text is reported", () => {
  const result = compareRenderedMarkdown(
    "<p>keep</p><h5>gone</h5>",
    "<p>keep</p><p></p>",
  );
  assert.equal(result.faithful, false);
  assert.ok(result.reasons.includes("text"));
});

test("compareRenderedMarkdown: paragraph wrapping and line breaks do not count", () => {
  // Loose → tight list re-serialization drops <p> inside <li>; a soft line
  // break becomes a hard one. Neither loses content.
  const result = compareRenderedMarkdown(
    "<ul><li><p>a</p></li><li><p>b</p></li></ul><p>x<br>y</p>",
    "<ul><li>a</li><li>b</li></ul><p>x<br>y</p>",
  );
  assert.equal(result.faithful, true);
});

test("compareRenderedMarkdown: database ids and ordered view ids are semantic", () => {
  const database =
    '<div data-doc-database-block data-database-id="11111111-2222-4333-8444-555555555555" data-view-id="table"></div>';
  const same = compareRenderedMarkdown(
    `${database}${database}`,
    `${database}${database}`,
  );
  assert.deepEqual(same, { faithful: true, reasons: [] });
  const changed = compareRenderedMarkdown(
    database,
    database.replace('data-view-id="table"', 'data-view-id="board"'),
  );
  assert.equal(changed.faithful, false);
  assert.deepEqual(changed.reasons, ["database blocks"]);
  const removed = compareRenderedMarkdown(database, "<div></div>");
  assert.equal(removed.faithful, false);
  assert.ok(removed.reasons.includes("database blocks"));
});
