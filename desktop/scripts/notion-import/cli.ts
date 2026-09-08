import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { convertNotionArchive } from "./convert.ts";
import {
  prepareDataUrlAssets,
  verifyPreparedDataUrlAssets,
} from "./dataUrlAssets.ts";
import type { PreparedDataUrlAssets } from "./dataUrlAssets.ts";
import { bindPublicationAssetUrls } from "./publicationBindings.ts";
import type { PublicationBindingStatus } from "./publicationBindings.ts";
import { preparePublicationAssets } from "./publicationAssets.ts";
import type {
  PrivatePublicationAssetManifest,
  PublicPublicationAssetManifest,
} from "./publicationAssets.ts";
import { createBuzzCliPublicationApi } from "./buzzCliPublicationAdapter.ts";
import { buildPublicationPreflight } from "./publicationPreflight.ts";
import {
  buildPublicationCompatibilityReport,
  type PublicationCompatibilityReport,
} from "./publicationCompatibility.ts";
import { buildDryRun, parseIntermediate } from "./publish.ts";
import { writePublicationEvidenceVerification } from "./evidenceVerification.ts";
import {
  fetchRelayContentLimit,
  RelayContentLimitError,
} from "./relayContentLimit.ts";
import type { RelayContentLimit } from "./relayContentLimit.ts";
import { buildPublicReport, renderMarkdownReport } from "./report.ts";
import {
  executePublication,
  JsonPublicationJournalStore,
} from "./publicationExecutor.ts";
import type { ContentLimitProvenance } from "./types.ts";

const DEFAULT_OUTPUT = path.resolve("notion-import-output");

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeAtomic(
  filePath: string,
  contents: string | Uint8Array,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, contents, { flag: "wx" });
  await rename(temporary, filePath);
}

function required(value: string | undefined, option: string): string {
  if (!value) throw new Error(`missing-required-option:${option}`);
  return path.resolve(value);
}

function requiredValue(value: string | undefined, option: string): string {
  if (!value) throw new Error(`missing-required-option:${option}`);
  return value;
}

