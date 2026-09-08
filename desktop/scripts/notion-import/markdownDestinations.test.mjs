import assert from "node:assert/strict";
import { test } from "node:test";

import { rewriteMarkdownDestinations } from "./markdownDestinations.ts";

test("rewrites only parser-recognized destinations when labels, titles, and code repeat the URL", () => {
  const target = "Folder%20Name/file.png";
  const source = [
    `[${target}](${target} "${target}")`,
    `![${target}](${target})`,
    `[definition][asset]`,
    "",
    `[asset]: ${target} "${target}"`,
    `\`${target}\``,
    "```text",
    target,
    "```",
  ].join("\n");

  const rewritten = rewriteMarkdownDestinations(source, ({ url }) =>
    url === target ? "https://assets.example/final.png" : null,
  );

  assert.equal(rewritten.replacementCount, 3);
  assert.equal(
    rewritten.body,
    [
      `[${target}](https://assets.example/final.png "${target}")`,
      `![${target}](https://assets.example/final.png)`,
      `[definition][asset]`,
      "",
      `[asset]: https://assets.example/final.png "${target}"`,
      `\`${target}\``,
      "```text",
      target,
      "```",
    ].join("\n"),
  );
});

test("autolinks are rewritten at their destination without touching adjacent prose", () => {
  const source =
    "Before <https://assets.example/original.pdf> after https://assets.example/original.pdf";
  const rewritten = rewriteMarkdownDestinations(source, ({ url }) =>
    url === "https://assets.example/original.pdf"
      ? "https://assets.example/file.pdf"
      : null,
  );

  assert.equal(rewritten.replacementCount, 1);
  assert.equal(
    rewritten.body,
    "Before <https://assets.example/file.pdf> after https://assets.example/original.pdf",
  );
});
