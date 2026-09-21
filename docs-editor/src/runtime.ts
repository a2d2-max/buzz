import {
  StoreContainer,
  AwarenessStore,
  createYProxy,
  nanoid,
  type Doc,
  type Workspace,
  type WorkspaceMeta,
  type DocMeta,
  type DocsPropertiesMeta,
  type ExtensionType,
  type GetStoreOptions,
  type RemoveStoreOptions,
  type Store,
  type YBlock,
} from "@blocksuite/affine/store";
import { BlobEngine, MemoryBlobSource } from "@blocksuite/affine/sync";
import { NoopLogger } from "@blocksuite/affine/global/utils";
import { Subject } from "rxjs";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

/** Cache asset bytes before making them available to a block, so recovery is synchronous. */
class RecoveryBlobSource extends MemoryBlobSource {
  readonly encoded = new Map<
    string,
    { id: string; type: string; data: string }
  >();
  override async set(id: string, blob: Blob) {
    if (blob.size > 16 * 1024 * 1024)
      throw Error("Attachment exceeds this document’s storage limit.");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const data = btoa(
      Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
    );
    this.encoded.set(id, { id, type: blob.type, data });
    return super.set(id, blob);
  }
  override delete(id: string) {
    this.encoded.delete(id);
    return super.delete(id);
  }
}

/** One mounted a2d2 document owns this runtime, including its nested documents. */
export class EditorWorkspace implements Workspace {
  readonly doc: Y.Doc;
  readonly docs = new Map<string, EditorDocument>();
  readonly slots = { docListUpdated: new Subject<void>() };
  readonly changed = new Subject<void>();
  readonly idGenerator = nanoid;
  readonly blobs = new RecoveryBlobSource();
  readonly blobSync = new BlobEngine(this.blobs, [], new NoopLogger());
  readonly awarenessStore: AwarenessStore;
  readonly meta: EditorMetadata;
  storeExtensions: ExtensionType[] = [];
  private disposed = false;
  private readonly onChange = () => this.changed.next();

  constructor(readonly id: string) {
    this.doc = new Y.Doc({ guid: id });
    this.awarenessStore = new AwarenessStore(new Awareness(this.doc));
    this.meta = new EditorMetadata(this.doc);
    this.doc.on("update", this.onChange);
    this.blobSync.start();
  }
  createDoc(id = nanoid()): EditorDocument {
    if (this.disposed) throw Error("workspace-disposed");
    if (this.docs.has(id)) throw Error("duplicate-document");
    if (this.docs.size >= 1000) throw Error("document-limit");
    this.meta.initialize();
    const doc = new EditorDocument(id, this);
    this.docs.set(id, doc);
    if (!this.meta.getDocMeta(id)) {
      this.meta.addDocMeta({ id, title: "", tags: [], createDate: Date.now() });
    }
    this.slots.docListUpdated.next();
    this.onChange();
    return doc;
  }
  getDoc(id: string) {
    return this.docs.get(id) ?? null;
  }
  removeDoc(id: string) {
    const doc = this.docs.get(id);
    if (!doc) return;
    this.docs.delete(id);
    this.meta.removeDocMeta(id);
    doc.dispose();
    this.doc.getMap("spaces").delete(id);
    this.slots.docListUpdated.next();
    this.onChange();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const doc of this.docs.values()) doc.dispose();
    this.docs.clear();
    this.blobSync.stop();
    this.awarenessStore.destroy();
    this.meta.dispose();
    this.slots.docListUpdated.complete();
    this.changed.complete();
    this.doc.off("update", this.onChange);
    this.doc.destroy();
  }
}

