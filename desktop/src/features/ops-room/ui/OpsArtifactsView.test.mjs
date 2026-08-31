import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import React from "react";

import { OpsBridgeContractError, OpsPageError } from "../opsBridge.ts";
import {
  artifactRows,
  loadArtifactsPage,
  OpsArtifactsView,
} from "./OpsArtifactsView.tsx";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  window: dom.window,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { cleanup, fireEvent, render, screen, waitFor } = await import(
  "@testing-library/react"
);
const clients = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});
const artifact = (id, version = 1) => ({
  id,
  kind: "markdown",
  status: "ready",
  title: id,
  version,
});
function renderView(props) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Number.POSITIVE_INFINITY, retry: false },
    },
  });
  clients.push(client);
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(OpsArtifactsView, props),
    ),
  );
}

test("exposes page rows with their immutable representation for the native reader", () => {
  assert.deepEqual(
    artifactRows([
      {
        id: "artifact:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        kind: "markdown",
        status: "ready",
        title: "Review",
        version: 1,
      },
    ]),
    [
      {
        id: "artifact:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        kind: "markdown",
        representation: "preview",
        status: "ready",
        title: "Review",
        version: 1,
      },
    ],
  );
});

test("keeps unsupported image rows and can page past an image-only first page", async () => {
  const image = {
    ...artifact("artifact:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    kind: "image",
    title: "Screenshot",
  };
  const markdown = artifact("artifact:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.deepEqual(artifactRows([image]), [{ ...image, representation: null }]);

  const calls = [];
  renderView({
    loadPage: async (cursor) => {
      calls.push(cursor);
      return cursor === null
        ? { items: [image], next_cursor: "cursor-1" }
        : { items: [markdown], next_cursor: null };
    },
  });
  await screen.findByText("Screenshot");
  assert.ok(screen.getByText("image · native preview unavailable"));
  assert.ok(screen.queryByRole("button", { name: "Screenshot" }) === null);
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByText(markdown.id);
  assert.deepEqual(calls, [null, "cursor-1"]);
});

test("keeps immutable rows across Load more and replaces them after one stale restart", async () => {
  const first = artifact("artifact:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const replacement = artifact("artifact:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  const calls = [];
  renderView({
    loadPage: async (cursor) => {
      calls.push(cursor);
      return cursor === null
        ? { items: [first], next_cursor: "cursor-1" }
        : { items: [replacement], next_cursor: null, restarted: true };
    },
  });
  await screen.findByText(first.id);
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByText(replacement.id);
  assert.ok(screen.queryByText(first.id) === null);
  assert.deepEqual(calls, [null, "cursor-1"]);
});

test("renders every non-readable connection state without fetching", () => {
  for (const [connectionState, expected] of [
    ["loading", "운영 데이터를 불러오는 중"],
    ["disconnected", "Hub에 연결할 수 없습니다"],
    ["not_configured", "Local Ops Hub가 설정되지 않았습니다"],
    ["version_mismatch", "Ops 계약 버전이 맞지 않습니다"],
    ["contract_invalid", "Ops 데이터 계약을 확인할 수 없습니다"],
  ]) {
    let calls = 0;
    const { unmount } = renderView({
      connectionState,
      loadPage: async () => {
        calls += 1;
        return { items: [], next_cursor: null };
      },
    });
    assert.ok(screen.getByText(expected));
    assert.equal(calls, 0);
    unmount();
  }
});

test("isolates unavailable and invalid Artifacts modules without hiding a valid paged read-only page", async () => {
  for (const [moduleState, expected] of [
    ["unavailable", "Artifacts are unavailable."],
    ["contract_invalid", "Artifacts contract is invalid."],
  ]) {
    const { unmount } = renderView({ moduleState });
    assert.ok(screen.getByText(expected));
    unmount();
  }

  const item = artifact("artifact:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  renderView({
    disabled: true,
    loadPage: async () => ({ items: [item], next_cursor: null }),
  });
  await screen.findByText(item.id);
  assert.ok(screen.getByText("Read-only safe mode is active."));
});

test("keeps stale signed Artifacts readable with an explicit stale banner", async () => {
  const item = artifact("artifact:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  renderView({
    connectionState: "stale",
    loadPage: async () => ({ items: [item], next_cursor: null }),
  });
  await screen.findByText(item.id);
  assert.ok(screen.getByText("연결이 끊겨 마지막 동기화 상태를 표시합니다."));
});

test("offers retry when the Artifacts page changes again after the one stale restart", async () => {
  const item = artifact("artifact:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  let attempts = 0;
  renderView({
    loadPage: async () => {
      attempts += 1;
      if (attempts === 1) throw new OpsPageError("stale_cursor");
      return { items: [item], next_cursor: null };
    },
  });
  await screen.findByText(
    "Artifacts changed again while refreshing. Try again.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry artifacts" }));
  await screen.findByText(item.id);
  assert.equal(attempts, 2);
});

