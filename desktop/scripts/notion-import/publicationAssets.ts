import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  type ExtractedArchiveEntry,
  extractArchiveAssets,
  verifyExtractedEntry,
} from "./archiveExtraction.ts";
import {
  prepareDataUrlAssets,
  verifyPreparedDataUrlAssets,
} from "./dataUrlAssets.ts";
import {
  collectMarkdownDestinations,
  rewriteMarkdownDestinations,
} from "./markdownDestinations.ts";
import { expandNotionHtml, extractPageDocument } from "./markdown.ts";
import type { NotionImport } from "./types.ts";
import { readNotionZip } from "./zipReader.ts";

export type PublicationAssetReference = {
  referenceId: string;
  pageId: string;
  nodeType: "definition" | "image" | "link";
  sourceKind: "inline" | "zip-binary";
  sourceSha256: string;
  originalTarget: string;
  placeholder: string;
  archivePath: string | null;
};

export type PublicationPageMapping = {
  pageId: string;
  inputBodySha256: string;
  preparedBodySha256: string;
  referenceCount: number;
};

export type PrivatePublicationAssetManifest = {
  version: 1;
  sourceArchiveSha256: string;
  binaryEntries: ExtractedArchiveEntry[];
  csvEntries: ExtractedArchiveEntry[];
  references: PublicationAssetReference[];
  pages: PublicationPageMapping[];
};

export type PublicationUploadAsset = {
  sourceSha256: string;
  bytes: number;
  mime: string;
  sourceKinds: Array<"inline" | "zip-binary">;
  entryCount: number;
  referenceCount: number;
  uploadStatus: "not-uploaded";
  remoteSha256: null;
  remoteUrl: null;
  readbackVerified: false;
};

export type PublicPublicationAssetManifest = {
  version: 1;
  status: "no-assets" | "pending-production-binding";
  sourceArchiveSha256: string;
  archiveBytes: number;
  archiveEntryCount: number;
  binaryEntryCount: number;
  binaryUniqueCount: number;
  binaryReferenceCount: number;
  inlineEntryCount: number;
  inlineUniqueCount: number;
  combinedEntryCount: number;
  combinedUniqueCount: number;
  totalReferenceCount: number;
  csvEntryCount: number;
  csvUniqueCount: number;
  csvReferenceCount: number;
  unreferencedBinaryEntryCount: number;
  unreferencedCsvEntryCount: number;
  extractedBinaryEntryCount: number;
  extractedCsvEntryCount: number;
  verifiedReferenceCount: number;
  assetBindingsComplete: boolean;
  bindingMode: "none";
  readyForSigning: boolean;
  readyToPublish: false;
  uploadAssets: PublicationUploadAsset[];
};

export type PreparedPublicationAssets = {
  imported: NotionImport;
  publicManifest: PublicPublicationAssetManifest;
  privateManifest: PrivatePublicationAssetManifest;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isExternalUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//");
}

function resolveLocalTarget(sourcePath: string, rawUrl: string): string | null {
  const withoutFragment = rawUrl.split(/[?#]/, 1)[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutFragment).normalize("NFC");
  } catch {
    return null;
  }
  if (isExternalUrl(decoded)) return null;
  return path.posix
    .resolve("/", path.posix.dirname(sourcePath), decoded)
    .slice(1);
}

function safeExtension(entryPath: string): string {
  const extension = path.posix.extname(entryPath).slice(1).toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(extension) ? extension : "bin";
}

async function writeInlineAsset(
  outputDirectory: string,
  relativePath: string,
  bytes: Buffer,
  expectedHash: string,
): Promise<void> {
  const root = path.resolve(outputDirectory);
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error("publication-inline-path-escaped");
  }
  await mkdir(path.dirname(target), { recursive: true });
  try {
    const existing = await lstat(target);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("publication-existing-path-not-file");
    }
    const existingBytes = await readFile(target);
    if (sha256(existingBytes) !== expectedHash) {
      throw new Error("publication-existing-file-hash-mismatch");
    }
    return;
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    try {
      await link(temporary, target);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      ) {
        throw error;
      }
      const existing = await lstat(target);
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new Error("publication-existing-path-not-file");
      }
      const existingBytes = await readFile(target);
      if (sha256(existingBytes) !== expectedHash) {
        throw new Error("publication-existing-file-hash-mismatch");
      }
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    });
  }
}

