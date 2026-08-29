import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createOpsRoomFixture } from "./testing/opsRoomFixture.mjs";
import {
  ensureOpsRoomHash,
  opsRoomHash,
  parseOpsRoomHash,
  projectOpsRoom,
} from "./opsProjection.ts";

describe("Ops Room projection", () => {
  test("projects public selection and source badges without leaking provider provenance", () => {
    const projected = projectOpsRoom(createOpsRoomFixture());

    assert.equal(
      projected.workspace.selectedChannelId,
      "project:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    assert.equal(
      projected.workspace.selectedThreadId,
      "work:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    assert.equal(
      projected.context.workItem.id,
      projected.workspace.selectedThreadId,
    );
    assert.deepEqual(
      projected.sessions.map(({ sourceLabel }) => sourceLabel),
      ["Orca", "Codex", "Codex sub", "Claude Code"],
    );
    assert.deepEqual(projected.context.provider, {
      provider: "codex",
      model: "gpt-5.6",
      effort: "high",
      status: "running",
    });
    assert.equal("provenance" in projected.context.provider, false);
    assert.equal("source_ref" in projected.context.provider, false);
  });

  test("sorts timeline chronologically with a stable id tie-break", () => {
    const projected = projectOpsRoom(createOpsRoomFixture());

    assert.deepEqual(
      projected.timeline.map(({ id }) => id),
      [
        "event:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "event:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "event:cccccccccccccccccccccccccccccccc",
        "event:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "event:dddddddddddddddddddddddddddddddd",
        "event:ffffffffffffffffffffffffffffffff",
      ],
    );
    assert.deepEqual(
      projected.timeline.map(({ sourceLabel }) => sourceLabel),
      ["Orca", "Codex", "Codex", "Claude Code", "Codex sub", "Hub"],
    );
    assert.equal(projected.timeline[4].verb, "완료");
    assert.equal(projected.timeline[5].outcome, "승인 필요");
  });

  test("keeps empty collections explicit for honest empty-state rendering", () => {
    const fixture = createOpsRoomFixture();
    fixture.room.channels = [];
    fixture.room.threads = [];
    fixture.room.messages = [];
    fixture.room.context.sessions = [];
    fixture.room.context.approvals = [];
    fixture.room.context.artifacts = [];
    fixture.session_tree = [];
    fixture.checklist = [];
    fixture.decisions = [];

    const projected = projectOpsRoom(fixture);

    assert.deepEqual(projected.workspace.channels, []);
    assert.deepEqual(projected.workspace.threads, []);
    assert.deepEqual(projected.sessions, []);
    assert.deepEqual(projected.timeline, []);
    assert.deepEqual(projected.context.sessions, []);
    assert.deepEqual(projected.context.checklist, []);
    assert.deepEqual(projected.context.decisions, []);
    assert.deepEqual(projected.context.approvals, []);
    assert.deepEqual(projected.context.artifacts, []);
  });

  test("converts the validated 0..1 work progress contract to a display percentage", () => {
    const fixture = createOpsRoomFixture();
    fixture.room.context.work_item.progress = 0.75;

    const projected = projectOpsRoom(fixture);

    assert.equal(projected.context.workItem.progress, 75);
  });

  test("projects a bounded default timeline summary while retaining bounded disclosure", () => {
    const fixture = createOpsRoomFixture();
    fixture.room.messages[0].body = "가".repeat(500);

    const projected = projectOpsRoom(fixture);
    const item = projected.timeline.find(
      ({ id }) => id === "event:dddddddddddddddddddddddddddddddd",
    );

    assert.ok(item);
    assert.equal(item.summary.length, 141);
    assert.equal(item.summary.endsWith("…"), true);
    assert.equal(item.body.length, 500);
  });

  test("round-trips the room/channel/thread selection through the hash URL", () => {
    const hash = opsRoomHash({
      channel: "project:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      thread: "work:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    assert.equal(
      hash,
      "#/ops?view=room&channel=project%3Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&thread=work%3Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    assert.deepEqual(parseOpsRoomHash(hash), {
      channel: "project:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      thread: "work:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      limit: 100,
    });
  });

  test("keeps an existing room selection and normalizes only missing Ops routes", () => {
    const selected =
      "#/ops?view=room&channel=project%3Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&thread=work%3Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    assert.equal(ensureOpsRoomHash(selected), selected);
    assert.equal(ensureOpsRoomHash("#/ops"), "#/ops?view=room");
    assert.equal(ensureOpsRoomHash("#/agents"), "#/ops?view=room");
  });
});
