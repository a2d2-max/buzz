import {
  type DocDatabaseDirective,
  parseDocDatabaseDirectiveLine,
} from "./docDatabaseDirective.ts";

type PositionedNode = {
  children?: PositionedNode[];
  data?: Record<string, unknown>;
  position?: {
    start: { column: number; offset?: number };
    end: { column: number; offset?: number };
  };
  type: string;
  value?: string;
};

function completeColumnZeroParagraph(
  node: PositionedNode,
  source: string,
): string | null {
  const start = node.position?.start;
  const end = node.position?.end;
  if (
    start?.column !== 1 ||
    typeof start.offset !== "number" ||
    typeof end?.offset !== "number" ||
    (start.offset > 0 && source[start.offset - 1] !== "\n") ||
    (end.offset < source.length &&
      source[end.offset] !== "\n" &&
      source[end.offset] !== "\r")
  ) {
    return null;
  }
  return source.slice(start.offset, end.offset);
}

function databaseNode(directive: DocDatabaseDirective): PositionedNode {
  return {
    type: "doc-database-block",
    data: {
      hName: "doc-database-block",
      hProperties: {
        "data-database-id": directive.databaseId,
        ...(directive.viewId ? { "data-view-id": directive.viewId } : {}),
      },
    },
  };
}

function paragraphAfterOffset(
  node: PositionedNode,
  absoluteOffset: number,
): PositionedNode | null {
  const children = node.children ?? [];
  const remaining = children.flatMap((child) => {
    const start = child.position?.start.offset;
    const end = child.position?.end.offset;
    if (typeof start !== "number" || typeof end !== "number") return [];
    if (end <= absoluteOffset) return [];
    if (start >= absoluteOffset) return [child];
    if (child.type !== "text" || typeof child.value !== "string") return [];
    const value = child.value.slice(absoluteOffset - start);
    return value ? [{ ...child, value }] : [];
  });
  return remaining.length > 0 ? { ...node, children: remaining } : null;
}

function leadingDirectives(raw: string): {
  consumed: number;
  directives: DocDatabaseDirective[];
} {
  const directives: DocDatabaseDirective[] = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const newlineOffset = raw.slice(cursor).search(/[\r\n]/);
    const lineEnd = newlineOffset < 0 ? raw.length : cursor + newlineOffset;
    const directive = parseDocDatabaseDirectiveLine(raw.slice(cursor, lineEnd));
    if (!directive) break;
    directives.push(directive);
    if (lineEnd === raw.length) return { consumed: lineEnd, directives };
    cursor =
      raw[lineEnd] === "\r" && raw[lineEnd + 1] === "\n"
        ? lineEnd + 2
        : lineEnd + 1;
  }
  return { consumed: cursor, directives };
}

/** Docs-only remark transform for exact root-level database directive lines. */
export default function remarkDocDatabases() {
  return (tree: PositionedNode, file: { value?: unknown }) => {
    if (tree.type !== "root" || !Array.isArray(tree.children)) return;
    const source = typeof file.value === "string" ? file.value : "";
    tree.children = tree.children.flatMap((node) => {
      if (node.type !== "paragraph") return [node];
      const raw = completeColumnZeroParagraph(node, source);
      if (raw === null) return [node];
      const { consumed, directives } = leadingDirectives(raw);
      if (directives.length === 0) return [node];
      const nodeOffset = node.position?.start.offset;
      if (typeof nodeOffset !== "number") return [node];
      const remainder = paragraphAfterOffset(node, nodeOffset + consumed);
      return [
        ...directives.map(databaseNode),
        ...(remainder ? [remainder] : []),
      ];
    });
  };
}
