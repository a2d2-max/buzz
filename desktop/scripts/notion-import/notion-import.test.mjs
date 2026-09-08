import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";
import { after, before, describe, test } from "node:test";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../..");
const FIXTURE_ZIP = path.join(HERE, "fixtures/notion-export.zip");
const CLI = path.join(HERE, "cli.ts");

const ROOT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CHILD_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DUPLICATE_ONE_ID = "cccccccccccccccccccccccccccccccc";
const DUPLICATE_TWO_ID = "dddddddddddddddddddddddddddddddd";
const MISSING_ID = "ffffffffffffffffffffffffffffffff";
const SYNTHETIC_ID = "notion-4ed4166cc1e4ee9ec79ea2970c39e664";
const AMBIGUOUS_CHILD_ID = "11111111111111111111111111111111";
const NESTED_ID = "22222222222222222222222222222222";
const PERCENT_ID = "33333333333333333333333333333333";
const LITERAL_PERCENT_ID = "44444444444444444444444444444444";
const PIPE_TITLE_ID = "55555555555555555555555555555555";
const LATE_HEADING_ID = "66666666666666666666666666666666";
const COMMA_TITLE_ID = "88888888888888888888888888888888";

async function runCli(args) {
  return execFileAsync(
    process.execPath,
    [
      "--import",
      path.join(DESKTOP, "test-loader.mjs"),
      "--experimental-strip-types",
      CLI,
      ...args,
    ],
    { cwd: DESKTOP, maxBuffer: 10 * 1024 * 1024 },
  );
}

function makeStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const checksum = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(entry.centralCrc ?? checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

async function expectZipFailure(entries, reason) {
  const scratch = await mkdtemp(
    path.join(os.tmpdir(), "notion-import-bad-zip-"),
  );
  try {
    const zipPath = path.join(scratch, "input.zip");
    await writeFile(zipPath, makeStoredZip(entries));
    await assert.rejects(
      runCli([
        "convert",
        "--zip",
        zipPath,
        "--output",
        path.join(scratch, "output"),
      ]),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, reason);
        return true;
      },
    );
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}

let output;
let intermediate;
let pages;

before(async () => {
  output = await mkdtemp(path.join(os.tmpdir(), "notion-import-test-"));
  await runCli([
    "convert",
    "--zip",
    FIXTURE_ZIP,
    "--output",
    output,
    "--relation-column",
    "Relation",
  ]);
  intermediate = JSON.parse(
    await readFile(path.join(output, "notion-import.json"), "utf8"),
  );
  pages = new Map(intermediate.pages.map((page) => [page.id, page]));
});

after(async () => {
  await rm(output, { force: true, recursive: true });
});

function page(id) {
  const found = pages.get(id);
  assert.ok(found, `fixture page ${id} must exist`);
  return found;
}

