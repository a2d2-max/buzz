import { expect, test, type Page } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

const LOCAL_OPS_STORAGE_KEY = "buzz-local-ops-guest.v1";
const FORBIDDEN_ACTION_NAME =
  /deliver|send|execute|push|merge|deploy|전달|보내기|실행|푸시|병합|배포/i;

const VIEWPORTS = [
  { height: 900, name: "desktop", width: 1280 },
  { height: 900, name: "compact", width: 736 },
  { height: 844, name: "mobile", width: 390 },
] as const;

const OPS_CAPABILITIES_FIXTURE = {
  contract_version: 1,
  reads: ["snapshot", "events", "artifact"],
  drafts: ["message", "internal_task", "provider_action"],
  transitions: ["submit", "approve", "risk_confirm", "deliver", "reject"],
};

const OPS_SNAPSHOT_FIXTURE = {
  contract_version: 1,
  revision: 19,
  event_sequence: "19",
  generated_at: "2026-08-30T00:00:00.000Z",
  health: { hub: "ready", orca: "observed", codex: "ready" },
  room: {
    channels: [
      {
        id: "workspace:configured-redacted",
        project_id: "project:configured-redacted",
        label: "Configured redacted workspace",
        count: 1,
      },
    ],
    selected_channel_id: "workspace:configured-redacted",
    threads: [
      {
        id: "work:configured-redacted",
        type: "work",
        work_item_id: "work:configured-redacted",
        session_id: null,
        project_id: "project:configured-redacted",
        title: "Configured native Ops parity",
        status: "in_progress",
        provider: "codex",
        updated_at: "2026-08-30T00:00:00.000Z",
        session_count: 2,
        approval_count: 1,
        artifact_count: 0,
      },
    ],
    selected_thread_id: "work:configured-redacted",
    messages: [
      {
        id: "event:configured-completion-redacted",
        kind: "completion",
        timestamp: "2026-08-30T00:01:00.000Z",
        role: "agent",
        author: "Codex sub",
        body: "Configured deterministic parity verification completed.",
        details: { source: "codex_sub", outcome: "완료", tests: 3 },
      },
    ],
    context: {
      work_item: {
        id: "work:configured-redacted",
        project_id: "project:configured-redacted",
        title: "Configured native Ops parity",
        status: "in_progress",
        progress: 0.75,
        last_activity_at: "2026-08-30T00:01:00.000Z",
        execution_provider: "codex",
        provider_model: "configured-mock-model",
        provider_effort: "high",
        revision: 19,
        updated_at: "2026-08-30T00:01:00.000Z",
      },
      provider_run: null,
      sessions: [],
      approvals: [
        {
          id: "approval:configured-redacted",
          work_item_id: "work:configured-redacted",
          target_session_id: "session:configured-codex-direct-redacted",
          draft_text: "[configured redacted external draft]",
          action_kind: "deliver",
          status: "held",
          hold_reason: "external_action_disabled",
          risk_class: ["external"],
          risk_targets: ["configured-redacted-target"],
          approved_at: null,
          revision: 19,
          updated_at: "2026-08-30T00:01:00.000Z",
        },
      ],
      artifacts: [],
    },
    diagnostics: { fixture: "configured-deterministic-redacted" },
  },
  session_tree: [
    {
      id: "session:configured-codex-direct-redacted",
      source: "codex_direct",
      parent_session_id: null,
      work_item_id: "work:configured-redacted",
      title: "Codex direct",
      activity: "coordinating",
      health: "active",
      last_activity_at: "2026-08-30T00:01:00.000Z",
      child_ids: ["session:configured-codex-sub-redacted"],
    },
    {
      id: "session:configured-codex-sub-redacted",
      source: "codex_sub",
      parent_session_id: "session:configured-codex-direct-redacted",
      work_item_id: "work:configured-redacted",
      title: "Codex sub",
      activity: "complete",
      health: "ready",
      last_activity_at: "2026-08-30T00:01:00.000Z",
      child_ids: [],
    },
  ],
  checklist: [],
  decisions: [],
};

