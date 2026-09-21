import { BlockModel, BlockSchemaExtension, defineBlockSchema } from "@blocksuite/affine/store";
import { BlockComponent, BlockViewExtension } from "@blocksuite/affine/std";
import { BlockMarkdownAdapterExtension, type BlockMarkdownAdapterMatcher } from "@blocksuite/affine/shared/adapters";
import { html } from "lit";
import { literal } from "lit/static-html.js";

export const LINKED_DATABASE_FLAVOUR = "a2d2:linked-database";
import { linkedDatabaseReference, type LinkedDatabaseReference } from "./linkedDatabaseReference";
export { linkedDatabaseReference } from "./linkedDatabaseReference";
class LinkedDatabaseModel extends BlockModel<LinkedDatabaseReference> {}
const schema = defineBlockSchema({
  flavour: LINKED_DATABASE_FLAVOUR,
  props: () => ({ databaseId: "", viewId: null }) as LinkedDatabaseReference,
  metadata: { version: 1, role: "content", parent: ["affine:note"], children: [] },
  toModel: () => new LinkedDatabaseModel(),
});
class LinkedDatabaseBlock extends BlockComponent<LinkedDatabaseModel> {
  override renderBlock() {
    const reference = linkedDatabaseReference(this.model.props);
    return html`<div contenteditable="false" style="padding:12px;border:1px solid #8886;border-radius:8px;margin:8px 0">
      ${reference ? html`<button type="button" @click=${() => this.dispatchEvent(new CustomEvent("a2d2-open-linked-database", {
        bubbles: true, composed: true, detail: { blockId: this.model.id, ...reference },
      }))}>Open linked database</button>` : html`<span role="alert">Invalid database reference. This block cannot be edited.</span>`}
    </div>`;
  }
}
if (!customElements.get("a2d2-linked-database")) customElements.define("a2d2-linked-database", LinkedDatabaseBlock);
const markdown: BlockMarkdownAdapterMatcher = {
  flavour: LINKED_DATABASE_FLAVOUR,
  toMatch: () => false,
  fromMatch: ({ node }) => node.flavour === LINKED_DATABASE_FLAVOUR,
  toBlockSnapshot: {},
  fromBlockSnapshot: { enter: ({ node }, { walkerContext }) => {
    const reference = linkedDatabaseReference(node.props);
    if (!reference) throw Error("Invalid linked database reference.");
    walkerContext.openNode({ type: "paragraph", children: [{ type: "text", value: `:::db ${reference.databaseId}${reference.viewId ? ` ${reference.viewId}` : ""}` }] }, "children").closeNode();
    walkerContext.skipAllChildren();
  } },
};
export const linkedDatabaseStoreExtensions = [BlockSchemaExtension(schema), BlockMarkdownAdapterExtension(markdown)];
export const linkedDatabaseViewExtension = BlockViewExtension(LINKED_DATABASE_FLAVOUR, literal`a2d2-linked-database`);