test("offers retry when Load more remains stale after the one restart", async () => {
  const first = artifact("artifact:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const replacement = artifact("artifact:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  const calls = [];
  renderView({
    loadPage: async (cursor) => {
      calls.push(cursor);
      if (cursor === null) return { items: [first], next_cursor: "cursor-1" };
      if (calls.length === 2) throw new OpsPageError("stale_cursor");
      return { items: [replacement], next_cursor: null, restarted: true };
    },
  });
  await screen.findByText(first.id);
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByText(
    "Artifacts changed again while refreshing. Try again.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry artifacts" }));
  await screen.findByText(replacement.id);
  assert.ok(screen.queryByText(first.id) === null);
  assert.deepEqual(calls, [null, "cursor-1", "cursor-1"]);
});

test("isolates unavailable and invalid paged Artifacts failures", async () => {
  for (const [error, expected] of [
    [new Error("artifacts_unavailable"), "Artifacts are unavailable."],
    [new OpsBridgeContractError(), "Ops 데이터 계약을 확인할 수 없습니다"],
    [
      new OpsPageError("invalid_cursor"),
      "Ops 데이터 계약을 확인할 수 없습니다",
    ],
  ]) {
    const { unmount } = renderView({
      loadPage: async () => {
        throw error;
      },
    });
    await waitFor(() => assert.ok(screen.getByText(expected)));
    unmount();
  }
});

test("requires one valid paged Artifacts capability before requesting a page", async () => {
  const pageCalls = [];
  const page = { items: [], next_cursor: null, restarted: false };
  const loadPage = async (request, revision) => {
    pageCalls.push({ request, revision });
    return { page, restarted: false };
  };
  await assert.rejects(
    loadArtifactsPage(null, {
      getCapabilities: async () => ({
        contract_version: 1,
        reads: ["snapshot", "events", "artifact"],
        drafts: [],
        transitions: [],
        modules: [],
      }),
      loadPage,
    }),
    /artifacts_unavailable/,
  );
  await assert.rejects(
    loadArtifactsPage(null, {
      getCapabilities: async () => ({
        contract_version: 1,
        reads: ["snapshot", "events", "artifact"],
        drafts: [],
        transitions: [],
        modules: [
          {
            name: "artifacts",
            schema_version: 1,
            paged: false,
          },
        ],
      }),
      loadPage,
    }),
    { name: "OpsBridgeContractError" },
  );
  assert.equal(pageCalls.length, 0);

  assert.deepEqual(
    await loadArtifactsPage(null, {
      getCapabilities: async () => ({
        contract_version: 1,
        reads: ["snapshot", "events", "artifact"],
        drafts: [],
        transitions: [],
        modules: [
          {
            name: "artifacts",
            schema_version: 1,
            paged: true,
            collection_revision: 19,
          },
        ],
      }),
      loadPage,
    }),
    page,
  );
  assert.equal(pageCalls.length, 1);
  assert.equal(pageCalls[0].revision, 19);
  assert.equal(pageCalls[0].request.module, "artifacts");
});

test("renders an explicit empty signed artifacts page", async () => {
  renderView({ loadPage: async () => ({ items: [], next_cursor: null }) });
  await waitFor(() =>
    assert.ok(screen.getByText("No verified artifacts are available.")),
  );
});
