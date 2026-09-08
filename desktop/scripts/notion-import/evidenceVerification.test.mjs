import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { run } from "./cli.ts";
import { writePublicationEvidenceVerification } from "./evidenceVerification.ts";
import { buildPublicationPreflight } from "./publicationPreflight.ts";

const scratchDirectories = new Set();
const EXPECTED_ID_PARENT_HASH =
  "29d7bacd6d09e392007f6882ed1063db71e3ac48f777fd603f92d3baf028e1f4";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture() {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "notion-evidence-"));
  scratchDirectories.add(scratch);
  const outputDirectory = path.join(scratch, "output");
  await mkdir(outputDirectory);
  const sourceArchivePath = path.join(scratch, "source.zip");
  const sourceIntermediatePath = path.join(scratch, "source.json");
  const archive = Buffer.from("synthetic archive fixture");
  const pages = [
    {
      id: "root",
      idSource: "notion",
      sourcePath: "root.md",
      title: "Root",
      body: "source root",
      parentId: null,
      order: 0,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "child",
      idSource: "notion",
      sourcePath: "child.md",
      title: "Child",
      body: "source child",
      parentId: "root",
      order: 0,
      createdAt: 2,
      updatedAt: 2,
    },
  ];
  const importedWithPages = (candidatePages) => ({
    version: 1,
    source: { archivePath: sourceArchivePath, archiveBytes: archive.length },
    pages: candidatePages,
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
      pageCount: candidatePages.length,
      markdownFileCount: candidatePages.length,
      pageFailureCount: 0,
    },
  });
  const imported = importedWithPages(pages);
  const prepared = {
    ...importedWithPages(
      pages.map((page) => ({ ...page, body: `prepared ${page.id}` })),
    ),
  };
  const final = {
    ...importedWithPages(
      pages.map((page) => ({ ...page, body: `final ${page.id}` })),
    ),
  };
  const preflight = buildPublicationPreflight({
    imported: final,
    bindingStatus: {
      productionBindingsComplete: true,
      bindingMode: "production",
    },
    contentLimit: {
      effectiveMaxContentBytes: 524_288,
      limitVerified: true,
      operationalAdvertisementConfirmed: true,
    },
  });
  await writeFile(sourceArchivePath, archive);
  await writeFile(sourceIntermediatePath, `${JSON.stringify(imported)}\n`);
  const artifacts = {
    "notion-publication-assets.json": {
      sourceArchiveSha256: sha256(archive),
      archiveBytes: archive.length,
      archiveEntryCount: 3,
      binaryEntryCount: 1,
      binaryUniqueCount: 1,
      inlineEntryCount: 0,
      inlineUniqueCount: 0,
      combinedEntryCount: 1,
      combinedUniqueCount: 1,
      totalReferenceCount: 1,
      csvEntryCount: 1,
      csvUniqueCount: 1,
      csvReferenceCount: 1,
      unreferencedBinaryEntryCount: 0,
      unreferencedCsvEntryCount: 0,
    },
    "notion-publication-assets.private.json": {
      sourceArchiveSha256: sha256(archive),
    },
    "notion-publication-bindings.simulated.json": { version: 1 },
    "notion-publication-compatibility.json": { version: 1 },
    "notion-publication-final.json": final,
    "notion-publication-preflight.json": preflight,
    "notion-publication-prepared.json": prepared,
    "notion-publication-status.json": { version: 1 },
  };
  await Promise.all(
    Object.entries(artifacts).map(([name, value]) =>
      writeFile(path.join(outputDirectory, name), `${JSON.stringify(value)}\n`),
    ),
  );
  await writeFile(
    path.join(outputDirectory, "notion-publication-report.md"),
    "# Fixture report\n",
  );
  return { outputDirectory, sourceArchivePath, sourceIntermediatePath };
}

