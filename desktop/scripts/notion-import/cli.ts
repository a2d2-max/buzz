import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { convertNotionArchive } from "./convert.ts";
import { buildDryRun, parseIntermediate } from "./publish.ts";
import { buildPublicReport, renderMarkdownReport } from "./report.ts";

const DEFAULT_OUTPUT = path.resolve("notion-import-output");

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
  await rename(temporary, filePath);
}

function required(value: string | undefined, option: string): string {
  if (!value) throw new Error(`missing-required-option:${option}`);
  return path.resolve(value);
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
  const imported = parseIntermediate(
    JSON.parse(await readFile(inputPath, "utf8")) as unknown,
  );
  const dryRun = buildDryRun({ imported, relay: parsed.values.relay });
  const markdownReport = renderMarkdownReport(imported, dryRun);
  await Promise.all([
    writeAtomic(path.join(output, "notion-events.json"), json(dryRun)),
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
    `Dry-run wrote ${dryRun.events.length} unsigned kind-30623 inputs; no relay connection was made.\n`,
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
