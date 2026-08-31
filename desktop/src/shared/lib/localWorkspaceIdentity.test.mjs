import assert from "node:assert/strict";
import test from "node:test";

import {
  createLocalWorkspaceIdentityService,
  LOCAL_WORKSPACE_ID_STORAGE_KEY,
} from "./localWorkspaceIdentity.ts";

const FIRST_UUID = "01234567-89ab-4def-8123-456789abcdef";
const SECOND_UUID = "fedcba98-7654-4abc-9def-0123456789ab";

function memoryStorage(initial = new Map()) {
  return {
    getItem(key) {
      return initial.get(key) ?? null;
    },
    setItem(key, value) {
      initial.set(key, value);
    },
  };
}

test("creates and persists a valid local workspace UUID", () => {
  const storage = memoryStorage();
  const identity = createLocalWorkspaceIdentityService({
    createUuid: () => FIRST_UUID,
    storage,
  });

  assert.equal(identity.getId(), FIRST_UUID);
  assert.equal(storage.getItem(LOCAL_WORKSPACE_ID_STORAGE_KEY), FIRST_UUID);
});

test("a new service instance reuses the persisted workspace UUID", () => {
  const storage = memoryStorage();
  const first = createLocalWorkspaceIdentityService({
    createUuid: () => FIRST_UUID,
    storage,
  });
  assert.equal(first.getId(), FIRST_UUID);

  const reloaded = createLocalWorkspaceIdentityService({
    createUuid: () => SECOND_UUID,
    storage,
  });
  assert.equal(reloaded.getId(), FIRST_UUID);
});

test("replaces a corrupt persisted workspace value", () => {
  const storage = memoryStorage(
    new Map([[LOCAL_WORKSPACE_ID_STORAGE_KEY, "not-a-workspace-uuid"]]),
  );
  const identity = createLocalWorkspaceIdentityService({
    createUuid: () => SECOND_UUID,
    storage,
  });

  assert.equal(identity.getId(), SECOND_UUID);
  assert.equal(storage.getItem(LOCAL_WORKSPACE_ID_STORAGE_KEY), SECOND_UUID);
});

test("write-denied storage keeps a stable in-memory UUID", () => {
  const storage = {
    getItem() {
      throw new DOMException("denied", "SecurityError");
    },
    setItem() {
      throw new DOMException("denied", "SecurityError");
    },
  };
  let calls = 0;
  const identity = createLocalWorkspaceIdentityService({
    createUuid() {
      calls += 1;
      return calls === 1 ? FIRST_UUID : SECOND_UUID;
    },
    storage,
  });

  assert.equal(identity.getId(), FIRST_UUID);
  assert.equal(identity.getId(), FIRST_UUID);
  assert.equal(calls, 1);
});
