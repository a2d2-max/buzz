import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { getPublicKey } from "nostr-tools";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../..");
const CLI = path.join(HERE, "cli.ts");
const FIXTURE_ZIP = path.join(HERE, "fixtures/notion-export.zip");
const scratch = await mkdtemp(
  path.join(os.tmpdir(), "notion-publication-cli-"),
);

async function runCli(args, options = {}) {
  return execFileAsync(
    process.execPath,
    [
      "--import",
      path.join(DESKTOP, "test-loader.mjs"),
      "--experimental-strip-types",
      CLI,
      ...args,
    ],
    {
      cwd: DESKTOP,
      maxBuffer: 10 * 1024 * 1024,
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    },
  );
}

after(async () => {
  await rm(scratch, { force: true, recursive: true });
});

test("prepare-publication extracts all sources, applies simulated URLs, and only calls relay metadata", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "Content-Type": "application/nostr+json" });
    response.end(
      JSON.stringify({
        limitation: {
          max_content_length: 524_288,
          max_message_length: 1_048_576,
        },
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const relay = `ws://127.0.0.1:${address.port}`;
  const converted = path.join(scratch, "converted");
  const output = path.join(scratch, "prepared");
  try {
    await runCli([
      "convert",
      "--zip",
      FIXTURE_ZIP,
      "--output",
      converted,
      "--relation-column",
      "Relation",
    ]);
    const { stdout } = await runCli([
      "prepare-publication",
      "--input",
      path.join(converted, "notion-import.json"),
      "--output",
      output,
      "--relay",
      relay,
      "--operational-target",
      relay,
      "--simulate-bindings-origin",
      "https://simulation.invalid",
    ]);
    const manifest = JSON.parse(
      await readFile(
        path.join(output, "notion-publication-assets.json"),
        "utf8",
      ),
    );
    const preflight = JSON.parse(
      await readFile(
        path.join(output, "notion-publication-preflight.json"),
        "utf8",
      ),
    );
    const finalImport = JSON.parse(
      await readFile(
        path.join(output, "notion-publication-final.json"),
        "utf8",
      ),
    );
    const compatibility = JSON.parse(
      await readFile(
        path.join(output, "notion-publication-compatibility.json"),
        "utf8",
      ),
    );
    assert.deepEqual(
      {
        binaryEntryCount: manifest.binaryEntryCount,
        binaryReferenceCount: manifest.binaryReferenceCount,
        combinedEntryCount: manifest.combinedEntryCount,
        csvEntryCount: manifest.csvEntryCount,
        csvReferenceCount: manifest.csvReferenceCount,
      },
      {
        binaryEntryCount: 2,
        binaryReferenceCount: 3,
        combinedEntryCount: 2,
        csvEntryCount: 2,
        csvReferenceCount: 1,
      },
    );
    assert.equal(preflight.complete, true);
    assert.equal(preflight.bindingStatus.bindingMode, "simulated");
    assert.equal(preflight.bindingStatus.referencesBound, true);
    assert.equal(preflight.readyForSigning, false);
    assert.equal(preflight.readyToPublish, false);
    assert.equal(
      preflight.contentLimit.operationalAdvertisementConfirmed,
      true,
    );
    assert.equal(preflight.contentLimit.advertisedMaxMessageBytes, 1_048_576);
    assert.equal(preflight.codecValidatedPageCount, 12);
    assert.equal(preflight.events.length, 12);
    assert.equal(compatibility.summary.assetCount, 2);
    assert.equal(
      compatibility.evidenceScope,
      "node-buzz-cli-source-audit-only",
    );
    assert.equal("buzzCliRuntimeIntegrationVerified" in compatibility, false);
    assert.equal(
      "nodeTauriExecutionHostBridgeAvailable" in compatibility,
      false,
    );
    assert.equal(compatibility.buzzCliExecutionAdapterImplemented, true);
    assert.equal(compatibility.operationalUploadReady, false);
    assert.equal(compatibility.liveUploadCount, 0);
    assert.doesNotMatch(
      JSON.stringify(finalImport.pages.map((page) => page.body)),
      /notion-(?:publication|inline)-assets|;base64,/,
    );
    assert.deepEqual(requests, ["GET /info"]);
    assert.match(stdout, /No upload, signing, or publication was used/);

    const privateManifest = JSON.parse(
      await readFile(
        path.join(output, "notion-publication-assets.private.json"),
        "utf8",
      ),
    );
    assert.ok(privateManifest.binaryEntries[0]);
    await writeFile(
      path.join(output, privateManifest.binaryEntries[0].extractedRelativePath),
      "corrupt retained source",
    );
    await assert.rejects(
      runCli([
        "prepare-publication",
        "--input",
        path.join(converted, "notion-import.json"),
        "--output",
        output,
        "--relay",
        relay,
        "--operational-target",
        relay,
        "--simulate-bindings-origin",
        "https://simulation.invalid",
      ]),
    );
    const failedStatus = JSON.parse(
      await readFile(
        path.join(output, "notion-publication-status.json"),
        "utf8",
      ),
    );
    const failedPreflight = JSON.parse(
      await readFile(
        path.join(output, "notion-publication-preflight.json"),
        "utf8",
      ),
    );
    const failedCompatibility = JSON.parse(
      await readFile(
        path.join(output, "notion-publication-compatibility.json"),
        "utf8",
      ),
    );
    assert.equal(failedStatus.complete, false);
    assert.equal(failedStatus.readyForSigning, false);
    assert.equal(failedStatus.readyToPublish, false);
    assert.equal(failedPreflight.status, "invalidated");
    assert.equal(failedPreflight.complete, false);
    assert.equal(failedCompatibility.status, "invalidated");
    assert.equal(requests.length, 2);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("execute-publication stays locked before reading inputs or invoking Buzz", async () => {
  await assert.rejects(runCli(["execute-publication"]), (error) => {
    assert.match(error.stderr, /publication-live-execution-not-authorized/);
    return true;
  });
});

test("execute-publication resumes through a deterministic fake CLI unit fixture", async () => {
  const execution = path.join(scratch, "execute-fixture");
  const statePath = path.join(execution, "relay-state.json");
  const buzzPath = path.join(execution, "fixture-buzz.mjs");
  const inputPath = path.join(execution, "prepared.json");
  const assetsPath = path.join(execution, "assets.json");
  const privateAssetsPath = path.join(execution, "assets.private.json");
  const compatibilityPath = path.join(execution, "compatibility.json");
  const contentLimitPath = path.join(execution, "content-limit.json");
  const outputPath = path.join(execution, "output");
  const journalPath = path.join(execution, "publication-journal.json");
  const sourceArchiveSha256 = "e".repeat(64);
  const fixtureSecret = Uint8Array.from([...new Array(31).fill(0), 1]);
  const signerPubkey = getPublicKey(fixtureSecret);
  const relayHttp = "http://127.0.0.1:39001";
  const relayWs = "ws://127.0.0.1:39001";
  await mkdir(execution, { recursive: true });
  await writeFile(statePath, `${JSON.stringify({ events: [] })}\n`);
  await writeFile(
    inputPath,
    `${JSON.stringify({
      version: 1,
      source: { archivePath: "fixture.zip", archiveBytes: 1 },
      pages: [
        {
          id: "fixture-page",
          idSource: "notion",
          sourcePath: "fixture.md",
          title: "Fixture",
          body: "Fixture body",
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
        pageCount: 1,
        markdownFileCount: 1,
        pageFailureCount: 0,
      },
    })}\n`,
  );
  await writeFile(
    assetsPath,
    `${JSON.stringify({
      version: 1,
      status: "no-assets",
      sourceArchiveSha256,
      combinedUniqueCount: 0,
      totalReferenceCount: 0,
      uploadAssets: [],
    })}\n`,
  );
  await writeFile(
    privateAssetsPath,
    `${JSON.stringify({
      version: 1,
      sourceArchiveSha256,
      binaryEntries: [],
      csvEntries: [],
      references: [],
      pages: [],
    })}\n`,
  );
  await writeFile(
    compatibilityPath,
    `${JSON.stringify({ version: 1, assets: [] })}\n`,
  );
  await writeFile(
    contentLimitPath,
    `${JSON.stringify({
      advertisedMaxContentBytes: 524_288,
      advertisedMaxMessageBytes: 1_048_576,
      effectiveMaxContentBytes: 524_288,
      source: "advertised",
      reason: "max-content-length-advertised",
      limitVerified: true,
      operationalAdvertisementConfirmed: true,
      relayInfoUrl: `${relayHttp}/info`,
      relayInfoEndpoint: "/info",
      relayInfoHttpStatus: 200,
      infoEndpointHttpStatus: 200,
    })}\n`,
  );
  const nostrToolsUrl = import.meta.resolve("nostr-tools");
  await writeFile(
    buzzPath,
    `#!/usr/bin/env node
import { finalizeEvent, getPublicKey } from ${JSON.stringify(nostrToolsUrl)};
import { readFile, writeFile } from "node:fs/promises";
const secret = Uint8Array.from([...new Array(31).fill(0), 1]);
const statePath = process.env.FIXTURE_BUZZ_STATE;
const args = process.argv.slice(2);
const operation = args.slice(0, 2).join(" ");
if (operation === "publication identity") {
  process.stdout.write(JSON.stringify({ relay: ${JSON.stringify(relayHttp)}, pubkey: getPublicKey(secret) }));
} else if (operation === "publication query-doc") {
  const pageId = args[args.indexOf("--page-id") + 1];
  const state = JSON.parse(await readFile(statePath, "utf8"));
  process.stdout.write(JSON.stringify(state.events.filter((event) => event.tags.some((tag) => tag[0] === "d" && tag[1] === \`doc:\${pageId}\`))));
} else if (operation === "publication sign-doc") {
  const input = JSON.parse(await readFile(args[args.indexOf("--input") + 1], "utf8"));
  process.stdout.write(JSON.stringify(finalizeEvent({ kind: input.kind, content: input.content, tags: input.tags, created_at: input.createdAt }, secret)));
} else if (operation === "publication publish-doc") {
  const event = JSON.parse(await readFile(args[args.indexOf("--input") + 1], "utf8"));
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (!state.events.some((candidate) => candidate.id === event.id)) state.events.push(event);
  await writeFile(statePath, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ event_id: event.id, accepted: true, message: "" }));
} else {
  process.stderr.write("unsupported fixture operation");
  process.exitCode = 2;
}
`,
    { mode: 0o700 },
  );
  await chmod(buzzPath, 0o700);
  const args = [
    "execute-publication",
    "--input",
    inputPath,
    "--assets",
    assetsPath,
    "--private-assets",
    privateAssetsPath,
    "--compatibility",
    compatibilityPath,
    "--content-limit",
    contentLimitPath,
    "--output",
    outputPath,
    "--journal",
    journalPath,
    "--buzz-cli",
    buzzPath,
    "--target-relay",
    relayWs,
    "--signer-pubkey",
    signerPubkey,
    "--authorize-live",
  ];
  const environment = {
    FIXTURE_BUZZ_STATE: statePath,
    BUZZ_PRIVATE_KEY:
      "0000000000000000000000000000000000000000000000000000000000000001",
  };

  const first = await runCli(args, { env: environment });
  assert.match(first.stdout, /complete=true; assets=0; pages=1/);
  const firstJournal = JSON.parse(await readFile(journalPath, "utf8"));
  assert.equal(firstJournal.complete, true);
  assert.equal(firstJournal.signerPubkey, signerPubkey);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).events.length, 1);

  const resumed = await runCli(args, { env: environment });
  assert.match(resumed.stdout, /complete=true; assets=0; pages=1/);
  assert.equal(
    JSON.parse(await readFile(statePath, "utf8")).events.length,
    1,
    "resume must not duplicate the already read-back event",
  );
});
