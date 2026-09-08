import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { finalizeEvent, getPublicKey } from "nostr-tools";

import {
  JsonPublicationJournalStore,
  executePublication,
} from "./publicationExecutor.ts";

const FIXTURE_ONLY_SECRET_KEY = new Uint8Array(32).fill(7);
const FIXTURE_ONLY_PUBKEY = getPublicKey(FIXTURE_ONLY_SECRET_KEY);
const ROOT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHILD_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const servers = new Set();
const scratches = new Set();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function relayFixture() {
  const state = {
    assets: new Map(),
    events: new Map(),
    uploadCalls: 0,
    readCalls: 0,
    publishCalls: 0,
    queryCalls: 0,
    failUploadCount: 0,
    failPublishAt: null,
    falseSuccess: false,
    corruptReadback: false,
  };
  const server = createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.method === "PUT" && request.url === "/upload") {
      state.uploadCalls += 1;
      const body = await readRequest(request);
      if (state.failUploadCount > 0) {
        state.failUploadCount -= 1;
        response.writeHead(500).end("upload failed");
        return;
      }
      const hash = sha256(body);
      state.assets.set(hash, body);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          url: `${origin}/media/${hash}.bin`,
          sha256: hash,
          size: body.length,
          type: "application/octet-stream",
          uploaded: 1,
        }),
      );
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/media/")) {
      const hash = request.url.slice("/media/".length).split(".", 1)[0];
      const body = state.assets.get(hash);
      if (!body) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200).end(body);
      return;
    }
    if (request.method === "POST" && request.url === "/events") {
      state.publishCalls += 1;
      const event = JSON.parse((await readRequest(request)).toString("utf8"));
      if (state.failPublishAt === state.publishCalls) {
        response.writeHead(503).end("interrupted");
        return;
      }
      if (!state.falseSuccess) {
        const d = event.tags.find((tag) => tag[0] === "d")?.[1];
        const versions = state.events.get(d) ?? [];
        versions.push(event);
        state.events.set(d, versions);
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ eventId: event.id, accepted: true, message: "" }),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/query") {
      state.queryCalls += 1;
      const filter = JSON.parse((await readRequest(request)).toString("utf8"));
      const d = filter["#d"]?.[0];
      response.writeHead(200, { "Content-Type": "application/json" });
      const events = state.events.get(d) ?? [];
      const responseEvents =
        state.corruptReadback && state.publishCalls > 0
          ? events.map((event) => ({ ...event, sig: "0".repeat(128) }))
          : events;
      response.end(JSON.stringify(responseEvents));
      return;
    }
    response.writeHead(404).end();
  });
  servers.add(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const httpOrigin = `http://127.0.0.1:${address.port}`;
  const relay = `ws://127.0.0.1:${address.port}`;
  let signCalls = 0;
  return {
    relay,
    state,
    get signCalls() {
      return signCalls;
    },
    api: {
      async getCurrentRelay() {
        return relay;
      },
      async getCurrentSignerPubkey() {
        return FIXTURE_ONLY_PUBKEY;
      },
      async uploadAsset(asset) {
        const body = await readFile(asset.localPath);
        const response = await fetch(`${httpOrigin}/upload`, {
          method: "PUT",
          body,
        });
        if (!response.ok) throw new Error(`upload-http-${response.status}`);
        return response.json();
      },
      async readAsset(binding) {
        state.readCalls += 1;
        const response = await fetch(binding.url);
        if (!response.ok) throw new Error(`asset-read-http-${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      },
      async queryDocVersions(pageId) {
        const response = await fetch(`${httpOrigin}/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kinds: [30623, 30078],
            "#d": [`doc:${pageId}`],
            limit: 100,
          }),
        });
        return response.json();
      },
      async signEvent(input) {
        signCalls += 1;
        return finalizeEvent(
          {
            kind: input.kind,
            tags: input.tags,
            content: input.content,
            created_at: input.createdAt,
          },
          FIXTURE_ONLY_SECRET_KEY,
        );
      },
      async publishEvent(event) {
        const response = await fetch(`${httpOrigin}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
        });
        if (!response.ok) throw new Error(`publish-http-${response.status}`);
        return response.json();
      },
      nowSeconds() {
        return 2_000;
      },
    },
  };
}

async function executionFixture(relay, contentLimit = 524_288) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "notion-executor-"));
  scratches.add(scratch);
  const bytes = Buffer.from("fixture attachment");
  const actualSourceHash = sha256(bytes);
  const localPath = path.join(scratch, "asset.bin");
  await writeFile(localPath, bytes);
  const rootPlaceholder = `./notion-publication-assets/${actualSourceHash}.bin#binary-000001`;
  const childPlaceholder = `./notion-publication-assets/${actualSourceHash}.bin#binary-000002`;
  const pages = [
    {
      id: ROOT_ID,
      idSource: "notion",
      sourcePath: `Root ${ROOT_ID}.md`,
      title: "Root",
      body: `[asset](${rootPlaceholder})`,
      parentId: null,
      order: 0,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: CHILD_ID,
      idSource: "notion",
      sourcePath: `Root/Child ${CHILD_ID}.md`,
      title: "Child",
      body: `![asset](${childPlaceholder})`,
      parentId: ROOT_ID,
      order: 0,
      createdAt: 2,
      updatedAt: 2,
    },
  ];
  const imported = {
    version: 1,
    source: { archivePath: path.join(scratch, "source.zip"), archiveBytes: 1 },
    pages,
    databases: [],
    diagnostics: {
      unresolvedLinks: [],
      unresolvedParents: [],
      ambiguousRelations: [],
      unresolvedRelations: [],
      unsupportedPageSyntax: [],
      conversionFailures: [],
    },
    report: { pageCount: 2, markdownFileCount: 2, pageFailureCount: 0 },
  };
  const references = [rootPlaceholder, childPlaceholder].map(
    (placeholder, index) => ({
      referenceId: `binary-00000${index + 1}`,
      pageId: index === 0 ? ROOT_ID : CHILD_ID,
      nodeType: index === 0 ? "link" : "image",
      sourceKind: "zip-binary",
      sourceSha256: actualSourceHash,
      originalTarget: "asset.bin",
      placeholder,
      archivePath: "asset.bin",
    }),
  );
  return {
    outputDirectory: scratch,
    journalPath: path.join(scratch, "publication-journal.private.json"),
    imported,
    privateManifest: {
      version: 1,
      sourceArchiveSha256: "d".repeat(64),
      binaryEntries: [
        {
          archiveIndex: 1,
          archivePath: "asset.bin",
          bytes: bytes.length,
          compressedBytes: bytes.length,
          crc32: "00000000",
          sha256: actualSourceHash,
          mime: "application/octet-stream",
          mimeSource: "opaque",
          extractedRelativePath: "asset.bin",
        },
      ],
      csvEntries: [],
      references,
      pages: pages.map((page) => ({
        pageId: page.id,
        inputBodySha256: sha256(page.body),
        preparedBodySha256: sha256(page.body),
        referenceCount: 1,
      })),
    },
    publicManifest: {
      version: 1,
      status: "pending-production-binding",
      sourceArchiveSha256: "d".repeat(64),
      archiveBytes: 1,
      archiveEntryCount: 3,
      binaryEntryCount: 1,
      binaryUniqueCount: 1,
      binaryReferenceCount: 2,
      inlineEntryCount: 0,
      inlineUniqueCount: 0,
      combinedEntryCount: 1,
      combinedUniqueCount: 1,
      totalReferenceCount: 2,
      csvEntryCount: 0,
      csvUniqueCount: 0,
      csvReferenceCount: 0,
      unreferencedBinaryEntryCount: 0,
      unreferencedCsvEntryCount: 0,
      extractedBinaryEntryCount: 1,
      extractedCsvEntryCount: 0,
      verifiedReferenceCount: 2,
      assetBindingsComplete: false,
      bindingMode: "none",
      readyForSigning: false,
      readyToPublish: false,
      uploadAssets: [
        {
          sourceSha256: actualSourceHash,
          bytes: bytes.length,
          mime: "application/octet-stream",
          sourceKinds: ["zip-binary"],
          entryCount: 1,
          referenceCount: 2,
          uploadStatus: "not-uploaded",
          remoteSha256: null,
          remoteUrl: null,
          readbackVerified: false,
        },
      ],
    },
    contentLimit: {
      advertisedMaxContentBytes: contentLimit,
      advertisedMaxMessageBytes: 1_048_576,
      effectiveMaxContentBytes: contentLimit,
      source: "advertised",
      reason: "max-content-length-advertised",
      limitVerified: true,
      operationalAdvertisementConfirmed: true,
      relayInfoUrl: `${relay.replace("ws://", "http://")}/info`,
      relayInfoEndpoint: "/info",
      relayInfoHttpStatus: 200,
      infoEndpointHttpStatus: 200,
    },
  };
}

function authorization(relay) {
  return {
    liveExecutionAuthorized: true,
    targetRelay: relay,
    signerPubkey: FIXTURE_ONLY_PUBKEY,
  };
}

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    ),
  );
  servers.clear();
  await Promise.all(
    [...scratches].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  scratches.clear();
});