function countRawArchiveReferences(
  archive: Awaited<ReturnType<typeof readNotionZip>>,
  imported: NotionImport,
  binaryPaths: Set<string>,
  csvPaths: Set<string>,
): { binary: Map<string, number>; csv: Map<string, number> } {
  const pagesByPath = new Map(
    imported.pages.map((page) => [page.sourcePath, page]),
  );
  const binary = new Map<string, number>();
  const csv = new Map<string, number>();
  for (const entry of archive.textEntries) {
    if (
      !entry.path.toLowerCase().endsWith(".md") ||
      !pagesByPath.has(entry.path)
    ) {
      continue;
    }
    const body = expandNotionHtml(
      extractPageDocument(entry.path, entry.text).body,
    );
    for (const destination of collectMarkdownDestinations(body)) {
      const target = resolveLocalTarget(entry.path, destination.url);
      if (!target) continue;
      if (binaryPaths.has(target))
        binary.set(target, (binary.get(target) ?? 0) + 1);
      if (csvPaths.has(target)) csv.set(target, (csv.get(target) ?? 0) + 1);
    }
  }
  return { binary, csv };
}

function buildUploadAssets(
  binaryEntries: ExtractedArchiveEntry[],
  inlineAssets: Awaited<
    ReturnType<typeof prepareDataUrlAssets>
  >["publicManifest"]["assets"],
  references: PublicationAssetReference[],
): PublicationUploadAsset[] {
  const byHash = new Map<
    string,
    {
      bytes: number;
      mime: string;
      sourceKinds: Set<"inline" | "zip-binary">;
      entryCount: number;
    }
  >();
  for (const entry of binaryEntries) {
    const current = byHash.get(entry.sha256) ?? {
      bytes: entry.bytes,
      mime: entry.mime,
      sourceKinds: new Set<"inline" | "zip-binary">(),
      entryCount: 0,
    };
    if (current.bytes !== entry.bytes)
      throw new Error("publication-hash-size-conflict");
    current.sourceKinds.add("zip-binary");
    current.entryCount += 1;
    byHash.set(entry.sha256, current);
  }
  for (const asset of inlineAssets) {
    const current = byHash.get(asset.sha256) ?? {
      bytes: asset.bytes,
      mime: asset.mime,
      sourceKinds: new Set<"inline" | "zip-binary">(),
      entryCount: 0,
    };
    if (current.bytes !== asset.bytes)
      throw new Error("publication-hash-size-conflict");
    current.sourceKinds.add("inline");
    current.entryCount += 1;
    byHash.set(asset.sha256, current);
  }
  return [...byHash.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceSha256, asset]) => ({
      sourceSha256,
      bytes: asset.bytes,
      mime: asset.mime,
      sourceKinds: [...asset.sourceKinds].sort(),
      entryCount: asset.entryCount,
      referenceCount: references.filter(
        (reference) => reference.sourceSha256 === sourceSha256,
      ).length,
      uploadStatus: "not-uploaded" as const,
      remoteSha256: null,
      remoteUrl: null,
      readbackVerified: false as const,
    }));
}

