import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { verifyEvent } from "nostr-tools";

import {
  type DocPage,
  docPageContentEquals,
  parseDocPageEvent,
} from "../../src/features/docs/lib/docPageCodec.ts";
import { pickLatestDocPages } from "../../src/features/docs/lib/docTree.ts";
import type { BlobDescriptor } from "../../src/shared/api/tauri.ts";
import type { RelayEvent } from "../../src/shared/api/types.ts";
import {
  bindPublicationAssetUrls,
  type PublicationAssetBinding,
  validateUploadedPublicationAsset,
} from "./publicationBindings.ts";
import type {
  PrivatePublicationAssetManifest,
  PublicPublicationAssetManifest,
  PublicationUploadAsset,
} from "./publicationAssets.ts";
import {
  buildPublicationPreflight,
  type PublicationPreflight,
} from "./publicationPreflight.ts";
import type {
  ContentLimitProvenance,
  NotionImport,
  UnsignedDocEvent,
} from "./types.ts";

export type PublicationApi = {
  getCurrentRelay(): Promise<string>;
  getCurrentSignerPubkey(): Promise<string>;
  uploadAsset(asset: {
    localPath: string;
    sourceSha256: string;
    sourceBytes: number;
    mime: string;
  }): Promise<BlobDescriptor>;
  readAsset(binding: PublicationAssetBinding): Promise<Uint8Array>;
  queryDocVersions(pageId: string): Promise<RelayEvent[]>;
  signEvent(input: UnsignedDocEvent): Promise<RelayEvent>;
  publishEvent(event: RelayEvent): Promise<{
    eventId: string;
    accepted: boolean;
    message: string;
  }>;
  nowSeconds(): number;
};

export type PublicationExecutionAuthorization = {
  liveExecutionAuthorized: boolean;
  targetRelay: string;
  signerPubkey: string;
};

type AssetJournalEntry = {
  sourceSha256: string;
  sourceBytes: number;
  localPath: string;
  status: "failed" | "pending" | "readback" | "uploaded";
  attempts: number;
  descriptor: BlobDescriptor | null;
  uploadAccepted: boolean;
  readbackVerified: boolean;
  lastError: string | null;
};

type PageJournalEntry = {
  pageId: string;
  parentId: string | null;
  sourceContentSha256: string;
  finalContentSha256: string | null;
  status:
    | "accepted"
    | "conflict"
    | "failed"
    | "identical"
    | "pending"
    | "readback"
    | "signed";
  baseEventId: string | null;
  existingEventId: string | null;
  signedEventId: string | null;
  signedEventPath: string | null;
  relayAccepted: boolean;
  acceptanceMessage: string | null;
  readbackEventId: string | null;
  readbackVerified: boolean;
  attempts: number;
  lastError: string | null;
};

type JournalMeta = {
  version: 1;
  targetRelay: string;
  signerPubkey: string;
  sourceArchiveSha256: string;
  preparedCorpusSha256: string;
  complete: boolean;
  lastError: string | null;
  preflight: PublicationPreflight | null;
};

export type PublicationJournal = JournalMeta & {
  assets: Record<string, AssetJournalEntry>;
  pages: Record<string, PageJournalEntry>;
};

async function writeAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
  await rename(temporary, filePath);
}

function safeError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "publication-unknown-error";
  const code =
    message.match(/^[a-z0-9-]+/i)?.[0] ?? "publication-unknown-error";
  return code.slice(0, 120);
}

/** Small-file journal: page/signed-event records persist independently for bounded resume I/O. */
export class JsonPublicationJournalStore {
  readonly journalPath: string;
  private readonly dataDirectory: string;

  constructor(journalPath: string) {
    this.journalPath = path.resolve(journalPath);
    this.dataDirectory = `${this.journalPath}.d`;
  }

