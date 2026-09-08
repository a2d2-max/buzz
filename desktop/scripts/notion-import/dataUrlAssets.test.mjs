import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, test } from "node:test";

import {
  prepareDataUrlAssets,
  verifyPreparedDataUrlAssets,
} from "./dataUrlAssets.ts";

const scratchDirectories = new Set();
const PAGE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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
    central.writeUInt32LE(checksum, 16);
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

async function fixture(body, attachmentBytes = Buffer.from("different")) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "notion-data-url-"));
  scratchDirectories.add(scratch);
  const archivePath = path.join(scratch, "input.zip");
  await writeFile(
    archivePath,
    makeStoredZip([
      { name: `Page ${PAGE_ID}.md`, data: Buffer.from("# Page") },
      { name: "same-size.bin", data: attachmentBytes },
      { name: "ignored.csv", data: Buffer.from("Name\nRow\n") },
    ]),
  );
  return {
    output: path.join(scratch, "output"),
    imported: {
      version: 1,
      source: { archivePath, archiveBytes: 1 },
      pages: [
        {
          id: PAGE_ID,
          idSource: "notion",
          sourcePath: `Page ${PAGE_ID}.md`,
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
        archiveEntryCount: 3,
        markdownFileCount: 1,
        pageCount: 1,
        pageFailureCount: 0,
        nativePageIdCount: 1,
        syntheticPageIdCount: 0,
        unresolvedParentCount: 0,
        ambiguousParentFolderCount: 0,
        databaseCount: 0,
        databaseCsvFileCount: 1,
        databaseRowCount: 0,
        inlineDatabaseCount: 0,
        pageLinkTargetCount: 0,
        linkResolvedCount: 0,
        linkUnresolvedCount: 0,
        relationResolvedCount: 0,
        relationAmbiguousCount: 0,
        relationUnresolvedCount: 0,
        relationNonemptyCellCount: 0,
        relationReferenceCount: 0,
        relationColumnCount: 0,
        attachmentFileCount: 1,
        attachmentReferenceCount: 4,
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

test("parser link, image, and definition data URLs extract deterministically while code stays literal", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02]);
  const dataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  const body = [
    `[link](${dataUrl})`,
    `![image](${dataUrl})`,
    "[definition][asset]",
    "",
    `[asset]: ${dataUrl}`,
    "",
    `\`${dataUrl}\``,
    "```text",
    dataUrl,
    "```",
  ].join("\n");
  const { imported } = await fixture(body, jpeg);

  const first = await prepareDataUrlAssets(imported);
  const second = await prepareDataUrlAssets(imported);

  assert.equal(first.publicManifest.occurrenceCount, 3);
  assert.equal(first.publicManifest.pageCount, 1);
  assert.equal(first.publicManifest.uniqueAssetCount, 1);
  assert.equal(first.publicManifest.decodedBytes, jpeg.length);
  assert.equal(first.publicManifest.zipAttachmentFileCount, 1);
  assert.equal(first.publicManifest.zipAttachmentMatchedUniqueAssetCount, 1);
  assert.equal(first.publicManifest.zipAttachmentMatchCount, 1);
  assert.equal(first.publicManifest.existingAttachmentReferenceCount, 4);
  assert.equal(first.publicManifest.assetBindingsComplete, false);
  assert.equal(first.publicManifest.status, "pending-url-binding");
  assert.deepEqual(first.publicManifest, second.publicManifest);
  assert.deepEqual(first.privateManifest, second.privateManifest);
  assert.match(first.imported.pages[0].body, /notion-inline-assets/);
  assert.match(first.imported.pages[0].body, new RegExp(`\\\`${dataUrl}\\\``));
  assert.match(
    first.imported.pages[0].body,
    new RegExp(`text\\n${dataUrl}\\n`),
  );
});

test("a label equal to its data URL stays intact while the destination is replaced", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x05, 0x06]);
  const dataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  const { imported } = await fixture(`[${dataUrl}](${dataUrl} "${dataUrl}")`);
  const prepared = await prepareDataUrlAssets(imported);

  assert.match(prepared.imported.pages[0].body, new RegExp(`^\\[${dataUrl}`));
  assert.match(
    prepared.imported.pages[0].body,
    /\]\(\.\/notion-inline-assets\//,
  );
  assert.match(prepared.imported.pages[0].body, new RegExp(`"${dataUrl}"\\)$`));
  const reparsed = await prepareDataUrlAssets(prepared.imported);
  assert.equal(reparsed.publicManifest.occurrenceCount, 0);
});

test("reconstruction reads extracted bytes and detects missing or changed files", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x03, 0x04]);
  const dataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  const { imported, output } = await fixture(`[asset](${dataUrl})`);
  const prepared = await prepareDataUrlAssets(imported);
  const asset = prepared.publicManifest.assets[0];
  const assetDirectory = path.join(output, "notion-inline-assets");
  await mkdir(assetDirectory, { recursive: true });
  await writeFile(
    path.join(output, asset.relativePath),
    prepared.assetBytes.get(asset.sha256),
  );

  assert.equal(
    await verifyPreparedDataUrlAssets({
      original: imported,
      prepared: prepared.imported,
      privateManifest: prepared.privateManifest,
      assetDirectory,
    }),
    1,
  );

  await writeFile(
    path.join(output, asset.relativePath),
    Buffer.from("tampered"),
  );
  await assert.rejects(
    verifyPreparedDataUrlAssets({
      original: imported,
      prepared: prepared.imported,
      privateManifest: prepared.privateManifest,
      assetDirectory,
    }),
    /data-url-asset-hash-mismatch/,
  );
});

test("invalid base64, unsupported MIME, and signature mismatch block preparation", async () => {
  for (const [url, reason] of [
    ["data:image/jpeg;base64,%%%", "data-url-invalid-base64"],
    ["data:text/plain;base64,dGV4dA==", "data-url-unsupported-format"],
    ["data:image/jpeg;base64,dGV4dA==", "data-url-signature-mismatch"],
  ]) {
    const { imported } = await fixture(`[asset](${url})`);
    await assert.rejects(prepareDataUrlAssets(imported), new RegExp(reason));
  }
});
