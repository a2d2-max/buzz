import assert from "node:assert/strict";
import { after, afterEach, before, mock, test } from "node:test";

import {
  columnOf,
  installBoardTestDom,
  keyboardDrag,
} from "./communityTaskTestDom.mjs";

const AUTHOR = "a".repeat(64);
const ASSIGNEE = "b".repeat(64);
const STRANGER = "c".repeat(64);
const CARD_ID = "card-1";
/** `activeCommunity` is null without a stored community, so the key is "". */
const QUERY_KEY = ["community-tasks", ""];

let dom;

before(() => {
  dom = installBoardTestDom();
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  mock.reset();
});

after(() => dom.window.close());

const TEST_QUERY_DEFAULTS = {
  mutations: { gcTime: 0, retry: false },
  queries: {
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  },
};

async function seedEvent({
  assignees = [],
  status = "todo",
  id = CARD_ID,
  title = "Ship the board",
  body = "",
  due,
} = {}) {
  const { serializeCommunityTaskContent } = await import(
    "../lib/communityTaskCodec.ts"
  );
  return {
    id: "1".repeat(64),
    pubkey: AUTHOR,
    created_at: 1_000,
    kind: 30078,
    tags: [
      ["d", `community-task:${id}`],
      ["t", "community-task"],
    ],
    content: serializeCommunityTaskContent({
      author: AUTHOR,
      title,
      body,
      ...(due === undefined ? {} : { due }),
      status,
      assignees,
      order: 1,
      createdAt: 900,
      updatedAt: 1_000,
    }),
    sig: "s".repeat(128),
  };
}

/**
 * Stubs the relay + Tauri seams the panel writes through. `signing` is
 * called once per `sign_event` with the call index and decides how that
 * signing settles; every other Tauri command answers with something
 * harmless so React Query never retries into the test's timers. The live
 * subscription reports ready at once so history is allowed to start.
 */
async function installSeams({ signing }) {
  const { relayClient } = await import("@/shared/api/relayClient");
  const published = [];
  let signCounter = 0;
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  mock.method(relayClient, "subscribeLive", (_filter, _onEvent, onReady) => {
    onReady?.("eose");
    return Promise.resolve(() => Promise.resolve());
  });
  mock.method(relayClient, "subscribeToReconnects", () => () => {});
  mock.method(relayClient, "publishEvent", (event) => {
    published.push(event);
    return Promise.resolve();
  });
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: (command, args) => {
      if (command === "sign_event") {
        const index = signCounter++;
        return signing(args, index).then((input) =>
          JSON.stringify({
            id: `${String(index + 1).padStart(4, "0")}${"f".repeat(60)}`,
            pubkey: input.pubkey,
            created_at: args.createdAt,
            kind: args.kind,
            tags: args.tags,
            content: args.content,
            sig: "s".repeat(128),
          }),
        );
      }
      if (command === "get_users_batch") {
        return Promise.resolve({ profiles: {}, missing: [] });
      }
      if (command === "search_users") {
        return Promise.resolve({ users: [], next_cursor: null });
      }
      return Promise.resolve([]);
    },
    transformCallback: () => 1,
  };
  return { published };
}

/** Settle React and the write queue until `predicate` holds (or give up). */
async function settleUntil(predicate, { attempts = 50 } = {}) {
  const { act } = await import("@testing-library/react");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (predicate()) return;
  }
  throw new Error("settleUntil: predicate never held");
}

async function renderPanel({ events, viewer }) {
  const { createElement } = await import("react");
  const { render } = await import("@testing-library/react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { CommunitiesProvider } = await import(
    "@/features/communities/useCommunities.tsx"
  );
  const { ThemeProvider } = await import("@/shared/theme/ThemeProvider.tsx");
  const { CommunityTasksBoardPanel } = await import(
    "./CommunityTasksBoardPanel.tsx"
  );
  const queryClient = new QueryClient({ defaultOptions: TEST_QUERY_DEFAULTS });
  queryClient.setQueryData(["identity"], { pubkey: viewer });
  queryClient.setQueryData(QUERY_KEY, events);
  const result = render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        ThemeProvider,
        null,
        createElement(
          CommunitiesProvider,
          null,
          createElement(CommunityTasksBoardPanel, {}),
        ),
      ),
    ),
  );
  return { ...result, queryClient };
}