  private assetPath(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error("publication-journal-invalid-asset-hash");
    }
    return path.join(this.dataDirectory, "assets", `${hash}.json`);
  }

  private pagePath(pageId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(pageId)) {
      throw new Error("publication-journal-invalid-page-id");
    }
    return path.join(this.dataDirectory, "pages", `${pageId}.json`);
  }

  private signedEventPath(pageId: string): string {
    return path.join(this.dataDirectory, "signed-events", `${pageId}.json`);
  }

  async load(): Promise<PublicationJournal | null> {
    let meta: JournalMeta;
    try {
      meta = JSON.parse(
        await readFile(this.journalPath, "utf8"),
      ) as JournalMeta;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    }
    const assets: Record<string, AssetJournalEntry> = {};
    const pages: Record<string, PageJournalEntry> = {};
    for (const [directory, target] of [
      [path.join(this.dataDirectory, "assets"), assets],
      [path.join(this.dataDirectory, "pages"), pages],
    ] as const) {
      let names: string[] = [];
      try {
        names = await readdir(directory);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          throw error;
        }
      }
      for (const name of names
        .filter((candidate) => candidate.endsWith(".json"))
        .sort()) {
        const value = JSON.parse(
          await readFile(path.join(directory, name), "utf8"),
        ) as AssetJournalEntry | PageJournalEntry;
        target[name.slice(0, -5)] = value as never;
      }
    }
    return { ...meta, assets, pages };
  }

  async saveMeta(meta: JournalMeta): Promise<void> {
    await writeAtomic(this.journalPath, meta);
  }

  async saveAsset(entry: AssetJournalEntry): Promise<void> {
    await writeAtomic(this.assetPath(entry.sourceSha256), entry);
  }

  async savePage(entry: PageJournalEntry): Promise<void> {
    await writeAtomic(this.pagePath(entry.pageId), entry);
  }

  async saveSignedEvent(pageId: string, event: RelayEvent): Promise<string> {
    const eventPath = this.signedEventPath(pageId);
    await writeAtomic(eventPath, event);
    return eventPath;
  }

  async loadSignedEvent(pageId: string): Promise<RelayEvent> {
    return JSON.parse(
      await readFile(this.signedEventPath(pageId), "utf8"),
    ) as RelayEvent;
  }

  async withLock<T>(work: () => Promise<T>): Promise<T> {
    const lockPath = `${this.journalPath}.lock`;
    await mkdir(path.dirname(lockPath), { recursive: true });
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    for (let attempt = 0; attempt < 2 && handle === null; attempt += 1) {
      try {
        handle = await open(lockPath, "wx");
        await handle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
        ) {
          throw error;
        }
        let ownerAlive = true;
        try {
          const owner = JSON.parse(await readFile(lockPath, "utf8")) as {
            pid?: unknown;
          };
          if (
            typeof owner.pid !== "number" ||
            !Number.isSafeInteger(owner.pid)
          ) {
            ownerAlive = false;
          } else {
            process.kill(owner.pid, 0);
          }
        } catch (ownerError) {
          ownerAlive =
            ownerError instanceof Error &&
            "code" in ownerError &&
            ownerError.code !== "ESRCH" &&
            ownerError.code !== "ENOENT";
        }
        if (ownerAlive) throw new Error("publication-journal-locked");
        await unlink(lockPath).catch((unlinkError) => {
          if (
            !(
              unlinkError instanceof Error &&
              "code" in unlinkError &&
              unlinkError.code === "ENOENT"
            )
          ) {
            throw unlinkError;
          }
        });
      }
    }
    if (!handle) throw new Error("publication-journal-locked");
    try {
      return await work();
    } finally {
      await handle.close();
      await unlink(lockPath);
    }
  }
}