function safeRelayOrigin(relay: string): string | null {
  try {
    const parsed = new URL(relay);
    if (
      (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return null;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

const SAFE_ASSET_FAILURES = new Set([
  "asset-zip-input-invalid",
  "asset-zip-entry-count-too-large",
  "data-url-asset-size-invalid",
  "data-url-asset-bytes-missing",
  "data-url-body-reconstruction-mismatch",
  "data-url-destination-remains",
  "data-url-hash-mime-conflict",
  "data-url-existing-asset-hash-mismatch",
  "data-url-invalid-base64",
  "data-url-missing-payload",
  "data-url-missing-source-position",
  "data-url-page-mismatch",
  "data-url-placeholder-invalid",
  "data-url-placeholder-missing",
  "data-url-reconstruction-mismatch",
  "data-url-signature-mismatch",
  "data-url-source-position-mismatch",
  "data-url-unsupported-format",
]);

function safeAssetFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const code = message.split(":", 1)[0];
  return SAFE_ASSET_FAILURES.has(code) ? code : "data-url-preparation-failed";
}

function failedMarkdownReport(stage: string, reason: string): string {
  return [
    "# Notion import publish status",
    "",
    "## 결론",
    "",
    "dry-run 준비를 끝내지 못했다. 이전 publish report는 이 상태로 무효다.",
    "",
    `- stage=${stage}`,
    `- reason=${reason}`,
    "- 실제 발행=0",
    "",
  ].join("\n");
}

async function writeFailedPublishArtifacts({
  imported,
  output,
  relay,
  reportPath,
  reason,
  stage,
}: {
  imported: ReturnType<typeof parseIntermediate>;
  output: string;
  relay: string;
  reportPath?: string;
  reason: string;
  stage: "asset-preparation" | "relay-info";
}): Promise<void> {
  const failedStatus = {
    version: 1,
    mode: "dry-run",
    status: "failed",
    stage,
    complete: false,
    validationPassed: false,
    readyForSigning: false,
    readyToPublish: false,
    relay: safeRelayOrigin(relay),
    reason,
    events: [],
    failures: [],
  };
  const failedReport = {
    version: 1,
    counts: imported.report,
    conversionFailures: imported.diagnostics.conversionFailures,
    publish: failedStatus,
  };
  const markdown = failedMarkdownReport(stage, reason);
  await Promise.all([
    writeAtomic(path.join(output, "notion-events.json"), json(failedStatus)),
    writeAtomic(
      path.join(output, "notion-publish-status.json"),
      json(failedStatus),
    ),
    writeAtomic(
      path.join(output, "notion-import-report.json"),
      json(failedReport),
    ),
    writeAtomic(path.join(output, "notion-import-report.md"), markdown),
    writeAtomic(
      path.join(output, "notion-data-url-assets.json"),
      json({ version: 1, status: "invalidated", stage, reason }),
    ),
    writeAtomic(
      path.join(output, "notion-data-url-assets.private.json"),
      json({ version: 1, status: "invalidated", stage, reason }),
    ),
    ...(reportPath ? [writeAtomic(path.resolve(reportPath), markdown)] : []),
  ]);
}

async function writeExtractedAssets(
  output: string,
  assets: Awaited<ReturnType<typeof prepareDataUrlAssets>>,
): Promise<void> {
  for (const asset of assets.publicManifest.assets) {
    const bytes = assets.assetBytes.get(asset.sha256);
    if (!bytes) throw new Error("data-url-asset-bytes-missing");
    const outputPath = path.join(output, asset.relativePath);
    let existing: Buffer | null = null;
    try {
      existing = await readFile(outputPath);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    }
    if (existing) {
      const existingHash = createHash("sha256").update(existing).digest("hex");
      if (existingHash !== asset.sha256) {
        throw new Error("data-url-existing-asset-hash-mismatch");
      }
      continue;
    }
    await writeAtomic(outputPath, bytes);
  }
}

async function runConvert(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      zip: { type: "string" },
      output: { type: "string" },
      report: { type: "string" },
      "relation-column": { type: "string", multiple: true },
    },
    strict: true,
  });
  const archivePath = required(parsed.values.zip, "--zip");
  const output = path.resolve(parsed.values.output ?? DEFAULT_OUTPUT);
  const imported = await convertNotionArchive(
    archivePath,
    new Set(parsed.values["relation-column"] ?? []),
  );
  const markdownReport = renderMarkdownReport(imported);

  await Promise.all([
    writeAtomic(path.join(output, "notion-import.json"), json(imported)),
    writeAtomic(
      path.join(output, "notion-import-diagnostics.json"),
      json(imported.diagnostics),
    ),
    writeAtomic(
      path.join(output, "notion-import-report.json"),
      json(buildPublicReport(imported)),
    ),
    writeAtomic(path.join(output, "notion-import-report.md"), markdownReport),
    ...(parsed.values.report
      ? [writeAtomic(path.resolve(parsed.values.report), markdownReport)]
      : []),
  ]);

  process.stdout.write(
    `Converted ${imported.report.pageCount}/${imported.report.markdownFileCount} pages (dry local stage).\n`,
  );
  if (imported.report.pageFailureCount > 0) {
    throw new Error(
      `page-conversion-failed:${imported.report.pageFailureCount}`,
    );
  }
}

