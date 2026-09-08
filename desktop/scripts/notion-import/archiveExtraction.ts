import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";
import unzipper from "unzipper";

import { normalizeArchivePath } from "./zipReader.ts";

const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_EXTRACTED_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_EXTRACTED_BYTES = 4 * 1024 * 1024 * 1024;

export type ExtractedArchiveEntry = {
  archiveIndex: number;
  archivePath: string;
  bytes: number;
  compressedBytes: number;
  crc32: string;
  sha256: string;
  mime: string;
  mimeSource: "extension" | "magic" | "opaque";
  extractedRelativePath: string;
};

export type ExtractedArchiveAssets = {
  archiveBytes: number;
  archiveEntryCount: number;
  sourceArchiveSha256: string;
  binaryEntries: ExtractedArchiveEntry[];
  csvEntries: ExtractedArchiveEntry[];
};

async function hashFile(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function extensionMime(entryPath: string): string | null {
  const extension = path.posix.extname(entryPath).toLowerCase();
  return (
    (
      {
        ".csv": "text/csv",
        ".docx":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".gif": "image/gif",
        ".html": "text/html",
        ".jpeg": "image/jpeg",
        ".jpg": "image/jpeg",
        ".json": "application/json",
        ".m4a": "audio/mp4",
        ".mov": "video/quicktime",
        ".mp4": "video/mp4",
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".txt": "text/plain",
        ".webp": "image/webp",
        ".xlsx":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".yaml": "application/yaml",
        ".yml": "application/yaml",
        ".zip": "application/zip",
      } as Record<string, string>
    )[extension] ?? null
  );
}

function sniffMime(prefix: Buffer): string | null {
  if (prefix.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return "image/jpeg";
  }
  if (
    prefix
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  const ascii = prefix.subarray(0, 16).toString("ascii");
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (ascii.startsWith("%PDF-")) return "application/pdf";
  if (ascii.startsWith("PK\u0003\u0004")) return "application/zip";
  if (
    prefix.length >= 12 &&
    ascii.startsWith("RIFF") &&
    prefix.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    prefix.length >= 12 &&
    prefix.subarray(4, 8).toString("ascii") === "ftyp"
  ) {
    return "application/iso-bmff";
  }
  return null;
}

async function ensureDirectoryWithoutSymlinks(
  root: string,
  relativeDirectory: string,
): Promise<void> {
  await mkdir(root, { recursive: true });
  let current = root;
  for (const component of relativeDirectory.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const existing = await lstat(current);
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new Error("publication-extraction-path-not-directory");
      }
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
      await mkdir(current);
    }
  }
}

async function verifyExistingFile(
  target: string,
  expectedBytes: number,
  expectedHash: string,
): Promise<boolean> {
  try {
    const existing = await lstat(target);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("publication-existing-path-not-file");
    }
    if (
      existing.size !== expectedBytes ||
      (await hashFile(target)) !== expectedHash
    ) {
      throw new Error("publication-existing-file-hash-mismatch");
    }
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function writeBufferAtEnd(
  handle: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      null,
    );
    if (bytesWritten <= 0)
      throw new Error("publication-extraction-write-failed");
    offset += bytesWritten;
  }
}

