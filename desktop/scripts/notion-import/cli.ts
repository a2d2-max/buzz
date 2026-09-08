import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { convertNotionArchive } from "./convert.ts";
import {
  prepareDataUrlAssets,
  verifyPreparedDataUrlAssets,
} from "./dataUrlAssets.ts";
import type { PreparedDataUrlAssets } from "./dataUrlAssets.ts";
import { buildDryRun, parseIntermediate } from "./publish.ts";
import {
  fetchRelayContentLimit,
  RelayContentLimitError,
} from "./relayContentLimit.ts";
import type { RelayContentLimit } from "./relayContentLimit.ts";
import { buildPublicReport, renderMarkdownReport } from "./report.ts";

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

export async function run(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === "convert") return runConvert(args);
  if (command === "publish") return runPublish(args);
  throw new Error("usage: notion-import <convert|publish> [options]");
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