async function captureToasts(t) {
  const { toast } = await import("sonner");
  const priorError = toast.error;
  const priorSuccess = toast.success;
  const errors = [];
  const successes = [];
  toast.error = (message) => {
    errors.push(message);
    return 0;
  };
  toast.success = (message) => {
    successes.push(message);
    return 0;
  };
  t.after(() => {
    toast.error = priorError;
    toast.success = priorSuccess;
  });
  return { errors, successes };
}

test("an optimistic move rolls back and reports when signing fails", async (t) => {
  const { act } = await import("@testing-library/react");
  const toasts = await captureToasts(t);
  // Hold the signing step open so the optimistic state can be observed
  // before the write resolves either way.
  let failSigning;
  const signing = new Promise((_resolve, reject) => {
    failSigning = reject;
  });
  const { published } = await installSeams({ signing: () => signing });
  const { container, queryClient } = await renderPanel({
    events: [await seedEvent()],
    viewer: AUTHOR,
  });
  t.after(() => queryClient.clear());

  assert.equal(columnOf(container, CARD_ID), "todo");
  await keyboardDrag(
    container.querySelector("[data-testid='community-task-drag-handle']"),
    1,
  );
  // Optimistic: the card is already in Doing while the write is in flight.
  assert.equal(columnOf(container, CARD_ID), "doing");
  assert.deepEqual(toasts.errors, []);

  failSigning(new Error("Failed to save the task."));
  await act(async () => {
    await Promise.resolve();
  });

  assert.equal(columnOf(container, CARD_ID), "todo");
  assert.deepEqual(toasts.errors, ["Failed to save the task."]);
  assert.deepEqual(published, []);
});

