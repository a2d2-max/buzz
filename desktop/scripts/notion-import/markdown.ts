import path from "node:path";
import { fromMarkdown } from "mdast-util-from-markdown";

import { scanUnsupportedMarkdown } from "../../src/features/docs/lib/markdownFidelity.ts";
import type { ImportedDatabase, UnresolvedLink } from "./types.ts";

type MarkdownNode = {
  type?: string;
  depth?: number;
  value?: string;
  alt?: string;
  url?: string;
  children?: MarkdownNode[];
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
};

type Replacement = { start: number; end: number; value: string };

export type ExtractedPageDocument = {
  title: string;
  body: string;
};

export type MarkdownConversion = {
  body: string;
  resolvedLinks: number;
  inlineDatabases: number;
  attachmentReferences: number;
  unresolvedLinks: UnresolvedLink[];
  unsupportedSyntax: string[];
};

function nodeText(node: MarkdownNode): string {
  if (node.type === "text" || node.type === "inlineCode") {
    return node.value ?? "";
  }
  if (node.type === "image") return node.alt ?? "";
  return (node.children ?? []).map(nodeText).join("");
}

function filenameTitle(sourcePath: string): string {
  return path.posix
    .basename(sourcePath, ".md")
    .replace(/\s+[0-9a-f]{32}$/i, "")
    .trim();
}

/** Pulls a leading H1 into the separate Docs title field to avoid rendering it twice. */
export function extractPageDocument(
  sourcePath: string,
  markdown: string,
): ExtractedPageDocument {
  const tree = fromMarkdown(markdown) as MarkdownNode;
  const first = tree.children?.[0];
  const start = first?.position?.start.offset;
  const end = first?.position?.end.offset;
  if (
    first?.type === "heading" &&
    first.depth === 1 &&
    start !== undefined &&
    end !== undefined &&
    markdown.slice(0, start).trim() === ""
  ) {
    return {
      title: nodeText(first).trim() || filenameTitle(sourcePath),
      body: markdown.slice(end).replace(/^(?:\r?\n){1,2}/, ""),
    };
  }
  return { title: filenameTitle(sourcePath), body: markdown };
}

function walk(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function decodeLinkPath(rawUrl: string): string | null {
  const withoutFragment = rawUrl.split(/[?#]/, 1)[0];
  try {
    return decodeURIComponent(withoutFragment).normalize("NFC");
  } catch {
    return null;
  }
}

function resolveArchiveTarget(sourcePath: string, decodedUrl: string): string {
  const absolute = path.posix.resolve(
    "/",
    path.posix.dirname(sourcePath),
    decodedUrl,
  );
  return absolute.slice(1);
}

function notionIdFromMarkdownTarget(target: string): string | null {
  return (
    target.match(/(?:^|\s)([0-9a-f]{32})\.md$/i)?.[1]?.toLowerCase() ?? null
  );
}

function replaceLinkUrl(
  source: string,
  node: MarkdownNode,
  replacementUrl: string,
): Replacement | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  const rawUrl = node.url;
  if (start === undefined || end === undefined || rawUrl === undefined) {
    return null;
  }
  const linkSource = source.slice(start, end);
  const relativeStart = linkSource.indexOf(rawUrl);
  if (relativeStart < 0) return null;
  return {
    start: start + relativeStart,
    end: start + relativeStart + rawUrl.length,
    value: replacementUrl,
  };
}

function applyReplacements(
  source: string,
  replacements: Replacement[],
): string {
  let output = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    output =
      output.slice(0, replacement.start) +
      replacement.value +
      output.slice(replacement.end);
  }
  return output;
}

function protectMarkdownCode(source: string): {
  protectedSource: string;
  restore: (value: string) => string;
} {
  const tree = fromMarkdown(source) as MarkdownNode;
  const ranges: Array<{ start: number; end: number }> = [];
  walk(tree, (node) => {
    if (node.type !== "code" && node.type !== "inlineCode") return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) ranges.push({ start, end });
  });
  ranges.sort((a, b) => a.start - b.start);

  let prefix = "NOTION_IMPORT_PROTECTED_CODE_";
  while (source.includes(prefix)) prefix = `_${prefix}`;
  const replacements = ranges.map((range, index) => ({
    ...range,
    original: source.slice(range.start, range.end),
    token: `${prefix}${index}__`,
  }));
  const protectedSource = applyReplacements(
    source,
    replacements.map(({ start, end, token }) => ({ start, end, value: token })),
  );
  return {
    protectedSource,
    restore: (value) => {
      let restored = value;
      for (const replacement of replacements) {
        restored = restored.replace(
          replacement.token,
          () => replacement.original,
        );
      }
      return restored;
    },
  };
}