async function runPublish(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      input: { type: "string" },
      output: { type: "string" },
      relay: { type: "string" },
      report: { type: "string" },
      "dry-run": { type: "boolean", default: true },
    },
    strict: true,
  });
  if (parsed.values["dry-run"] !== true) {
    throw new Error("live-publish-is-not-supported");
  }
  const inputPath = required(parsed.values.input, "--input");
  const output = path.resolve(parsed.values.output ?? path.dirname(inputPath));
  const relay = requiredValue(parsed.values.relay, "--relay");
  const imported = parseIntermediate(
    JSON.parse(await readFile(inputPath, "utf8")) as unknown,
  );
  let contentLimit: RelayContentLimit;
  try {
    contentLimit = await fetchRelayContentLimit(relay);
  } catch (error) {
    const reason =
      error instanceof RelayContentLimitError
        ? error.code
        : "relay-info-unknown-failure";
    await writeFailedPublishArtifacts({
      imported,
      output,
      relay,
      reportPath: parsed.values.report,
      reason,
      stage: "relay-info",
    });
    throw new Error(reason);
  }
  let assets: PreparedDataUrlAssets;
  try {
    assets = await prepareDataUrlAssets(imported);
    await writeExtractedAssets(output, assets);
    const assetDirectory = path.join(output, "notion-inline-assets");
    assets.publicManifest.reconstructionVerifiedPageCount =
      await verifyPreparedDataUrlAssets({
        original: imported,
        prepared: assets.imported,
        privateManifest: assets.privateManifest,
        assetDirectory,
      });
    await Promise.all([
      writeAtomic(
        path.join(output, "notion-data-url-assets.private.json"),
        json(assets.privateManifest),
      ),
      writeAtomic(
        path.join(output, "notion-data-url-assets.json"),
        json(assets.publicManifest),
      ),
    ]);
  } catch (error) {
    const reason = safeAssetFailure(error);
    await writeFailedPublishArtifacts({
      imported,
      output,
      relay,
      reportPath: parsed.values.report,
      reason,
      stage: "asset-preparation",
    });
    throw new Error(reason);
  }
  const dryRun = buildDryRun({
    imported: assets.imported,
    assetPreparation: assets.publicManifest,
    contentLimit,
    relay,
  });
  const markdownReport = renderMarkdownReport(imported, dryRun);
  const publishStatus = {
    version: 1,
    mode: "dry-run",
    status: dryRun.complete ? "complete" : "incomplete",
    stage: "event-validation",
    complete: dryRun.complete,
    validationPassed: dryRun.validationPassed,
    readyForSigning: dryRun.readyForSigning,
    readyToPublish: dryRun.readyToPublish,
    relay: dryRun.relay,
    contentLimit,
    inputPageCount: dryRun.inputPageCount,
    unsignedEventCount: dryRun.events.length,
    failureCount: dryRun.failures.length,
    assetPreparation: dryRun.assetPreparation,
  };
  await Promise.all([
    writeAtomic(path.join(output, "notion-events.json"), json(dryRun)),
    writeAtomic(
      path.join(output, "notion-publish-status.json"),
      json(publishStatus),
    ),
    writeAtomic(
      path.join(output, "notion-import-report.json"),
      json(buildPublicReport(imported, dryRun)),
    ),
    writeAtomic(path.join(output, "notion-import-report.md"), markdownReport),
    ...(parsed.values.report
      ? [writeAtomic(path.resolve(parsed.values.report), markdownReport)]
      : []),
  ]);
  process.stdout.write(
    `Metadata GET resolved ${contentLimit.effectiveMaxContentBytes} bytes (${contentLimit.source}); dry-run wrote ${dryRun.events.length} unsigned kind-30623 inputs. No WebSocket, signing, or live publish was used.\n`,
  );
  if (dryRun.failures.length > 0) {
    throw new Error(`page-content-too-large:${dryRun.failures.length}`);
  }
}

function simulatedOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("invalid-simulated-bindings-origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("invalid-simulated-bindings-origin");
  }
  return parsed.origin;
}

