import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createMarkdownComponents } from "../../../shared/ui/markdown.tsx";
import {
  clearMarkdownNodeCache,
  renderCachedMarkdown,
} from "../../../shared/ui/markdown/nodeCache.ts";
import { MarkdownRuntimeContext } from "../../../shared/ui/markdown/runtimeContext.ts";

const DATABASE_ID = "11111111-1111-4111-8111-111111111111";
const VIEW_ID = "22222222-2222-4222-8222-222222222222";

const blockComponents = {
  "doc-database-block": (props) =>
    React.createElement(
      "output",
      {
        "data-database": props["data-database-id"],
        "data-view": props["data-view-id"],
      },
      "database",
    ),
};

function render(content, docsDatabases) {
  return renderToStaticMarkup(
    renderCachedMarkdown({
      components: blockComponents,
      content,
      docsDatabases,
      hardLineBreaks: false,
      variant: "docs-database-transform-test",
    }),
  );
}

test("Docs-only transform activates only an exact root column-zero directive", () => {
  clearMarkdownNodeCache();
  const directive = `:::db ${DATABASE_ID} ${VIEW_ID}`;
  assert.match(
    render(directive, true),
    new RegExp(`data-database="${DATABASE_ID}"`),
  );
  assert.doesNotMatch(render(directive, false), /data-database=/);

  for (const source of [
    `\\:::db ${DATABASE_ID}`,
    ` :::db ${DATABASE_ID}`,
    `- :::db ${DATABASE_ID}`,
    `> :::db ${DATABASE_ID}`,
    `before :::db ${DATABASE_ID}`,
    `:::db ${DATABASE_ID} ${VIEW_ID} extra`,
    `\`\`\`\n:::db ${DATABASE_ID}\n\`\`\``,
    `~~~\n:::db ${DATABASE_ID}\n~~~`,
  ]) {
    assert.doesNotMatch(render(source, true), /data-database=/, source);
  }
});

test("a valid read block stays interactive beside an escaped literal", () => {
  clearMarkdownNodeCache();
  const html = render(
    `:::db ${DATABASE_ID}\n\n\\:::db ${DATABASE_ID} ${VIEW_ID}`,
    true,
  );
  assert.equal((html.match(/data-database=/g) ?? []).length, 1);
  assert.match(html, new RegExp(`:::db ${DATABASE_ID} ${VIEW_ID}`));
});

test("a leading directive splits from adjacent prose images and directives", () => {
  clearMarkdownNodeCache();
  const prose = render(`:::db ${DATABASE_ID}\nAdjacent *prose*`, true);
  assert.equal((prose.match(/data-database=/g) ?? []).length, 1);
  assert.match(prose, /Adjacent <em>prose<\/em>/);

  const image = render(
    `:::db ${DATABASE_ID}\n![Diagram](https://example.com/diagram.png)`,
    true,
  );
  assert.equal((image.match(/data-database=/g) ?? []).length, 1);
  assert.match(image, /<img[^>]+diagram\.png/);

  const consecutive = render(
    `:::db ${DATABASE_ID}\n:::db ${DATABASE_ID} ${VIEW_ID}`,
    true,
  );
  assert.equal((consecutive.match(/data-database=/g) ?? []).length, 2);

  assert.doesNotMatch(
    render(`Before\n:::db ${DATABASE_ID}`, true),
    /data-database=/,
  );
  assert.equal(
    (
      render(
        `# Before\n:::db ${DATABASE_ID}\n\n- Item\n\n:::db ${DATABASE_ID} ${VIEW_ID}`,
        true,
      ).match(/data-database=/g) ?? []
    ).length,
    2,
  );
});

test("Docs database parse flag partitions cached markdown", () => {
  clearMarkdownNodeCache();
  const input = {
    components: blockComponents,
    content: `:::db ${DATABASE_ID}`,
    hardLineBreaks: false,
    variant: "docs-database-cache-test",
  };
  const literal = renderCachedMarkdown({ ...input, docsDatabases: false });
  const database = renderCachedMarkdown({ ...input, docsDatabases: true });
  assert.notEqual(literal, database);
  assert.equal(
    database,
    renderCachedMarkdown({ ...input, docsDatabases: true }),
  );
});

test("cached Docs block reads the current runtime renderer", () => {
  clearMarkdownNodeCache();
  const node = renderCachedMarkdown({
    components: createMarkdownComponents(true, false, false, true),
    content: `:::db ${DATABASE_ID} ${VIEW_ID}`,
    docsDatabases: true,
    hardLineBreaks: false,
    variant: "docs-database-runtime-test",
  });
  const runtime = (label) => ({
    channels: [],
    onOpenChannel: () => {},
    onOpenEntityLink: () => {},
    onOpenMessageLink: () => {},
    relayOrigin: null,
    renderDocDatabase: (databaseId, viewId) =>
      React.createElement("output", null, `${label}:${databaseId}:${viewId}`),
  });
  const renderWith = (label) =>
    renderToStaticMarkup(
      React.createElement(
        MarkdownRuntimeContext.Provider,
        { value: runtime(label) },
        node,
      ),
    );

  assert.match(renderWith("first"), /first:11111111.*22222222/);
  assert.match(renderWith("second"), /second:11111111.*22222222/);
});
