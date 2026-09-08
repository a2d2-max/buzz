import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";
import { fromMarkdown } from "mdast-util-from-markdown";
import unzipper from "unzipper";

import type { NotionImport } from "./types.ts";

const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_DATA_URL_ASSET_BYTES = 16 * 1024 * 1024;

type MarkdownNode = {
  type?: string;
  url?: string;
  children?: MarkdownNode[];
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
};

type Replacement = { start: number; end: number; value: string };

type DecodedAsset = {
  bytes: Buffer;
  extension: string;
  header: string;
  mime: SupportedImageMime;
  sha256: string;
};

type SupportedImageMime =
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export type DataUrlAssetOccurrence = {
  pageId: string;
  nodeType: "definition" | "image" | "link";
  placeholder: string;
  assetSha256: string;
  dataUrlHeader: string;
  rawDataUrl: string;
  rawDataUrlSha256: string;
  sourceUrlStart: number;
  sourceUrlEnd: number;
};

export type DataUrlPageMapping = {
  pageId: string;
  originalBodySha256: string;
  preparedBodySha256: string;
  occurrenceCount: number;
};

export type PrivateDataUrlManifest = {
  version: 1;
  occurrences: DataUrlAssetOccurrence[];
  pages: DataUrlPageMapping[];
};

export type PublicDataUrlAsset = {
  sha256: string;
  mime: SupportedImageMime;
  bytes: number;
  relativePath: string;
  occurrenceCount: number;
  zipAttachmentMatchCount: number;
  uploadStatus: "not-uploaded";
  remoteUrl: null;
};

export type PublicDataUrlManifest = {
  version: 1;
  status: "no-data-urls" | "pending-url-binding";
  occurrenceCount: number;
  pageCount: number;
  uniqueAssetCount: number;
  decodedBytes: number;
  zipAttachmentFileCount: number;
  zipAttachmentMatchedUniqueAssetCount: number;
  zipAttachmentMatchCount: number;
  existingAttachmentReferenceCount: number;
  reconstructionVerifiedPageCount: number;
  assetBindingsComplete: boolean;
  assets: PublicDataUrlAsset[];
};

