import assert from "node:assert/strict";
import { test, afterEach, mock } from "node:test";
import { relayClient } from "@/shared/api/relayClient";
import * as sync from "./communityTaskSavedViews.ts";
const user = "a".repeat(64);
const view = {
  name: "Mine",
  layout: "list",
  sort: "title",
  filters: { search: "Alpha", status: "all", assignee: "mine", due: "all" },
};
let rows = [];
let writes = [];
let rejectWrite = false;
function setup() {
  rows = [];
  writes = [];
  rejectWrite = false;
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        if (command === "nip44_encrypt_to_self")
          return `encrypted:${args.plaintext}`;
        if (command === "nip44_decrypt_from_self") {
          if (!args.ciphertext.startsWith("encrypted:"))
            throw new Error("bad ciphertext");
          return args.ciphertext.slice(10);
        }
        if (command === "sign_event")
          return JSON.stringify({
            id: String(writes.length + 1).padStart(64, "0"),
            pubkey: user,
            kind: args.kind,
            tags: args.tags,
            content: args.content,
            created_at: args.createdAt,
            sig: "s".repeat(128),
          });
        throw new Error(command);
      },
    },
  };
  mock.method(relayClient, "fetchEvents", async (filter) => {
    assert.deepEqual(filter.authors, [user]);
    assert.deepEqual(filter["#d"], ["community-task-views.v1"]);
    return rows;
  });
  mock.method(relayClient, "publishEvent", async (event) => {
    if (rejectWrite) throw new Error("relay rejected");
    writes.push(event);
    rows = [event];
  });
}
afterEach(() => {
  mock.reset();
  delete globalThis.window;
});
test("signed encrypted views restore without local cache and explicit deletion survives a fresh read", async () => {
  setup();
  assert.equal(
    typeof sync.saveRemoteCommunityTaskViews,
    "function",
    "remote view persistence is missing",
  );
  await sync.saveRemoteCommunityTaskViews(user, [view], null, () => true);
  assert.ok(writes[0].content.startsWith("encrypted:"));
  const restored = await sync.fetchRemoteCommunityTaskViews(user);
  assert.deepEqual(restored.views, [view]);
  await sync.saveRemoteCommunityTaskViews(user, [], restored.event, () => true);
  assert.deepEqual((await sync.fetchRemoteCommunityTaskViews(user)).views, []);
});
test("foreign signer and damaged remote data are errors, never empty successful reads", async () => {
  setup();
  assert.equal(typeof sync.fetchRemoteCommunityTaskViews, "function");
  rows = [
    {
      pubkey: "b".repeat(64),
      kind: 30078,
      tags: [["d", "community-task-views.v1"]],
      content: "encrypted:{}",
    },
  ];
  await assert.rejects(sync.fetchRemoteCommunityTaskViews(user));
  rows[0].pubkey = user;
  rows[0].content = "broken";
  await assert.rejects(sync.fetchRemoteCommunityTaskViews(user));
});
test("stale edit, publish rejection and community switch never overwrite remote views", async () => {
  setup();
  assert.equal(typeof sync.saveRemoteCommunityTaskViews, "function");
  await sync.saveRemoteCommunityTaskViews(user, [view], null, () => true);
  await assert.rejects(
    sync.saveRemoteCommunityTaskViews(user, [], null, () => true),
    /changed/,
  );
  const head = rows[0];
  rejectWrite = true;
  await assert.rejects(
    sync.saveRemoteCommunityTaskViews(user, [], head, () => true),
    /rejected/,
  );
  rejectWrite = false;
  await assert.rejects(
    sync.saveRemoteCommunityTaskViews(user, [], head, () => false),
    /changed/,
  );
  assert.equal(writes.length, 1);
});
