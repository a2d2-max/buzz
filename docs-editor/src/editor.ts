import { upgradeLinkedDatabaseBlocks } from "./linkedDatabaseReference";
import { LINKED_DATABASE_FLAVOUR, linkedDatabaseReference, linkedDatabaseStoreExtensions, linkedDatabaseViewExtension } from "./linkedDatabase";
import "@blocksuite/affine/effects";
import "@blocksuite/affine/global/types";
import { RootBlockModel } from "@blocksuite/affine/model";
import "@toeverything/theme/style.css";
import {
  StoreExtensionManager,
  ViewExtensionManager,
} from "@blocksuite/affine/ext-loader";
import { getInternalStoreExtensions } from "@blocksuite/affine/extensions/store";
import { getInternalViewExtensions } from "@blocksuite/affine/extensions/view";
import { BlockStdScope } from "@blocksuite/affine/std";
import { MarkdownAdapter } from "@blocksuite/affine/shared/adapters";
import { Text, type Store } from "@blocksuite/affine/store";
import { html, render } from "lit";
import { EditorWorkspace } from "./runtime";
import { restoreSnapshot, saveSnapshot } from "./snapshot";

export type EditorInput = {
  id: string;
  title: string;
  body: string;
  affine?: { version: number; data: string };
};
/** Mount a local editor. The caller owns saving, identity and conflict resolution. */
export async function mountEditor(
  element: HTMLElement,
  input: EditorInput,
  changed: () => void,
) {
  const workspace = new EditorWorkspace(input.id);
  workspace.storeExtensions = [...new StoreExtensionManager(
    getInternalStoreExtensions(),
  ).get("store"), ...linkedDatabaseStoreExtensions];
  const views = new ViewExtensionManager(getInternalViewExtensions());
  let store: Store;
  try {
    if (input.affine) {
      store = (await restoreSnapshot(workspace, input.affine)).getStore();
    } else {
      const doc = workspace.createDoc(input.id);
      store = doc.getStore();
      doc.load();
      const job = store.getTransformer();
      try {
        const adapter = new MarkdownAdapter(job, store.provider);
        const snapshot = await adapter.toDocSnapshot({ file: input.body });
        upgradeLinkedDatabaseBlocks(snapshot.blocks, () => crypto.randomUUID());
        snapshot.blocks.props.title = {
          "$blocksuite:internal:text$": true,
          delta: [{ insert: input.title }],
        };
        await job.snapshotToBlock(snapshot.blocks, store);
        if (!store.root) throw Error("Unable to import this document.");
      } finally {
        job[Symbol.dispose]();
      }
    }
    if (!store.root || store.root.flavour !== "affine:page")
      throw Error("Unsupported document root.");
    let disposed = false;
    let revision = 0;
    let mode: "page" | "edgeless" = "page";
    const draw = () => {
      render(null, element);
      const scope = new BlockStdScope({ store, extensions: [...views.get(mode), linkedDatabaseViewExtension] });
      render(
        html`<div class=${mode === "page" ? "affine-page-viewport" : "affine-edgeless-viewport"}>
        ${mode === "page" ? html`<doc-title .doc=${store}></doc-title>` : ""}
        <div class=${mode === "page" ? "page-editor" : "edgeless-editor-container"}>${scope.render()}</div>
      </div>`,
        element,
      );
    };
    draw();
    const subscription = workspace.changed.subscribe(() => {
      revision++;
      changed();
    });
    return {
      workspace,
      store,
      attachDatabase(value: unknown) {
        const reference = linkedDatabaseReference(value);
        if (disposed || !reference || store.readonly) throw Error("Cannot link this database.");
        const note = store.root?.children.find(block => block.flavour === "affine:note");
        if (!note) throw Error("This document has no editable note.");
        store.addBlock(LINKED_DATABASE_FLAVOUR, reference, note);
      },
      selectDatabaseView(blockId: string, value: unknown) {
        const reference = linkedDatabaseReference(value);
        const model = store.getBlock(blockId)?.model;
        if (disposed || store.readonly || !reference || model?.flavour !== LINKED_DATABASE_FLAVOUR || linkedDatabaseReference(model.props)?.databaseId !== reference.databaseId)
          throw Error("The linked database block changed. Reopen it before editing.");
        store.updateBlock(model, reference);
      },
      recoverySnapshot() {
        const root = store.root;
        if (!(root instanceof RootBlockModel))
          throw Error("Unsupported document root.");
        const title = root.props.title;
        if (!(title instanceof Text))
          throw Error("Unsupported document title.");
        return {
          title: title.toString(),
          body: input.body,
          affine: saveSnapshot(workspace, store.id),
        };
      },
      setMode(next: "page" | "edgeless") {
        if (disposed) return;
        mode = next;
        draw();
      },
      async snapshot() {
        if (disposed) throw Error("Editor is closed.");
        for (let attempt = 0; attempt < 3; attempt++) {
          const before = revision;
          const job = store.getTransformer();
          try {
            const adapter = new MarkdownAdapter(job, store.provider);
            const snapshot = job.docToSnapshot(store);
            if (!snapshot)
              throw Error("Unable to export the document preview.");
            const result = await adapter.fromDocSnapshot({
              snapshot,
              assets: job.assetsManager,
            });
            const affine = await saveSnapshot(workspace, store.id);
            if (before !== revision) continue;
            const root = store.root;
            if (!(root instanceof RootBlockModel))
              throw Error("Unsupported document root.");
            const title = root.props.title;
            if (!(title instanceof Text))
              throw Error("Unsupported document title.");
            return { title: title.toString(), body: result.file, affine };
          } finally {
            job[Symbol.dispose]();
          }
        }
        throw Error("The document changed during saving. Please retry.");
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        subscription.unsubscribe();
        render(null, element);
        workspace.dispose();
      },
    };
  } catch (error) {
    render(null, element);
    workspace.dispose();
    throw error;
  }
}