test("a successful move publishes a newer revision and the card stays put", async (t) => {
  const { act } = await import("@testing-library/react");
  const toasts = await captureToasts(t);
  const { published } = await installSeams({
    signing: () => Promise.resolve({ pubkey: AUTHOR }),
  });
  const seed = await seedEvent();
  const { container, queryClient } = await renderPanel({
    events: [seed],
    viewer: AUTHOR,
  });
  t.after(() => queryClient.clear());

  await keyboardDrag(
    container.querySelector("[data-testid='community-task-drag-handle']"),
    1,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(published.length, 1);
  const [event] = published;
  assert.equal(event.kind, 30078);
  assert.deepEqual(event.tags, [
    ["d", `community-task:${CARD_ID}`],
    ["t", "community-task"],
  ]);
  const content = JSON.parse(event.content);
  assert.equal(content.status, "doing");
  assert.equal(content.author, AUTHOR);
  assert.equal(content.title, "Ship the board");
  assert.ok(content.updatedAt > 1_000, "updatedAt moves forward");
  assert.ok(event.created_at > seed.created_at, "replacement sorts after");

  // The overlay is gone and the cache carries the new revision.
  assert.equal(columnOf(container, CARD_ID), "doing");
  const cached = queryClient.getQueryData(QUERY_KEY);
  assert.equal(cached.length, 1);
  assert.equal(cached[0].id, event.id);
  assert.deepEqual(toasts.errors, []);
});

test("a second move of the same card waits for the first and builds on it", async (t) => {
  const toasts = await captureToasts(t);
  // Hold only the first signing; everything after it signs at once.
  let releaseFirst;
  const firstSigning = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const { published } = await installSeams({
    signing: (_args, index) =>
      index === 0 ? firstSigning : Promise.resolve({ pubkey: AUTHOR }),
  });
  const { container, queryClient } = await renderPanel({
    events: [await seedEvent()],
    viewer: AUTHOR,
  });
  t.after(() => queryClient.clear());

  // To Do -> Doing (held), then Doing -> Done while the first is in flight.
  await keyboardDrag(
    container.querySelector("[data-testid='community-task-drag-handle']"),
    1,
  );
  assert.equal(columnOf(container, CARD_ID), "doing");
  await keyboardDrag(
    container.querySelector("[data-testid='community-task-drag-handle']"),
    1,
  );
  assert.equal(columnOf(container, CARD_ID), "done", "optimistic overlay");
  assert.deepEqual(published, [], "the second write waits for the first");

  releaseFirst({ pubkey: AUTHOR });
  await settleUntil(() => published.length === 2);

  const [first, second] = published.map((event) => ({
    content: JSON.parse(event.content),
    createdAt: event.created_at,
    id: event.id,
  }));
  assert.equal(first.content.status, "doing");
  assert.equal(second.content.status, "done");
  assert.ok(
    second.content.updatedAt > first.content.updatedAt,
    "the second write strictly follows the first",
  );
  assert.ok(second.createdAt > first.createdAt);
  assert.equal(columnOf(container, CARD_ID), "done");
  const cached = queryClient.getQueryData(QUERY_KEY);
  assert.equal(cached.length, 1);
  assert.equal(cached[0].id, second.id, "the cache keeps the newest write");
  assert.deepEqual(toasts.errors, []);
});

test("only the author and assignees get drag handles", async (t) => {
  await installSeams({ signing: () => Promise.resolve({ pubkey: STRANGER }) });
  const events = [await seedEvent({ assignees: [ASSIGNEE] })];

  const stranger = await renderPanel({ events, viewer: STRANGER });
  t.after(() => stranger.queryClient.clear());
  assert.equal(
    stranger.container.querySelectorAll(
      "[data-testid='community-task-drag-handle']",
    ).length,
    0,
  );
  assert.equal(columnOf(stranger.container, CARD_ID), "todo");
  stranger.unmount();

  const assignee = await renderPanel({ events, viewer: ASSIGNEE });
  t.after(() => assignee.queryClient.clear());
  assert.equal(
    assignee.container.querySelectorAll(
      "[data-testid='community-task-drag-handle']",
    ).length,
    1,
  );
});

test("a new task is published as the viewer's own card and joins To Do", async (t) => {
  const { act, fireEvent } = await import("@testing-library/react");
  const toasts = await captureToasts(t);
  const { published } = await installSeams({
    signing: () => Promise.resolve({ pubkey: AUTHOR }),
  });
  const { container, queryClient } = await renderPanel({
    events: [],
    viewer: AUTHOR,
  });
  t.after(() => queryClient.clear());

  assert.ok(container.querySelector("[data-testid='community-tasks-empty']"));
  await act(async () => {
    fireEvent.click(
      container.querySelector("[data-testid='community-task-new']"),
    );
  });
  const title = globalThis.document.body.querySelector(
    "[data-testid='community-task-dialog-title']",
  );
  assert.ok(title, "the dialog opened");
  fireEvent.change(title, { target: { value: "First card" } });
  await act(async () => {
    fireEvent.submit(
      globalThis.document.body.querySelector("#community-task-form"),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(published.length, 1);
  const content = JSON.parse(published[0].content);
  assert.equal(content.title, "First card");
  assert.equal(content.status, "todo");
  assert.equal(content.author, AUTHOR);
  assert.deepEqual(content.assignees, []);
  const dTag = published[0].tags.find((tag) => tag[0] === "d")[1];
  assert.match(dTag, /^community-task:[0-9a-f-]{36}$/);
  assert.deepEqual(toasts.successes, ["Task created."]);

  const card = container.querySelector("[data-testid='community-task-card']");
  assert.ok(card, "the new card is on the board");
  assert.equal(card.closest("[data-status]").dataset.status, "todo");
});

test("a signed-out viewer cannot create tasks", async (t) => {
  await installSeams({ signing: () => Promise.resolve({ pubkey: AUTHOR }) });
  const { container, queryClient } = await renderPanel({
    events: [],
    viewer: undefined,
  });
  t.after(() => queryClient.clear());
  assert.equal(
    container.querySelector("[data-testid='community-task-new']").disabled,
    true,
  );
});

test("search survives layout changes and a no-match filter can be cleared", async (t) => {
  const { fireEvent, screen } = await import("@testing-library/react");
  await installSeams({ signing: async () => ({ pubkey: AUTHOR }) });
  const { queryClient } = await renderPanel({
    events: [
      await seedEvent({
        id: "alpha",
        title: "Alpha",
        body: "Release checklist",
      }),
      await seedEvent({ id: "beta", title: "Beta", status: "doing" }),
    ],
    viewer: AUTHOR,
  });
  t.after(() => queryClient.clear());
  fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), {
    target: { value: " RELEASE " },
  });
  assert.equal(screen.getAllByTestId("community-task-card").length, 1);
  assert.match(screen.getByTestId("community-task-card").textContent, /Alpha/);
  fireEvent.click(screen.getByRole("button", { name: "List view" }));
  assert.equal(screen.getAllByTestId("community-task-row").length, 1);
  assert.match(screen.getByTestId("community-task-row").textContent, /Alpha/);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks" }), {
    target: { value: "missing" },
  });
  assert.ok(screen.getByText("No matching tasks"));
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  assert.equal(screen.getAllByTestId("community-task-row").length, 2);
});

