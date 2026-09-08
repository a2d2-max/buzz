import assert from "node:assert/strict";
import test from "node:test";

import { CommunityTaskWriteQueue } from "./communityTaskWriteQueue.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

test("writes to one card run one after another, in order", async () => {
  const queue = new CommunityTaskWriteQueue();
  const first = deferred();
  const log = [];
  const a = queue.enqueue("card", async () => {
    log.push("a:start");
    await first.promise;
    log.push("a:end");
    return "a";
  });
  const b = queue.enqueue("card", async () => {
    log.push("b:start");
    return "b";
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(log, ["a:start"], "b waits for a");
  assert.equal(queue.isBusy("card"), true);

  first.resolve();
  assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
  assert.deepEqual(log, ["a:start", "a:end", "b:start"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(queue.isBusy("card"), false);
});

test("different cards do not wait for each other", async () => {
  const queue = new CommunityTaskWriteQueue();
  const held = deferred();
  const log = [];
  const slow = queue.enqueue("card-1", async () => {
    await held.promise;
    log.push("slow");
  });
  await queue.enqueue("card-2", async () => {
    log.push("fast");
  });
  assert.deepEqual(log, ["fast"]);
  held.resolve();
  await slow;
  assert.deepEqual(log, ["fast", "slow"]);
});

test("a failed write neither blocks nor poisons the next one", async () => {
  const queue = new CommunityTaskWriteQueue();
  const failing = queue.enqueue("card", async () => {
    throw new Error("relay said no");
  });
  const next = queue.enqueue("card", async () => "recovered");
  await assert.rejects(failing, /relay said no/);
  assert.equal(await next, "recovered");
});