test("live calls stay locked until an exact execution authorization is supplied", async () => {
  const relay = await relayFixture();
  const data = await executionFixture(relay.relay);
  await assert.rejects(
    executePublication({
      ...data,
      api: relay.api,
      authorization: {
        ...authorization(relay.relay),
        liveExecutionAuthorized: false,
      },
      journalStore: new JsonPublicationJournalStore(data.journalPath),
    }),
    /publication-live-execution-not-authorized/,
  );
  assert.equal(relay.state.uploadCalls, 0);
  assert.equal(relay.state.queryCalls, 0);
  assert.equal(relay.state.publishCalls, 0);

  data.contentLimit.relayInfoUrl = "https://other.example/info";
  await assert.rejects(
    executePublication({
      ...data,
      api: relay.api,
      authorization: authorization(relay.relay),
      journalStore: new JsonPublicationJournalStore(data.journalPath),
    }),
    /publication-content-limit-target-mismatch/,
  );
  assert.equal(relay.state.uploadCalls, 0);
  assert.equal(relay.state.queryCalls, 0);

  const currentRelayMismatchApi = {
    ...relay.api,
    async getCurrentRelay() {
      return "ws://127.0.0.1:1";
    },
  };
  data.contentLimit.relayInfoUrl = `${relay.relay.replace("ws://", "http://")}/info`;
  data.contentLimit.effectiveMaxContentBytes -= 1;
  await assert.rejects(
    executePublication({
      ...data,
      api: relay.api,
      authorization: authorization(relay.relay),
      journalStore: new JsonPublicationJournalStore(data.journalPath),
    }),
    /publication-content-limit-provenance-mismatch/,
  );
  data.contentLimit.effectiveMaxContentBytes =
    data.contentLimit.advertisedMaxContentBytes;
  data.contentLimit.relayInfoEndpoint = "/";
  data.contentLimit.relayInfoUrl = `${relay.relay.replace("ws://", "http://")}/`;
  data.contentLimit.infoEndpointHttpStatus = 404;
  await assert.rejects(
    executePublication({
      ...data,
      api: currentRelayMismatchApi,
      authorization: authorization(relay.relay),
      journalStore: new JsonPublicationJournalStore(data.journalPath),
    }),
    /publication-current-relay-mismatch/,
  );
  const signerMismatchApi = {
    ...relay.api,
    async getCurrentSignerPubkey() {
      return "f".repeat(64);
    },
  };
  await assert.rejects(
    executePublication({
      ...data,
      api: signerMismatchApi,
      authorization: authorization(relay.relay),
      journalStore: new JsonPublicationJournalStore(data.journalPath),
    }),
    /publication-current-signer-mismatch/,
  );
  assert.equal(relay.state.uploadCalls, 0);
  assert.equal(relay.state.queryCalls, 0);

  data.contentLimit.limitVerified = false;
  data.contentLimit.operationalAdvertisementConfirmed = false;
  await assert.rejects(
    executePublication({
      ...data,
      api: relay.api,
      authorization: authorization(relay.relay),
      journalStore: new JsonPublicationJournalStore(data.journalPath),
    }),
    /publication-content-limit-unverified/,
  );
  data.contentLimit.limitVerified = true;
  data.contentLimit.operationalAdvertisementConfirmed = true;

  data.publicManifest.sourceArchiveSha256 = "e".repeat(64);
  await assert.rejects(
    executePublication({
      ...data,
      api: relay.api,
      authorization: authorization(relay.relay),
      journalStore: new JsonPublicationJournalStore(data.journalPath),
    }),
    /publication-manifest-source-conflict/,
  );
  assert.equal(relay.state.uploadCalls, 0);
  assert.equal(relay.state.queryCalls, 0);
});