test("status and assignment filters intersect while list opening uses existing read-only permissions", async (t) => {
  const { fireEvent, screen } = await import("@testing-library/react");
  await installSeams({ signing: async () => ({ pubkey: STRANGER }) });
  const { queryClient } = await renderPanel({
    events: [
      await seedEvent({
        id: "mine",
        title: "Assigned to me",
        assignees: [STRANGER],
        status: "doing",
      }),
      await seedEvent({
        id: "other",
        title: "Someone else's task",
        status: "doing",
      }),
      await seedEvent({
        id: "future",
        title: "Future task",
        assignees: [STRANGER],
      }),
    ],
    viewer: STRANGER,
  });
  t.after(() => queryClient.clear());
  fireEvent.change(
    screen.getByRole("combobox", { name: "Filter by assignee" }),
    { target: { value: "mine" } },
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Filter by status" }), {
    target: { value: "doing" },
  });
  fireEvent.click(screen.getByRole("button", { name: "List view" }));
  assert.equal(screen.getAllByTestId("community-task-row").length, 1);
  assert.match(
    screen.getByTestId("community-task-row").textContent,
    /Assigned to me/,
  );
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Open Someone else's task" }),
  );
  assert.ok(screen.getByTestId("community-task-readonly"));
  assert.equal(screen.queryByTestId("community-task-sheet-save"), null);
});

test("due sorting works in both layouts and overdue excludes completed tasks", async (t) => {
  const { fireEvent, screen } = await import("@testing-library/react");
  await installSeams({ signing: async () => ({ pubkey: AUTHOR }) });
  const { queryClient } = await renderPanel({
    events: [
      await seedEvent({ id: "no-due", title: "No due" }),
      await seedEvent({ id: "later", title: "Later", due: 978480000 }),
      await seedEvent({ id: "earlier", title: "Earlier", due: 978393600 }),
      await seedEvent({
        id: "completed",
        title: "Completed",
        due: 978307200,
        status: "done",
      }),
    ],
    viewer: AUTHOR,
  });
  t.after(() => queryClient.clear());
  fireEvent.change(screen.getByRole("combobox", { name: "Sort tasks" }), {
    target: { value: "due" },
  });
  const todo = screen.getAllByTestId("community-task-column")[0];
  assert.deepEqual(
    [...todo.querySelectorAll("[data-task-id]")].map((el) => el.dataset.taskId),
    ["earlier", "later", "no-due"],
  );
  fireEvent.change(
    screen.getByRole("combobox", { name: "Filter by due date" }),
    { target: { value: "overdue" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "List view" }));
  assert.deepEqual(
    screen.getAllByTestId("community-task-row").map((el) => el.dataset.taskId),
    ["earlier", "later"],
  );
});