afterEach(async () => {
  await Promise.all(
    [...scratchDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  scratchDirectories.clear();
});

test("writes byte-derived artifact hashes and proves original approved IDs and parents survive", async () => {
  const data = await fixture();
  const receiptPath = path.join(data.outputDirectory, "verification.json");
  const receipt = await writePublicationEvidenceVerification({
    repoRoot: path.resolve(".."),
    sourceArchivePath: data.sourceArchivePath,
    sourceIntermediatePath: data.sourceIntermediatePath,
    outputDirectory: data.outputDirectory,
    receiptPath,
  });

  assert.equal(receipt.complete, true);
  assert.equal(receipt.sources.archive.matchesPublicManifest, true);
  assert.equal(receipt.sources.archive.matchesPrivateManifest, true);
  assert.equal(receipt.sources.archive.matchesApprovedSourcePath, true);
  assert.equal(receipt.sources.archive.matchesApprovedSourceBytes, true);
  assert.equal(receipt.pageIdentities.allMatch, true);
  assert.equal(
    receipt.pageIdentities.originalApproved.sha256,
    EXPECTED_ID_PARENT_HASH,
  );
  assert.equal(receipt.pageIdentities.prepared.sha256, EXPECTED_ID_PARENT_HASH);
  assert.equal(receipt.pageIdentities.final.sha256, EXPECTED_ID_PARENT_HASH);
  assert.equal(receipt.corpus.reported.inputPageCount, 2);
  assert.equal(receipt.corpus.recomputed.codecValidatedPageCount, 2);
  assert.equal(receipt.corpus.validationCountsMatch, true);
  assert.equal(receipt.artifacts.length, 9);
  assert.deepEqual(JSON.parse(await readFile(receiptPath, "utf8")), receipt);
});

test("persists a failed receipt when a prepared parent differs from the approved source", async () => {
  const data = await fixture();
  const preparedPath = path.join(
    data.outputDirectory,
    "notion-publication-prepared.json",
  );
  const prepared = JSON.parse(await readFile(preparedPath, "utf8"));
  prepared.pages[1].parentId = null;
  await writeFile(preparedPath, `${JSON.stringify(prepared)}\n`);
  const receiptPath = path.join(data.outputDirectory, "verification.json");

  const receipt = await writePublicationEvidenceVerification({
    repoRoot: path.resolve(".."),
    sourceArchivePath: data.sourceArchivePath,
    sourceIntermediatePath: data.sourceIntermediatePath,
    outputDirectory: data.outputDirectory,
    receiptPath,
  });

  assert.equal(receipt.complete, false);
  assert.equal(receipt.pageIdentities.allMatch, false);
  assert.deepEqual(receipt.failures, ["page-identities-differ"]);
});

test("verify-evidence CLI writes the machine-readable receipt", async () => {
  const data = await fixture();
  const receiptPath = path.join(data.outputDirectory, "verification.json");

  await run([
    "verify-evidence",
    "--input",
    data.sourceIntermediatePath,
    "--zip",
    data.sourceArchivePath,
    "--output",
    data.outputDirectory,
    "--receipt",
    receiptPath,
  ]);

  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.complete, true);
  assert.equal(receipt.sources.archive.matchesPublicManifest, true);
});

test("persists a failed receipt when the approved intermediate names a different archive size", async () => {
  const data = await fixture();
  const source = JSON.parse(
    await readFile(data.sourceIntermediatePath, "utf8"),
  );
  source.source.archiveBytes += 1;
  await writeFile(data.sourceIntermediatePath, `${JSON.stringify(source)}\n`);

  const receipt = await writePublicationEvidenceVerification({
    repoRoot: path.resolve(".."),
    sourceArchivePath: data.sourceArchivePath,
    sourceIntermediatePath: data.sourceIntermediatePath,
    outputDirectory: data.outputDirectory,
    receiptPath: path.join(data.outputDirectory, "verification.json"),
  });

  assert.equal(receipt.complete, false);
  assert.equal(receipt.sources.archive.matchesApprovedSourceBytes, false);
  assert.deepEqual(receipt.failures, [
    "source-intermediate-archive-byte-denominator-mismatch",
  ]);
});