test("the durable journal excludes concurrent writers and recovers a dead-owner lock", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "notion-journal-lock-"));
  scratches.add(scratch);
  const journalPath = path.join(scratch, "publication-journal.private.json");
  const store = new JsonPublicationJournalStore(journalPath);
  let release;
  const held = store.withLock(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    store.withLock(async () => undefined),
    /publication-journal-locked/,
  );
  release();
  await held;

  await mkdir(path.dirname(journalPath), { recursive: true });
  await writeFile(
    `${journalPath}.lock`,
    `${JSON.stringify({ pid: 99_999_999 })}\n`,
  );
  await store.withLock(async () => undefined);
  await assert.rejects(
    store.saveAsset({ sourceSha256: "../escape" }),
    /publication-journal-invalid-asset-hash/,
  );
});

test("upload failure is durably incomplete and never reaches signing or publication", async () => {
  const relay = await relayFixture();
  relay.state.failUploadCount = 1;
  const data = await executionFixture(relay.relay);
  const store = new JsonPublicationJournalStore(data.journalPath);
  await assert.rejects(
    executePublication({
      ...data,
      api: relay.api,
      authorization: authorization(relay.relay),
      journalStore: store,
    }),
    /upload-http-500/,
  );
  const journal = await store.load();
  assert.equal(Object.values(journal.assets)[0].status, "failed");
  assert.equal(journal.complete, false);
  assert.equal(relay.signCalls, 0);
  assert.equal(relay.state.publishCalls, 0);
});