function publicationMarkdownReport(
  prepared: Awaited<ReturnType<typeof preparePublicationAssets>>,
  preflight: ReturnType<typeof buildPublicationPreflight>,
  compatibility: PublicationCompatibilityReport,
): string {
  const manifest = prepared.publicManifest;
  return [
    "# Notion publication preparation",
    "",
    "## Status",
    "",
    `- local preparation complete=${preflight.complete}`,
    `- binding mode=${preflight.bindingStatus.bindingMode}`,
    `- references bound=${preflight.bindingStatus.boundReferenceCount}/${preflight.bindingStatus.totalReferenceCount}`,
    `- ready for signing=${preflight.readyForSigning}`,
    `- operational upload ready=${compatibility.operationalUploadReady}`,
    "- ready to publish=false",
    "- live upload/sign/publish=0",
    "",
    "## Denominators",
    "",
    `- archive entries=${manifest.archiveEntryCount}`,
    `- binary entries=${manifest.binaryEntryCount}`,
    `- binary unique=${manifest.binaryUniqueCount}`,
    `- inline entries=${manifest.inlineEntryCount}`,
    `- inline unique=${manifest.inlineUniqueCount}`,
    `- combined entries=${manifest.combinedEntryCount}`,
    `- combined unique=${manifest.combinedUniqueCount}`,
    `- binary references=${manifest.binaryReferenceCount}`,
    `- inline references=${manifest.inlineEntryCount}`,
    `- total references=${manifest.totalReferenceCount}`,
    `- CSV originals=${manifest.csvEntryCount}`,
    `- CSV references=${manifest.csvReferenceCount}`,
    `- unreferenced binary entries=${manifest.unreferencedBinaryEntryCount}`,
    `- unreferenced CSV entries=${manifest.unreferencedCsvEntryCount}`,
    `- pages codec/content validated=${preflight.codecValidatedPageCount}/${preflight.contentValidatedPageCount}`,
    `- source upload bytes=${compatibility.summary.sourceBytes}`,
    `- source max bytes=${compatibility.summary.maxSourceBytes}`,
    `- format-blocked assets=${compatibility.summary.formatBlockedCount}`,
    `- Buzz CLI execution adapter implemented=${compatibility.buzzCliExecutionAdapterImplemented}`,
    `- Buzz CLI readback-blocked assets=${compatibility.summary.buzzCliReadbackBlockedCount}`,
    "",
    "This report contains counts and hashes only; source paths, titles, and bodies stay in private local artifacts.",
    "",
  ].join("\n");
}

function safePublicationFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const code = message.split(":", 1)[0];
  return /^(?:data-url|publication|relay-info)-[a-z0-9-]+$/.test(code)
    ? code
    : "publication-preparation-failed";
}

async function writeFailedPublicationArtifacts({
  output,
  relay,
  reportPath,
  reason,
}: {
  output: string;
  relay: string;
  reportPath?: string;
  reason: string;
}): Promise<void> {
  const failed = {
    version: 1,
    mode: "local-publication-preparation",
    status: "invalidated",
    stage: "local-preparation",
    reason,
    complete: false,
    readyForSigning: false,
    readyToPublish: false,
    liveUploadCount: 0,
    liveSignedEventCount: 0,
    livePublishedEventCount: 0,
    relay: safeRelayOrigin(relay),
  };
  const markdown = failedMarkdownReport("local-preparation", reason);
  await Promise.all([
    writeAtomic(
      path.join(output, "notion-publication-status.json"),
      json(failed),
    ),
    writeAtomic(
      path.join(output, "notion-publication-preflight.json"),
      json(failed),
    ),
    writeAtomic(
      path.join(output, "notion-publication-final.json"),
      json(failed),
    ),
    writeAtomic(
      path.join(output, "notion-publication-compatibility.json"),
      json(failed),
    ),
    writeAtomic(path.join(output, "notion-publication-report.md"), markdown),
    ...(reportPath ? [writeAtomic(path.resolve(reportPath), markdown)] : []),
  ]);
}

