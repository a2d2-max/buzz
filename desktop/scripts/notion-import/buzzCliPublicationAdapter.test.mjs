import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";

import { createBuzzCliPublicationApi } from "./buzzCliPublicationAdapter.ts";

const HASH = "a".repeat(64);
const PUBKEY = "b".repeat(64);
const EVENT_ID = "c".repeat(64);
const SIG = "d".repeat(128);

test("Buzz CLI adapter binds every executor operation without exposing credential flags", async () => {
  const calls = [];
  const event = {
    id: EVENT_ID,
    pubkey: PUBKEY,
    kind: 30623,
    content: '{"title":"fixture"}',
    created_at: 1,
    tags: [
      ["d", "doc:fixture-page"],
      ["t", "community-doc"],
    ],
    sig: SIG,
  };
  const runner = async (executable, args) => {
    calls.push({ executable, args: [...args] });
    const command = args.join(" ");
    if (command === "publication identity") {
      return {
        stdout: `${JSON.stringify({ relay: "https://relay.example", pubkey: PUBKEY })}\n`,
      };
    }
    if (command.startsWith("upload file --file ")) {
      return {
        stdout: `${JSON.stringify({
          url: `https://relay.example/media/${HASH}.pdf`,
          sha256: HASH,
          size: 7,
          type: "application/pdf",
          uploaded: 1,
        })}\n`,
      };
    }
    if (command.startsWith("media get ")) {
      const outputIndex = args.indexOf("--output");
      assert.notEqual(outputIndex, -1);
      await writeFile(args[outputIndex + 1], "fixture");
      return { stdout: "" };
    }
    if (command === "publication query-doc --page-id fixture-page") {
      return { stdout: `${JSON.stringify([event])}\n` };
    }
    if (command.startsWith("publication sign-doc --input ")) {
      return { stdout: `${JSON.stringify(event)}\n` };
    }
    if (command.startsWith("publication publish-doc --input ")) {
      return {
        stdout: `${JSON.stringify({ event_id: EVENT_ID, accepted: true, message: "" })}\n`,
      };
    }
    throw new Error(`unexpected-command:${command}`);
  };
  const api = createBuzzCliPublicationApi({
    buzzCliPath: "/fixture/bin/buzz",
    runner,
  });

  assert.equal(await api.getCurrentRelay(), "wss://relay.example");
  assert.equal(await api.getCurrentSignerPubkey(), PUBKEY);
  assert.equal(
    (
      await api.uploadAsset({
        localPath: "/fixture/source.pdf",
        sourceSha256: HASH,
        sourceBytes: 7,
        mime: "application/pdf",
      })
    ).sha256,
    HASH,
  );
  assert.equal(
    Buffer.from(
      await api.readAsset({
        sourceSha256: HASH,
        sourceBytes: 7,
        remoteSha256: HASH,
        remoteBytes: 7,
        mime: "application/pdf",
        url: `https://relay.example/media/${HASH}.pdf`,
        uploadAccepted: true,
        readbackVerified: false,
      }),
    ).toString(),
    "fixture",
  );
  assert.deepEqual(await api.queryDocVersions("fixture-page"), [event]);
  assert.deepEqual(
    await api.signEvent({
      kind: 30623,
      content: event.content,
      tags: event.tags,
      createdAt: 1,
    }),
    event,
  );
  assert.deepEqual(await api.publishEvent(event), {
    eventId: EVENT_ID,
    accepted: true,
    message: "",
  });

  assert.equal(calls[0].executable, "/fixture/bin/buzz");
  assert.equal(
    calls.filter((call) => call.args[0] === "publication").length,
    4,
  );
  assert.equal(
    calls.some((call) =>
      call.args.some((argument) =>
        ["--private-key", "--auth-tag", "--relay"].includes(argument),
      ),
    ),
    false,
  );
});

test("Buzz CLI adapter rejects non-JSON and oversized readback before returning bytes", async () => {
  const api = createBuzzCliPublicationApi({
    buzzCliPath: "/fixture/bin/buzz",
    runner: async (_executable, args) => {
      if (args[0] === "publication") return { stdout: "not-json" };
      const outputIndex = args.indexOf("--output");
      await writeFile(args[outputIndex + 1], "too-large");
      return { stdout: "" };
    },
  });
  await assert.rejects(
    api.getCurrentRelay(),
    /publication-buzz-cli-invalid-json/,
  );
  await assert.rejects(
    api.readAsset({
      sourceSha256: HASH,
      sourceBytes: 1,
      remoteSha256: HASH,
      remoteBytes: 1,
      mime: "application/pdf",
      url: `https://relay.example/media/${HASH}.pdf`,
      uploadAccepted: true,
      readbackVerified: false,
    }),
    /publication-buzz-cli-readback-size-mismatch/,
  );
});
