import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { bindPublicationAssetUrls } from "./publicationBindings.ts";

const PAGE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const ZIP_ONE = `./notion-publication-assets/${HASH_A}.png#binary-000001`;
const ZIP_TWO = `./notion-publication-assets/${HASH_A}.png#binary-000002`;
const INLINE = `./notion-inline-assets/${HASH_B}.jpg#ref-000001`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const body = [
    `[${ZIP_ONE}](${ZIP_ONE} "${ZIP_ONE}")`,
    `![duplicate](${ZIP_TWO})`,
    `[inline](${INLINE})`,
    `\`${ZIP_ONE}\``,
  ].join("\n");
  const imported = {
    version: 1,
    source: { archivePath: "/private/source.zip", archiveBytes: 1 },
    pages: [
      {
        id: PAGE_ID,
        idSource: "notion",
        sourcePath: `Workspace/Page ${PAGE_ID}.md`,
        title: "Page",
        body,
        parentId: null,
        order: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    databases: [],
    diagnostics: {
      unresolvedLinks: [],
      unresolvedParents: [],
      ambiguousRelations: [],
      unresolvedRelations: [],
      unsupportedPageSyntax: [],
      conversionFailures: [],
    },
    report: { pageCount: 1, markdownFileCount: 1, pageFailureCount: 0 },
  };
  const references = [
    {
      referenceId: "binary-000001",
      pageId: PAGE_ID,
      nodeType: "link",
      sourceKind: "zip-binary",
      sourceSha256: HASH_A,
      originalTarget: "diagram.png",
      placeholder: ZIP_ONE,
      archivePath: "Workspace/diagram.png",
    },
    {
      referenceId: "binary-000002",
      pageId: PAGE_ID,
      nodeType: "image",
      sourceKind: "zip-binary",
      sourceSha256: HASH_A,
      originalTarget: "copy.png",
      placeholder: ZIP_TWO,
      archivePath: "Workspace/copy.png",
    },
    {
      referenceId: "inline-000001",
      pageId: PAGE_ID,
      nodeType: "link",
      sourceKind: "inline",
      sourceSha256: HASH_B,
      originalTarget: "data:image/jpeg;base64,/9j/",
      placeholder: INLINE,
      archivePath: null,
    },
  ];
  return {
    imported,
    privateManifest: {
      version: 1,
      sourceArchiveSha256: "d".repeat(64),
      binaryEntries: [],
      csvEntries: [],
      references,
      pages: [
        {
          pageId: PAGE_ID,
          inputBodySha256: "e".repeat(64),
          preparedBodySha256: sha256(body),
          referenceCount: 3,
        },
      ],
    },
    publicManifest: {
      version: 1,
      status: "pending-production-binding",
      sourceArchiveSha256: "d".repeat(64),
      archiveBytes: 1,
      archiveEntryCount: 1,
      binaryEntryCount: 3,
      binaryUniqueCount: 2,
      binaryReferenceCount: 2,
      inlineEntryCount: 1,
      inlineUniqueCount: 1,
      combinedEntryCount: 4,
      combinedUniqueCount: 3,
      totalReferenceCount: 3,
      csvEntryCount: 0,
      csvUniqueCount: 0,
      csvReferenceCount: 0,
      unreferencedBinaryEntryCount: 1,
      unreferencedCsvEntryCount: 0,
      extractedBinaryEntryCount: 3,
      extractedCsvEntryCount: 0,
      verifiedReferenceCount: 3,
      assetBindingsComplete: false,
      bindingMode: "none",
      readyForSigning: false,
      readyToPublish: false,
      uploadAssets: [
        {
          sourceSha256: HASH_A,
          bytes: 10,
          mime: "image/png",
          sourceKinds: ["zip-binary"],
          entryCount: 2,
          referenceCount: 2,
          uploadStatus: "not-uploaded",
          remoteSha256: null,
          remoteUrl: null,
          readbackVerified: false,
        },
        {
          sourceSha256: HASH_B,
          bytes: 6,
          mime: "image/jpeg",
          sourceKinds: ["inline"],
          entryCount: 1,
          referenceCount: 1,
          uploadStatus: "not-uploaded",
          remoteSha256: null,
          remoteUrl: null,
          readbackVerified: false,
        },
        {
          sourceSha256: HASH_C,
          bytes: 20,
          mime: "application/pdf",
          sourceKinds: ["zip-binary"],
          entryCount: 1,
          referenceCount: 0,
          uploadStatus: "not-uploaded",
          remoteSha256: null,
          remoteUrl: null,
          readbackVerified: false,
        },
      ],
    },
  };
}

function binding(sourceSha256, suffix, overrides = {}) {
  return {
    sourceSha256,
    sourceBytes:
      sourceSha256 === HASH_B ? 6 : sourceSha256 === HASH_C ? 20 : 10,
    remoteSha256: suffix.repeat(64),
    remoteBytes:
      sourceSha256 === HASH_B ? 6 : sourceSha256 === HASH_C ? 20 : 10,
    mime:
      sourceSha256 === HASH_B
        ? "image/jpeg"
        : sourceSha256 === HASH_C
          ? "application/pdf"
          : "image/png",
    url: `https://relay.example/media/${suffix.repeat(64)}.bin`,
    uploadAccepted: true,
    readbackVerified: true,
    ...overrides,
  };
}

function productionBinding(sourceSha256, overrides = {}) {
  const sourceBytes =
    sourceSha256 === HASH_B ? 6 : sourceSha256 === HASH_C ? 20 : 10;
  const mime =
    sourceSha256 === HASH_B
      ? "image/jpeg"
      : sourceSha256 === HASH_C
        ? "application/pdf"
        : "image/png";
  return {
    sourceSha256,
    sourceBytes,
    remoteSha256: sourceSha256,
    remoteBytes: sourceBytes,
    mime,
    url: `https://relay.example/media/${sourceSha256}.bin`,
    uploadAccepted: true,
    readbackVerified: true,
    ...overrides,
  };
}

test("simulated URLs replace every destination but never claim production signing readiness", () => {
  const data = fixture();
  const result = bindPublicationAssetUrls({
    ...data,
    bindings: {
      version: 1,
      mode: "simulated",
      targetRelay: "wss://relay.example",
      assets: [
        binding(HASH_A, "1"),
        binding(HASH_B, "2"),
        binding(HASH_C, "3"),
      ],
    },
  });

  assert.equal(result.status.boundReferenceCount, 3);
  assert.equal(result.status.unboundReferenceCount, 0);
  assert.equal(result.status.referencesBound, true);
  assert.equal(result.status.productionBindingsComplete, false);
  assert.equal(result.status.assetBindingsComplete, false);
  assert.equal(result.status.readyForSigning, false);
  const body = result.imported.pages[0].body;
  assert.match(body, /^\[\.\/notion-publication-assets\//);
  assert.match(body, /"\.\/notion-publication-assets\//);
  assert.match(body, /`\.\/notion-publication-assets\//);
  assert.doesNotMatch(body, /\]\(\.\/notion-(?:publication|inline)-assets\//);
});

test("missing upload bindings remain explicit and keep the local placeholder", () => {
  const data = fixture();
  const result = bindPublicationAssetUrls({
    ...data,
    bindings: {
      version: 1,
      mode: "simulated",
      targetRelay: "wss://relay.example",
      assets: [binding(HASH_A, "1")],
    },
  });

  assert.equal(result.status.boundReferenceCount, 2);
  assert.equal(result.status.unboundReferenceCount, 1);
  assert.equal(result.status.referencesBound, false);
  assert.match(result.imported.pages[0].body, /notion-inline-assets/);
});

test("production bindings require accepted readback and a same-origin relay media URL", () => {
  const data = fixture();
  const good = [
    productionBinding(HASH_A),
    productionBinding(HASH_B),
    productionBinding(HASH_C),
  ];
  const result = bindPublicationAssetUrls({
    ...data,
    bindings: {
      version: 1,
      mode: "production",
      targetRelay: "wss://relay.example",
      assets: good,
    },
  });
  assert.equal(result.status.productionBindingsComplete, true);
  assert.equal(result.status.readyForSigning, true);

  for (const bad of [
    productionBinding(HASH_A, { uploadAccepted: false }),
    productionBinding(HASH_A, { readbackVerified: false }),
    productionBinding(HASH_A, {
      url: `https://other.example/media/${HASH_A}.png`,
    }),
    productionBinding(HASH_A, {
      remoteSha256: "f".repeat(64),
      url: `https://relay.example/media/${"f".repeat(64)}.bin`,
    }),
    productionBinding(HASH_A, { remoteBytes: 9 }),
  ]) {
    assert.throws(
      () =>
        bindPublicationAssetUrls({
          ...data,
          bindings: {
            version: 1,
            mode: "production",
            targetRelay: "wss://relay.example",
            assets: [bad, productionBinding(HASH_B), productionBinding(HASH_C)],
          },
        }),
      /publication-binding-/,
    );
  }
});