/** Extract and prepare every source attachment without making network calls. */
export async function preparePublicationAssets({
  imported,
  outputDirectory,
}: {
  imported: NotionImport;
  outputDirectory: string;
}): Promise<PreparedPublicationAssets> {
  let archive: Awaited<ReturnType<typeof readNotionZip>>;
  try {
    archive = await readNotionZip(imported.source.archivePath);
  } catch (error) {
    if (error instanceof Error && error.message === "unsafe-zip-entry-path") {
      throw new Error("publication-unsafe-zip-entry-path");
    }
    throw error;
  }
  const archiveCsvEntryCount = archive.textEntries.filter((entry) =>
    entry.path.toLowerCase().endsWith(".csv"),
  ).length;
  if (
    archive.archiveBytes !== imported.source.archiveBytes ||
    archive.archiveEntryCount !== imported.report.archiveEntryCount ||
    archive.attachments.length !== imported.report.attachmentFileCount ||
    archiveCsvEntryCount !== imported.report.databaseCsvFileCount
  ) {
    throw new Error("publication-source-denominator-mismatch");
  }
  const extracted = await extractArchiveAssets(
    imported.source.archivePath,
    outputDirectory,
  );
  if (
    extracted.archiveEntryCount !== imported.report.archiveEntryCount ||
    extracted.binaryEntries.length !== imported.report.attachmentFileCount ||
    extracted.csvEntries.length !== imported.report.databaseCsvFileCount
  ) {
    throw new Error("publication-source-denominator-mismatch");
  }

  const inline = await prepareDataUrlAssets(imported);
  for (const asset of inline.publicManifest.assets) {
    const bytes = inline.assetBytes.get(asset.sha256);
    if (!bytes) throw new Error("publication-inline-bytes-missing");
    await writeInlineAsset(
      outputDirectory,
      asset.relativePath,
      bytes,
      asset.sha256,
    );
  }
  inline.publicManifest.reconstructionVerifiedPageCount =
    await verifyPreparedDataUrlAssets({
      original: imported,
      prepared: inline.imported,
      privateManifest: inline.privateManifest,
      assetDirectory: path.join(outputDirectory, "notion-inline-assets"),
    });

  const binaryByPath = new Map(
    extracted.binaryEntries.map((entry) => [entry.archivePath, entry]),
  );
  const csvByPath = new Map(
    extracted.csvEntries.map((entry) => [entry.archivePath, entry]),
  );
  const rawReferences = countRawArchiveReferences(
    archive,
    imported,
    new Set(binaryByPath.keys()),
    new Set(csvByPath.keys()),
  );
  const prepared = structuredClone(inline.imported);
  const references: PublicationAssetReference[] =
    inline.privateManifest.occurrences.map((occurrence, index) => ({
      referenceId: `inline-${(index + 1).toString().padStart(6, "0")}`,
      pageId: occurrence.pageId,
      nodeType: occurrence.nodeType,
      sourceKind: "inline",
      sourceSha256: occurrence.assetSha256,
      originalTarget: occurrence.rawDataUrl,
      placeholder: occurrence.placeholder,
      archivePath: null,
    }));
  const pages: PublicationPageMapping[] = [];
  let binaryReferenceIndex = 0;
  for (const page of prepared.pages) {
    const inputBody = imported.pages.find(
      (candidate) => candidate.id === page.id,
    )?.body;
    if (inputBody === undefined) throw new Error("publication-page-mismatch");
    const beforeCount = references.length;
    const rewritten = rewriteMarkdownDestinations(page.body, (destination) => {
      const target = resolveLocalTarget(page.sourcePath, destination.url);
      const entry = target ? binaryByPath.get(target) : undefined;
      if (!entry) return null;
      binaryReferenceIndex += 1;
      const referenceId = `binary-${binaryReferenceIndex
        .toString()
        .padStart(6, "0")}`;
      const placeholder = `./notion-publication-assets/${entry.sha256}.${safeExtension(
        entry.archivePath,
      )}#${referenceId}`;
      references.push({
        referenceId,
        pageId: page.id,
        nodeType: destination.nodeType,
        sourceKind: "zip-binary",
        sourceSha256: entry.sha256,
        originalTarget: destination.url,
        placeholder,
        archivePath: entry.archivePath,
      });
      return placeholder;
    });
    page.body = rewritten.body;
    const referenceCount =
      references.length -
      beforeCount +
      references.filter(
        (reference) =>
          reference.pageId === page.id && reference.sourceKind === "inline",
      ).length;
    if (referenceCount > 0) {
      pages.push({
        pageId: page.id,
        inputBodySha256: sha256(inputBody),
        preparedBodySha256: sha256(page.body),
        referenceCount,
      });
    }
  }

  const binaryReferenceCount = references.filter(
    (reference) => reference.sourceKind === "zip-binary",
  ).length;
  if (
    binaryReferenceCount !== imported.report.attachmentReferenceCount ||
    [...rawReferences.binary.values()].reduce(
      (sum, count) => sum + count,
      0,
    ) !== imported.report.attachmentReferenceCount
  ) {
    throw new Error("publication-binary-reference-denominator-mismatch");
  }
  const csvReferenceCount = [...rawReferences.csv.values()].reduce(
    (sum, count) => sum + count,
    0,
  );
  if (csvReferenceCount !== imported.report.inlineDatabaseCount) {
    throw new Error("publication-csv-reference-denominator-mismatch");
  }

  const uploadAssets = buildUploadAssets(
    extracted.binaryEntries,
    inline.publicManifest.assets,
    references,
  );
  const binaryUniqueCount = new Set(
    extracted.binaryEntries.map((entry) => entry.sha256),
  ).size;
  const inlineUniqueCount = inline.publicManifest.uniqueAssetCount;
  const combinedEntryCount =
    extracted.binaryEntries.length + inline.publicManifest.occurrenceCount;
  const combinedUniqueCount = uploadAssets.length;
  const referencedBinaryPaths = new Set(rawReferences.binary.keys());
  const referencedCsvPaths = new Set(rawReferences.csv.keys());
  const privateManifest: PrivatePublicationAssetManifest = {
    version: 1,
    sourceArchiveSha256: extracted.sourceArchiveSha256,
    binaryEntries: extracted.binaryEntries,
    csvEntries: extracted.csvEntries,
    references,
    pages,
  };
  const publicManifest: PublicPublicationAssetManifest = {
    version: 1,
    status:
      uploadAssets.length === 0 ? "no-assets" : "pending-production-binding",
    sourceArchiveSha256: extracted.sourceArchiveSha256,
    archiveBytes: extracted.archiveBytes,
    archiveEntryCount: extracted.archiveEntryCount,
    binaryEntryCount: extracted.binaryEntries.length,
    binaryUniqueCount,
    binaryReferenceCount,
    inlineEntryCount: inline.publicManifest.occurrenceCount,
    inlineUniqueCount,
    combinedEntryCount,
    combinedUniqueCount,
    totalReferenceCount: references.length,
    csvEntryCount: extracted.csvEntries.length,
    csvUniqueCount: new Set(extracted.csvEntries.map((entry) => entry.sha256))
      .size,
    csvReferenceCount,
    unreferencedBinaryEntryCount: extracted.binaryEntries.filter(
      (entry) => !referencedBinaryPaths.has(entry.archivePath),
    ).length,
    unreferencedCsvEntryCount: extracted.csvEntries.filter(
      (entry) => !referencedCsvPaths.has(entry.archivePath),
    ).length,
    extractedBinaryEntryCount: extracted.binaryEntries.length,
    extractedCsvEntryCount: extracted.csvEntries.length,
    verifiedReferenceCount: 0,
    assetBindingsComplete: uploadAssets.length === 0,
    bindingMode: "none",
    readyForSigning: uploadAssets.length === 0,
    readyToPublish: false,
    uploadAssets,
  };
  publicManifest.verifiedReferenceCount = await verifyPreparedPublicationAssets(
    {
      imported: prepared,
      privateManifest,
      outputDirectory,
    },
  );
  return { imported: prepared, privateManifest, publicManifest };
}