function normalizeRelay(relay: string): string {
  let parsed: URL;
  try {
    parsed = new URL(relay);
  } catch {
    throw new Error("publication-invalid-target-relay");
  }
  if (
    (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("publication-invalid-target-relay");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (
    parsed.protocol === "ws:" &&
    hostname !== "localhost" &&
    hostname !== "127.0.0.1" &&
    hostname !== "::1"
  ) {
    throw new Error("publication-insecure-target-relay");
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function assertContentLimitTarget(
  targetRelay: string,
  contentLimit: ContentLimitProvenance,
): void {
  if (
    !contentLimit.limitVerified ||
    !contentLimit.operationalAdvertisementConfirmed ||
    contentLimit.source !== "advertised"
  ) {
    throw new Error("publication-content-limit-unverified");
  }
  if (
    !Number.isSafeInteger(contentLimit.advertisedMaxContentBytes) ||
    (contentLimit.advertisedMaxContentBytes ?? 0) <= 0 ||
    contentLimit.effectiveMaxContentBytes !==
      contentLimit.advertisedMaxContentBytes ||
    (contentLimit.advertisedMaxMessageBytes !== undefined &&
      (!Number.isSafeInteger(contentLimit.advertisedMaxMessageBytes) ||
        contentLimit.advertisedMaxMessageBytes <
          contentLimit.effectiveMaxContentBytes)) ||
    contentLimit.reason !== "max-content-length-advertised" ||
    contentLimit.relayInfoHttpStatus !== 200 ||
    (contentLimit.relayInfoEndpoint === "/info"
      ? contentLimit.infoEndpointHttpStatus !== 200
      : ![404, 405, 501].includes(contentLimit.infoEndpointHttpStatus))
  ) {
    throw new Error("publication-content-limit-provenance-mismatch");
  }
  const expected = new URL(targetRelay);
  expected.protocol = expected.protocol === "wss:" ? "https:" : "http:";
  let actual: URL;
  try {
    actual = new URL(contentLimit.relayInfoUrl);
  } catch {
    throw new Error("publication-content-limit-target-mismatch");
  }
  if (
    actual.origin !== expected.origin ||
    actual.username !== "" ||
    actual.password !== "" ||
    actual.search !== "" ||
    actual.hash !== "" ||
    actual.pathname !== contentLimit.relayInfoEndpoint
  ) {
    throw new Error("publication-content-limit-target-mismatch");
  }
}

function hashPageCorpus(imported: NotionImport): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        imported.pages.map((page) => ({
          id: page.id,
          body: page.body,
          parentId: page.parentId,
          title: page.title,
          order: page.order,
          createdAt: page.createdAt,
          updatedAt: page.updatedAt,
        })),
      ),
    )
    .digest("hex");
}

function validateExecutionManifests(
  publicManifest: PublicPublicationAssetManifest,
  privateManifest: PrivatePublicationAssetManifest,
): void {
  if (
    !/^[0-9a-f]{64}$/.test(publicManifest.sourceArchiveSha256) ||
    publicManifest.sourceArchiveSha256 !== privateManifest.sourceArchiveSha256
  ) {
    throw new Error("publication-manifest-source-conflict");
  }
  if (
    publicManifest.uploadAssets.length !== publicManifest.combinedUniqueCount ||
    privateManifest.references.length !== publicManifest.totalReferenceCount
  ) {
    throw new Error("publication-manifest-denominator-conflict");
  }
  const uploadByHash = new Map<string, PublicationUploadAsset>();
  for (const asset of publicManifest.uploadAssets) {
    if (
      !/^[0-9a-f]{64}$/.test(asset.sourceSha256) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes <= 0 ||
      uploadByHash.has(asset.sourceSha256)
    ) {
      throw new Error("publication-manifest-upload-identity-conflict");
    }
    uploadByHash.set(asset.sourceSha256, asset);
  }
  const retainedHashes = new Set(
    privateManifest.binaryEntries.map((entry) => entry.sha256),
  );
  for (const reference of privateManifest.references) {
    retainedHashes.add(reference.sourceSha256);
  }
  if (
    retainedHashes.size !== uploadByHash.size ||
    [...retainedHashes].some((hash) => !uploadByHash.has(hash))
  ) {
    throw new Error("publication-manifest-retained-identity-conflict");
  }
}

async function hashLocalFile(
  filePath: string,
): Promise<{ bytes: number; sha256: string }> {
  const handle = await open(filePath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    for (;;) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
      hash.update(buffer.subarray(0, result.bytesRead));
    }
  } finally {
    await handle.close();
  }
  return { bytes, sha256: hash.digest("hex") };
}