function expandNotionHtml(source: string): string {
  const protectedCode = protectMarkdownCode(source);
  const withoutAsides = protectedCode.protectedSource.replace(
    /<aside(?:\s[^>]*)?>([\s\S]*?)<\/aside>/gi,
    (_match, contents: string) =>
      contents
        .trim()
        .split(/\r?\n/)
        .map((line) => (line.length === 0 ? ">" : `> ${line}`))
        .join("\n"),
  );
  const expanded = withoutAsides.replace(
    /<details(?:\s[^>]*)?>([\s\S]*?)<\/details>/gi,
    (_match, contents: string) => {
      const summary = contents.match(
        /<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>/i,
      );
      const title = summary?.[1].trim() ?? "";
      const body = summary
        ? contents.replace(summary[0], "").trim()
        : contents.trim();
      return [title ? `**${title}**` : "", body].filter(Boolean).join("\n\n");
    },
  );
  return protectedCode.restore(expanded);
}

function isExternalUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//");
}

export function convertMarkdown({
  pageId,
  sourcePath,
  body,
  pageIdBySourcePath,
  pageIds,
  databaseBySourcePath,
  attachmentPaths,
}: {
  pageId: string;
  sourcePath: string;
  body: string;
  pageIdBySourcePath: Map<string, string>;
  pageIds: Set<string>;
  databaseBySourcePath: Map<string, ImportedDatabase>;
  attachmentPaths: Set<string>;
}): MarkdownConversion {
  // Notion wrappers contain real Markdown. Expand them first, while shielding
  // every parser-recognized code range, then parse again so links inside the
  // former wrapper take the same rewrite/counting path as ordinary links.
  const expandedBody = expandNotionHtml(body);
  const tree = fromMarkdown(expandedBody) as MarkdownNode;
  const replacements: Replacement[] = [];
  const unresolvedLinks: UnresolvedLink[] = [];
  let resolvedLinks = 0;
  let inlineDatabases = 0;
  let attachmentReferences = 0;
  let hasMultilineInlineDatabase = false;

  walk(tree, (node) => {
    if ((node.type !== "link" && node.type !== "image") || !node.url) return;
    const decoded = decodeLinkPath(node.url);
    if (decoded === null) {
      if (/\.(?:md|csv)(?:[?#]|$)/i.test(node.url)) {
        unresolvedLinks.push({
          pageId,
          targetId: null,
          reason: "invalid-encoding",
        });
      }
      return;
    }
    if (isExternalUrl(decoded)) return;
    const targetPath = resolveArchiveTarget(sourcePath, decoded);
    if (attachmentPaths.has(targetPath)) attachmentReferences += 1;
    if (node.type !== "link") return;

    if (/\.csv$/i.test(targetPath)) {
      const database = databaseBySourcePath.get(targetPath);
      if (!database) return;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      replacements.push({
        start,
        end,
        value: `\n\n${database.markdown}\n\n`,
      });
      inlineDatabases += 1;
      hasMultilineInlineDatabase ||= database.hasMultilineCells;
      return;
    }
    if (!/\.md$/i.test(targetPath)) return;

    const targetId =
      pageIdBySourcePath.get(targetPath) ??
      notionIdFromMarkdownTarget(targetPath);
    if (!targetId || !pageIds.has(targetId)) {
      unresolvedLinks.push({
        pageId,
        targetId,
        reason: "page-not-found",
      });
      return;
    }
    const replacement = replaceLinkUrl(
      expandedBody,
      node,
      `/#/docs/${targetId}`,
    );
    if (replacement) {
      replacements.push(replacement);
      resolvedLinks += 1;
    }
  });

  const converted = applyReplacements(expandedBody, replacements);
  const unsupportedSyntax = scanUnsupportedMarkdown(converted);
  if (hasMultilineInlineDatabase) unsupportedSyntax.push("CSV multiline cells");
  return {
    body: converted,
    resolvedLinks,
    inlineDatabases,
    attachmentReferences,
    unresolvedLinks,
    unsupportedSyntax,
  };
}