/** Verify retained bytes and every prepared destination against the manifest. */
export async function verifyPreparedPublicationAssets({
  imported,
  privateManifest,
  outputDirectory,
}: {
  imported: NotionImport;
  privateManifest: PrivatePublicationAssetManifest;
  outputDirectory: string;
}): Promise<number> {
  for (const entry of [
    ...privateManifest.binaryEntries,
    ...privateManifest.csvEntries,
  ]) {
    await verifyExtractedEntry(outputDirectory, entry);
  }
  const binaryPaths = new Set(
    privateManifest.binaryEntries.map((entry) => entry.archivePath),
  );
  const csvPaths = new Set(
    privateManifest.csvEntries.map((entry) => entry.archivePath),
  );
  const referencesByPage = new Map<string, PublicationAssetReference[]>();
  for (const reference of privateManifest.references) {
    const current = referencesByPage.get(reference.pageId) ?? [];
    current.push(reference);
    referencesByPage.set(reference.pageId, current);
  }
  let verified = 0;
  for (const page of imported.pages) {
    const expected = referencesByPage.get(page.id) ?? [];
    const destinations = collectMarkdownDestinations(page.body);
    const destinationCounts = new Map<string, number>();
    const reconstructionReplacements: Array<{
      start: number;
      end: number;
      originalTarget: string;
    }> = [];
    for (const destination of destinations) {
      destinationCounts.set(
        destination.url,
        (destinationCounts.get(destination.url) ?? 0) + 1,
      );
      if (destination.url.toLowerCase().startsWith("data:")) {
        throw new Error("publication-data-url-remains");
      }
      const archiveTarget = resolveLocalTarget(
        page.sourcePath,
        destination.url,
      );
      if (archiveTarget && binaryPaths.has(archiveTarget)) {
        throw new Error("publication-archive-destination-remains");
      }
      if (archiveTarget && csvPaths.has(archiveTarget)) {
        throw new Error("publication-csv-destination-remains");
      }
      const reference = expected.find(
        (candidate) => candidate.placeholder === destination.url,
      );
      if (reference) {
        reconstructionReplacements.push({
          start: destination.start,
          end: destination.end,
          originalTarget: reference.originalTarget,
        });
      }
    }
    for (const reference of expected) {
      if (destinationCounts.get(reference.placeholder) !== 1) {
        throw new Error("publication-placeholder-mismatch");
      }
      verified += 1;
    }
    const mapping = privateManifest.pages.find(
      (candidate) => candidate.pageId === page.id,
    );
    if (mapping) {
      let reconstructed = page.body;
      for (const replacement of reconstructionReplacements.sort(
        (left, right) => right.start - left.start,
      )) {
        reconstructed =
          reconstructed.slice(0, replacement.start) +
          replacement.originalTarget +
          reconstructed.slice(replacement.end);
      }
      if (sha256(reconstructed) !== mapping.inputBodySha256) {
        throw new Error("publication-body-reconstruction-mismatch");
      }
    }
  }

  const inlineByHash = new Map(
    privateManifest.references
      .filter((reference) => reference.sourceKind === "inline")
      .map((reference) => [
        reference.sourceSha256,
        reference.placeholder.match(
          /^\.\/notion-inline-assets\/([0-9a-f]{64}\.[a-z]+)#/,
        )?.[1] ?? null,
      ]),
  );
  for (const [hash, filename] of inlineByHash) {
    if (!filename) throw new Error("publication-inline-placeholder-invalid");
    const bytes = await readFile(
      path.join(outputDirectory, "notion-inline-assets", filename),
    );
    if (sha256(bytes) !== hash)
      throw new Error("publication-inline-hash-mismatch");
  }
  if (verified !== privateManifest.references.length) {
    throw new Error("publication-reference-count-mismatch");
  }
  return verified;
}
