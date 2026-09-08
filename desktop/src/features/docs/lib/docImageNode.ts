import { mergeAttributes, Node } from "@tiptap/core";

type MarkdownSerializerStateLike = {
  write: (text: string) => void;
  closeBlock: (node: unknown) => void;
};

/**
 * Block-level image node for document editing.
 *
 * `@tiptap/extension-image` is not a dependency and the chat composer has no
 * image node, so without this an `![alt](url)` in a page body would be parsed
 * by markdown-it into `<img>` and then silently dropped by the editor schema —
 * the next autosave would delete the image. markdown-it handles the parse
 * side; this node accepts the `<img>` and serializes it back to markdown.
 */
export const DocImageNode = Node.create({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "img[src]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "img",
      mergeAttributes(
        {
          class: "my-2 block max-w-full rounded-lg",
          draggable: "false",
          loading: "lazy",
        },
        HTMLAttributes,
      ),
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize(
          state: MarkdownSerializerStateLike,
          node: { attrs: Record<string, unknown> },
        ) {
          const alt = String(node.attrs.alt ?? "").replace(/[[\]]/g, "\\$&");
          const src = String(node.attrs.src ?? "").replace(/[()]/g, "\\$&");
          const rawTitle = node.attrs.title;
          const title =
            typeof rawTitle === "string" && rawTitle.length > 0
              ? ` "${rawTitle.replace(/"/g, '\\"')}"`
              : "";
          state.write(`![${alt}](${src}${title})`);
          state.closeBlock(node);
        },
        parse: {
          // markdown-it turns `![alt](src)` into <img>; parseHTML picks it up.
        },
      },
    };
  },
});
