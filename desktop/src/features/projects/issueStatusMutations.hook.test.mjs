import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

const OWNER = "a".repeat(64);
const OTHER_OWNER = "b".repeat(64);
const AUTHOR = "c".repeat(64);
const ISSUE_ID = "d".repeat(64);

const boundProject = {
  id: `30617:${OWNER}:bound`,
  owner: OWNER,
  repoAddress: `30617:${OWNER}:bound`,
};
const perCallProject = {
  id: `30617:${OTHER_OWNER}:per-call`,
  owner: OTHER_OWNER,
  repoAddress: `30617:${OTHER_OWNER}:per-call`,
};

const issue = {
  author: AUTHOR,
  id: ISSUE_ID,
  status: "Backlog",
  statusCreatedAt: null,
};

// A settled mutation is collected at once — React Query's default 5-minute
// mutation gc timer would otherwise hold the test process open.
const TEST_QUERY_DEFAULTS = {
  mutations: { gcTime: 0, retry: false },
  queries: { gcTime: Number.POSITIVE_INFINITY, retry: false },
};

/** Records every Tauri call and fails at signing, so no relay is reached. */
function installSigningProbe(t) {
  const prior = globalThis.window.__TAURI_INTERNALS__;
  t.after(() => {
    globalThis.window.__TAURI_INTERNALS__ = prior;
  });
  const calls = [];
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: (command, args) => {
      calls.push([command, args]);
      return Promise.reject(new Error("no signer in tests"));
    },
  };
  return calls;
}

async function renderStatusMutation(t, project) {
  const { createElement } = await import("react");
  const { renderHook } = await import("@testing-library/react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { useUpdateProjectIssueStatusMutation } = await import(
    "./issueStatusMutations.ts"
  );
  const queryClient = new QueryClient({ defaultOptions: TEST_QUERY_DEFAULTS });
  t.after(() => queryClient.clear());
  const { result } = renderHook(
    () => useUpdateProjectIssueStatusMutation(project),
    {
      wrapper: ({ children }) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    },
  );
  return result.current.mutateAsync;
}

function repoTagOf(calls) {
  assert.equal(calls.length, 1, "exactly one signing attempt");
  const [command, args] = calls[0];
  assert.equal(command, "sign_event");
  return args.tags.find((tag) => tag[0] === "a")?.[1];
}

test("the hook publishes against the project it was bound to", async (t) => {
  const { act } = await import("@testing-library/react");
  const calls = installSigningProbe(t);
  const mutateAsync = await renderStatusMutation(t, boundProject);

  await act(async () => {
    await assert.rejects(
      mutateAsync({ issue, signAsManagedOwner: false, status: "Triage" }),
      /no signer in tests/,
    );
  });

  assert.equal(repoTagOf(calls), boundProject.repoAddress);
});

test("a project named on the call wins over the bound one", async (t) => {
  const { act } = await import("@testing-library/react");
  const calls = installSigningProbe(t);
  const mutateAsync = await renderStatusMutation(t, boundProject);

  await act(async () => {
    await assert.rejects(
      mutateAsync({
        issue,
        project: perCallProject,
        signAsManagedOwner: false,
        status: "Triage",
      }),
      /no signer in tests/,
    );
  });

  assert.equal(repoTagOf(calls), perCallProject.repoAddress);
});

test("an unbound hook still publishes for a project named on the call", async (t) => {
  const { act } = await import("@testing-library/react");
  const calls = installSigningProbe(t);
  const mutateAsync = await renderStatusMutation(t, undefined);

  await act(async () => {
    await assert.rejects(
      mutateAsync({
        issue,
        project: perCallProject,
        signAsManagedOwner: false,
        status: "Done",
      }),
      /no signer in tests/,
    );
  });

  assert.equal(repoTagOf(calls), perCallProject.repoAddress);
});

test("with no project anywhere the write is refused before signing", async (t) => {
  const { act } = await import("@testing-library/react");
  const calls = installSigningProbe(t);
  const mutateAsync = await renderStatusMutation(t, null);

  await act(async () => {
    await assert.rejects(
      mutateAsync({ issue, signAsManagedOwner: false, status: "Done" }),
      /No project selected/,
    );
  });

  assert.deepEqual(calls, []);
});