test("a cross-origin upload descriptor is rejected before readback can fetch it", async () => {
  const relay = await relayFixture();
  const data = await executionFixture(relay.relay);
  const api = {
    ...relay.api,
    async uploadAsset(asset) {
      const descriptor = await relay.api.uploadAsset(asset);
      return {
        ...descriptor,
        url: `http://127.0.0.1:1/media/${descriptor.sha256}.bin`,
      };
    },
  };
  await assert.rejects(
    executePublication({
      ...data,
      api,
      authorization: authorization(relay.relay),
      journalStore: new JsonPublicationJournalStore(data.journalPath),
    }),
    /publication-binding-production-url-mismatch/,
  );
  assert.equal(relay.state.readCalls, 0);
  assert.equal(relay.signCalls, 0);
  assert.equal(relay.state.publishCalls, 0);
});

test("interruption resumes with the same signed event ids and no duplicate upload", async () => {
  const relay = await relayFixture();
  relay.state.failPublishAt = 2;
  const data = await executionFixture(relay.relay);
  const store = new JsonPublicationJournalStore(data.journalPath);
  await assert.rejects(
    executePublication({
      ...data,
      api: relay.api,
      authorization: authorization(relay.relay),
      journalStore: store,
    }),
    /publish-http-503/,
  );
  const interrupted = await store.load();
  const firstEventId = interrupted.pages[ROOT_ID].signedEventId;
  const secondEventId = interrupted.pages[CHILD_ID].signedEventId;
  assert.match(firstEventId, /^[0-9a-f]{64}$/);
  assert.match(secondEventId, /^[0-9a-f]{64}$/);
  assert.equal(interrupted.pages[ROOT_ID].readbackVerified, true);
  assert.equal(interrupted.pages[CHILD_ID].readbackVerified, false);
  assert.equal(relay.signCalls, 2);

  relay.state.failPublishAt = null;
  const resumed = await executePublication({
    ...data,
    api: relay.api,
    authorization: authorization(relay.relay),
    journalStore: store,
  });
  assert.equal(resumed.complete, true);
  assert.equal(resumed.pages[ROOT_ID].signedEventId, firstEventId);
  assert.equal(resumed.pages[CHILD_ID].signedEventId, secondEventId);
  assert.equal(relay.state.uploadCalls, 1);
  assert.equal(relay.signCalls, 2);
  assert.equal(relay.state.events.get(`doc:${ROOT_ID}`).length, 1);
  assert.equal(relay.state.events.get(`doc:${CHILD_ID}`).length, 1);
});