export type PreparedDataUrlAssets = {
  imported: NotionImport;
  privateManifest: PrivateDataUrlManifest;
  publicManifest: PublicDataUrlManifest;
  assetBytes: Map<string, Buffer>;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function walk(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function applyReplacements(
  source: string,
  replacements: Replacement[],
): string {
  let result = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    result =
      result.slice(0, replacement.start) +
      replacement.value +
      result.slice(replacement.end);
  }
  return result;
}

function signatureMatches(mime: SupportedImageMime, bytes: Buffer): boolean {
  if (mime === "image/jpeg") {
    return (
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    );
  }
  if (mime === "image/png") {
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mime === "image/gif") {
    const signature = bytes.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

function extensionFor(mime: SupportedImageMime): string {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/gif") return "gif";
  return "webp";
}

function decodeDataUrl(rawUrl: string): DecodedAsset {
  const comma = rawUrl.indexOf(",");
  if (comma < 0) throw new Error("data-url-missing-payload");
  const header = rawUrl.slice(0, comma);
  const match = header.match(/^data:(image\/(?:gif|jpeg|png|webp));base64$/i);
  if (!match) throw new Error("data-url-unsupported-format");
  const mime = match[1].toLowerCase() as SupportedImageMime;
  const payload = rawUrl.slice(comma + 1);
  if (
    payload.length === 0 ||
    payload.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      payload,
    )
  ) {
    throw new Error("data-url-invalid-base64");
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length === 0 || bytes.length > MAX_DATA_URL_ASSET_BYTES) {
    throw new Error("data-url-asset-size-invalid");
  }
  if (bytes.toString("base64") !== payload) {
    throw new Error("data-url-invalid-base64");
  }
  if (!signatureMatches(mime, bytes)) {
    throw new Error("data-url-signature-mismatch");
  }
  return {
    bytes,
    extension: extensionFor(mime),
    header,
    mime,
    sha256: sha256(bytes),
  };
}

function urlReplacement(
  source: string,
  node: MarkdownNode,
  value: string,
): Replacement {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || node.url === undefined) {
    throw new Error("data-url-missing-source-position");
  }
  const nodeSource = source.slice(start, end);
  let destinationStart = 0;
  if (node.type === "definition") {
    const definitionDelimiter = nodeSource.lastIndexOf("]:");
    if (definitionDelimiter < 0)
      throw new Error("data-url-source-position-mismatch");
    destinationStart = definitionDelimiter + 2;
  } else if (nodeSource.startsWith("<") && nodeSource.endsWith(">")) {
    destinationStart = 1;
  } else {
    const inlineDelimiter = nodeSource.lastIndexOf("](");
    if (inlineDelimiter < 0)
      throw new Error("data-url-source-position-mismatch");
    destinationStart = inlineDelimiter + 2;
  }
  const relativeStart = nodeSource.indexOf(node.url, destinationStart);
  if (relativeStart < 0) throw new Error("data-url-source-position-mismatch");
  return {
    start: start + relativeStart,
    end: start + relativeStart + node.url.length,
    value,
  };
}

function assertNoPreparedDataUrlDestinations(body: string): void {
  const tree = fromMarkdown(body) as MarkdownNode;
  walk(tree, (node) => {
    if (
      (node.type === "link" ||
        node.type === "image" ||
        node.type === "definition") &&
      node.url?.toLowerCase().startsWith("data:")
    ) {
      throw new Error("data-url-destination-remains");
    }
  });
}

async function zipAttachmentMatches(
  archivePath: string,
  assets: Map<string, Buffer>,
): Promise<{ attachmentFileCount: number; matches: Map<string, number> }> {
  const archive = await stat(archivePath);
  if (!archive.isFile() || archive.size > MAX_ARCHIVE_BYTES) {
    throw new Error("asset-zip-input-invalid");
  }
  const directory = await unzipper.Open.file(archivePath);
  if (directory.files.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error("asset-zip-entry-count-too-large");
  }
  const hashesBySize = new Map<number, Set<string>>();
  for (const [hash, bytes] of assets) {
    const hashes = hashesBySize.get(bytes.length) ?? new Set<string>();
    hashes.add(hash);
    hashesBySize.set(bytes.length, hashes);
  }
  const matches = new Map<string, number>();
  let attachmentFileCount = 0;
  for (const [entryIndex, entry] of directory.files.entries()) {
    if (entry.type !== "File") continue;
    const extension = path.posix.extname(entry.path).toLowerCase();
    if (extension === ".md" || extension === ".csv") continue;
    attachmentFileCount += 1;
    const candidates = hashesBySize.get(entry.uncompressedSize);
    if (!candidates) continue;
    if (
      !Number.isSafeInteger(entry.uncompressedSize) ||
      entry.uncompressedSize < 0 ||
      entry.uncompressedSize > MAX_DATA_URL_ASSET_BYTES ||
      (entry.flags & 1) !== 0
    ) {
      throw new Error(`asset-zip-entry-invalid:entry-index=${entryIndex}`);
    }
    const hash = createHash("sha256");
    const checksumChunks: Buffer[] = [];
    let bytesRead = 0;
    const stream = entry.stream();
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesRead += buffer.length;
      if (
        bytesRead > entry.uncompressedSize ||
        bytesRead > MAX_DATA_URL_ASSET_BYTES
      ) {
        stream.destroy();
        throw new Error(
          `asset-zip-entry-size-mismatch:entry-index=${entryIndex}`,
        );
      }
      hash.update(buffer);
      checksumChunks.push(buffer);
    }
    if (bytesRead !== entry.uncompressedSize) {
      throw new Error(
        `asset-zip-entry-size-mismatch:entry-index=${entryIndex}`,
      );
    }
    const contents = Buffer.concat(checksumChunks, bytesRead);
    if (crc32(contents) >>> 0 !== entry.crc32 >>> 0) {
      throw new Error(`asset-zip-entry-crc-mismatch:entry-index=${entryIndex}`);
    }
    const digest = hash.digest("hex");
    if (candidates.has(digest))
      matches.set(digest, (matches.get(digest) ?? 0) + 1);
  }
  return { attachmentFileCount, matches };
}