export class EditorDocument implements Doc {
  readonly spaceDoc: Y.Doc;
  readonly rootDoc: Y.Doc;
  readonly yBlocks: Y.Map<YBlock>;
  readonly awarenessStore: AwarenessStore;
  private readonly stores: StoreContainer;
  private readonly ownedStores = new Set<Store>();
  private readyValue = false;
  private disposed = false;
  private readonly onChange = () => this.workspace.changed.next();
  constructor(
    readonly id: string,
    readonly workspace: EditorWorkspace,
  ) {
    this.rootDoc = workspace.doc;
    const spaces = this.rootDoc.getMap<Y.Doc>("spaces");
    this.spaceDoc = spaces.get(id) ?? new Y.Doc({ guid: id });
    if (!spaces.has(id)) spaces.set(id, this.spaceDoc);
    this.yBlocks = this.spaceDoc.getMap<YBlock>("blocks");
    this.awarenessStore = workspace.awarenessStore;
    this.stores = new StoreContainer(this);
    this.spaceDoc.on("update", this.onChange);
  }
  get meta() {
    return this.workspace.meta.getDocMeta(this.id);
  }
  get ready() {
    return this.readyValue;
  }
  get loaded() {
    return this.readyValue && !this.disposed;
  }
  getStore(options: GetStoreOptions = {}): Store {
    if (this.disposed) throw Error("document-disposed");
    const store = this.stores.getStore({
      ...options,
      id: options.id ?? this.id,
      extensions: [
        ...this.workspace.storeExtensions,
        ...(options.extensions ?? []),
      ],
    });
    this.ownedStores.add(store);
    return store;
  }
  removeStore(options: RemoveStoreOptions) {
    // Existing hosts can still hold this store; dispose all owned stores when
    // the document unmounts, after those hosts have been disconnected.
    this.stores.removeStore(options);
  }
  load(initialize?: () => void) {
    if (this.disposed) throw Error("document-disposed");
    if (this.readyValue) return;
    initialize?.();
    this.readyValue = true;
  }
  clear() {
    if (this.disposed) throw Error("document-disposed");
    this.spaceDoc.transact(() => this.yBlocks.clear());
  }
  remove() {
    this.workspace.removeDoc(this.id);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const store of this.ownedStores) store.dispose();
    this.ownedStores.clear();
    this.spaceDoc.off("update", this.onChange);
    this.spaceDoc.destroy();
  }
}

class EditorMetadata implements WorkspaceMeta {
  readonly docMetaAdded = new Subject<string>();
  readonly docMetaRemoved = new Subject<string>();
  readonly docMetaUpdated = new Subject<void>();
  private readonly data: { pages: DocMeta[]; properties?: DocsPropertiesMeta };
  private readonly map: Y.Map<unknown>;
  private readonly changed = () => this.docMetaUpdated.next();
  constructor(private readonly doc: Y.Doc) {
    this.map = doc.getMap("metadata");
    this.data = createYProxy(this.map) as unknown as typeof this.data;
    this.map.observeDeep(this.changed);
  }
  initialize() {
    if (!this.data.pages) this.data.pages = [];
  }
  get docMetas() {
    return this.data.pages ?? [];
  }
  get docs() {
    return this.docMetas;
  }
  get properties() {
    return this.data.properties ?? { tags: { options: [] } };
  }
  setProperties(value: DocsPropertiesMeta) {
    this.data.properties = value;
  }
  getDocMeta(id: string) {
    return this.docMetas.find((doc) => doc.id === id);
  }
  addDocMeta(value: DocMeta, index = this.docMetas.length) {
    if (this.getDocMeta(value.id)) throw Error("duplicate-metadata");
    this.doc.transact(() => this.docMetas.splice(index, 0, value));
    this.docMetaAdded.next(value.id);
  }
  setDocMeta(id: string, value: Partial<DocMeta>) {
    const meta = this.getDocMeta(id);
    if (!meta) throw Error("missing-metadata");
    if (value.id !== undefined && value.id !== id)
      throw Error("immutable-document-id");
    this.doc.transact(() => Object.assign(meta, value));
  }
  removeDocMeta(id: string) {
    const index = this.docMetas.findIndex((doc) => doc.id === id);
    if (index < 0) return;
    this.doc.transact(() => this.docMetas.splice(index, 1));
    this.docMetaRemoved.next(id);
  }
  dispose() {
    this.map.unobserveDeep(this.changed);
    this.docMetaAdded.complete();
    this.docMetaRemoved.complete();
    this.docMetaUpdated.complete();
  }
}
