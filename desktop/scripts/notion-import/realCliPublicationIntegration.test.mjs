import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { getPublicKey, verifyEvent } from "nostr-tools";

const execFileAsync = promisify(execFile);
const FIXTURE_KEY =
  "0000000000000000000000000000000000000000000000000000000000000001";
const FIXTURE_SECRET = Uint8Array.from([...new Array(31).fill(0), 1]);
const FIXTURE_PUBKEY = getPublicKey(FIXTURE_SECRET);
const scratchDirectories = new Set();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function digestFile(filePath) {
  const metadata = await stat(filePath);
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { bytes: metadata.size, sha256: hash.digest("hex") };
}

async function readRequestBody(request, maximum = 2 * 1024 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximum) throw new Error("fixture-request-too-large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function tagValue(event, name) {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

function authenticatedEvent(request) {
  const authorization = request.headers.authorization;
  assert.equal(typeof authorization, "string");
  assert.match(authorization, /^Nostr /);
  const event = JSON.parse(
    Buffer.from(authorization.slice("Nostr ".length), "base64url").toString(
      "utf8",
    ),
  );
  assert.equal(verifyEvent(event), true);
  assert.equal(event.pubkey, FIXTURE_PUBKEY);
  return event;
}

function verifyNip98(request, body, url) {
  const event = authenticatedEvent(request);
  assert.equal(event.kind, 27235);
  assert.equal(tagValue(event, "u"), url);
  assert.equal(tagValue(event, "method"), request.method);
  assert.equal(tagValue(event, "payload"), sha256(body));
  return event;
}

function verifyBlossom(request, operation, serverAuthority) {
  const event = authenticatedEvent(request);
  assert.equal(event.kind, 24242);
  assert.equal(tagValue(event, "t"), operation);
  assert.equal(tagValue(event, "server"), serverAuthority);
  return event;
}

async function startFixtureServer() {
  const state = {
    uploadRequests: 0,
    mediaReadbackRequests: 0,
    queryRequests: 0,
    eventPublishRequests: 0,
    verifiedBlossomAuth: 0,
    verifiedNip98Auth: 0,
    uploadedBytes: null,
    storedEvents: new Map(),
    hidePublishedEventOnce: false,
  };
  let origin = "";
  const server = http.createServer((request, response) => {
    void (async () => {
      const body = await readRequestBody(request);
      const requestUrl = `${origin}${request.url}`;
      const authority = new URL(origin).host;
      if (request.method === "PUT" && request.url === "/upload") {
        const auth = verifyBlossom(request, "upload", authority);
        state.verifiedBlossomAuth += 1;
        const digest = sha256(body);
        assert.equal(tagValue(auth, "x"), digest);
        assert.equal(request.headers["x-sha-256"], digest);
        assert.equal(request.headers["content-type"], "application/pdf");
        state.uploadRequests += 1;
        state.uploadedBytes = body;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            url: `${origin}/media/${digest}.pdf`,
            sha256: digest,
            size: body.length,
            type: "application/pdf",
            uploaded: 1,
          }),
        );
        return;
      }
      if (request.method === "GET" && request.url?.startsWith("/media/")) {
        verifyBlossom(request, "get", authority);
        state.verifiedBlossomAuth += 1;
        assert.ok(state.uploadedBytes);
        state.mediaReadbackRequests += 1;
        response.writeHead(200, {
          "content-length": String(state.uploadedBytes.length),
          "content-type": "application/pdf",
        });
        response.end(state.uploadedBytes);
        return;
      }
      if (request.method === "POST" && request.url === "/query") {
        verifyNip98(request, body, requestUrl);
        state.verifiedNip98Auth += 1;
        state.queryRequests += 1;
        const filters = JSON.parse(body.toString("utf8"));
        assert.deepEqual(filters[0].kinds, [30623, 30078]);
        const pageDTag = filters[0]["#d"][0];
        let events = [...state.storedEvents.values()].filter((event) =>
          event.tags.some((tag) => tag[0] === "d" && tag[1] === pageDTag),
        );
        if (state.hidePublishedEventOnce && events.length > 0) {
          events = [];
          state.hidePublishedEventOnce = false;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(events));
        return;
      }
      if (request.method === "POST" && request.url === "/events") {
        verifyNip98(request, body, requestUrl);
        state.verifiedNip98Auth += 1;
        state.eventPublishRequests += 1;
        const event = JSON.parse(body.toString("utf8"));
        assert.equal(verifyEvent(event), true);
        assert.equal(event.pubkey, FIXTURE_PUBKEY);
        assert.equal(event.kind, 30623);
        state.storedEvents.set(event.id, event);
        state.hidePublishedEventOnce = true;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            event_id: event.id,
            accepted: true,
            message: "fixture accepted",
          }),
        );
        return;
      }
      response.writeHead(404);
      response.end();
    })().catch((error) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : "fixture-error");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    state,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function writeFixtureFiles(scratch, origin) {
  const output = path.join(scratch, "output");
  await mkdir(path.join(output, "notion-zip-attachments"), {
    recursive: true,
  });
  const pdf = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n",
  );
  const sourceSha256 = sha256(pdf);
  const placeholder = `./notion-publication-assets/${sourceSha256}.pdf`;
  const body = `[synthetic fixture](${placeholder})`;
  const page = {
    id: "fixture-page",
    idSource: "notion",
    sourcePath: "fixture.md",
    title: "Synthetic fixture",
    body,
    parentId: null,
    order: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  const input = {
    version: 1,
    source: { archivePath: "synthetic-only.zip", archiveBytes: 1 },
    pages: [page],
    databases: [],
    diagnostics: {
      unresolvedLinks: [],
      unresolvedParents: [],
      ambiguousRelations: [],
      unresolvedRelations: [],
      unsupportedPageSyntax: [],
      conversionFailures: [],
    },
    report: { pageCount: 1, markdownFileCount: 1, pageFailureCount: 0 },
  };
  const archiveSha256 = "e".repeat(64);
  const publicManifest = {
    version: 1,
    status: "pending-production-binding",
    sourceArchiveSha256: archiveSha256,
    archiveBytes: 1,
    archiveEntryCount: 1,
    binaryEntryCount: 1,
    binaryUniqueCount: 1,
    binaryReferenceCount: 1,
    inlineEntryCount: 0,
    inlineUniqueCount: 0,
    combinedEntryCount: 1,
    combinedUniqueCount: 1,
    totalReferenceCount: 1,
    csvEntryCount: 0,
    csvUniqueCount: 0,
    csvReferenceCount: 0,
    unreferencedBinaryEntryCount: 0,
    unreferencedCsvEntryCount: 0,
    extractedBinaryEntryCount: 1,
    extractedCsvEntryCount: 0,
    verifiedReferenceCount: 1,
    assetBindingsComplete: false,
    bindingMode: "none",
    readyForSigning: false,
    readyToPublish: false,
    uploadAssets: [
      {
        sourceSha256,
        bytes: pdf.length,
        mime: "application/pdf",
        sourceKinds: ["zip-binary"],
        entryCount: 1,
        referenceCount: 1,
        uploadStatus: "not-uploaded",
        remoteSha256: null,
        remoteUrl: null,
        readbackVerified: false,
      },
    ],
  };
  const extractedRelativePath = "notion-zip-attachments/fixture.pdf";
  const privateManifest = {
    version: 1,
    sourceArchiveSha256: archiveSha256,
    binaryEntries: [
      {
        archiveIndex: 0,
        archivePath: "fixture.pdf",
        bytes: pdf.length,
        compressedBytes: pdf.length,
        crc32: "00000000",
        sha256: sourceSha256,
        mime: "application/pdf",
        mimeSource: "magic",
        extractedRelativePath,
      },
    ],
    csvEntries: [],
    references: [
      {
        referenceId: "fixture-reference",
        pageId: page.id,
        nodeType: "link",
        sourceKind: "zip-binary",
        sourceSha256,
        originalTarget: "fixture.pdf",
        placeholder,
        archivePath: "fixture.pdf",
      },
    ],
    pages: [
      {
        pageId: page.id,
        inputBodySha256: sha256(body),
        preparedBodySha256: sha256(body),
        referenceCount: 1,
      },
    ],
  };
  const compatibility = {
    version: 1,
    assets: [{ sourceSha256, sourceBytes: pdf.length, reasons: [] }],
  };
  const contentLimit = {
    advertisedMaxContentBytes: 524_288,
    advertisedMaxMessageBytes: 1_048_576,
    effectiveMaxContentBytes: 524_288,
    source: "advertised",
    reason: "max-content-length-advertised",
    limitVerified: true,
    operationalAdvertisementConfirmed: true,
    relayInfoUrl: `${origin}/info`,
    relayInfoEndpoint: "/info",
    relayInfoHttpStatus: 200,
    infoEndpointHttpStatus: 200,
  };
  const paths = {
    input: path.join(scratch, "prepared.json"),
    assets: path.join(scratch, "assets.json"),
    privateAssets: path.join(scratch, "assets.private.json"),
    compatibility: path.join(scratch, "compatibility.json"),
    contentLimit: path.join(scratch, "content-limit.json"),
    output,
    journal: path.join(scratch, "journal.private.json"),
  };
  await Promise.all([
    writeFile(paths.input, `${JSON.stringify(input)}\n`),
    writeFile(paths.assets, `${JSON.stringify(publicManifest)}\n`),
    writeFile(paths.privateAssets, `${JSON.stringify(privateManifest)}\n`),
    writeFile(paths.compatibility, `${JSON.stringify(compatibility)}\n`),
    writeFile(paths.contentLimit, `${JSON.stringify(contentLimit)}\n`),
    writeFile(path.join(output, extractedRelativePath), pdf),
  ]);
  return { paths, sourceSha256, sourceBytes: pdf.length };
}