async function runPreparePublication(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      input: { type: "string" },
      output: { type: "string" },
      relay: { type: "string" },
      report: { type: "string" },
      "operational-target": { type: "string" },
      "simulate-bindings-origin": { type: "string" },
    },
    strict: true,
  });
  const inputPath = required(parsed.values.input, "--input");
  const output = path.resolve(parsed.values.output ?? path.dirname(inputPath));
  const relay = requiredValue(parsed.values.relay, "--relay");
  let artifactsWritten = false;
  try {
    const imported = parseIntermediate(
      JSON.parse(await readFile(inputPath, "utf8")) as unknown,
    );
    const contentLimit = await fetchRelayContentLimit(relay, {
      ...(parsed.values["operational-target"]
        ? { operationalTargetRelay: parsed.values["operational-target"] }
        : {}),
    });
    const prepared = await preparePublicationAssets({
      imported,
      outputDirectory: output,
    });
    let finalImport = prepared.imported;
    let bindingStatus: PublicationBindingStatus = {
      version: 1,
      targetRelay: safeRelayOrigin(relay) ?? relay,
      bindingMode: "none",
      uploadAssetCount: prepared.publicManifest.uploadAssets.length,
      boundAssetCount: 0,
      totalReferenceCount: prepared.privateManifest.references.length,
      boundReferenceCount: 0,
      unboundReferenceCount: prepared.privateManifest.references.length,
      referencesBound: prepared.privateManifest.references.length === 0,
      productionBindingsComplete: false,
      assetBindingsComplete: false,
      readyForSigning: false,
      readyToPublish: false,
    };
    let bindings: unknown = null;
    if (parsed.values["simulate-bindings-origin"]) {
      const origin = simulatedOrigin(parsed.values["simulate-bindings-origin"]);
      const simulatedBindings = {
        version: 1 as const,
        mode: "simulated" as const,
        targetRelay: safeRelayOrigin(relay) ?? relay,
        assets: prepared.publicManifest.uploadAssets.map((asset) => ({
          sourceSha256: asset.sourceSha256,
          sourceBytes: asset.bytes,
          remoteSha256: asset.sourceSha256,
          remoteBytes: asset.bytes,
          mime: asset.mime,
          url: `${origin}/media/${asset.sourceSha256}.bin`,
          uploadAccepted: false,
          readbackVerified: false,
        })),
      };
      const bound = bindPublicationAssetUrls({
        imported: prepared.imported,
        privateManifest: prepared.privateManifest,
        publicManifest: prepared.publicManifest,
        bindings: simulatedBindings,
      });
      finalImport = bound.imported;
      bindingStatus = bound.status;
      bindings = simulatedBindings;
    }
    const preflight = buildPublicationPreflight({
      imported: finalImport,
      bindingStatus,
      contentLimit,
    });
    const compatibility = buildPublicationCompatibilityReport({
      publicManifest: prepared.publicManifest,
      privateManifest: prepared.privateManifest,
    });
    const status = {
      version: 1,
      mode: "local-publication-preparation",
      complete: preflight.complete,
      readyForSigning: preflight.readyForSigning,
      operationalUploadReady: compatibility.operationalUploadReady,
      buzzCliExecutionAdapterImplemented:
        compatibility.buzzCliExecutionAdapterImplemented,
      readyToPublish: false,
      liveUploadCount: 0,
      liveSignedEventCount: 0,
      livePublishedEventCount: 0,
      denominators: {
        archiveEntryCount: prepared.publicManifest.archiveEntryCount,
        binaryEntryCount: prepared.publicManifest.binaryEntryCount,
        binaryUniqueCount: prepared.publicManifest.binaryUniqueCount,
        inlineEntryCount: prepared.publicManifest.inlineEntryCount,
        inlineUniqueCount: prepared.publicManifest.inlineUniqueCount,
        combinedEntryCount: prepared.publicManifest.combinedEntryCount,
        combinedUniqueCount: prepared.publicManifest.combinedUniqueCount,
        totalReferenceCount: prepared.publicManifest.totalReferenceCount,
        csvEntryCount: prepared.publicManifest.csvEntryCount,
        pageCount: imported.pages.length,
      },
      contentLimit,
      bindingStatus,
      compatibilitySummary: compatibility.summary,
      readinessBlockers: preflight.readinessBlockers,
      uploadReadinessBlockers: [
        ...(compatibility.summary.formatBlockedCount > 0
          ? ["source-format-incompatible"]
          : []),
        "production-target-signer-not-bound",
        "production-upload-not-runtime-verified",
      ],
    };
    const markdown = publicationMarkdownReport(
      prepared,
      preflight,
      compatibility,
    );
    await Promise.all([
      writeAtomic(
        path.join(output, "notion-publication-prepared.json"),
        json(prepared.imported),
      ),
      writeAtomic(
        path.join(output, "notion-publication-final.json"),
        json(finalImport),
      ),
      writeAtomic(
        path.join(output, "notion-publication-assets.json"),
        json(prepared.publicManifest),
      ),
      writeAtomic(
        path.join(output, "notion-publication-assets.private.json"),
        json(prepared.privateManifest),
      ),
      writeAtomic(
        path.join(output, "notion-publication-bindings.simulated.json"),
        json(bindings),
      ),
      writeAtomic(
        path.join(output, "notion-publication-preflight.json"),
        json(preflight),
      ),
      writeAtomic(
        path.join(output, "notion-publication-status.json"),
        json(status),
      ),
      writeAtomic(
        path.join(output, "notion-publication-compatibility.json"),
        json(compatibility),
      ),
      writeAtomic(path.join(output, "notion-publication-report.md"), markdown),
      ...(parsed.values.report
        ? [writeAtomic(path.resolve(parsed.values.report), markdown)]
        : []),
    ]);
    artifactsWritten = true;
    process.stdout.write(
      `Prepared ${prepared.publicManifest.combinedEntryCount} binary entries and ${prepared.publicManifest.totalReferenceCount} references; validated ${preflight.codecValidatedPageCount} Docs pages. No upload, signing, or publication was used.\n`,
    );
    if (!preflight.complete) throw new Error("publication-preflight-failed");
  } catch (error) {
    if (!artifactsWritten) {
      const reason = safePublicationFailure(error);
      await writeFailedPublicationArtifacts({
        output,
        relay,
        reportPath: parsed.values.report,
        reason,
      });
      throw new Error(reason);
    }
    throw error;
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

function contentLimitFrom(value: unknown): ContentLimitProvenance {
  const candidate =
    value && typeof value === "object" && "contentLimit" in value
      ? (value as { contentLimit: unknown }).contentLimit
      : value;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !("effectiveMaxContentBytes" in candidate) ||
    !("relayInfoUrl" in candidate)
  ) {
    throw new Error("publication-invalid-content-limit-input");
  }
  return candidate as ContentLimitProvenance;
}