function localAssetPath(
  asset: PublicationUploadAsset,
  manifest: PrivatePublicationAssetManifest,
  outputDirectory: string,
): string {
  const binary = manifest.binaryEntries.find(
    (entry) => entry.sha256 === asset.sourceSha256,
  );
  const relative =
    binary?.extractedRelativePath ??
    manifest.references
      .find(
        (reference) =>
          reference.sourceKind === "inline" &&
          reference.sourceSha256 === asset.sourceSha256,
      )
      ?.placeholder.match(
        /^\.\/(notion-inline-assets\/[0-9a-f]{64}\.[a-z]+)/,
      )?.[1];
  if (!relative) throw new Error("publication-local-asset-missing");
  const root = path.resolve(outputDirectory);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("publication-local-asset-path-escaped");
  }
  return resolved;
}

function latestPage(events: RelayEvent[], pageId: string): DocPage | undefined {
  const pages = validateQueriedEvents(events)
    .map((event) => parseDocPageEvent(event))
    .filter((page): page is DocPage => page !== null && page.id === pageId);
  return pickLatestDocPages(pages).get(pageId);
}

function validateQueriedEvents(events: RelayEvent[]): RelayEvent[] {
  for (const event of events) {
    try {
      if (!verifyEvent(event)) throw new Error("invalid");
    } catch {
      throw new Error("publication-query-invalid-event");
    }
  }
  return events;
}

function relayEventsEqual(left: RelayEvent, right: RelayEvent): boolean {
  return (
    left.id === right.id &&
    left.pubkey === right.pubkey &&
    left.created_at === right.created_at &&
    left.kind === right.kind &&
    left.content === right.content &&
    left.sig === right.sig &&
    JSON.stringify(left.tags) === JSON.stringify(right.tags)
  );
}