describe("convert CLI fixture", () => {
  test("page ids use the trailing Notion id or a deterministic marked path hash", () => {
    assert.equal(pages.size, 12);
    assert.equal(page(ROOT_ID).idSource, "notion");
    assert.equal(page(SYNTHETIC_ID).idSource, "path-hash");
    assert.equal(intermediate.report.nativePageIdCount, 11);
    assert.equal(intermediate.report.syntheticPageIdCount, 1);
  });

  test("a leading H1 becomes the title, while a later H1 stays in the body", () => {
    assert.equal(page(ROOT_ID).title, "Root Page");
    assert.doesNotMatch(page(ROOT_ID).body, /^# Root Page/m);
    assert.equal(page(LATE_HEADING_ID).title, "Late Heading");
    assert.match(page(LATE_HEADING_ID).body, /^Preface stays/);
    assert.match(page(LATE_HEADING_ID).body, /^# Later heading stays too$/m);
  });

  test("closest unique folder parents and archive sibling order form the tree", () => {
    assert.equal(page(ROOT_ID).parentId, null);
    assert.equal(page(ROOT_ID).order, 0);
    assert.equal(page(CHILD_ID).parentId, ROOT_ID);
    assert.equal(page(CHILD_ID).order, 0);
    assert.equal(page(DUPLICATE_ONE_ID).order, 1);
    assert.equal(page(DUPLICATE_TWO_ID).order, 2);
  });

  test("an ambiguous parent moves to root while its certain subtree stays attached", () => {
    assert.equal(page(AMBIGUOUS_CHILD_ID).parentId, null);
    assert.equal(page(NESTED_ID).parentId, AMBIGUOUS_CHILD_ID);
    assert.deepEqual(intermediate.diagnostics.unresolvedParents, [
      {
        candidateParentIds: [DUPLICATE_ONE_ID, DUPLICATE_TWO_ID],
        pageId: AMBIGUOUS_CHILD_ID,
        reason: "ambiguous-parent-title",
      },
    ]);
    assert.equal(intermediate.report.unresolvedParentCount, 1);
  });

  test("page links resolve by id or exact decoded path, including literal percent names", () => {
    const body = page(ROOT_ID).body;
    assert.match(body, new RegExp(`\\[Child\\]\\(/#/docs/${CHILD_ID}\\)`));
    assert.match(body, new RegExp(`\\[Loose\\]\\(/#/docs/${SYNTHETIC_ID}\\)`));
    assert.match(body, new RegExp(`\\[Percent\\]\\(/#/docs/${PERCENT_ID}\\)`));
    assert.match(
      body,
      new RegExp(
        `\\[Literal percent encoding\\]\\(/#/docs/${LITERAL_PERCENT_ID}\\)`,
      ),
    );
  });

  test("a missing page link stays unchanged and is listed without its title", () => {
    assert.match(page(ROOT_ID).body, new RegExp(MISSING_ID));
    assert.deepEqual(intermediate.diagnostics.unresolvedLinks, [
      { pageId: ROOT_ID, reason: "page-not-found", targetId: MISSING_ID },
    ]);
    assert.equal(
      intermediate.report.pageLinkTargetCount,
      intermediate.report.linkResolvedCount +
        intermediate.report.linkUnresolvedCount,
    );
  });

  test("an inline CSV becomes a table with quoted, multiline and escaped cells", () => {
    const body = page(ROOT_ID).body;
    assert.match(body, /\| Name \| Relation \| Notes \|/);
    assert.match(body, /first line ⏎ second \\| cell/);
    assert.match(body, /comma, quote &quot;ok&quot;/);
    assert.equal(intermediate.report.databaseCount, 1);
    assert.equal(intermediate.report.databaseCsvFileCount, 2);
    assert.equal(intermediate.report.databaseRowCount, 6);
    assert.equal(intermediate.report.inlineDatabaseCount, 1);
  });

  test("only named relation columns use label-to-unique-title links", () => {
    const body = page(ROOT_ID).body;
    assert.match(body, new RegExp(`\\[Child Page\\]\\(/#/docs/${CHILD_ID}\\)`));
    assert.match(
      body,
      new RegExp(`\\[A\\\\\\|B\\]\\(/#/docs/${PIPE_TITLE_ID}\\)`),
    );
    assert.match(
      body,
      new RegExp(`\\[Comma, Title\\]\\(/#/docs/${COMMA_TITLE_ID}\\)`),
    );
    assert.doesNotMatch(
      body,
      new RegExp(`Three.*\\[Child Page\\]\\(/#/docs/${CHILD_ID}\\)`),
    );
    assert.equal(intermediate.report.relationResolvedCount, 8);
    assert.equal(intermediate.report.relationNonemptyCellCount, 6);
    assert.equal(intermediate.report.relationReferenceCount, 11);
    assert.equal(intermediate.report.relationColumnCount, 1);
  });

  test("ambiguous and unknown relation labels stay text and are counted", () => {
    assert.match(page(ROOT_ID).body, /\| Two \| Duplicate \(Duplicate%20/);
    assert.match(
      page(ROOT_ID).body,
      /\| Four \| Missing Relation \(Missing%20Relation%20/,
    );
    assert.equal(intermediate.report.relationAmbiguousCount, 2);
    assert.equal(intermediate.report.relationUnresolvedCount, 1);
    assert.equal(intermediate.diagnostics.ambiguousRelations.length, 2);
    assert.equal(intermediate.diagnostics.unresolvedRelations.length, 1);
    assert.equal(
      "value" in intermediate.diagnostics.unresolvedRelations[0],
      false,
    );
  });

  test("aside and details expand, then their page links are rewritten", () => {
    const body = page(ROOT_ID).body;
    const proseBeforeFence = body.slice(0, body.indexOf("```html"));
    assert.doesNotMatch(
      proseBeforeFence,
      /<aside>|<\/aside>|<details>|<\/details>/,
    );
    assert.match(body, /> Remember \*\*this\*\*\./);
    assert.match(body, /\*\*Open this\*\*[\s\S]*Expanded body\./);
    assert.match(
      body,
      new RegExp(`\\[Child in aside\\]\\(/#/docs/${CHILD_ID}\\)`),
    );
    assert.match(
      body,
      new RegExp(`\\[Loose in details\\]\\(/#/docs/${SYNTHETIC_ID}\\)`),
    );
  });

  test("fenced and differently-delimited inline code keep literal Notion HTML", () => {
    const body = page(ROOT_ID).body;
    assert.match(body, /```html\n<aside>fenced literal<\/aside>/);
    assert.match(
      body,
      /<details><summary>fenced<\/summary>literal<\/details>\nreplacement tokens stay literal: \$` \$' \$&\n```/,
    );
    assert.match(body, /`<aside>inline literal<\/aside>`/);
    assert.match(body, /``<details>literal ` tick<\/details>``/);
    assert.match(body, /``replacement \$` \$' \$&``/);
  });

  test("attachments keep their relative paths and physical/reference counts stay separate", () => {
    assert.match(
      page(ROOT_ID).body,
      /!\[Diagram\]\(Root%20Page\/diagram\.png\)/,
    );
    assert.match(
      page(ROOT_ID).body,
      /\[Aside file\]\(Root%20Page\/brief\.pdf\)/,
    );
    assert.equal(intermediate.report.attachmentFileCount, 2);
    assert.equal(intermediate.report.attachmentReferenceCount, 3);
  });

  test("unsupported syntax is counted after every conversion", () => {
    assert.deepEqual(intermediate.report.unsupportedSyntax, {
      "CSV multiline cells": 1,
      footnotes: 1,
      tables: 1,
    });
  });
});

describe("ZIP input guards", () => {
  test("invalid UTF-8 fails instead of replacing source bytes", async () => {
    await expectZipFailure(
      [
        {
          name: "Bad 99999999999999999999999999999999.md",
          data: Buffer.from([0x23, 0x20, 0xc3, 0x28]),
        },
      ],
      /invalid-utf8-text-entry:entry-index=0/,
    );
  });

  test("a central-directory CRC mismatch fails", async () => {
    await expectZipFailure(
      [
        {
          name: "Bad 99999999999999999999999999999999.md",
          data: Buffer.from("# Valid UTF-8"),
          centralCrc: 1,
        },
      ],
      /zip-entry-crc-mismatch:entry-index=0/,
    );
  });

  test("duplicate and path-traversal entries fail without exposing names", async () => {
    const safeName = "Same 99999999999999999999999999999999.md";
    await expectZipFailure(
      [
        { name: safeName, data: Buffer.from("# One") },
        { name: safeName, data: Buffer.from("# Two") },
      ],
      /duplicate-zip-entry:entry-index=1/,
    );
    await expectZipFailure(
      [
        {
          name: "../Bad 99999999999999999999999999999999.md",
          data: Buffer.from("# Bad"),
        },
      ],
      /unsafe-zip-entry-path/,
    );
  });
});

describe("publish dry-run CLI", () => {
  test("creates depth-first unsigned kind-30623 signer inputs without a key or network", async () => {
    const { stdout } = await runCli([
      "publish",
      "--input",
      path.join(output, "notion-import.json"),
      "--output",
      output,
      "--relay",
      "wss://must-not-connect.invalid",
    ]);
    const events = JSON.parse(
      await readFile(path.join(output, "notion-events.json"), "utf8"),
    );

    assert.equal(events.mode, "dry-run");
    assert.equal(events.complete, true);
    assert.equal(events.readyToPublish, false);
    assert.equal(events.inputPageCount, 12);
    assert.equal(events.rejectedParentCount, 0);
    assert.equal(events.dependentEventCount, 0);
    assert.equal(events.relay, "wss://must-not-connect.invalid");
    assert.deepEqual(
      events.events.map((event) => event.pageId),
      [
        ROOT_ID,
        CHILD_ID,
        DUPLICATE_ONE_ID,
        DUPLICATE_TWO_ID,
        SYNTHETIC_ID,
        AMBIGUOUS_CHILD_ID,
        NESTED_ID,
        PERCENT_ID,
        LITERAL_PERCENT_ID,
        PIPE_TITLE_ID,
        LATE_HEADING_ID,
        COMMA_TITLE_ID,
      ],
    );
    assert.deepEqual(events.events[0].unsignedEvent.tags, [
      ["d", `doc:${ROOT_ID}`],
      ["t", "community-doc"],
    ]);
    assert.equal(events.events[0].unsignedEvent.kind, 30623);
    assert.equal("id" in events.events[0].unsignedEvent, false);
    assert.equal("pubkey" in events.events[0].unsignedEvent, false);
    assert.equal("sig" in events.events[0].unsignedEvent, false);
    assert.match(stdout, /dry-run/i);
    const report = JSON.parse(
      await readFile(path.join(output, "notion-import-report.json"), "utf8"),
    );
    assert.deepEqual(report.publish, {
      complete: true,
      dependentEventCount: 0,
      failureCount: 0,
      failures: [],
      inputPageCount: 12,
      livePublished: false,
      maxFailureBytes: null,
      minFailureBytes: null,
      mode: "dry-run",
      readyToPublish: false,
      rejectedParentCount: 0,
      unsignedEventCount: 12,
    });
  });

  test("writes a failure and exits nonzero above the 256 KiB content limit", async () => {
    const oversizedOutput = await mkdtemp(
      path.join(os.tmpdir(), "notion-import-oversized-"),
    );
    try {
      const copy = structuredClone(intermediate);
      copy.pages[0].body = "x".repeat(300 * 1024);
      const inputPath = path.join(oversizedOutput, "notion-import.json");
      await writeFile(inputPath, `${JSON.stringify(copy)}\n`);
      await assert.rejects(
        runCli(["publish", "--input", inputPath, "--output", oversizedOutput]),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, /page-content-too-large/);
          return true;
        },
      );
      const events = JSON.parse(
        await readFile(
          path.join(oversizedOutput, "notion-events.json"),
          "utf8",
        ),
      );
      assert.deepEqual(
        events.failures.map(({ pageId, reason }) => ({ pageId, reason })),
        [{ pageId: ROOT_ID, reason: "page-content-too-large" }],
      );
      assert.equal(events.complete, false);
      assert.equal(events.readyToPublish, false);
      assert.equal(events.inputPageCount, 12);
      assert.equal(events.rejectedParentCount, 1);
      assert.equal(events.dependentEventCount, 1);
    } finally {
      await rm(oversizedOutput, { force: true, recursive: true });
    }
  });
});