/** Extracts parser-recognized Markdown data URLs without changing code ranges. */
export async function prepareDataUrlAssets(
  imported: NotionImport,
): Promise<PreparedDataUrlAssets> {
  const prepared = structuredClone(imported);
  const originalPages = new Map(imported.pages.map((page) => [page.id, page]));
  const occurrences: DataUrlAssetOccurrence[] = [];
  const pageMappings: DataUrlPageMapping[] = [];
  const assetBytes = new Map<string, Buffer>();
  const assetMetadata = new Map<
    string,
    { mime: SupportedImageMime; extension: string; occurrences: number }
  >();
  let occurrenceIndex = 0;

  for (const page of prepared.pages) {
    const originalPage = originalPages.get(page.id);
    if (!originalPage) throw new Error("data-url-page-mismatch");
    const source = originalPage.body;
    const tree = fromMarkdown(source) as MarkdownNode;
    const replacements: Replacement[] = [];
    const pageOccurrences: DataUrlAssetOccurrence[] = [];
    walk(tree, (node) => {
      if (
        (node.type !== "link" &&
          node.type !== "image" &&
          node.type !== "definition") ||
        typeof node.url !== "string" ||
        !node.url.toLowerCase().startsWith("data:")
      ) {
        return;
      }
      const asset = decodeDataUrl(node.url);
      occurrenceIndex += 1;
      const placeholder = `./notion-inline-assets/${asset.sha256}.${asset.extension}#ref-${occurrenceIndex.toString().padStart(6, "0")}`;
      const replacement = urlReplacement(source, node, placeholder);
      replacements.push(replacement);
      const occurrence: DataUrlAssetOccurrence = {
        pageId: page.id,
        nodeType: node.type,
        placeholder,
        assetSha256: asset.sha256,
        dataUrlHeader: asset.header,
        rawDataUrl: node.url,
        rawDataUrlSha256: sha256(node.url),
        sourceUrlStart: replacement.start,
        sourceUrlEnd: replacement.end,
      };
      occurrences.push(occurrence);
      pageOccurrences.push(occurrence);
      assetBytes.set(asset.sha256, asset.bytes);
      const metadata = assetMetadata.get(asset.sha256);
      if (metadata && metadata.mime !== asset.mime)
        throw new Error("data-url-hash-mime-conflict");
      assetMetadata.set(asset.sha256, {
        mime: asset.mime,
        extension: asset.extension,
        occurrences: (metadata?.occurrences ?? 0) + 1,
      });
    });
    page.body = applyReplacements(source, replacements);
    assertNoPreparedDataUrlDestinations(page.body);
    if (pageOccurrences.length > 0) {
      pageMappings.push({
        pageId: page.id,
        originalBodySha256: sha256(source),
        preparedBodySha256: sha256(page.body),
        occurrenceCount: pageOccurrences.length,
      });
    }
  }

  const comparison = await zipAttachmentMatches(
    imported.source.archivePath,
    assetBytes,
  );
  const assets = [...assetMetadata.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hash, metadata]) => ({
      sha256: hash,
      mime: metadata.mime,
      bytes: assetBytes.get(hash)?.length ?? 0,
      relativePath: `notion-inline-assets/${hash}.${metadata.extension}`,
      occurrenceCount: metadata.occurrences,
      zipAttachmentMatchCount: comparison.matches.get(hash) ?? 0,
      uploadStatus: "not-uploaded" as const,
      remoteUrl: null,
    }));
  const zipAttachmentMatchCount = assets.reduce(
    (sum, asset) => sum + asset.zipAttachmentMatchCount,
    0,
  );
  return {
    imported: prepared,
    privateManifest: { version: 1, occurrences, pages: pageMappings },
    publicManifest: {
      version: 1,
      status: occurrences.length === 0 ? "no-data-urls" : "pending-url-binding",
      occurrenceCount: occurrences.length,
      pageCount: pageMappings.length,
      uniqueAssetCount: assets.length,
      decodedBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
      zipAttachmentFileCount: comparison.attachmentFileCount,
      zipAttachmentMatchedUniqueAssetCount: assets.filter(
        (asset) => asset.zipAttachmentMatchCount > 0,
      ).length,
      zipAttachmentMatchCount,
      existingAttachmentReferenceCount:
        imported.report.attachmentReferenceCount,
      reconstructionVerifiedPageCount: 0,
      assetBindingsComplete: occurrences.length === 0,
      assets,
    },
    assetBytes,
  };
}

/** Verifies prepared bodies can reconstruct the immutable intermediate exactly. */
export async function verifyPreparedDataUrlAssets({
  original,
  prepared,
  privateManifest,
  assetDirectory,
}: {
  original: NotionImport;
  prepared: NotionImport;
  privateManifest: PrivateDataUrlManifest;
  assetDirectory: string;
}): Promise<number> {
  const originalPages = new Map(original.pages.map((page) => [page.id, page]));
  const preparedPages = new Map(prepared.pages.map((page) => [page.id, page]));
  let verified = 0;
  for (const mapping of privateManifest.pages) {
    const source = originalPages.get(mapping.pageId)?.body;
    let reconstructed = preparedPages.get(mapping.pageId)?.body;
    if (source === undefined || reconstructed === undefined)
      throw new Error("data-url-page-mismatch");
    const pageOccurrences = privateManifest.occurrences.filter(
      (occurrence) => occurrence.pageId === mapping.pageId,
    );
    for (const occurrence of pageOccurrences) {
      const matchingAsset = occurrence.placeholder.match(
        /^\.\/notion-inline-assets\/([0-9a-f]{64})\.([a-z]+)#ref-[0-9]{6}$/,
      );
      if (!matchingAsset || matchingAsset[1] !== occurrence.assetSha256) {
        throw new Error("data-url-placeholder-invalid");
      }
      const bytes = await readFile(
        path.join(
          assetDirectory,
          `${occurrence.assetSha256}.${matchingAsset[2]}`,
        ),
      );
      if (sha256(bytes) !== occurrence.assetSha256)
        throw new Error("data-url-asset-hash-mismatch");
      const rebuiltUrl = `${occurrence.dataUrlHeader},${bytes.toString("base64")}`;
      if (
        sha256(rebuiltUrl) !== occurrence.rawDataUrlSha256 ||
        rebuiltUrl !== occurrence.rawDataUrl
      ) {
        throw new Error("data-url-reconstruction-mismatch");
      }
      if (!reconstructed.includes(occurrence.placeholder)) {
        throw new Error("data-url-placeholder-missing");
      }
      reconstructed = reconstructed.replace(
        occurrence.placeholder,
        () => rebuiltUrl,
      );
    }
    if (
      sha256(source) !== mapping.originalBodySha256 ||
      sha256(preparedPages.get(mapping.pageId)?.body ?? "") !==
        mapping.preparedBodySha256 ||
      reconstructed !== source
    ) {
      throw new Error("data-url-body-reconstruction-mismatch");
    }
    verified += 1;
  }
  return verified;
}
