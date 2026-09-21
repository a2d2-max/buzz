/**
 * Detects page bodies the rich-text editor cannot carry faithfully.
 *
 * The editor is a TipTap document; its schema has no table, footnote, task
 * item, or raw HTML node. markdown-it still parses those constructs, and
 * ProseMirror then flattens whatever the schema cannot hold — a table turns
 * into its cell text run together — so the first autosave would overwrite the
 * page with the flattened copy. Two checks guard that: a syntax scan of the
 * source for known-unsupported constructs, and a structural comparison of the
 * source and the editor's echo, both rendered by the same markdown parser.
 */

const FENCED_CODE = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;

const UNSUPPORTED_SYNTAX: ReadonlyArray<[label: string, pattern: RegExp]> = [
  ["escaped database directives", /^\\:::db /m],
  ["tables", /^\s*\|.*\|\s*\n\s*\|?\s*:?-{3,}/m],
  ["footnotes", /\[\^[^\]\s]+\]/],
  ["task lists", /^\s*[-*+]\s+\[( |x|X)\]\s/m],
  ["HTML", /^\s*<[a-zA-Z][\w-]*(?:\s[^>]*)?>/m],
];

/** Human-readable labels of unsupported constructs found outside fenced code. */
export function scanUnsupportedMarkdown(source: string): string[] {
  const prose = source.replace(FENCED_CODE, "");
  return UNSUPPORTED_SYNTAX.filter(([, pattern]) => pattern.test(prose)).map(
    ([label]) => label,
  );
}

/** Wrapping-only tags whose presence differs between loose and tight renderings. */
const IGNORED_TAGS = new Set(["p", "br"]);

function summarize(html: string): {
  databaseBlocks: string[];
  text: string;
  tags: Map<string, number>;
} {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const text = (doc.body.textContent ?? "").replace(/\s+/g, "");
  const tags = new Map<string, number>();
  for (const element of doc.body.querySelectorAll("*")) {
    const tag = element.tagName.toLowerCase();
    if (IGNORED_TAGS.has(tag)) continue;
    tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }
  const databaseBlocks = [
    ...doc.body.querySelectorAll("[data-doc-database-block]"),
  ].map(
    (element) =>
      `${element.getAttribute("data-database-id") ?? ""}\u0000${element.getAttribute("data-view-id") ?? ""}`,
  );
  return { databaseBlocks, tags, text };
}

/**
 * Compares the parser's HTML for the original source with the HTML for the
 * editor's own serialization. Text content must match exactly (whitespace
 * aside) and every element type must appear the same number of times, except
 * paragraph/line-break wrappers, which legitimately differ between loose and
 * tight lists. `reasons` names what changed: `"text"` and/or tag names.
 */
export function compareRenderedMarkdown(
  sourceHtml: string,
  echoedHtml: string,
): { faithful: boolean; reasons: string[] } {
  const source = summarize(sourceHtml);
  const echoed = summarize(echoedHtml);
  const reasons: string[] = [];
  if (source.text !== echoed.text) reasons.push("text");
  if (
    source.databaseBlocks.length !== echoed.databaseBlocks.length ||
    source.databaseBlocks.some(
      (signature, index) => signature !== echoed.databaseBlocks[index],
    )
  ) {
    reasons.push("database blocks");
  }
  for (const [tag, count] of source.tags) {
    if ((echoed.tags.get(tag) ?? 0) !== count) reasons.push(tag);
  }
  for (const tag of echoed.tags.keys()) {
    if (!source.tags.has(tag)) reasons.push(tag);
  }
  return { faithful: reasons.length === 0, reasons: [...new Set(reasons)] };
}