async function runImporter({ binary, origin, paths, scratch }) {
  const repoRoot = path.resolve("..");
  const cliPath = path.join(repoRoot, "desktop/scripts/notion-import/cli.ts");
  const args = [
    "--import",
    path.join(repoRoot, "desktop/test-loader.mjs"),
    "--experimental-strip-types",
    cliPath,
    "execute-publication",
    "--input",
    paths.input,
    "--assets",
    paths.assets,
    "--private-assets",
    paths.privateAssets,
    "--compatibility",
    paths.compatibility,
    "--content-limit",
    paths.contentLimit,
    "--output",
    paths.output,
    "--journal",
    paths.journal,
    "--buzz-cli",
    binary,
    "--target-relay",
    origin.replace(/^http:/, "ws:"),
    "--signer-pubkey",
    FIXTURE_PUBKEY,
    "--authorize-live",
  ];
  const privateHome = path.join(scratch, "home");
  const privateTemp = path.join(scratch, "tmp");
  await Promise.all([
    mkdir(privateHome, { recursive: true }),
    mkdir(privateTemp, { recursive: true }),
  ]);
  const environment = {
    PATH: "/usr/bin:/bin",
    HOME: privateHome,
    TMPDIR: privateTemp,
    LANG: "C",
    LC_ALL: "C",
    BUZZ_RELAY_URL: origin,
    BUZZ_PRIVATE_KEY: FIXTURE_KEY,
  };
  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd: scratch,
      env: environment,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr, args };
  } catch (error) {
    return {
      exitCode: Number(error.code ?? 1),
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
      args,
    };
  }
}

