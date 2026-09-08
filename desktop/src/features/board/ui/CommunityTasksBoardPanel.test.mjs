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

async function seedEvent({ assignees = [], status = "todo" } = {}) {
  const { serializeCommunityTaskContent } = await import(
    "../lib/communityTaskCodec.ts"
  );
  return {
    id: "1".repeat(64),
    pubkey: AUTHOR,
    created_at: 1_000,
    kind: 30078,
    tags: [
      ["d", `community-task:${CARD_ID}`],
      ["t", "community-task"],
    ],
    content: serializeCommunityTaskContent({
      author: AUTHOR,
      title: "Ship the board",
      body: "",
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
 * Stubs the relay + Tauri seams the panel writes through. `signing` decides
 * what `sign_event` does; every other Tauri command answers with something
 * harmless so React Query never retries into the test's timers.
 */
async function installSeams({ signing }) {
  const { relayClient } = await import("@/shared/api/relayClient");
  const published = [];
  let signCounter = 0;
  mock.method(relayClient, "fetchEvents", () => Promise.resolve([]));
  mock.method(relayClient, "subscribeLive", () =>
    Promise.resolve(() => Promise.resolve()),
  );
  mock.method(relayClient, "subscribeToReconnects", () => () => {});
  mock.method(relayClient, "publishEvent", (event) => {
    published.push(event);
    return Promise.resolve();
  });
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: (command, args) => {
      if (command === "sign_event") {
        return signing(args).then((input) =>
          JSON.stringify({
            id: `${String(++signCounter).padStart(4, "0")}${"f".repeat(60)}`,
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