test("timeline places deadlines by calendar date, navigates weeks and opens undated tasks", async (t) => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const { timelineWeekStart } = await import("../lib/communityTaskTimeline.ts");
  await installSeams({ signing: async () => ({ pubkey: AUTHOR }) });
  const start = timelineWeekStart();
  const { queryClient } = await renderPanel({
    events: [
      await seedEvent({
        id: "this-week",
        title: "This week's delivery",
        due: start,
      }),
      await seedEvent({
        id: "next-week",
        title: "Next week's delivery",
        due: start + 7 * 86400,
      }),
      await seedEvent({ id: "unscheduled", title: "Unscheduled work" }),
    ],
    viewer: AUTHOR,
  });
  t.after(() => queryClient.clear());
  fireEvent.click(screen.getByRole("button", { name: "Timeline view" }));
  assert.ok(screen.getByRole("button", { name: "Open This week's delivery" }));
  assert.equal(
    screen.queryByRole("button", { name: "Open Next week's delivery" }),
    null,
  );
  assert.ok(screen.getByText("1 dated tasks outside this week"));
  fireEvent.click(screen.getByRole("button", { name: "Next week" }));
  assert.ok(screen.getByRole("button", { name: "Open Next week's delivery" }));
  assert.equal(
    screen.queryByRole("button", { name: "Open This week's delivery" }),
    null,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Open Unscheduled work" }),
  );
  assert.ok(screen.getByTestId("community-task-sheet-save"));
});

test("custom fields persist through panel create, edit, move and explicit removal", async (t) => {
  const { act, fireEvent, screen } = await import("@testing-library/react");
  const { published } = await installSeams({
    signing: async () => ({ pubkey: AUTHOR }),
  });
  const { queryClient, container } = await renderPanel({
    events: [],
    viewer: AUTHOR,
  });
  t.after(() => queryClient.clear());
  fireEvent.click(screen.getByTestId("community-task-new"));
  fireEvent.change(screen.getByTestId("community-task-dialog-title"), {
    target: { value: "Fields roundtrip" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "New field name" }), {
    target: { value: "Estimate" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "New field type" }), {
    target: { value: "number" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add field" }));
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Value: Estimate" }),
    { target: { value: "0" } },
  );
  await act(async () => {
    fireEvent.submit(
      screen.getByTestId("community-task-dialog").querySelector("form"),
    );
  });
  await settleUntil(() => published.length === 1);
  const initial = JSON.parse(published[0].content).customFields;
  assert.equal(initial[0].value, 0);
  assert.equal(initial[0].type, "number");
  fireEvent.click(screen.getByRole("button", { name: "List view" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Open Fields roundtrip" }),
  );
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Value: Estimate" }),
    { target: { value: "2.5" } },
  );
  await act(async () => {
    fireEvent.submit(
      screen.getByTestId("community-task-sheet-save").closest("form"),
    );
  });
  await settleUntil(() => published.length === 2);
  assert.equal(JSON.parse(published[1].content).customFields[0].value, 2.5);
  fireEvent.click(screen.getByRole("button", { name: "Board view" }));
  await keyboardDrag(
    container.querySelector("[data-testid='community-task-drag-handle']"),
    1,
  );
  await settleUntil(() => published.length === 3);
  assert.equal(JSON.parse(published[2].content).status, "doing");
  assert.equal(JSON.parse(published[2].content).customFields[0].value, 2.5);
  assert.deepEqual(JSON.parse(published[2].content).documents, []);
  fireEvent.click(screen.getByRole("button", { name: "List view" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Open Fields roundtrip" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Remove field: Estimate" }),
  );
  await act(async () => {
    fireEvent.submit(
      screen.getByTestId("community-task-sheet-save").closest("form"),
    );
  });
  await settleUntil(() => published.length === 4);
  assert.deepEqual(JSON.parse(published[3].content).customFields, []);
});