async function openLocalOpsRoom(page: Page, probeWatchStart: boolean) {
  if (!probeWatchStart) {
    await page.addInitScript((storageKey) => {
      window.localStorage.setItem(storageKey, "true");
    }, LOCAL_OPS_STORAGE_KEY);
  }
  const mockConfig = {
    identityLost: true,
    opsCapabilities: OPS_CAPABILITIES_FIXTURE,
    opsSnapshot: OPS_SNAPSHOT_FIXTURE,
  };
  await installMockBridge(page, mockConfig, {
    seedPreviewFeatures: false,
    skipOnboardingSeed: true,
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  if (probeWatchStart) {
    await page.goto("/");
    const entry = page.getByRole("button", {
      name: "Continue in local Ops mode",
    });
    await expect(entry).toBeVisible();
    const watchResults = await page.evaluate(async () => {
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      if (!invoke) throw new Error("Tauri E2E invoke bridge unavailable");
      return Promise.all([
        invoke("ops_bridge_start_watch", null),
        invoke("ops_bridge_start_watch", null),
      ]);
    });
    expect(watchResults).toEqual([
      {
        started: true,
        connection_generation: 1,
        sync_required: true,
        anchor_sequence: null,
      },
      {
        started: false,
        connection_generation: 1,
        sync_required: true,
        anchor_sequence: null,
      },
    ]);
    await entry.click();
  } else {
    await page.goto("/#/ops?view=room");
  }

  await expect(page).toHaveURL(/\/#\/ops\?view=room$/);
  await expect(page.getByText("Local Ops mode", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: FORBIDDEN_ACTION_NAME }),
  ).toHaveCount(0);
  await expect(page.getByTestId("ops-room-view")).toHaveAttribute(
    "data-reduced-motion",
    "true",
  );
}

async function expectSessionContent(page: Page) {
  const sessionTree = page.getByTestId("ops-session-tree");
  await expect(sessionTree).toBeVisible();
  const codexSub = sessionTree
    .getByRole("treeitem")
    .filter({ hasText: "Codex sub" });
  await expect(codexSub).toHaveCount(1);
  await expect(codexSub).toBeVisible();
}

async function expectTimelineContent(page: Page) {
  const timeline = page.getByTestId("ops-timeline");
  await expect(timeline).toBeVisible();
  const completion = timeline.locator("article").filter({ hasText: "완료" });
  await expect(completion).toHaveCount(1);
  await expect(completion).toBeVisible();
}

async function expectContextContent(page: Page) {
  const context = page.getByTestId("ops-context");
  await expect(context).toBeVisible();
  await expect(context.getByText("승인 필요", { exact: true })).toBeVisible();
}

async function expectWorkspaceFixture(page: Page) {
  const workspace = page.getByTestId("ops-workspace-nav");
  await expect(workspace).toBeVisible();
  await expect(
    workspace.getByText("Configured redacted workspace", { exact: true }),
  ).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.documentElement;
        const room = document.querySelector<HTMLElement>(
          '[data-testid="ops-room-view"]',
        );
        return {
          document: root.scrollWidth - root.clientWidth,
          room: room ? room.scrollWidth - room.clientWidth : 1,
        };
      }),
    )
    .toEqual({ document: 0, room: 0 });
}

async function expectAccessibleTargets(page: Page) {
  const targets = page.locator(
    [
      "button:visible",
      "a[href]:visible",
      "input:not([type=hidden]):visible",
      "select:visible",
      "textarea:visible",
      "summary:visible",
      '[role="button"]:visible',
      '[role="tab"]:visible',
      '[role="treeitem"]:visible',
      "[data-ops-interactive]:visible",
    ].join(", "),
  );
  expect(await targets.count()).toBeGreaterThan(0);
  const undersized = await targets.evaluateAll((elements) =>
    elements.flatMap((element) => {
      const box = element.getBoundingClientRect();
      return box.width >= 44 && box.height >= 44
        ? []
        : [
            {
              height: box.height,
              label:
                element.getAttribute("aria-label") ??
                element.textContent?.trim() ??
                element.tagName,
              width: box.width,
            },
          ];
    }),
  );
  expect(undersized).toEqual([]);
}

async function expectReducedMotionComputed(page: Page) {
  const targets = page.locator("[data-ops-interactive]:visible");
  expect(await targets.count()).toBeGreaterThan(0);
  const activeMotion = await targets.evaluateAll((elements) => {
    const hasDuration = (value: string) =>
      value.split(",").some((part) => Number.parseFloat(part) > 0);
    return elements.flatMap((element) => {
      const style = getComputedStyle(element);
      const hasTransition =
        style.transitionProperty !== "none" &&
        hasDuration(style.transitionDuration);
      const hasAnimation =
        style.animationName !== "none" && hasDuration(style.animationDuration);
      return hasTransition || hasAnimation
        ? [
            {
              animationDuration: style.animationDuration,
              animationName: style.animationName,
              label:
                element.getAttribute("aria-label") ??
                element.textContent?.trim() ??
                element.tagName,
              transitionDuration: style.transitionDuration,
              transitionProperty: style.transitionProperty,
            },
          ]
        : [];
    });
  });
  expect(activeMotion).toEqual([]);
}

