import assert from "node:assert/strict";
import { before, after, afterEach, test, mock } from "node:test";
import { installBoardTestDom, makeTask } from "./communityTaskTestDom.mjs";
let dom;
before(() => {
  dom = installBoardTestDom();
});
afterEach(async () => {
  (await import("@testing-library/react")).cleanup();
  mock.reset();
  window.localStorage.clear();
  delete window.__TAURI_INTERNALS__;
});
after(() => dom.window.close());
const user = "a".repeat(64);
const relay = "wss://one.example";
async function setup(subscriptionFailure = false) {
  const React = await import("react");
  const testing = await import("@testing-library/react");
  const { relayClient } = await import("@/shared/api/relayClient");
  const heads = new Map();
  let activeUser = user;
  let serial = 0;
  let failure = false;
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      if (command === "nip44_encrypt_to_self")
        return `encrypted:${args.plaintext}`;
      if (command === "nip44_decrypt_from_self") {
        if (!args.ciphertext.startsWith("encrypted:"))
          throw new Error("Cannot decrypt views");
        return args.ciphertext.slice(10);
      }
      if (command === "sign_event")
        return JSON.stringify({
          id: String(++serial).padStart(64, "0"),
          pubkey: activeUser,
          created_at: args.createdAt,
          kind: args.kind,
          tags: args.tags,
          content: args.content,
          sig: "s".repeat(128),
        });
      throw new Error(command);
    },
  };
  mock.method(relayClient, "fetchEvents", async (filter) => {
    return heads.has(filter.authors?.[0]) ? [heads.get(filter.authors[0])] : [];
  });
  mock.method(relayClient, "publishEvent", async (event) => {
    if (failure) throw new Error("Relay rejected save");
    heads.set(event.pubkey, event);
  });
  const subscription = mock.method(relayClient, "subscribeLive", async () => {
    if (subscriptionFailure) throw new Error("Live updates unavailable");
    return async () => {};
  });
  mock.method(relayClient, "subscribeToReconnects", () => () => {});
  const { CommunityTasksView } = await import("./CommunityTasksView.tsx");
  const props = {
    tasks: [
      makeTask({ title: "Alpha", assignees: [user], status: "doing" }),
      makeTask({ id: "beta", title: "Beta" }),
    ],
    viewer: user,
    relayUrl: relay,
    canMoveTask: () => false,
    onOpenTask() {},
    onMoveTask() {},
    newTaskButton: null,
  };
  const element = (changes = {}) =>
    React.createElement(CommunityTasksView, { ...props, ...changes });
  const rendered = testing.render(element());
  await testing.waitFor(() =>
    assert.ok(!testing.screen.queryByText("Loading views…")),
  );
  return {
    ...testing,
    ...rendered,
    element,
    heads,
    subscription,
    recoverSubscription() {
      subscriptionFailure = false;
    },
    setFailure(value) {
      failure = value;
    },
    setUser(value) {
      activeUser = value;
    },
  };
}
function change(fireEvent, screen, role, name, value) {
  fireEvent.change(screen.getByRole(role, { name }), { target: { value } });
}
async function save(ctx, name = "My work") {
  change(ctx.fireEvent, ctx.screen, "textbox", "New view name", name);
  ctx.fireEvent.click(ctx.screen.getByRole("button", { name: "Save view" }));
  await ctx.waitFor(() => assert.ok(ctx.screen.getByRole("option", { name })));
}
test("production views sync a complete snapshot and delete it across fresh cache-free mounts", async () => {
  const ctx = await setup();
  const { fireEvent, screen, waitFor } = ctx;
  change(fireEvent, screen, "searchbox", "Search tasks", "Alpha");
  change(fireEvent, screen, "combobox", "Filter by status", "doing");
  change(fireEvent, screen, "combobox", "Filter by assignee", "mine");
  change(fireEvent, screen, "combobox", "Filter by due date", "none");
  change(fireEvent, screen, "combobox", "Sort tasks", "title");
  fireEvent.click(screen.getByRole("button", { name: "List view" }));
  await save(ctx);
  assert.ok(ctx.heads.get(user).content.startsWith("encrypted:"));
  ctx.unmount();
  window.localStorage.clear();
  const second = ctx.render(ctx.element());
  await waitFor(() =>
    assert.ok(screen.getByRole("option", { name: "My work" })),
  );
  change(fireEvent, screen, "combobox", "Saved task views", "My work");
  fireEvent.click(screen.getByRole("button", { name: "Apply view" }));
  await waitFor(() =>
    assert.equal(screen.getByRole("searchbox").value, "Alpha"),
  );
  assert.equal(screen.getAllByTestId("community-task-row").length, 1);
  for (const [name, value] of [
    ["Filter by status", "doing"],
    ["Filter by assignee", "mine"],
    ["Filter by due date", "none"],
    ["Sort tasks", "title"],
  ])
    assert.equal(screen.getByRole("combobox", { name }).value, value);
  fireEvent.click(screen.getByRole("button", { name: "Delete view" }));
  await waitFor(() =>
    assert.ok(!screen.queryByRole("option", { name: "My work" })),
  );
  second.unmount();
  ctx.render(ctx.element());
  await waitFor(() => assert.ok(!screen.queryByText("Loading views…")));
  assert.ok(!screen.queryByRole("option", { name: "My work" }));
});
test("relay rejection preserves the UI draft and the prior remote snapshot", async () => {
  const ctx = await setup();
  await save(ctx, "Existing");
  ctx.setFailure(true);
  change(ctx.fireEvent, ctx.screen, "textbox", "New view name", "Retry me");
  ctx.fireEvent.click(ctx.screen.getByRole("button", { name: "Save view" }));
  await ctx.waitFor(() =>
    assert.match(ctx.screen.getByRole("alert").textContent, /rejected/),
  );
  assert.equal(
    ctx.screen.getByRole("textbox", { name: "New view name" }).value,
    "Retry me",
  );
  assert.equal(ctx.screen.queryByRole("option", { name: "Retry me" }), null);
  assert.ok(ctx.screen.getByRole("option", { name: "Existing" }));
  ctx.setFailure(false);
  await save(ctx, "Retry me");
});
test("account switch immediately clears exploration and cannot show another account's views", async () => {
  const ctx = await setup();
  await save(ctx, "Private");
  const other = "b".repeat(64);
  ctx.setUser(other);
  ctx.rerender(ctx.element({ viewer: other }));
  assert.equal(ctx.screen.queryByRole("option", { name: "Private" }), null);
  assert.equal(ctx.screen.getByRole("searchbox").value, "");
  await ctx.waitFor(() => assert.ok(!ctx.screen.queryByText("Loading views…")));
  ctx.rerender(ctx.element({ viewer: null }));
  assert.equal(ctx.screen.queryByRole("button", { name: "Save view" }), null);
});
test("unreadable remote snapshot stays intact and a reload recovers without empty overwrite", async () => {
  const ctx = await setup();
  await save(ctx);
  const good = ctx.heads.get(user);
  ctx.heads.set(user, { ...good, content: "broken" });
  ctx.fireEvent.click(ctx.screen.getByRole("button", { name: "Reload views" }));
  await ctx.waitFor(() =>
    assert.match(ctx.screen.getByRole("alert").textContent, /decrypt/),
  );
  assert.equal(ctx.heads.get(user).content, "broken");
  ctx.heads.set(user, good);
  ctx.fireEvent.click(ctx.screen.getByRole("button", { name: "Reload views" }));
  await ctx.waitFor(() => assert.ok(!ctx.screen.queryByRole("alert")));
});
test("explicit local import preserves remote views and local source, including on an empty task list", async () => {
  const ctx = await setup();
  await save(ctx, "Remote");
  const lib = await import("../lib/communityTaskSavedViews.ts");
  const key = lib.communityTaskSavedViewsKey(relay, user);
  const local = {
    name: "Local",
    layout: "timeline",
    sort: "manual",
    filters: { search: "", status: "all", assignee: "all", due: "all" },
  };
  lib.writeCommunityTaskSavedViews(key, [local]);
  ctx.rerender(ctx.element({ tasks: [] }));
  ctx.fireEvent.click(
    ctx.screen.getByRole("button", { name: "Import views from this device" }),
  );
  await ctx.waitFor(() =>
    assert.ok(ctx.screen.getByRole("option", { name: "Local" })),
  );
  assert.ok(ctx.screen.getByRole("option", { name: "Remote" }));
  assert.deepEqual(lib.readCommunityTaskSavedViews(key), [local]);
});
test("stale view edits are refused and reload exposes the winning device snapshot", async () => {
  const ctx = await setup();
  await save(ctx, "First");
  const head = ctx.heads.get(user);
  const body = JSON.parse(head.content.slice(10));
  body.views[0].name = "Other device";
  ctx.heads.set(user, {
    ...head,
    id: "f".repeat(64),
    content: `encrypted:${JSON.stringify(body)}`,
  });
  change(ctx.fireEvent, ctx.screen, "textbox", "New view name", "Stale");
  ctx.fireEvent.click(ctx.screen.getByRole("button", { name: "Save view" }));
  await ctx.waitFor(() =>
    assert.match(ctx.screen.getByRole("alert").textContent, /changed/),
  );
  ctx.fireEvent.click(ctx.screen.getByRole("button", { name: "Reload views" }));
  await ctx.waitFor(() =>
    assert.ok(ctx.screen.getByRole("option", { name: "Other device" })),
  );
  assert.equal(ctx.screen.queryByRole("option", { name: "Stale" }), null);
});

test("live subscription failures stay visible after history refresh and reload retries registration", async () => {
  const ctx = await setup(true);
  await ctx.waitFor(() =>
    assert.match(
      ctx.screen.getByRole("alert").textContent,
      /Live updates unavailable/,
    ),
  );
  ctx.fireEvent(window, new window.Event("focus"));
  await ctx.waitFor(() =>
    assert.equal(
      ctx.screen.getByRole("button", { name: "Save view" }).disabled,
      true,
    ),
  );
  assert.match(
    ctx.screen.getByRole("alert").textContent,
    /Live updates unavailable/,
  );
  ctx.recoverSubscription();
  ctx.fireEvent.click(ctx.screen.getByRole("button", { name: "Reload views" }));
  await ctx.waitFor(() => assert.ok(ctx.subscription.mock.callCount() >= 2));
  await ctx.waitFor(() => assert.ok(!ctx.screen.queryByRole("alert")));
});