async function extractEntry(
  entry: unzipper.File,
  archiveIndex: number,
  archivePath: string,
  outputDirectory: string,
  category: "notion-csv-originals" | "notion-zip-attachments",
): Promise<ExtractedArchiveEntry> {
  if (
    !Number.isSafeInteger(entry.uncompressedSize) ||
    entry.uncompressedSize < 0 ||
    entry.uncompressedSize > MAX_EXTRACTED_ENTRY_BYTES ||
    !Number.isSafeInteger(entry.compressedSize) ||
    entry.compressedSize < 0 ||
    (entry.uncompressedSize > 0 && entry.compressedSize === 0) ||
    (entry.flags & 1) !== 0
  ) {
    throw new Error(
      `publication-zip-entry-invalid:entry-index=${archiveIndex}`,
    );
  }
  const relativePath = path.join(category, ...archivePath.split("/"));
  const extractionRoot = path.resolve(outputDirectory);
  const target = path.resolve(extractionRoot, relativePath);
  if (
    target !== extractionRoot &&
    !target.startsWith(`${extractionRoot}${path.sep}`)
  ) {
    throw new Error("publication-extraction-path-escaped");
  }
  await ensureDirectoryWithoutSymlinks(
    extractionRoot,
    path.dirname(relativePath),
  );

  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx");
  const hash = createHash("sha256");
  let checksum = 0;
  let bytesRead = 0;
  let prefix = Buffer.alloc(0);
  try {
    const stream = entry.stream();
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesRead += buffer.length;
      if (
        bytesRead > entry.uncompressedSize ||
        bytesRead > MAX_EXTRACTED_ENTRY_BYTES
      ) {
        stream.destroy();
        throw new Error(
          `publication-zip-entry-size-mismatch:entry-index=${archiveIndex}`,
        );
      }
      hash.update(buffer);
      checksum = crc32(buffer, checksum) >>> 0;
      if (prefix.length < 4096) {
        prefix = Buffer.concat([
          prefix,
          buffer.subarray(0, 4096 - prefix.length),
        ]);
      }
      await writeBufferAtEnd(handle, buffer);
    }
    if (bytesRead !== entry.uncompressedSize) {
      throw new Error(
        `publication-zip-entry-size-mismatch:entry-index=${archiveIndex}`,
      );
    }
    if (checksum !== entry.crc32 >>> 0) {
      throw new Error(
        `publication-zip-entry-crc-mismatch:entry-index=${archiveIndex}`,
      );
    }
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();

  const digest = hash.digest("hex");
  if (await verifyExistingFile(target, bytesRead, digest)) {
    await unlink(temporary);
  } else {
    try {
      await link(temporary, target);
      await unlink(temporary);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      ) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      await verifyExistingFile(target, bytesRead, digest);
      await unlink(temporary);
    }
  }

  const magicMime = sniffMime(prefix);
  const declaredMime = extensionMime(archivePath);
  return {
    archiveIndex,
    archivePath,
    bytes: bytesRead,
    compressedBytes: entry.compressedSize,
    crc32: checksum.toString(16).padStart(8, "0"),
    sha256: digest,
    mime: magicMime ?? declaredMime ?? "application/octet-stream",
    mimeSource: magicMime ? "magic" : declaredMime ? "extension" : "opaque",
    extractedRelativePath: relativePath.split(path.sep).join("/"),
  };
}

/** Securely extract every original binary and CSV entry without overwriting. */
export async function extractArchiveAssets(
  archivePath: string,
  outputDirectory: string,
): Promise<ExtractedArchiveAssets> {
  const archiveStat = await stat(archivePath);
  if (!archiveStat.isFile() || archiveStat.size > MAX_ARCHIVE_BYTES) {
    throw new Error("publication-archive-invalid");
  }
  const directory = await unzipper.Open.file(archivePath);
  if (directory.files.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error("publication-zip-entry-count-too-large");
  }
  const seen = new Set<string>();
  const binaryEntries: ExtractedArchiveEntry[] = [];
  const csvEntries: ExtractedArchiveEntry[] = [];
  let totalExtractedBytes = 0;
  let archiveEntryCount = 0;
  for (const [archiveIndex, entry] of directory.files.entries()) {
    if (entry.type !== "File") continue;
    archiveEntryCount += 1;
    let entryPath: string;
    try {
      entryPath = normalizeArchivePath(entry.path);
    } catch {
      throw new Error("publication-unsafe-zip-entry-path");
    }
    if (!entryPath || seen.has(entryPath)) {
      throw new Error("publication-duplicate-zip-entry");
    }
    seen.add(entryPath);
    const extension = path.posix.extname(entryPath).toLowerCase();
    if (extension === ".md") continue;
    totalExtractedBytes += entry.uncompressedSize;
    if (
      !Number.isSafeInteger(totalExtractedBytes) ||
      totalExtractedBytes > MAX_TOTAL_EXTRACTED_BYTES
    ) {
      throw new Error("publication-extracted-total-too-large");
    }
    const category =
      extension === ".csv" ? "notion-csv-originals" : "notion-zip-attachments";
    const extracted = await extractEntry(
      entry,
      archiveIndex,
      entryPath,
      outputDirectory,
      category,
    );
    if (extension === ".csv") csvEntries.push(extracted);
    else binaryEntries.push(extracted);
  }
  return {
    archiveBytes: archiveStat.size,
    archiveEntryCount,
    sourceArchiveSha256: await hashFile(archivePath),
    binaryEntries,
    csvEntries,
  };
}

/** Hash a retained extracted file without loading it into memory. */
export async function verifyExtractedEntry(
  outputDirectory: string,
  entry: ExtractedArchiveEntry,
): Promise<void> {
  const target = path.resolve(outputDirectory, entry.extractedRelativePath);
  const root = path.resolve(outputDirectory);
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error("publication-extraction-path-escaped");
  }
  if (!(await verifyExistingFile(target, entry.bytes, entry.sha256))) {
    throw new Error("publication-extracted-file-missing");
  }
}