async function expectNativeOpsArgumentsAndNoMutations(page: Page) {
  const synchronizedWatch = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!invoke) throw new Error("Tauri E2E invoke bridge unavailable");
    return invoke("ops_bridge_start_watch", null);
  });
  expect(synchronizedWatch).toEqual({
    started: false,
    connection_generation: 1,
    sync_required: false,
    anchor_sequence: null,
  });
  const calls = await page.evaluate(
    () => window.__BUZZ_E2E_COMMAND_PAYLOADS__ ?? [],
  );
  const capabilities = calls.filter(
    ({ command }) => command === "ops_bridge_capabilities",
  );
  const snapshots = calls.filter(
    ({ command }) => command === "ops_bridge_snapshot",
  );
  const starts = calls.filter(
    ({ command }) => command === "ops_bridge_start_watch",
  );
  const acknowledgements = calls.filter(
    ({ command }) => command === "ops_bridge_ack_sync",
  );
  expect(capabilities.length).toBeGreaterThan(0);
  expect(snapshots.length).toBeGreaterThan(0);
  expect(starts.length).toBeGreaterThan(0);
  expect(acknowledgements.length).toBeGreaterThan(0);
  for (const call of capabilities) expect(call.payload).toBeNull();
  for (const call of snapshots) {
    expect(call.payload).toEqual({
      selection: { channel: null, limit: 100, thread: null },
    });
  }
  for (const call of starts) expect(call.payload).toBeNull();
  for (const call of acknowledgements) {
    expect(call.payload).toEqual({
      request: { generation: 1, applied_sequence: "19" },
    });
  }

  const mutations = calls.filter(({ command }) =>
    [
      "ops_bridge_create_draft",
      "ops_bridge_transition",
      "ops_bridge_deliver",
      "ops_bridge_delivery",
    ].includes(command),
  );
  expect(mutations).toEqual([]);
}

test("the strict Ops page mock stays configurable while UI consumption is disabled", async ({
  page,
}) => {
  await page.addInitScript((storageKey) => {
    window.localStorage.setItem(storageKey, "true");
  }, LOCAL_OPS_STORAGE_KEY);
  const timelinePage = {
    contract_version: 1 as const,
    revision: 31,
    generated_at: "2026-08-30T00:03:00.000Z",
    items: [
      {
        id: "event:paged-redacted",
        timestamp: "2026-08-30T00:03:00.000Z",
        kind: "status",
        author: "Codex",
        body: "Deterministic redacted page fixture",
      },
    ],
    next_cursor: "opaque-redacted-next",
  };
  await installMockBridge(
    page,
    {
      identityLost: true,
      opsCapabilities: OPS_CAPABILITIES_FIXTURE,
      opsSnapshot: OPS_SNAPSHOT_FIXTURE,
      opsPages: { timeline: timelinePage },
    },
    { seedPreviewFeatures: false, skipOnboardingSeed: true },
  );
  await page.goto("/#/ops?view=room");

  expect(
    await page.evaluate(
      () =>
        (window.__BUZZ_E2E_COMMANDS__ ?? []).filter(
          (command) => command === "ops_bridge_page",
        ).length,
    ),
  ).toBe(0);

  const request = {
    module: "timeline",
    scope: {
      channel: null,
      thread: null,
      sort: "occurred_at_desc",
    },
    page_size: 100,
    cursor: null,
  };
  const result = await page.evaluate(async (pageRequest) => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!invoke) throw new Error("Tauri E2E invoke bridge unavailable");
    return invoke("ops_bridge_page", { request: pageRequest });
  }, request);
  expect(result).toEqual(timelinePage);

  const invalid = await page.evaluate(async (pageRequest) => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!invoke) throw new Error("Tauri E2E invoke bridge unavailable");
    try {
      await invoke("ops_bridge_page", {
        request: {
          ...pageRequest,
          scope: { ...pageRequest.scope, sort: "created_at_desc" },
        },
      });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, request);
  expect(invalid).toBe("ops_bridge_invalid_request");

  const typedCursorError = await page.evaluate(async (pageRequest) => {
    const config = window.__BUZZ_E2E__;
    if (!config?.mock) throw new Error("Ops E2E config unavailable");
    config.mock.opsPageErrors = { timeline: "stale_cursor" };
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!invoke) throw new Error("Tauri E2E invoke bridge unavailable");
    try {
      await invoke("ops_bridge_page", { request: pageRequest });
      return null;
    } catch (error) {
      return error;
    }
  }, request);
  expect(typedCursorError).toEqual({ error: "stale_cursor" });

  const calls = await page.evaluate(
    () => window.__BUZZ_E2E_COMMAND_PAYLOADS__ ?? [],
  );
  expect(
    calls.filter(({ command }) => command === "ops_bridge_page")[0]?.payload,
  ).toEqual({ request });
});

