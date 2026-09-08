import { stat } from "node:fs/promises";
import { crc32 } from "node:zlib";
import unzipper from "unzipper";

const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_TEXT_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_TEXT_BYTES = 512 * 1024 * 1024;

export type ZipTextEntry = {
  archiveIndex: number;
  path: string;
  bytes: number;
  modifiedAtMs: number;
  text: string;
};

export type ZipAttachmentEntry = {
  archiveIndex: number;
  path: string;
  bytes: number;
};

export type NotionZipContents = {
  archiveBytes: number;
  archiveEntryCount: number;
  textEntries: ZipTextEntry[];
  attachments: ZipAttachmentEntry[];
};

function normalizeArchivePath(rawPath: string): string {
  if (rawPath.includes("\0") || rawPath.includes("\\")) {
    throw new Error("unsafe-zip-entry-path");
  }
  // ZIP names are already decoded by unzipper. A literal percent belongs to
  // the exported filename; percent decoding applies only to Markdown URLs.
  const normalized = rawPath.normalize("NFC");
  const parts = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    parts.some((part) => part === "." || part === "..")
  ) {
    throw new Error("unsafe-zip-entry-path");
  }
  return parts.filter(Boolean).join("/");
}

async function readBoundedEntry(
  entry: unzipper.File,
  entryIndex: number,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(entry.uncompressedSize) ||
    entry.uncompressedSize < 0 ||
    entry.uncompressedSize > MAX_TEXT_ENTRY_BYTES
  ) {
    throw new Error(`text-entry-too-large:entry-index=${entryIndex}`);
  }
  if (entry.uncompressedSize > 0 && entry.compressedSize === 0) {
    throw new Error(`invalid-compressed-size:entry-index=${entryIndex}`);
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  const stream = entry.stream();
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_TEXT_ENTRY_BYTES || bytes > entry.uncompressedSize) {
      stream.destroy(
        new Error(`text-entry-size-mismatch:entry-index=${entryIndex}`),
      );
      throw new Error(`text-entry-size-mismatch:entry-index=${entryIndex}`);
    }
    chunks.push(buffer);
  }
  if (bytes !== entry.uncompressedSize) {
    throw new Error(`text-entry-size-mismatch:entry-index=${entryIndex}`);
  }
  const contents = Buffer.concat(chunks, bytes);
  if (crc32(contents) >>> 0 !== entry.crc32 >>> 0) {
    throw new Error(`zip-entry-crc-mismatch:entry-index=${entryIndex}`);
  }
  return contents;
}

/**
 * Reads only Markdown and CSV bodies. Attachments stay compressed in the ZIP;
 * their central-directory metadata is enough for the import report.
 */
export async function readNotionZip(
  archivePath: string,
): Promise<NotionZipContents> {
  const archiveStat = await stat(archivePath);
  if (!archiveStat.isFile()) throw new Error("zip-input-is-not-a-file");
  if (archiveStat.size > MAX_ARCHIVE_BYTES) {
    throw new Error("zip-input-too-large");
  }

  const directory = await unzipper.Open.file(archivePath);
  if (directory.files.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error("zip-entry-count-too-large");
  }

  const seen = new Set<string>();
  const textEntries: ZipTextEntry[] = [];
  const attachments: ZipAttachmentEntry[] = [];
  let totalTextBytes = 0;

  for (const [archiveIndex, entry] of directory.files.entries()) {
    if (entry.type !== "File") continue;
    const entryPath = normalizeArchivePath(entry.path);
    if (!entryPath) continue;
    if (seen.has(entryPath))
      throw new Error(`duplicate-zip-entry:entry-index=${archiveIndex}`);
    seen.add(entryPath);

    const extension = entryPath.slice(entryPath.lastIndexOf(".")).toLowerCase();
    if (extension !== ".md" && extension !== ".csv") {
      attachments.push({
        archiveIndex,
        path: entryPath,
        bytes: entry.uncompressedSize,
      });
      continue;
    }

    totalTextBytes += entry.uncompressedSize;
    if (totalTextBytes > MAX_TOTAL_TEXT_BYTES) {
      throw new Error("zip-text-total-too-large");
    }
    if ((entry.flags & 1) !== 0)
      throw new Error(`encrypted-zip-entry:entry-index=${archiveIndex}`);
    const contents = await readBoundedEntry(entry, archiveIndex);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    } catch {
      throw new Error(`invalid-utf8-text-entry:entry-index=${archiveIndex}`);
    }
    textEntries.push({
      archiveIndex,
      path: entryPath,
      bytes: contents.length,
      modifiedAtMs: entry.lastModifiedDateTime.getTime(),
      text: text.replace(/^\uFEFF/, ""),
    });
  }

  return {
    archiveBytes: archiveStat.size,
    archiveEntryCount: directory.files.filter((entry) => entry.type === "File")
      .length,
    textEntries,
    attachments,
  };
}