function assertCliMediaCompatibility(
  value: unknown,
  publicManifest: PublicPublicationAssetManifest,
): void {
  if (
    !value ||
    typeof value !== "object" ||
    !("assets" in value) ||
    !Array.isArray(value.assets)
  ) {
    throw new Error("publication-invalid-compatibility-input");
  }
  const compatibility = value as PublicationCompatibilityReport;
  if (compatibility.assets.length !== publicManifest.uploadAssets.length) {
    throw new Error("publication-compatibility-denominator-mismatch");
  }
  const compatibilityByHash = new Map<
    string,
    PublicationCompatibilityReport["assets"][number]
  >();
  for (const asset of compatibility.assets) {
    if (
      typeof asset.sourceSha256 !== "string" ||
      !Array.isArray(asset.reasons) ||
      compatibilityByHash.has(asset.sourceSha256)
    ) {
      throw new Error("publication-invalid-compatibility-input");
    }
    compatibilityByHash.set(asset.sourceSha256, asset);
  }
  for (const asset of publicManifest.uploadAssets) {
    const compatible = compatibilityByHash.get(asset.sourceSha256);
    if (!compatible || compatible.sourceBytes !== asset.bytes) {
      throw new Error("publication-compatibility-asset-mismatch");
    }
  }
  const unresolved = new Set([
    "m4a-audio-iso-bmff-unsupported",
    "mov-container-unsupported",
    "svg-active-content-rejected",
  ]);
  if (
    [...compatibilityByHash.values()].some((asset) =>
      asset.reasons.some((reason) => unresolved.has(reason)),
    )
  ) {
    throw new Error("publication-source-media-incompatible");
  }
}