test("resume rehashes retained source bytes before trusting an uploaded asset journal", async () => {
  const relay = await relayFixture();
  relay.state.failPublishAt = 1;
  const data = await executionFixture(relay.relay);
  const store = new JsonPublicationJournalStore(data.journalPath);
  await assert.rejects(
    executePublication({
      ...data,
      api: relay.api,
      authorization: authorization(relay.relay),
      journalStore: store,
    }),
    /publish-http-503/,
  );
  await writeFile(path.join(data.outputDirectory, "asset.bin"), "tampered");
  relay.state.failPublishAt = null;
  await assert.rejects(
    executePublication({
      ...data,
      api: relay.api,
      authorization: authorization(relay.relay),
      journalStore: store,
    }),
    /publication-local-asset-hash-mismatch/,
  );
  assert.equal(relay.state.uploadCalls, 1);
  assert.equal(relay.state.publishCalls, 1);
});

test("resume rejects a conflicting per-page journal identity", async () => {
  const relay = await relayFixture();
  relay.state.failPublishAt = 1;
  const data = await executionFixture(relay.relay);
  const store = new JsonPublicationJournalStore(data.journalPath);
  await assert.rejects(
    executePublication({
      ...data,
      api: relay.api,
      authorization: authorization(relay.relay),
      journalStore: store,
    }),
    /publish-http-503/,
  );
  const pagePath = `${data.journalPath}.d/pages/${ROOT_ID}.json`;
  const page = JSON.parse(await readFile(pagePath, "utf8"));
  page.sourceContentSha256 = "f".repeat(64);
  await writeFile(pagePath, `${JSON.stringify(page)}\n`);
  relay.state.failPublishAt = null;

  await assert.rejects(
    executePublication({
      ...data,
      api: relay.api,
      authorization: authorization(relay.relay),
      journalStore: store,
    }),
    /publication-journal-page-conflict/,
  );
  assert.equal(relay.state.uploadCalls, 1);
  assert.equal(relay.state.publishCalls, 1);
});

test("identical existing pages are skipped and a differing existing page blocks the batch", async () => {
  const relay = await relayFixture();
  const data = await executionFixture(relay.relay);
  // Upload once to learn the production URL, then bind the expected final bodies.
  const descriptor = await relay.api.uploadAsset({
    localPath: path.join(data.outputDirectory, "asset.bin"),
  });
  const finalBodies = data.imported.pages.map((page) =>
    page.body.replace(/\.\/notion-publication-assets\/[^)]+/, descriptor.url),
  );
  const rootInput = {
    kind: 30623,
    tags: [
      ["d", `doc:${ROOT_ID}`],
      ["t", "community-doc"],
    ],
    content: JSON.stringify({
      title: "Root",
      body: finalBodies[0],
      parentId: null,
      order: 0,
      createdAt: 1,
      updatedAt: 1,
    }),
    createdAt: 1_000,
  };
  const rootEvent = await relay.api.signEvent(rootInput);
  relay.state.events.set(`doc:${ROOT_ID}`, [rootEvent]);
  const conflictEvent = await relay.api.signEvent({
    ...rootInput,
    tags: [
      ["d", `doc:${CHILD_ID}`],
      ["t", "community-doc"],
    ],
    content: JSON.stringify({
      title: "Human edit",
      body: "different",
      parentId: ROOT_ID,
      order: 0,
      createdAt: 2,
      updatedAt: 3,
    }),
  });
  relay.state.events.set(`doc:${CHILD_ID}`, [conflictEvent]);
  const baselineSignCalls = relay.signCalls;
  const baselinePublishCalls = relay.state.publishCalls;
  const store = new JsonPublicationJournalStore(data.journalPath);

  await assert.rejects(
    executePublication({
      ...data,
      api: relay.api,
      authorization: authorization(relay.relay),
      journalStore: store,
    }),
    /publication-page-conflict/,
  );
  const journal = await store.load();
  assert.equal(journal.pages[ROOT_ID].status, "identical");
  assert.equal(journal.pages[CHILD_ID].status, "conflict");
  assert.equal(relay.signCalls, baselineSignCalls);
  assert.equal(relay.state.publishCalls, baselinePublishCalls);
});

