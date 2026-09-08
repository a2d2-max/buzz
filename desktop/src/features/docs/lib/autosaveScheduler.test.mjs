import assert from "node:assert/strict";
import test from "node:test";

import { createAutosaveScheduler } from "./autosaveScheduler.ts";

/** Manual timer harness so tests control when the debounce fires. */
function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    timers: {
      setTimeout: (fn, _ms) => {
        const id = nextId++;
        pending.set(id, fn);
        return id;
      },
      clearTimeout: (id) => {
        pending.delete(id);
      },
    },
    fire() {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, fn] of entries) fn();
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup({ save } = {}) {
  const clock = fakeTimers();
  const saves = [];
  const states = [];
  const scheduler = createAutosaveScheduler({
    delayMs: 1_500,
    save:
      save ??
      (async (draft) => {
        saves.push(draft);
      }),
    onStateChange: (state) => states.push(state),
    timers: clock.timers,
  });
  return { clock, saves, scheduler, states };
}

test("schedule: saves the latest draft once the debounce fires", async () => {
  const { clock, saves, scheduler, states } = setup();
  scheduler.schedule({ body: "a" });
  assert.deepEqual(saves, []);
  assert.equal(scheduler.getState(), "dirty");
  clock.fire();
  await scheduler.flush();
  assert.deepEqual(saves, [{ body: "a" }]);
  assert.equal(scheduler.getState(), "saved");
  assert.deepEqual(states, ["dirty", "saving", "saved"]);
});

test("schedule twice inside the window: one save with the newest draft", async () => {
  const { clock, saves, scheduler } = setup();
  scheduler.schedule({ body: "a" });
  scheduler.schedule({ body: "ab" });
  assert.equal(clock.pendingCount, 1, "timer is restarted, not duplicated");
  clock.fire();
  await scheduler.flush();
  assert.deepEqual(saves, [{ body: "ab" }]);
});

test("flush: saves immediately and cancels the pending timer", async () => {
  const { clock, saves, scheduler } = setup();
  scheduler.schedule({ body: "a" });
  await scheduler.flush();
  assert.deepEqual(saves, [{ body: "a" }]);
  assert.equal(clock.pendingCount, 0);
  clock.fire();
  await scheduler.flush();
  assert.deepEqual(saves, [{ body: "a" }], "nothing dirty → no second save");
});

test("flush with nothing dirty never calls save and reports success", async () => {
  const { saves, scheduler } = setup();
  assert.equal(await scheduler.flush(), true);
  assert.deepEqual(saves, []);
  assert.equal(scheduler.getState(), "idle");
});

test("flush resolves true after a successful save and false after a failed one", async () => {
  let attempts = 0;
  const { scheduler } = setup({
    save: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("relay down");
    },
  });
  scheduler.schedule({ body: "a" });
  assert.equal(await scheduler.flush(), false);
  assert.equal(await scheduler.flush(), true);
});

test("an edit made while a save is in flight is saved afterwards, not lost", async () => {
  const gate = deferred();
  const saves = [];
  const { clock, scheduler } = setup({
    save: async (draft) => {
      saves.push(draft);
      if (saves.length === 1) await gate.promise;
    },
  });
  scheduler.schedule({ body: "a" });
  const first = scheduler.flush();
  assert.equal(scheduler.getState(), "saving");
  scheduler.schedule({ body: "ab" });
  gate.resolve();
  await first;
  assert.equal(scheduler.getState(), "dirty", "newer draft still pending");
  clock.fire();
  await scheduler.flush();
  assert.deepEqual(saves, [{ body: "a" }, { body: "ab" }]);
  assert.equal(scheduler.getState(), "saved");
});

test("a failed save keeps the draft dirty and retries on the next flush", async () => {
  let attempts = 0;
  const saves = [];
  const { scheduler, states } = setup({
    save: async (draft) => {
      attempts += 1;
      if (attempts === 1) throw new Error("relay down");
      saves.push(draft);
    },
  });
  scheduler.schedule({ body: "a" });
  await scheduler.flush();
  assert.equal(scheduler.getState(), "error");
  assert.deepEqual(saves, []);
  await scheduler.flush();
  assert.deepEqual(saves, [{ body: "a" }]);
  assert.equal(scheduler.getState(), "saved");
  assert.deepEqual(states, ["dirty", "saving", "error", "saving", "saved"]);
});

test("dispose cancels the timer without saving", async () => {
  const { clock, saves, scheduler } = setup();
  scheduler.schedule({ body: "a" });
  scheduler.dispose();
  assert.equal(clock.pendingCount, 0);
  clock.fire();
  assert.deepEqual(saves, []);
});

test("hasPendingChanges reflects unsaved drafts", async () => {
  const { scheduler } = setup();
  assert.equal(scheduler.hasPendingChanges(), false);
  scheduler.schedule({ body: "a" });
  assert.equal(scheduler.hasPendingChanges(), true);
  await scheduler.flush();
  assert.equal(scheduler.hasPendingChanges(), false);
});

test("isDirty: true while an unsaved draft exists, including after a failed save", async () => {
  let attempts = 0;
  const { scheduler } = setup({
    save: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("relay down");
    },
  });
  assert.equal(scheduler.isDirty(), false);
  scheduler.schedule({ body: "a" });
  assert.equal(scheduler.isDirty(), true);
  await scheduler.flush();
  assert.equal(scheduler.isDirty(), true, "failed save keeps the draft dirty");
  await scheduler.flush();
  assert.equal(scheduler.isDirty(), false);
});

test("isDirty: a draft scheduled during a save stays dirty until saved", async () => {
  const gate = deferred();
  const { scheduler } = setup({
    save: async () => {
      await gate.promise;
    },
  });
  scheduler.schedule({ body: "a" });
  const first = scheduler.flush();
  assert.equal(
    scheduler.isDirty(),
    false,
    "the in-flight draft is no longer pending",
  );
  scheduler.schedule({ body: "ab" });
  assert.equal(scheduler.isDirty(), true);
  gate.resolve();
  await first;
  assert.equal(scheduler.isDirty(), true);
  await scheduler.flush();
  assert.equal(scheduler.isDirty(), false);
});