function desiredPage(imported: NotionImport, pageId: string) {
  const page = imported.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error("publication-page-missing");
  return {
    id: page.id,
    title: page.title,
    body: page.body,
    parentId: page.parentId,
    order: page.order,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}

function validateSignedEvent(
  event: RelayEvent,
  pageId: string,
  expectedPubkey: string,
  content: string,
): void {
  const decoded = parseDocPageEvent(event);
  if (
    !decoded ||
    decoded.id !== pageId ||
    event.pubkey !== expectedPubkey ||
    event.content !== content ||
    !/^[0-9a-f]{64}$/.test(event.id) ||
    !/^[0-9a-f]{128}$/.test(event.sig) ||
    !verifyEvent(event)
  ) {
    throw new Error("publication-signed-event-mismatch");
  }
}

/** Resumable upload, conflict preflight, sign, publish, acceptance, and readback. */
export async function executePublication({
  imported,
  publicManifest,
  privateManifest,
  outputDirectory,
  contentLimit,
  authorization,
  api,
  journalStore,
}: {
  imported: NotionImport;
  publicManifest: PublicPublicationAssetManifest;
  privateManifest: PrivatePublicationAssetManifest;
  outputDirectory: string;
  contentLimit: ContentLimitProvenance;
  authorization: PublicationExecutionAuthorization;
  api: PublicationApi;
  journalStore: JsonPublicationJournalStore;
}): Promise<PublicationJournal> {
  if (!authorization.liveExecutionAuthorized) {
    throw new Error("publication-live-execution-not-authorized");
  }
  const targetRelay = normalizeRelay(authorization.targetRelay);
  assertContentLimitTarget(targetRelay, contentLimit);
  validateExecutionManifests(publicManifest, privateManifest);
  if (!/^[0-9a-f]{64}$/.test(authorization.signerPubkey)) {
    throw new Error("publication-invalid-signer-pubkey");
  }
  return journalStore.withLock(async () => {
    if (normalizeRelay(await api.getCurrentRelay()) !== targetRelay) {
      throw new Error("publication-current-relay-mismatch");
    }
    if ((await api.getCurrentSignerPubkey()) !== authorization.signerPubkey) {
      throw new Error("publication-current-signer-mismatch");
    }

    const preparedCorpusSha256 = hashPageCorpus(imported);
    let journal = await journalStore.load();
    if (journal) {
      if (
        journal.targetRelay !== targetRelay ||
        journal.signerPubkey !== authorization.signerPubkey ||
        journal.sourceArchiveSha256 !== privateManifest.sourceArchiveSha256 ||
        journal.preparedCorpusSha256 !== preparedCorpusSha256
      ) {
        throw new Error("publication-journal-identity-conflict");
      }
    } else {
      journal = {
        version: 1,
        targetRelay,
        signerPubkey: authorization.signerPubkey,
        sourceArchiveSha256: privateManifest.sourceArchiveSha256,
        preparedCorpusSha256,
        complete: false,
        lastError: null,
        preflight: null,
        assets: {},
        pages: {},
      };
      await journalStore.saveMeta(journal);
    }
    journal.complete = false;
    journal.lastError = null;
    await journalStore.saveMeta(journal);

    for (const asset of publicManifest.uploadAssets) {
      const localPath = localAssetPath(asset, privateManifest, outputDirectory);
      const actual = await hashLocalFile(localPath);
      if (
        actual.bytes !== asset.bytes ||
        actual.sha256 !== asset.sourceSha256
      ) {
        throw new Error("publication-local-asset-hash-mismatch");
      }
      if (!journal.assets[asset.sourceSha256]) {
        journal.assets[asset.sourceSha256] = {
          sourceSha256: asset.sourceSha256,
          sourceBytes: asset.bytes,
          localPath,
          status: "pending",
          attempts: 0,
          descriptor: null,
          uploadAccepted: false,
          readbackVerified: false,
          lastError: null,
        };
        await journalStore.saveAsset(journal.assets[asset.sourceSha256]);
      } else {
        const existing = journal.assets[asset.sourceSha256];
        if (
          existing.sourceSha256 !== asset.sourceSha256 ||
          existing.sourceBytes !== asset.bytes ||
          existing.localPath !== localPath
        ) {
          throw new Error("publication-journal-asset-conflict");
        }
      }
    }
    for (const page of imported.pages) {
      const sourceContentSha256 = createHash("sha256")
        .update(page.body)
        .digest("hex");
      if (!journal.pages[page.id]) {
        journal.pages[page.id] = {
          pageId: page.id,
          parentId: page.parentId,
          sourceContentSha256,
          finalContentSha256: null,
          status: "pending",
          baseEventId: null,
          existingEventId: null,
          signedEventId: null,
          signedEventPath: null,
          relayAccepted: false,
          acceptanceMessage: null,
          readbackEventId: null,
          readbackVerified: false,
          attempts: 0,
          lastError: null,
        };
        await journalStore.savePage(journal.pages[page.id]);
      } else {
        const existing = journal.pages[page.id];
        if (
          existing.pageId !== page.id ||
          existing.parentId !== page.parentId ||
          existing.sourceContentSha256 !== sourceContentSha256
        ) {
          throw new Error("publication-journal-page-conflict");
        }
      }
    }

    for (const asset of publicManifest.uploadAssets) {
      const entry = journal.assets[asset.sourceSha256];
      if (entry.readbackVerified && entry.descriptor) continue;
      entry.attempts += 1;
      entry.lastError = null;
      try {
        if (!entry.descriptor) {
          entry.descriptor = await api.uploadAsset({
            localPath: entry.localPath,
            sourceSha256: entry.sourceSha256,
            sourceBytes: entry.sourceBytes,
            mime: asset.mime,
          });
          entry.status = "uploaded";
          entry.uploadAccepted = true;
          await journalStore.saveAsset(entry);
        }
        const pendingBinding = {
          sourceSha256: entry.sourceSha256,
          sourceBytes: entry.sourceBytes,
          remoteSha256: entry.descriptor.sha256,
          remoteBytes: entry.descriptor.size,
          mime: entry.descriptor.type,
          url: entry.descriptor.url,
          uploadAccepted: true,
          readbackVerified: false,
        } satisfies PublicationAssetBinding;
        validateUploadedPublicationAsset({
          binding: pendingBinding,
          expected: asset,
          targetRelay,
        });
        const readback = await api.readAsset(pendingBinding);
        const readbackHash = createHash("sha256")
          .update(readback)
          .digest("hex");
        if (
          readback.length !== entry.descriptor.size ||
          readbackHash !== entry.descriptor.sha256
        ) {
          throw new Error("publication-asset-readback-mismatch");
        }
        entry.status = "readback";
        entry.readbackVerified = true;
        await journalStore.saveAsset(entry);
      } catch (error) {
        entry.status = "failed";
        entry.lastError = safeError(error);
        await journalStore.saveAsset(entry);
        journal.lastError = entry.lastError;
        await journalStore.saveMeta(journal);
        throw error;
      }
    }

    const productionBindings = {
      version: 1 as const,
      mode: "production" as const,
      targetRelay,
      assets: publicManifest.uploadAssets.map((asset) => {
        const entry = journal.assets[asset.sourceSha256];
        if (!entry.descriptor || !entry.readbackVerified) {
          throw new Error("publication-upload-journal-incomplete");
        }
        return {
          sourceSha256: entry.sourceSha256,
          sourceBytes: entry.sourceBytes,
          remoteSha256: entry.descriptor.sha256,
          remoteBytes: entry.descriptor.size,
          mime: entry.descriptor.type,
          url: entry.descriptor.url,
          uploadAccepted: entry.uploadAccepted,
          readbackVerified: entry.readbackVerified,
        };
      }),
    };
    const bound = bindPublicationAssetUrls({
      imported,
      privateManifest,
      publicManifest,
      bindings: productionBindings,
    });
    const preflight = buildPublicationPreflight({
      imported: bound.imported,
      bindingStatus: bound.status,
      contentLimit,
    });
    journal.preflight = preflight;
    journal.lastError = preflight.readyForSigning
      ? null
      : "publication-preflight-failed";
    await journalStore.saveMeta(journal);
    if (!preflight.readyForSigning)
      throw new Error("publication-preflight-failed");

    const eventByPage = new Map(
      preflight.events.map((event) => [event.pageId, event]),
    );
    let hasConflict = false;
    for (const page of bound.imported.pages) {
      const entry = journal.pages[page.id];
      const planned = eventByPage.get(page.id);
      if (!planned) throw new Error("publication-preflight-event-missing");
      entry.finalContentSha256 = createHash("sha256")
        .update(planned.unsignedEvent.content)
        .digest("hex");
      const newest = latestPage(await api.queryDocVersions(page.id), page.id);
      entry.baseEventId = newest?.eventId ?? null;
      if (newest && entry.signedEventId === newest.eventId) {
        entry.status = "readback";
        entry.existingEventId = newest.eventId;
        entry.relayAccepted = true;
        entry.readbackEventId = newest.eventId;
        entry.readbackVerified = true;
      } else if (
        newest &&
        docPageContentEquals(newest, desiredPage(bound.imported, page.id))
      ) {
        entry.status = "identical";
        entry.existingEventId = newest.eventId;
        entry.readbackEventId = newest.eventId;
        entry.readbackVerified = true;
      } else if (newest) {
        entry.status = "conflict";
        entry.existingEventId = newest.eventId;
        entry.lastError = "publication-page-conflict";
        hasConflict = true;
      }
      await journalStore.savePage(entry);
    }
    if (hasConflict) {
      journal.lastError = "publication-page-conflict";
      await journalStore.saveMeta(journal);
      throw new Error("publication-page-conflict");
    }

    for (const page of bound.imported.pages) {
      const entry = journal.pages[page.id];
      if (entry.status === "identical" || entry.readbackVerified) continue;
      const planned = eventByPage.get(page.id);
      if (!planned) throw new Error("publication-preflight-event-missing");
      const newest = latestPage(await api.queryDocVersions(page.id), page.id);
      if (newest) {
        if (entry.signedEventId === newest.eventId) {
          entry.status = "readback";
          entry.relayAccepted = true;
          entry.readbackVerified = true;
          entry.readbackEventId = newest.eventId;
          await journalStore.savePage(entry);
          continue;
        }
        if (
          docPageContentEquals(newest, desiredPage(bound.imported, page.id))
        ) {
          entry.status = "identical";
          entry.existingEventId = newest.eventId;
          entry.readbackVerified = true;
          entry.readbackEventId = newest.eventId;
          await journalStore.savePage(entry);
          continue;
        }
        entry.status = "conflict";
        entry.lastError = "publication-page-conflict";
        await journalStore.savePage(entry);
        throw new Error("publication-page-conflict");
      }

      let signedEvent: RelayEvent;
      if (entry.signedEventId) {
        signedEvent = await journalStore.loadSignedEvent(page.id);
      } else {
        signedEvent = await api.signEvent({
          ...planned.unsignedEvent,
          createdAt: api.nowSeconds(),
        });
        validateSignedEvent(
          signedEvent,
          page.id,
          authorization.signerPubkey,
          planned.unsignedEvent.content,
        );
        entry.signedEventId = signedEvent.id;
        entry.signedEventPath = await journalStore.saveSignedEvent(
          page.id,
          signedEvent,
        );
        entry.status = "signed";
        await journalStore.savePage(entry);
      }
      validateSignedEvent(
        signedEvent,
        page.id,
        authorization.signerPubkey,
        planned.unsignedEvent.content,
      );
      entry.attempts += 1;
      try {
        const acceptance = await api.publishEvent(signedEvent);
        if (!acceptance.accepted || acceptance.eventId !== signedEvent.id) {
          throw new Error("publication-relay-rejected");
        }
        entry.status = "accepted";
        entry.relayAccepted = true;
        // Operator-controlled relay text is not part of the durable proof.
        // Persist the acceptance bit and event ID from the signed event only.
        entry.acceptanceMessage = null;
        await journalStore.savePage(entry);
        const readback = validateQueriedEvents(
          await api.queryDocVersions(page.id),
        );
        const stored = readback.find((event) => event.id === signedEvent.id);
        if (!stored || !relayEventsEqual(stored, signedEvent)) {
          throw new Error("publication-event-readback-missing");
        }
        entry.status = "readback";
        entry.readbackEventId = stored.id;
        entry.readbackVerified = true;
        entry.lastError = null;
        await journalStore.savePage(entry);
      } catch (error) {
        entry.status = "failed";
        entry.lastError = safeError(error);
        await journalStore.savePage(entry);
        journal.lastError = entry.lastError;
        await journalStore.saveMeta(journal);
        throw error;
      }
    }

    journal.complete =
      Object.values(journal.assets).every(
        (asset) => asset.uploadAccepted && asset.readbackVerified,
      ) &&
      Object.values(journal.pages).every(
        (page) => page.status === "identical" || page.readbackVerified,
      );
    journal.lastError = journal.complete ? null : "publication-incomplete";
    await journalStore.saveMeta(journal);
    return journal;
  });
}