test("an older snapshot remains visible with live watch compatibility disabled", async ({
  page,
}) => {
  await page.addInitScript((storageKey) => {
    window.localStorage.setItem(storageKey, "true");
  }, LOCAL_OPS_STORAGE_KEY);
  const legacySnapshot: Record<string, unknown> = {
    ...OPS_SNAPSHOT_FIXTURE,
  };
  delete legacySnapshot.event_sequence;
  await installMockBridge(
    page,
    {
      identityLost: true,
      opsCapabilities: OPS_CAPABILITIES_FIXTURE,
      opsSnapshot: legacySnapshot,
    },
    { seedPreviewFeatures: false, skipOnboardingSeed: true },
  );

  await page.goto("/#/ops?view=room");
  await expect(page.getByTestId("ops-watch-compatibility")).toBeVisible();
  await expect(
    page
      .getByTestId("ops-workspace-nav")
      .getByText("Configured native Ops parity", { exact: true }),
  ).toBeVisible();
  const commands = await page.evaluate(
    () => window.__BUZZ_E2E_COMMANDS__ ?? [],
  );
  expect(
    commands.filter((command) => command === "ops_bridge_start_watch"),
  ).toEqual([]);
  expect(
    commands.filter((command) => command === "ops_bridge_ack_sync"),
  ).toEqual([]);
});

for (const viewport of VIEWPORTS) {
  test(`Local Ops Room matches native safety and responsive parity at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.setViewportSize(viewport);
    await openLocalOpsRoom(page, viewport.name === "desktop");
    await expectNoHorizontalOverflow(page);

    const panes = page.locator('[data-testid="ops-main-pane"]:visible');
    if (viewport.name === "desktop") {
      await expect(panes).toHaveCount(4);
      await expectWorkspaceFixture(page);
      await expectSessionContent(page);
      await expectTimelineContent(page);
      await expectContextContent(page);
    } else if (viewport.name === "compact") {
      await expect(panes).toHaveCount(2);
      await expect(
        page.getByRole("dialog", { name: "작업 컨텍스트" }),
      ).toHaveCount(0);

      const treeItems = page
        .getByTestId("ops-session-tree")
        .getByRole("treeitem");
      expect(await treeItems.count()).toBeGreaterThan(1);
      const oldTreeItem = treeItems.nth(0);
      const newTreeItem = treeItems.nth(1);
      await oldTreeItem.focus();
      await oldTreeItem.press("ArrowDown");
      await expect(oldTreeItem).toHaveAttribute("tabindex", "-1");
      await expect(newTreeItem).toHaveAttribute("tabindex", "0");
      await expect(newTreeItem).toBeFocused();

      await expectWorkspaceFixture(page);
      await expectSessionContent(page);
      await expectTimelineContent(page);

      const trigger = page.getByRole("button", { name: "컨텍스트 열기" });
      await trigger.focus();
      await trigger.click();
      const drawer = page.getByRole("dialog", { name: "작업 컨텍스트" });
      await expect(drawer).toBeFocused();
      await expectContextContent(page);
      await expectAccessibleTargets(page);
      await expectReducedMotionComputed(page);
      await drawer.press("Escape");
      await expect(drawer).toHaveCount(0);
      await expect(trigger).toBeFocused();
    } else {
      await expect(panes).toHaveCount(1);
      await expect(page.getByRole("tab")).toHaveCount(4);
      await expectTimelineContent(page);
      await expectAccessibleTargets(page);
      await expectReducedMotionComputed(page);

      await page.getByRole("tab", { name: "세션" }).click();
      await expectSessionContent(page);
      await expectAccessibleTargets(page);

      await page.getByRole("tab", { name: "컨텍스트" }).click();
      await expectContextContent(page);
      await expectAccessibleTargets(page);

      await page.getByRole("tab", { name: "작업" }).click();
      await expectWorkspaceFixture(page);
    }

    await expectAccessibleTargets(page);
    await expectReducedMotionComputed(page);
    await expectNativeOpsArgumentsAndNoMutations(page);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}
