import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPublicationPreflight } from "./publicationPreflight.ts";

const ROOT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHILD_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function fixture() {
  return {
    imported: {
      version: 1,
      source: { archivePath: "/private/source.zip", archiveBytes: 1 },
      pages: [
        {
          id: ROOT_ID,
          idSource: "notion",
          sourcePath: `Root ${ROOT_ID}.md`,
          title: "Root",
          body: "root body",
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
          body: "child body",
          parentId: ROOT_ID,
          order: 0,
          createdAt: 2,
          updatedAt: 2,
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
      report: {
        pageCount: 2,
        markdownFileCount: 2,
        pageFailureCount: 0,
      },
    },
    bindingStatus: {
      version: 1,
      targetRelay: "wss://relay.example",
      bindingMode: "production",
      uploadAssetCount: 3,
      boundAssetCount: 3,
      totalReferenceCount: 3,
      boundReferenceCount: 3,
      unboundReferenceCount: 0,
      referencesBound: true,
      productionBindingsComplete: true,
      assetBindingsComplete: true,
      readyForSigning: true,
      readyToPublish: false,
    },
    contentLimit: {
      advertisedMaxContentBytes: 524_288,
      advertisedMaxMessageBytes: 1_048_576,
      effectiveMaxContentBytes: 524_288,
      source: "advertised",
      reason: "max-content-length-advertised",
      limitVerified: true,
      operationalAdvertisementConfirmed: true,
      relayInfoUrl: "https://relay.example/info",
      relayInfoEndpoint: "/info",
      relayInfoHttpStatus: 200,
      infoEndpointHttpStatus: 200,
    },
  };
}

test("revalidates every stable id, parent, and final body through the production codec", () => {
  const result = buildPublicationPreflight(fixture());

  assert.equal(result.inputPageCount, 2);
  assert.equal(result.uniquePageIdCount, 2);
  assert.equal(result.validParentCount, 1);
  assert.equal(result.codecValidatedPageCount, 2);
  assert.equal(result.contentValidatedPageCount, 2);
  assert.equal(result.failures.length, 0);
  assert.equal(result.complete, true);
  assert.equal(result.readyForSigning, true);
  assert.equal(result.readyToPublish, false);
  assert.equal(result.events.length, 2);
  assert.deepEqual(
    result.events.map((event) => event.pageId),
    [ROOT_ID, CHILD_ID],
  );
  assert.match(result.corpusSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.contentLimit.advertisedMaxMessageBytes, 1_048_576);
});

test("simulated bindings can validate final URLs but cannot become signing ready", () => {
  const input = fixture();
  input.bindingStatus.bindingMode = "simulated";
  input.bindingStatus.productionBindingsComplete = false;
  input.bindingStatus.assetBindingsComplete = false;
  input.bindingStatus.readyForSigning = false;

  const result = buildPublicationPreflight(input);
  assert.equal(result.complete, true);
  assert.equal(result.events.length, 2);
  assert.equal(result.readyForSigning, false);
  assert.deepEqual(result.readinessBlockers, [
    "production-asset-bindings-missing",
  ]);
});

test("post-binding oversize invalidates the whole batch and emits no signable subset", () => {
  const input = fixture();
  input.imported.pages[1].body = `https://relay.example/media/${"f".repeat(500)}`;
  input.contentLimit.effectiveMaxContentBytes = 128;
  input.contentLimit.advertisedMaxContentBytes = 128;

  const result = buildPublicationPreflight(input);
  assert.equal(result.complete, false);
  assert.equal(result.readyForSigning, false);
  assert.equal(result.events.length, 0);
  assert.deepEqual(
    result.failures.map(({ pageId, reason }) => ({ pageId, reason })),
    [{ pageId: CHILD_ID, reason: "page-content-too-large" }],
  );
});

test("duplicate ids and dangling parents fail closed before any signable event exists", () => {
  const duplicate = fixture();
  duplicate.imported.pages[1].id = ROOT_ID;
  const duplicateResult = buildPublicationPreflight(duplicate);
  assert.equal(duplicateResult.complete, false);
  assert.equal(duplicateResult.events.length, 0);
  assert.ok(
    duplicateResult.failures.some(
      (failure) => failure.reason === "duplicate-page-id",
    ),
  );

  const dangling = fixture();
  dangling.imported.pages[1].parentId = "c".repeat(32);
  const danglingResult = buildPublicationPreflight(dangling);
  assert.equal(danglingResult.complete, false);
  assert.equal(danglingResult.events.length, 0);
  assert.deepEqual(
    danglingResult.failures.map(({ pageId, reason }) => ({ pageId, reason })),
    [{ pageId: CHILD_ID, reason: "dangling-parent" }],
  );
});