afterEach(async () => {
  await Promise.all(
    [...scratchDirectories].map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
  scratchDirectories.clear();
});

test("actual Rust CLI publishes through loopback and journal resume does not duplicate", {
  skip: !process.env.BUZZ_CLI_REAL_BINARY,
}, async () => {
  const binary = path.resolve(process.env.BUZZ_CLI_REAL_BINARY);
  const scratch = await mkdtemp(
    path.join(os.tmpdir(), "notion-real-cli-integration-"),
  );
  scratchDirectories.add(scratch);
  const fixture = await startFixtureServer();
  try {
    const data = await writeFixtureFiles(scratch, fixture.origin);
    const first = await runImporter({
      binary,
      origin: fixture.origin,
      paths: data.paths,
      scratch,
    });
    assert.notEqual(first.exitCode, 0);
    assert.match(first.stderr, /publication-event-readback-missing/);
    const second = await runImporter({
      binary,
      origin: fixture.origin,
      paths: data.paths,
      scratch,
    });
    assert.equal(second.exitCode, 0, second.stderr);

    const journal = JSON.parse(await readFile(data.paths.journal, "utf8"));
    assert.equal(journal.complete, true);
    assert.equal(journal.assets[data.sourceSha256].attempts, 1);
    assert.equal(journal.pages["fixture-page"].attempts, 1);
    assert.equal(journal.pages["fixture-page"].readbackVerified, true);
    const signedEvent = JSON.parse(
      await readFile(journal.pages["fixture-page"].signedEventPath, "utf8"),
    );
    assert.equal(verifyEvent(signedEvent), true);
    assert.equal(
      fixture.state.storedEvents.get(signedEvent.id)?.id,
      signedEvent.id,
    );
    assert.equal(fixture.state.uploadRequests, 1);
    assert.equal(fixture.state.mediaReadbackRequests, 1);
    assert.equal(fixture.state.eventPublishRequests, 1);
    assert.equal(fixture.state.storedEvents.size, 1);
    assert.equal(fixture.state.queryRequests, 4);
    assert.equal(fixture.state.verifiedBlossomAuth, 2);
    assert.equal(fixture.state.verifiedNip98Auth, 5);

    const repoRoot = path.resolve("..");
    const [head, tree, statusOutput, binaryDigest] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
      }),
      execFileAsync("git", ["rev-parse", "HEAD^{tree}"], {
        cwd: repoRoot,
        encoding: "utf8",
      }),
      execFileAsync("git", ["status", "--porcelain"], {
        cwd: repoRoot,
        encoding: "utf8",
      }),
      digestFile(binary),
    ]);
    const receiptPath = process.env.BUZZ_REAL_INTEGRATION_RECEIPT;
    if (receiptPath) {
      const sanitize = (argument) =>
        argument.startsWith(scratch)
          ? `<private-temp>${argument.slice(scratch.length)}`
          : argument;
      const receipt = {
        version: 1,
        mode: "deterministic-loopback-real-binary",
        production: false,
        generatedAt: new Date().toISOString(),
        git: {
          head: head.stdout.trim(),
          tree: tree.stdout.trim(),
          worktreeClean: statusOutput.stdout.length === 0,
        },
        binary: { path: binary, ...binaryDigest },
        fixture: {
          credential: "explicit-well-known-secp256k1-secret-00-through-01",
          signerPubkey: FIXTURE_PUBKEY,
          sourceDocumentUploaded: false,
          attachment: {
            type: "application/pdf",
            sha256: data.sourceSha256,
            bytes: data.sourceBytes,
          },
          relay: fixture.origin,
        },
        invocation: {
          executable: process.execPath,
          argv: first.args.map(sanitize),
          cwd: "<private-temp>",
          environmentKeys: Object.keys({
            PATH: true,
            HOME: true,
            TMPDIR: true,
            LANG: true,
            LC_ALL: true,
            BUZZ_RELAY_URL: true,
            BUZZ_PRIVATE_KEY: true,
          }),
        },
        runs: [
          {
            exitCode: first.exitCode,
            expectedInterruption: "publication-event-readback-missing",
          },
          { exitCode: second.exitCode, journalComplete: journal.complete },
        ],
        counters: {
          uploadRequests: fixture.state.uploadRequests,
          mediaReadbackRequests: fixture.state.mediaReadbackRequests,
          queryRequests: fixture.state.queryRequests,
          eventPublishRequests: fixture.state.eventPublishRequests,
          uniqueStoredEvents: fixture.state.storedEvents.size,
          verifiedBlossomAuth: fixture.state.verifiedBlossomAuth,
          verifiedNip98Auth: fixture.state.verifiedNip98Auth,
          assetAttempts: journal.assets[data.sourceSha256].attempts,
          pagePublishAttempts: journal.pages["fixture-page"].attempts,
          identityChecks: 2,
          signedEventsPersisted: 1,
        },
        result: {
          complete: true,
          uploadReadbackVerified: true,
          eventReadbackVerified: true,
          resumedWithoutDuplicateUpload: true,
          resumedWithoutDuplicatePublish: true,
        },
      };
      await mkdir(path.dirname(path.resolve(receiptPath)), {
        recursive: true,
      });
      await writeFile(
        path.resolve(receiptPath),
        `${JSON.stringify(receipt, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
  } finally {
    await fixture.close();
  }
});