async function runExecutePublication(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      input: { type: "string" },
      assets: { type: "string" },
      "private-assets": { type: "string" },
      compatibility: { type: "string" },
      "content-limit": { type: "string" },
      output: { type: "string" },
      journal: { type: "string" },
      "buzz-cli": { type: "string" },
      "target-relay": { type: "string" },
      "signer-pubkey": { type: "string" },
      "authorize-live": { type: "boolean", default: false },
    },
    strict: true,
  });
  if (parsed.values["authorize-live"] !== true) {
    throw new Error("publication-live-execution-not-authorized");
  }
  const inputPath = required(parsed.values.input, "--input");
  const publicManifestPath = required(parsed.values.assets, "--assets");
  const privateManifestPath = required(
    parsed.values["private-assets"],
    "--private-assets",
  );
  const compatibilityPath = required(
    parsed.values.compatibility,
    "--compatibility",
  );
  const contentLimitPath = required(
    parsed.values["content-limit"],
    "--content-limit",
  );
  const outputDirectory = required(parsed.values.output, "--output");
  const journalPath = required(parsed.values.journal, "--journal");
  const buzzCliPath = required(parsed.values["buzz-cli"], "--buzz-cli");
  const targetRelay = requiredValue(
    parsed.values["target-relay"],
    "--target-relay",
  );
  const signerPubkey = requiredValue(
    parsed.values["signer-pubkey"],
    "--signer-pubkey",
  );
  const [input, publicValue, privateValue, compatibility, limitValue] =
    await Promise.all([
      readJsonFile(inputPath),
      readJsonFile(publicManifestPath),
      readJsonFile(privateManifestPath),
      readJsonFile(compatibilityPath),
      readJsonFile(contentLimitPath),
    ]);
  const imported = parseIntermediate(input);
  const publicManifest = publicValue as PublicPublicationAssetManifest;
  const privateManifest = privateValue as PrivatePublicationAssetManifest;
  if (
    publicManifest.version !== 1 ||
    !Array.isArray(publicManifest.uploadAssets) ||
    privateManifest.version !== 1 ||
    !Array.isArray(privateManifest.references) ||
    !Array.isArray(privateManifest.pages)
  ) {
    throw new Error("publication-invalid-manifest-input");
  }
  assertCliMediaCompatibility(compatibility, publicManifest);
  const journal = await executePublication({
    imported,
    publicManifest,
    privateManifest,
    outputDirectory,
    contentLimit: contentLimitFrom(limitValue),
    authorization: {
      liveExecutionAuthorized: true,
      targetRelay,
      signerPubkey,
    },
    api: createBuzzCliPublicationApi({ buzzCliPath }),
    journalStore: new JsonPublicationJournalStore(journalPath),
  });
  process.stdout.write(
    `Publication journal complete=${journal.complete}; assets=${Object.keys(journal.assets).length}; pages=${Object.keys(journal.pages).length}.\n`,
  );
}

async function runVerifyEvidence(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      input: { type: "string" },
      zip: { type: "string" },
      output: { type: "string" },
      receipt: { type: "string" },
    },
    strict: true,
  });
  const sourceIntermediatePath = required(parsed.values.input, "--input");
  const sourceArchivePath = required(parsed.values.zip, "--zip");
  const outputDirectory = required(parsed.values.output, "--output");
  const receiptPath = required(parsed.values.receipt, "--receipt");
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const receipt = await writePublicationEvidenceVerification({
    repoRoot,
    sourceArchivePath,
    sourceIntermediatePath,
    outputDirectory,
    receiptPath,
  });
  process.stdout.write(
    `Evidence complete=${receipt.complete}; artifacts=${receipt.artifacts.length}; pages=${receipt.pageIdentities.originalApproved.pageCount}.\n`,
  );
  if (!receipt.complete) {
    throw new Error(
      `publication-evidence-invalid:${receipt.failures.join(",")}`,
    );
  }
}

export async function run(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === "convert") return runConvert(args);
  if (command === "publish") return runPublish(args);
  if (command === "prepare-publication") return runPreparePublication(args);
  if (command === "execute-publication") return runExecutePublication(args);
  if (command === "verify-evidence") return runVerifyEvidence(args);
  throw new Error(
    "usage: notion-import <convert|publish|prepare-publication|execute-publication|verify-evidence> [options]",
  );
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown-error";
    process.stderr.write(`notion-import: ${message}\n`);
    process.exitCode = 1;
  });
}
