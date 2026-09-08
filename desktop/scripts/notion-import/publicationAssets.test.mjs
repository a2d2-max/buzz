import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, test } from "node:test";

import {
  preparePublicationAssets,
  verifyPreparedPublicationAssets,
} from "./publicationAssets.ts";

const PAGE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const scratchDirectories = new Set();

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const checksum = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(entry.centralCrc ?? checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

async function fixture({ traversal = false } = {}) {
  const scratch = await mkdtemp(
    path.join(os.tmpdir(), "notion-publish-assets-"),
  );
  scratchDirectories.add(scratch);
  const archivePath = path.join(scratch, "input.zip");
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
  ]);
  const pdf = Buffer.from("%PDF-1.7\nfixture\n");
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 4, 5, 6]);
  const dataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  const pagePath = `Workspace/Page ${PAGE_ID}.md`;
  const archiveBody = [
    `![diagram](diagram.png "diagram.png")`,
    `[diagram.png](copy.png)`,
    `[table](table.csv)`,
    `[inline](${dataUrl})`,
    "`diagram.png`",
  ].join("\n");
  const body = archiveBody.replace(
    "[table](table.csv)",
    "| Name |\n| --- |\n| Row |",
  );
  const entries = [
    { name: pagePath, data: Buffer.from(`# Page\n\n${archiveBody}`) },
    { name: "Workspace/table.csv", data: Buffer.from("Name\nRow\n") },
    { name: "Workspace/unreferenced.csv", data: Buffer.from("Name\nOther\n") },
    { name: "Workspace/diagram.png", data: png },
    { name: "Workspace/copy.png", data: png },
    { name: "Workspace/orphan.pdf", data: pdf },
  ];
  if (traversal)
    entries.push({ name: "../escape.bin", data: Buffer.from("x") });
  const zip = makeStoredZip(entries);
  await writeFile(archivePath, zip);
  return {
    archivePath,
    body,
    dataUrl,
    jpeg,
    outputDirectory: path.join(scratch, "output"),
    pdf,
    png,
    zip,
    imported: {
      version: 1,
      source: { archivePath, archiveBytes: zip.length },
      pages: [
        {
          id: PAGE_ID,
          idSource: "notion",
          sourcePath: pagePath,
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
      report: {
        archiveEntryCount: entries.length,
        markdownFileCount: 1,
        pageCount: 1,
        pageFailureCount: 0,
        nativePageIdCount: 1,
        syntheticPageIdCount: 0,
        unresolvedParentCount: 0,
        ambiguousParentFolderCount: 0,
        databaseCount: 0,
        databaseCsvFileCount: 2,
        databaseRowCount: 0,
        inlineDatabaseCount: 1,
        pageLinkTargetCount: 0,
        linkResolvedCount: 0,
        linkUnresolvedCount: 0,
        relationResolvedCount: 0,
        relationAmbiguousCount: 0,
        relationUnresolvedCount: 0,
        relationNonemptyCellCount: 0,
        relationReferenceCount: 0,
        relationColumnCount: 0,
        attachmentFileCount: traversal ? 4 : 3,
        attachmentReferenceCount: 2,
        unsupportedSyntax: {},
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(
    [...scratchDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  scratchDirectories.clear();
});

test("extracts every binary and CSV entry, hashes duplicates, and prepares only real destinations", async () => {
  const data = await fixture();
  const prepared = await preparePublicationAssets({
    imported: data.imported,
    outputDirectory: data.outputDirectory,
  });

  assert.deepEqual(
    {
      archiveEntryCount: prepared.publicManifest.archiveEntryCount,
      binaryEntryCount: prepared.publicManifest.binaryEntryCount,
      binaryUniqueCount: prepared.publicManifest.binaryUniqueCount,
      binaryReferenceCount: prepared.publicManifest.binaryReferenceCount,
      inlineEntryCount: prepared.publicManifest.inlineEntryCount,
      inlineUniqueCount: prepared.publicManifest.inlineUniqueCount,
      combinedEntryCount: prepared.publicManifest.combinedEntryCount,
      combinedUniqueCount: prepared.publicManifest.combinedUniqueCount,
      totalReferenceCount: prepared.publicManifest.totalReferenceCount,
      csvEntryCount: prepared.publicManifest.csvEntryCount,
      csvReferenceCount: prepared.publicManifest.csvReferenceCount,
      unreferencedBinaryEntryCount:
        prepared.publicManifest.unreferencedBinaryEntryCount,
      unreferencedCsvEntryCount:
        prepared.publicManifest.unreferencedCsvEntryCount,
      readyForSigning: prepared.publicManifest.readyForSigning,
      readyToPublish: prepared.publicManifest.readyToPublish,
    },
    {
      archiveEntryCount: 6,
      binaryEntryCount: 3,
      binaryUniqueCount: 2,
      binaryReferenceCount: 2,
      inlineEntryCount: 1,
      inlineUniqueCount: 1,
      combinedEntryCount: 4,
      combinedUniqueCount: 3,
      totalReferenceCount: 3,
      csvEntryCount: 2,
      csvReferenceCount: 1,
      unreferencedBinaryEntryCount: 1,
      unreferencedCsvEntryCount: 1,
      readyForSigning: false,
      readyToPublish: false,
    },
  );
  assert.equal(prepared.publicManifest.sourceArchiveSha256, sha256(data.zip));
  assert.equal(prepared.publicManifest.assetBindingsComplete, false);
  assert.equal(prepared.privateManifest.binaryEntries.length, 3);
  assert.equal(prepared.privateManifest.csvEntries.length, 2);
  assert.equal(prepared.privateManifest.references.length, 3);
  assert.doesNotMatch(
    JSON.stringify(prepared.publicManifest),
    /Workspace|Page/,
  );

  const body = prepared.imported.pages[0].body;
  assert.match(body, /notion-publication-assets/);
  assert.match(body, /notion-inline-assets/);
  assert.match(body, /\[diagram\.png\]\(\.\/notion-publication-assets\//);
  assert.match(body, /"diagram\.png"/);
  assert.match(body, /`diagram\.png`/);
  assert.doesNotMatch(body, /;base64,/);
  assert.doesNotMatch(body, /table\.csv/);

  const diagram = prepared.privateManifest.binaryEntries.find(
    (entry) => entry.archivePath === "Workspace/diagram.png",
  );
  const copy = prepared.privateManifest.binaryEntries.find(
    (entry) => entry.archivePath === "Workspace/copy.png",
  );
  assert.equal(diagram.sha256, sha256(data.png));
  assert.equal(copy.sha256, diagram.sha256);
  assert.equal(
    diagram.crc32,
    (crc32(data.png) >>> 0).toString(16).padStart(8, "0"),
  );
  assert.deepEqual(
    await readFile(
      path.join(data.outputDirectory, diagram.extractedRelativePath),
    ),
    data.png,
  );
  assert.deepEqual(
    await readFile(
      path.join(
        data.outputDirectory,
        prepared.privateManifest.csvEntries[0].extractedRelativePath,
      ),
    ),
    Buffer.from("Name\nRow\n"),
  );

  assert.equal(
    await verifyPreparedPublicationAssets({
      imported: prepared.imported,
      privateManifest: prepared.privateManifest,
      outputDirectory: data.outputDirectory,
    }),
    3,
  );

  const repeated = await preparePublicationAssets({
    imported: data.imported,
    outputDirectory: data.outputDirectory,
  });
  assert.deepEqual(repeated.publicManifest, prepared.publicManifest);
  assert.deepEqual(repeated.privateManifest, prepared.privateManifest);
});

test("rejects archive traversal before any file can escape the extraction root", async () => {
  const data = await fixture({ traversal: true });
  await assert.rejects(
    preparePublicationAssets({
      imported: data.imported,
      outputDirectory: data.outputDirectory,
    }),
    /publication-unsafe-zip-entry-path/,
  );
  await assert.rejects(
    readFile(path.join(data.outputDirectory, "..", "escape.bin")),
  );
});

test("refuses an existing extracted file whose bytes do not match the ZIP entry", async () => {
  const data = await fixture();
  const conflicting = path.join(
    data.outputDirectory,
    "notion-zip-attachments",
    "Workspace",
    "diagram.png",
  );
  await mkdir(path.dirname(conflicting), { recursive: true });
  await writeFile(conflicting, "tampered");

  await assert.rejects(
    preparePublicationAssets({
      imported: data.imported,
      outputDirectory: data.outputDirectory,
    }),
    /publication-existing-file-hash-mismatch/,
  );
});

test("refuses a source archive whose byte denominator changed after conversion", async () => {
  const data = await fixture();
  data.imported.source.archiveBytes += 1;

  await assert.rejects(
    preparePublicationAssets({
      imported: data.imported,
      outputDirectory: data.outputDirectory,
    }),
    /publication-source-denominator-mismatch/,
  );
});

test("verification reconstructs the exact original body, not only the destination count", async () => {
  const data = await fixture();
  const prepared = await preparePublicationAssets({
    imported: data.imported,
    outputDirectory: data.outputDirectory,
  });
  prepared.imported.pages[0].body = prepared.imported.pages[0].body.replace(
    "diagram]",
    "changed-label]",
  );

  await assert.rejects(
    verifyPreparedPublicationAssets({
      imported: prepared.imported,
      privateManifest: prepared.privateManifest,
      outputDirectory: data.outputDirectory,
    }),
    /publication-body-reconstruction-mismatch/,
  );
});
