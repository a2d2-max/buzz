import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  PrivatePublicationAssetManifest,
  PublicPublicationAssetManifest,
} from "./publicationAssets.ts";
import {
  buildPublicationPreflight,
  type PublicationPreflight,
} from "./publicationPreflight.ts";
import type { NotionImport } from "./types.ts";

const execFileAsync = promisify(execFile);

const ARTIFACT_NAMES = [
  "notion-publication-assets.json",
  "notion-publication-assets.private.json",
  "notion-publication-bindings.simulated.json",
  "notion-publication-compatibility.json",
  "notion-publication-final.json",
  "notion-publication-preflight.json",
  "notion-publication-prepared.json",
  "notion-publication-status.json",
  "notion-publication-report.md",
] as const;

type FileDigest = {
  path: string;
  bytes: number;
  sha256: string;
};

type PageIdentityDigest = {
  pageCount: number;
  uniquePageIdCount: number;
  validParentCount: number;
  sha256: string;
};

export type PublicationEvidenceVerification = {
  version: 1;
  generatedAt: string;
  git: {
    head: string;
    tree: string;
    worktreeClean: boolean;
  };
  sources: {
    archive: FileDigest & {
      publicManifestSha256: string;
      privateManifestSha256: string;
      approvedSourcePath: string;
      approvedSourceBytes: number;
      matchesPublicManifest: boolean;
      matchesPrivateManifest: boolean;
      matchesArchiveByteDenominator: boolean;
      matchesApprovedSourcePath: boolean;
      matchesApprovedSourceBytes: boolean;
    };
    originalApprovedIntermediate: FileDigest;
  };
  artifacts: Array<FileDigest & { name: (typeof ARTIFACT_NAMES)[number] }>;
  pageIdentities: {
    algorithm: "sha256-utf8-json-id-parent-array-in-source-order";
    originalApproved: PageIdentityDigest;
    prepared: PageIdentityDigest;
    final: PageIdentityDigest;
    allMatch: boolean;
  };
  corpus: {
    reportedPreflightSha256: string;
    recomputedPreflightSha256: string;
    hashMatches: boolean;
    reported: {
      inputPageCount: number;
      uniquePageIdCount: number;
      validParentCount: number;
      codecValidatedPageCount: number;
      contentValidatedPageCount: number;
      eventCount: number;
      failureCount: number;
      complete: boolean;
    };
    recomputed: {
      inputPageCount: number;
      uniquePageIdCount: number;
      validParentCount: number;
      codecValidatedPageCount: number;
      contentValidatedPageCount: number;
      eventCount: number;
      failureCount: number;
      complete: boolean;
    };
    validationCountsMatch: boolean;
    matches: boolean;
  };
  denominators: {
    archiveEntryCount: number;
    binaryEntryCount: number;
    binaryUniqueCount: number;
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
  };
  complete: boolean;
  failures: string[];
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function digestFile(filePath: string): Promise<FileDigest> {
  const resolved = path.resolve(filePath);
  const metadata = await stat(resolved);
  if (!metadata.isFile()) throw new Error("publication-evidence-file-invalid");
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(resolved);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { path: resolved, bytes: metadata.size, sha256: hash.digest("hex") };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function pagesFrom(value: unknown): NotionImport["pages"] {
  if (
    !value ||
    typeof value !== "object" ||
    !("pages" in value) ||
    !Array.isArray(value.pages)
  ) {
    throw new Error("publication-evidence-pages-invalid");
  }
  for (const page of value.pages) {
    if (
      !page ||
      typeof page !== "object" ||
      !("id" in page) ||
      typeof page.id !== "string" ||
      !("parentId" in page) ||
      (page.parentId !== null && typeof page.parentId !== "string")
    ) {
      throw new Error("publication-evidence-pages-invalid");
    }
  }
  return value.pages as NotionImport["pages"];
}

function pageIdentityDigest(value: unknown): PageIdentityDigest {
  const pages = pagesFrom(value);
  const identities = pages.map((page) => ({
    id: page.id,
    parentId: page.parentId,
  }));
  const ids = new Set(identities.map((page) => page.id));
  return {
    pageCount: identities.length,
    uniquePageIdCount: ids.size,
    validParentCount: identities.filter(
      (page) =>
        page.parentId !== null &&
        page.parentId !== page.id &&
        ids.has(page.parentId),
    ).length,
    sha256: sha256(JSON.stringify(identities)),
  };
}

async function gitRevision(repoRoot: string): Promise<{
  head: string;
  tree: string;
  worktreeClean: boolean;
}> {
  const options = { cwd: path.resolve(repoRoot), encoding: "utf8" as const };
  const [head, tree, statusOutput] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], options),
    execFileAsync("git", ["rev-parse", "HEAD^{tree}"], options),
    execFileAsync("git", ["status", "--porcelain"], options),
  ]);
  return {
    head: head.stdout.trim(),
    tree: tree.stdout.trim(),
    worktreeClean: statusOutput.stdout.length === 0,
  };
}

