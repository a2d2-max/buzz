import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";

import { DocDatabaseNodeView } from "../ui/DocDatabaseNodeView";
import {
  parseDocDatabaseDirectiveLine,
  serializeDocDatabaseDirective,
} from "./docDatabaseDirective";

export const DOC_DATABASE_NODE_NAME = "databaseBlock";
const MARKDOWN_RULE_NAME = "buzz_doc_database";
const MARKDOWN_TOKEN_TYPE = "buzz_doc_database";

type MarkdownSerializerStateLike = {
  write: (text: string) => void;
  closeBlock: (node: unknown) => void;
};

/** Registers the exact standalone directive as one markdown-it block token. */
export function registerDocDatabaseMarkdownIt(
  // biome-ignore lint/suspicious/noExplicitAny: markdown-it is untyped here
  md: any,
): void {
  if (md.renderer.rules[MARKDOWN_TOKEN_TYPE]) return;
  const rule = (
    // biome-ignore lint/suspicious/noExplicitAny: markdown-it block state is untyped
    state: any,
    startLine: number,
    _endLine: number,
    silent: boolean,
  ): boolean => {
    if (state.tShift[startLine] !== 0) return false;
    const start = state.bMarks[startLine];
    const end = state.eMarks[startLine];
    const directive = parseDocDatabaseDirectiveLine(
      state.src.slice(start, end),
    );
    if (!directive) return false;
    if (!silent) {
      const token = state.push(MARKDOWN_TOKEN_TYPE, "div", 0);
      token.block = true;
      token.map = [startLine, startLine + 1];
      token.meta = directive;
    }
    state.line = startLine + 1;
    return true;
  };
  md.block.ruler.before("paragraph", MARKDOWN_RULE_NAME, rule);
  // biome-ignore lint/suspicious/noExplicitAny: markdown-it token is untyped
  md.renderer.rules[MARKDOWN_TOKEN_TYPE] = (tokens: any[], index: number) => {
    const directive = tokens[index].meta as {
      databaseId: string;
      viewId: string | null;
    };
    const escapeHtml = md.utils.escapeHtml;
    return `<div data-doc-database-block data-database-id="${escapeHtml(directive.databaseId)}"${directive.viewId ? ` data-view-id="${escapeHtml(directive.viewId)}"` : ""}></div>`;
  };
}

function parsedMarker(element: HTMLElement) {
  const databaseId = element.getAttribute("data-database-id") ?? "";
  const viewId = element.getAttribute("data-view-id");
  const parsed = parseDocDatabaseDirectiveLine(
    `:::db ${databaseId}${viewId ? ` ${viewId}` : ""}`,
  );
  return parsed
    ? { databaseId: parsed.databaseId, viewId: parsed.viewId }
    : false;
}

/** Docs-only block atom that owns the Markdown reference, never database state. */
export const DocDatabaseNode = Node.create({
  name: DOC_DATABASE_NODE_NAME,
  group: "block",
  atom: true,
  isolating: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      databaseId: { default: null },
      viewId: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-doc-database-block]",
        getAttrs: (element) => parsedMarker(element as HTMLElement),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const directive = parseDocDatabaseDirectiveLine(
      `:::db ${String(node.attrs.databaseId ?? "")}${typeof node.attrs.viewId === "string" ? ` ${node.attrs.viewId}` : ""}`,
    );
    if (!directive) throw new Error("Invalid Docs database node attributes.");
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-doc-database-block": "",
        "data-database-id": directive.databaseId,
        ...(directive.viewId ? { "data-view-id": directive.viewId } : {}),
      }),
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(
          state: MarkdownSerializerStateLike,
          node: { attrs: { databaseId: string; viewId: string | null } },
        ) {
          state.write(serializeDocDatabaseDirective(node.attrs));
          state.closeBlock(node);
        },
        parse: {
          // biome-ignore lint/suspicious/noExplicitAny: markdown-it is untyped
          setup(md: any) {
            registerDocDatabaseMarkdownIt(md);
          },
        },
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(DocDatabaseNodeView, {
      ignoreMutation: () => true,
      stopEvent: () => true,
    });
  },
});