test("post-binding oversize stops before signing even though upload succeeded", async () => {
  const relay = await relayFixture();
  const data = await executionFixture(relay.relay, 120);
  const store = new JsonPublicationJournalStore(data.journalPath);
  await assert.rejects(
    executePublication({
      ...data,
      api: relay.api,
      authorization: authorization(relay.relay),
      journalStore: store,
    }),
    /publication-preflight-failed/,
  );
  const journal = await store.load();
  assert.equal(journal.preflight.failures[0].reason, "page-content-too-large");
  assert.equal(relay.signCalls, 0);
  assert.equal(relay.state.publishCalls, 0);
});

test("an accepted response without readback never becomes a false success", async () => {
  const relay = await relayFixture();
  relay.state.falseSuccess = true;
  const data = await executionFixture(relay.relay);
  const store = new JsonPublicationJournalStore(data.journalPath);
  await assert.rejects(
    executePublication({
      ...data,
      api: relay.api,
      authorization: authorization(relay.relay),
      journalStore: store,
    }),
    /publication-event-readback-missing/,
  );
  const journal = await store.load();
  assert.equal(journal.pages[ROOT_ID].relayAccepted, true);
  assert.equal(journal.pages[ROOT_ID].readbackVerified, false);
  assert.equal(journal.complete, false);
});

test("an accepted response with a forged readback event never becomes success", async () => {
  const relay = await relayFixture();
  relay.state.corruptReadback = true;
  const data = await executionFixture(relay.relay);
  const store = new JsonPublicationJournalStore(data.journalPath);
  await assert.rejects(
    executePublication({
      ...data,
      api: relay.api,
      authorization: authorization(relay.relay),
      journalStore: store,
    }),
    /publication-query-invalid-event/,
  );
  const journal = await store.load();
  assert.equal(journal.pages[ROOT_ID].relayAccepted, true);
  assert.equal(journal.pages[ROOT_ID].readbackVerified, false);
  assert.equal(journal.complete, false);
});

test("a completed journal is invalidated before a later remote conflict check", async () => {
  const relay = await relayFixture();
  const data = await executionFixture(relay.relay);
  const store = new JsonPublicationJournalStore(data.journalPath);
  const complete = await executePublication({
    ...data,
    api: relay.api,
    authorization: authorization(relay.relay),
    journalStore: store,
  });
  assert.equal(complete.complete, true);

  const humanEdit = await relay.api.signEvent({
    kind: 30623,
    tags: [
      ["d", `doc:${ROOT_ID}`],
      ["t", "community-doc"],
    ],
    content: JSON.stringify({
      title: "Human edit",
      body: "newer content",
      parentId: null,
      order: 0,
      createdAt: 1,
      updatedAt: 3,
    }),
    createdAt: 3_000,
  });
  relay.state.events.get(`doc:${ROOT_ID}`).push(humanEdit);
  await assert.rejects(
    executePublication({
      ...data,
      api: relay.api,
      authorization: authorization(relay.relay),
      journalStore: store,
    }),
    /publication-page-conflict/,
  );
  assert.equal((await store.load()).complete, false);
});
