import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, describe, test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";

import { createOpsRoomFixture } from "../testing/opsRoomFixture.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/#/ops?view=room",
});

Object.assign(globalThis, {
  document: dom.window.document,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  HTMLElement: dom.window.HTMLElement,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
  Node: dom.window.Node,
  window: dom.window,
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let reducedMotion = false;
dom.window.matchMedia = (query) => ({
  matches: query === "(prefers-reduced-motion: reduce)" && reducedMotion,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() {
    return true;
  },
});

const { cleanup, fireEvent, render, screen } = await import(
  "@testing-library/react"
);
const { projectOpsRoom } = await import("../opsProjection.ts");
const { OpsSessionTree } = await import("./OpsSessionTree.tsx");
const {
  OpsRoomView,
  opsGlobalStateNoticeMessages,
  opsSourceConnectionState,
  opsSourceRoutePending,
  opsWorkRouteMode,
} = await import("./OpsRoomScreen.tsx");

afterEach(() => {
  cleanup();
  reducedMotion = false;
  Object.defineProperty(dom.window, "innerWidth", {
    configurable: true,
    value: 1280,
  });
});

function setWidth(width) {
  Object.defineProperty(dom.window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

function roomView(overrides = {}) {
  const projection = projectOpsRoom(createOpsRoomFixture());
  return React.createElement(OpsRoomView, {
    connectionState: "ready",
    onRetry() {},
    onSelectChannel() {},
    onSelectThread() {},
    projection,
    ...overrides,
  });
}

describe("native Ops Room components", () => {
  test("global notices omit not-requested modules and never label pending as retry", () => {
    assert.equal(typeof opsGlobalStateNoticeMessages, "function");
    assert.deepEqual(
      opsGlobalStateNoticeMessages({
        audit: { status: "retry_required", refreshed: true },
        evidence: { status: "pending" },
        search: { status: "not_requested" },
      }),
      ["Evidence is loading.", "Audit changed again. Retry required."],
    );
  });

  test("source routes relax snapshot transport only after capabilities are ready", () => {
    assert.equal(opsSourceRoutePending(undefined, null), true);
    assert.equal(opsSourceRoutePending({ contract_version: 1 }, null), false);
    assert.equal(
      opsSourceConnectionState(false, null, "disconnected"),
      "disconnected",
    );
    assert.equal(opsSourceConnectionState(true, null, "disconnected"), "ready");
    assert.equal(opsSourceConnectionState(true, null, "loading"), "ready");
    assert.equal(
      opsSourceConnectionState(true, null, "version_mismatch"),
      "version_mismatch",
    );
    assert.equal(
      opsSourceConnectionState(true, null, "contract_invalid"),
      "contract_invalid",
    );
    assert.equal(
      opsSourceConnectionState(
        true,
        new Error("capability failed"),
        "version_mismatch",
      ),
      "version_mismatch",
    );
    assert.equal(
      opsSourceConnectionState(true, new Error("capability failed"), "ready"),
      "disconnected",
    );
  });

  test("direct Work outer branch distinguishes lifecycle, updating, and true empty", () => {
    assert.equal(typeof opsWorkRouteMode, "function");
    assert.equal(opsWorkRouteMode(null, [], { status: "pending" }), "pending");
    assert.equal(
      opsWorkRouteMode(null, [], { status: "unavailable" }),
      "unavailable",
    );
    assert.equal(
      opsWorkRouteMode(null, [], { status: "contract_invalid" }),
      "contract_invalid",
    );
    assert.equal(
      opsWorkRouteMode(null, [], { status: "retry_required", refreshed: true }),
      "retry_required",
    );
    assert.equal(
      opsWorkRouteMode(null, [{ id: "work:a" }], {
        status: "ready",
        items: [{ id: "work:a" }],
        revision: 2,
        refreshed: false,
      }),
      "updating",
    );
    assert.equal(
      opsWorkRouteMode(null, [], {
        status: "ready",
        items: [],
        revision: 2,
        refreshed: false,
      }),
      "empty",
    );
    assert.equal(
      opsWorkRouteMode("work:a", [{ id: "work:a" }], {
        status: "ready",
        items: [{ id: "work:a" }],
        revision: 2,
        refreshed: false,
      }),
      "selected",
    );
  });

  test("renders the four-column desktop room with canonical work and no action controls", () => {
    setWidth(1280);
    render(roomView());

    assert.equal(screen.getAllByTestId("ops-main-pane").length, 4);
    assert.ok(screen.getByText("Buzz 통합"));
    assert.ok(screen.getAllByText("Codex sub").length >= 1);
    assert.ok(screen.getAllByText("완료").length >= 1);
    assert.ok(screen.getByText("gpt-5.6"));
    assert.ok(screen.getByText("72%"));
    const progress = screen.getByRole("progressbar", { name: "진행률 72%" });
    assert.equal(progress.getAttribute("aria-valuenow"), "72");
    assert.equal(progress.firstElementChild?.style.width, "72%");
    assert.equal(
      screen.queryAllByRole("button", {
        name: /deliver|send|execute|push|merge|publish|deploy/i,
      }).length,
      0,
    );
  });

  test("moves roving tree focus with arrows and selects with Enter", () => {
    const projection = projectOpsRoom(createOpsRoomFixture());
    let selected = null;
    render(
      React.createElement(OpsSessionTree, {
        onSelect(id) {
          selected = id;
        },
        selectedSessionId: projection.sessions[0].id,
        sessions: projection.sessions,
      }),
    );

    const treeItems = screen.getAllByRole("treeitem");
    treeItems[0].focus();
    fireEvent.keyDown(treeItems[0], { key: "ArrowDown" });
    assert.equal(document.activeElement, treeItems[1]);
    assert.equal(treeItems[1].tabIndex, 0);
    fireEvent.keyDown(treeItems[1], { key: "Enter" });
    assert.equal(selected, projection.sessions[1].id);
    fireEvent.keyDown(treeItems[1], { key: "ArrowUp" });
    assert.equal(document.activeElement, treeItems[0]);
  });

  test("resets roving focus to the first valid session when the tree swaps", () => {
    const projection = projectOpsRoom(createOpsRoomFixture());
    const view = render(
      React.createElement(OpsSessionTree, {
        onSelect() {},
        selectedSessionId: projection.sessions[2].id,
        sessions: projection.sessions,
      }),
    );
    assert.equal(screen.getAllByRole("treeitem")[2].tabIndex, 0);

    const nextSessions = projection.sessions
      .slice(0, 2)
      .map((session, index) => ({
        ...session,
        id: `next-${index}`,
        parentSessionId: null,
      }));
    view.rerender(
      React.createElement(OpsSessionTree, {
        onSelect() {},
        selectedSessionId: null,
        sessions: nextSessions,
      }),
    );

    const nextItems = screen.getAllByRole("treeitem");
    assert.equal(nextItems[0].tabIndex, 0);
    assert.equal(nextItems[1].tabIndex, -1);
  });

  test("keeps work-linked session selection local without changing the canonical thread", () => {
    setWidth(1280);
    let threadSelections = 0;
    const projection = projectOpsRoom(createOpsRoomFixture());
    const view = render(
      roomView({
        onSelectThread() {
          threadSelections += 1;
        },
        projection,
      }),
    );
    const canonicalThread = projection.workspace.selectedThreadId;
    fireEvent.click(screen.getAllByRole("treeitem")[2]);
    assert.equal(
      screen.getAllByRole("treeitem")[2].getAttribute("aria-selected"),
      "true",
    );
    assert.equal(threadSelections, 0);
    assert.equal(projection.workspace.selectedThreadId, canonicalThread);

    const nextProjection = {
      ...projection,
      sessions: [
        {
          ...projection.sessions[0],
          id: "fresh-session",
          parentSessionId: null,
        },
      ],
      workspace: {
        ...projection.workspace,
        selectedThreadId: "work:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    };
    view.rerender(roomView({ projection: nextProjection }));
    assert.equal(
      screen.getByRole("treeitem").getAttribute("aria-selected"),
      "true",
    );
  });

  test("fits the four real panes inside a 1024px desktop viewport", () => {
    setWidth(1024);
    render(roomView());

    const grid = screen.getByTestId("ops-desktop-grid");
    const minimumWidth = Number(grid.dataset.minimumWidth);
    assert.ok(minimumWidth > 0);
    assert.ok(minimumWidth <= 1024 - 24);
    assert.equal(grid.style.maxWidth, "100%");
    assert.equal(screen.getAllByTestId("ops-main-pane").length, 4);
  });

  test("opens compact context as an accessible drawer and restores trigger focus", () => {
    setWidth(736);
    render(roomView());

    assert.equal(screen.getAllByTestId("ops-main-pane").length, 2);
    const trigger = screen.getByRole("button", { name: "컨텍스트 열기" });
    trigger.focus();
    fireEvent.click(trigger);
    const drawer = screen.getByRole("dialog", { name: "작업 컨텍스트" });
    assert.equal(document.activeElement, drawer);
    fireEvent.keyDown(drawer, { key: "Tab" });
    const close = screen.getByRole("button", { name: "컨텍스트 닫기" });
    assert.equal(document.activeElement, close);
    fireEvent.click(close);
    assert.ok(document.activeElement === trigger);
  });

  test("renders one mobile pane behind four 44px tabs", () => {
    setWidth(390);
    render(roomView());

    assert.equal(screen.getAllByRole("tab").length, 4);
    assert.equal(screen.getAllByTestId("ops-main-pane").length, 1);
    fireEvent.click(screen.getByRole("tab", { name: "컨텍스트" }));
    assert.ok(screen.getByTestId("ops-context"));
  });

  test("keeps every interactive target at a computed minimum of 44x44", () => {
    setWidth(1280);
    render(roomView());

    const targets = Array.from(
      document.querySelectorAll("[data-ops-interactive]"),
    );
    assert.ok(targets.length > 0);
    for (const target of targets) {
      const style = getComputedStyle(target);
      assert.ok(Number.parseFloat(style.minWidth) >= 44);
      assert.ok(Number.parseFloat(style.minHeight) >= 44);
    }
  });

  test("renders honest empty records and distinct connection states", () => {
    const fixture = createOpsRoomFixture();
    fixture.room.channels = [];
    fixture.room.threads = [];
    fixture.room.messages = [];
    fixture.session_tree = [];
    fixture.room.context.sessions = [];
    fixture.room.context.approvals = [];
    fixture.room.context.artifacts = [];
    fixture.checklist = [];
    fixture.decisions = [];
    const projection = projectOpsRoom(fixture);

    const view = render(roomView({ connectionState: "ready", projection }));
    assert.ok(screen.getAllByText("기록 없음").length >= 4);

    view.rerender(roomView({ connectionState: "stale" }));
    assert.ok(screen.getByText(/마지막 동기화 상태/));
    view.rerender(roomView({ connectionState: "disconnected" }));
    assert.ok(screen.getByText("Hub에 연결할 수 없습니다"));
    view.rerender(roomView({ connectionState: "not_configured" }));
    assert.ok(screen.getByText("Local Ops Hub가 설정되지 않았습니다"));
    view.rerender(roomView({ connectionState: "version_mismatch" }));
    assert.ok(screen.getByText("Ops 계약 버전이 맞지 않습니다"));
    assert.match(document.body.textContent, /RAOU.*Hub/);
    assert.equal(document.body.textContent.includes("Buzz"), false);
    view.rerender(roomView({ connectionState: "contract_invalid" }));
    assert.ok(screen.getByText("Ops 데이터 계약을 확인할 수 없습니다"));
  });

  test("shows a bounded verb-object-outcome summary before timeline disclosure", () => {
    setWidth(1280);
    render(roomView());

    const summaries = screen.getAllByTestId("ops-timeline-summary");
    assert.ok(summaries.length > 0);
    assert.match(summaries[0].textContent ?? "", /위임|구현|완료|검토|전달/);
    assert.ok((summaries[0].textContent ?? "").length <= 141);
  });

  test("marks reduced-motion composition without waiting for animation", () => {
    reducedMotion = true;
    setWidth(736);
    render(roomView());

    assert.equal(
      screen.getByTestId("ops-room-view").dataset.reducedMotion,
      "true",
    );
    const trigger = screen.getByRole("button", { name: "컨텍스트 열기" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "컨텍스트 닫기" }));
    assert.equal(document.activeElement, trigger);
  });

  test("keeps room shaping out of React and Tauri out of leaf components", async () => {
    const rootSource = await readFile(
      new URL("./OpsRoomScreen.tsx", import.meta.url),
      "utf8",
    );
    const roomViewSource = await readFile(
      new URL("./OpsRoomView.tsx", import.meta.url),
      "utf8",
    );
    const leafNames = [
      "OpsWorkspaceNav",
      "OpsSessionTree",
      "OpsTimeline",
      "OpsContextPanel",
      "OpsConnectionState",
    ];

    for (const name of leafNames) {
      const source = await readFile(
        new URL(`./${name}.tsx`, import.meta.url),
        "utf8",
      );
      assert.doesNotMatch(source, /@tauri-apps|\binvoke\s*\(/);
    }
    assert.doesNotMatch(
      `${rootSource}\n${roomViewSource}`,
      /snapshot\.room\.[\s\S]*?\.map\s*\(/,
    );
  });
});