function denominators(manifest: PublicPublicationAssetManifest) {
  return {
    archiveEntryCount: manifest.archiveEntryCount,
    binaryEntryCount: manifest.binaryEntryCount,
    binaryUniqueCount: manifest.binaryUniqueCount,
    inlineEntryCount: manifest.inlineEntryCount,
    inlineUniqueCount: manifest.inlineUniqueCount,
    combinedEntryCount: manifest.combinedEntryCount,
    combinedUniqueCount: manifest.combinedUniqueCount,
    totalReferenceCount: manifest.totalReferenceCount,
    csvEntryCount: manifest.csvEntryCount,
    csvUniqueCount: manifest.csvUniqueCount,
    csvReferenceCount: manifest.csvReferenceCount,
    unreferencedBinaryEntryCount: manifest.unreferencedBinaryEntryCount,
    unreferencedCsvEntryCount: manifest.unreferencedCsvEntryCount,
  };
}

function preflightSummary(preflight: PublicationPreflight) {
  return {
    inputPageCount: preflight.inputPageCount,
    uniquePageIdCount: preflight.uniquePageIdCount,
    validParentCount: preflight.validParentCount,
    codecValidatedPageCount: preflight.codecValidatedPageCount,
    contentValidatedPageCount: preflight.contentValidatedPageCount,
    eventCount: preflight.events.length,
    failureCount: preflight.failures.length,
    complete: preflight.complete,
  };
}

