import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createHashOpsNavigationPort,
  createRouterOpsNavigationPort,
  normalizeHashOpsNavigation,
  normalizeOpsNavigation,
  parseOpsRouteState,
  opsRouteNeedsNormalization,
  serializeOpsRouteState,
} from "./opsRouteState.ts";

test("normalizes an unknown Ops view to room while preserving the room selection", () => {
  const parsed = parseOpsRouteState(
    "#/ops?view=unknown&channel=all&thread=work-1",
  );

  assert.deepEqual(parsed, {
    channel: "all",
    thread: "work-1",
    view: "room",
  });
  assert.equal(
    serializeOpsRouteState(parsed),
    "#/ops?view=room&channel=all&thread=work-1",
  );
});

test("marks unknown view hashes for replace normalization", () => {
  assert.equal(
    opsRouteNeedsNormalization("#/ops?view=unknown&channel=all"),
    true,
  );
  assert.equal(
    opsRouteNeedsNormalization("#/ops?view=room&channel=all"),
    false,
  );
});

test("authenticated Router replaces an unknown view and pushes user selections", () => {
  const search = { channel: "all", thread: "work-1", view: "unknown" };
  const writes = [];
  const navigation = createRouterOpsNavigationPort({
    navigate: (options) => writes.push(options),
    readSearch: () => search,
  });

  assert.deepEqual(navigation.readOpsState(), {
    channel: "all",
    thread: "work-1",
    view: "room",
  });
  normalizeOpsNavigation(navigation, search.view);
  navigation.pushOpsState({
    channel: "all",
    thread: "work-1",
    view: "artifacts",
  });

  assert.deepEqual(writes, [
    {
      replace: true,
      resetScroll: false,
      search: { channel: "all", thread: "work-1", view: "room" },
    },
    {
      replace: false,
      resetScroll: false,
      search: { channel: "all", thread: "work-1", view: "artifacts" },
    },
  ]);
});

test("authenticated Router replaces a missing view with canonical room state", () => {
  const writes = [];
  const navigation = createRouterOpsNavigationPort({
    navigate: (options) => writes.push(options),
    readSearch: () => ({ channel: "all" }),
  });

  normalizeOpsNavigation(navigation, undefined);

  assert.deepEqual(writes, [
    {
      replace: true,
      resetScroll: false,
      search: { channel: "all", thread: undefined, view: "room" },
    },
  ]);
});

test("Router navigation adapter preserves optional native-screen callbacks", () => {
  const opened = [];
  const navigation = createRouterOpsNavigationPort({
    navigate() {},
    openAgents: () => opened.push("agents"),
    openProjects: () => opened.push("projects"),
    openSettings: () => opened.push("settings"),
    openWorkflows: () => opened.push("workflows"),
    readSearch: () => ({ view: "room" }),
  });

  navigation.openAgents();
  navigation.openProjects();
  navigation.openWorkflows();
  navigation.openSettings();

  assert.deepEqual(opened, ["agents", "projects", "workflows", "settings"]);
});

test("guest normalization replaces missing and unknown views without adding Back history", () => {
  for (const hash of ["#/ops", "#/ops?view=unknown&channel=all"]) {
    const writes = [];
    const target = {
      addEventListener() {},
      history: {
        pushState(_state, _title, url) {
          writes.push(["push", url]);
        },
        replaceState(_state, _title, url) {
          writes.push(["replace", url]);
          target.location.hash = url;
        },
      },
      location: { hash },
      removeEventListener() {},
    };
    const navigation = createHashOpsNavigationPort(target);

    normalizeHashOpsNavigation(navigation, hash);

    assert.deepEqual(writes, [
      [
        "replace",
        hash.includes("channel=all")
          ? "#/ops?view=room&channel=all"
          : "#/ops?view=room",
      ],
    ]);
  }
});

test("guest hash adapter publishes mounted-view updates for hash and history navigation", () => {
  const listeners = new Map();
  const historyWrites = [];
  const location = { hash: "#/ops?view=room" };
  const target = {
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    history: {
      pushState(_state, _title, url) {
        historyWrites.push(["push", url]);
        location.hash = url;
      },
      replaceState(_state, _title, url) {
        historyWrites.push(["replace", url]);
        location.hash = url;
      },
    },
    location,
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== listener),
      );
    },
  };
  const navigation = createHashOpsNavigationPort(target);
  const states = [];
  const unsubscribe = navigation.subscribe(() =>
    states.push(navigation.readOpsState()),
  );

  navigation.pushOpsState({ channel: null, thread: null, view: "artifacts" });
  location.hash = "#/ops?view=knowledge";
  for (const listener of listeners.get("popstate") ?? []) listener();
  unsubscribe();

  assert.deepEqual(historyWrites, [["push", "#/ops?view=artifacts"]]);
  assert.deepEqual(states, [
    { channel: null, thread: null, view: "artifacts" },
    { channel: null, thread: null, view: "knowledge" },
  ]);
  assert.equal((listeners.get("hashchange") ?? []).length, 0);
  assert.equal((listeners.get("popstate") ?? []).length, 0);
});