/** Rehash the retained publication evidence and compare approved page identities. */
export async function buildPublicationEvidenceVerification({
  repoRoot,
  sourceArchivePath,
  sourceIntermediatePath,
  outputDirectory,
}: {
  repoRoot: string;
  sourceArchivePath: string;
  sourceIntermediatePath: string;
  outputDirectory: string;
}): Promise<PublicationEvidenceVerification> {
  const output = path.resolve(outputDirectory);
  const publicManifestPath = path.join(
    output,
    "notion-publication-assets.json",
  );
  const privateManifestPath = path.join(
    output,
    "notion-publication-assets.private.json",
  );
  const preparedPath = path.join(output, "notion-publication-prepared.json");
  const finalPath = path.join(output, "notion-publication-final.json");
  const preflightPath = path.join(output, "notion-publication-preflight.json");
  const [
    git,
    archive,
    originalApprovedIntermediate,
    publicManifest,
    privateManifest,
    originalApproved,
    prepared,
    final,
    preflight,
    artifacts,
  ] = await Promise.all([
    gitRevision(repoRoot),
    digestFile(sourceArchivePath),
    digestFile(sourceIntermediatePath),
    readJson<PublicPublicationAssetManifest>(publicManifestPath),
    readJson<PrivatePublicationAssetManifest>(privateManifestPath),
    readJson<NotionImport>(sourceIntermediatePath),
    readJson<NotionImport>(preparedPath),
    readJson<NotionImport>(finalPath),
    readJson<PublicationPreflight>(preflightPath),
    Promise.all(
      ARTIFACT_NAMES.map(async (name) => ({
        name,
        ...(await digestFile(path.join(output, name))),
      })),
    ),
  ]);
  const originalApprovedIdentities = pageIdentityDigest(originalApproved);
  const preparedIdentities = pageIdentityDigest(prepared);
  const finalIdentities = pageIdentityDigest(final);
  const allIdentitiesMatch =
    originalApprovedIdentities.sha256 === preparedIdentities.sha256 &&
    originalApprovedIdentities.sha256 === finalIdentities.sha256 &&
    originalApprovedIdentities.pageCount === preparedIdentities.pageCount &&
    originalApprovedIdentities.pageCount === finalIdentities.pageCount;
  const recomputedPreflight = buildPublicationPreflight({
    imported: final,
    bindingStatus: preflight.bindingStatus,
    contentLimit: preflight.contentLimit,
  });
  const preflightHashMatches =
    preflight.corpusSha256 === recomputedPreflight.corpusSha256;
  const reportedPreflight = preflightSummary(preflight);
  const recomputedPreflightSummary = preflightSummary(recomputedPreflight);
  const validationCountsMatch =
    JSON.stringify(reportedPreflight) ===
    JSON.stringify(recomputedPreflightSummary);
  const approvedSourcePath = path.resolve(originalApproved.source.archivePath);
  const approvedSourceBytes = originalApproved.source.archiveBytes;
  const failures: string[] = [];
  if (archive.sha256 !== publicManifest.sourceArchiveSha256) {
    failures.push("source-archive-public-manifest-mismatch");
  }
  if (archive.sha256 !== privateManifest.sourceArchiveSha256) {
    failures.push("source-archive-private-manifest-mismatch");
  }
  if (archive.bytes !== publicManifest.archiveBytes) {
    failures.push("source-archive-byte-denominator-mismatch");
  }
  if (archive.path !== approvedSourcePath) {
    failures.push("source-intermediate-archive-path-mismatch");
  }
  if (archive.bytes !== approvedSourceBytes) {
    failures.push("source-intermediate-archive-byte-denominator-mismatch");
  }
  if (!allIdentitiesMatch) failures.push("page-identities-differ");
  if (!preflightHashMatches) failures.push("preflight-corpus-hash-mismatch");
  if (!validationCountsMatch)
    failures.push("preflight-validation-count-mismatch");
  if (!recomputedPreflight.complete)
    failures.push("recomputed-preflight-incomplete");
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    git,
    sources: {
      archive: {
        ...archive,
        publicManifestSha256: publicManifest.sourceArchiveSha256,
        privateManifestSha256: privateManifest.sourceArchiveSha256,
        approvedSourcePath,
        approvedSourceBytes,
        matchesPublicManifest:
          archive.sha256 === publicManifest.sourceArchiveSha256,
        matchesPrivateManifest:
          archive.sha256 === privateManifest.sourceArchiveSha256,
        matchesArchiveByteDenominator:
          archive.bytes === publicManifest.archiveBytes,
        matchesApprovedSourcePath: archive.path === approvedSourcePath,
        matchesApprovedSourceBytes: archive.bytes === approvedSourceBytes,
      },
      originalApprovedIntermediate,
    },
    artifacts,
    pageIdentities: {
      algorithm: "sha256-utf8-json-id-parent-array-in-source-order",
      originalApproved: originalApprovedIdentities,
      prepared: preparedIdentities,
      final: finalIdentities,
      allMatch: allIdentitiesMatch,
    },
    corpus: {
      reportedPreflightSha256: preflight.corpusSha256,
      recomputedPreflightSha256: recomputedPreflight.corpusSha256,
      hashMatches: preflightHashMatches,
      reported: reportedPreflight,
      recomputed: recomputedPreflightSummary,
      validationCountsMatch,
      matches:
        preflightHashMatches &&
        validationCountsMatch &&
        recomputedPreflight.complete,
    },
    denominators: denominators(publicManifest),
    complete: failures.length === 0,
    failures,
  };
}

/** Atomically persist the byte-derived publication evidence receipt. */
export async function writePublicationEvidenceVerification({
  receiptPath,
  ...options
}: Parameters<typeof buildPublicationEvidenceVerification>[0] & {
  receiptPath: string;
}): Promise<PublicationEvidenceVerification> {
  const receipt = await buildPublicationEvidenceVerification(options);
  const resolved = path.resolve(receiptPath);
  const temporary = `${resolved}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, resolved);
  return receipt;
}
