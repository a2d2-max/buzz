import assert from "node:assert/strict";
import test from "node:test";

import {
  CRITICAL_PERCENT,
  quotaPresentation,
  quotaTone,
  WARN_PERCENT,
  windowSentence,
} from "./accountQuotaPresentation.ts";

function quota(overrides) {
  return {
    state: "ok",
    plan: null,
    windows: [],
    message: null,
    ...overrides,
  };
}

function window(overrides) {
  return {
    label: "Current week (all models)",
    usedPercent: 24,
    resetsAt: "Sep 13 at 10:59pm (Asia/Seoul)",
    ...overrides,
  };
}

test("still reading: says so instead of showing an empty meter", () => {
  const shown = quotaPresentation({
    label: "max",
    pending: true,
    quota: undefined,
  });
  assert.equal(shown.kind, "pending");
});

test("a measured window renders its percent, its reset text, and a bar", () => {
  const shown = quotaPresentation({
    label: "max",
    pending: false,
    quota: quota({ plan: "pro", windows: [window()] }),
  });
  assert.equal(shown.kind, "windows");
  assert.equal(shown.plan, "pro");
  assert.equal(shown.limitReached, false);
  assert.deepEqual(shown.rows, [
    {
      key: "Current week (all models)",
      sentence:
        "Current week (all models): 24% used, resets Sep 13 at 10:59pm (Asia/Seoul)",
      percent: 24,
      tone: "normal",
    },
  ]);
});

test("an unknown percent stays unknown — it never becomes a 0% bar", () => {
  const shown = quotaPresentation({
    label: "max",
    pending: false,
    quota: quota({ windows: [window({ usedPercent: null })] }),
  });
  assert.equal(shown.kind, "windows");
  assert.equal(shown.rows[0].percent, null);
  assert.match(shown.rows[0].sentence, /usage unknown/);
  // The distinction the whole component exists to preserve.
  assert.notEqual(shown.rows[0].percent, 0);
});

test("a genuinely untouched window still reads as measured 0%", () => {
  const shown = quotaPresentation({
    label: "max",
    pending: false,
    quota: quota({ windows: [window({ usedPercent: 0 })] }),
  });
  assert.equal(shown.rows[0].percent, 0);
  assert.match(shown.rows[0].sentence, /0% used/);
});

test("out of quota is called out and every bar turns critical", () => {
  const shown = quotaPresentation({
    label: "ax",
    pending: false,
    quota: quota({
      state: "limit_reached",
      plan: "pro",
      windows: [
        window({ usedPercent: 100 }),
        window({ label: "Spark", usedPercent: 0 }),
      ],
    }),
  });
  assert.equal(shown.kind, "windows");
  assert.equal(shown.limitReached, true);
  assert.deepEqual(
    shown.rows.map((row) => row.tone),
    ["critical", "critical"],
  );
});

test("an expired login asks for a sign-in and keeps the provider's reason", () => {
  const shown = quotaPresentation({
    label: "ax",
    pending: false,
    quota: quota({
      state: "needs_login",
      message: "ChatGPT rejected this login",
    }),
  });
  assert.equal(shown.kind, "note");
  assert.equal(shown.tone, "warning");
  assert.match(shown.text, /Sign in again/);
  assert.match(shown.text, /ChatGPT rejected this login/);
});

test("a failed reading shows why, never zeros", () => {
  const shown = quotaPresentation({
    label: "max",
    pending: false,
    quota: quota({ state: "unavailable", message: "could not reach ChatGPT" }),
  });
  assert.equal(shown.kind, "note");
  assert.equal(shown.tone, "muted");
  assert.equal(shown.text, "could not reach ChatGPT");
});

test("an api-key account says quota does not apply to it", () => {
  const shown = quotaPresentation({
    label: "key",
    pending: false,
    quota: quota({
      state: "not_applicable",
      message: "API-key accounts bill per request — no plan quota",
    }),
  });
  assert.equal(shown.kind, "note");
  assert.match(shown.text, /bill per request/);
});

test("ok with no windows is a contract change, not an idle account", () => {
  const shown = quotaPresentation({
    label: "max",
    pending: false,
    quota: quota({ windows: [] }),
  });
  assert.equal(shown.kind, "note");
  assert.match(shown.text, /unavailable/);
});

test("a rejected query leaves no meter behind", () => {
  const shown = quotaPresentation({
    label: "gone",
    pending: false,
    quota: undefined,
  });
  assert.equal(shown.kind, "note");
  assert.match(shown.text, /unavailable for gone/);
});

test("tone changes exactly at each threshold", () => {
  assert.equal(quotaTone(WARN_PERCENT - 1, false), "normal");
  assert.equal(quotaTone(WARN_PERCENT, false), "warning");
  assert.equal(quotaTone(CRITICAL_PERCENT - 1, false), "warning");
  assert.equal(quotaTone(CRITICAL_PERCENT, false), "critical");
  assert.equal(quotaTone(null, false), "normal");
  // Being out of quota outranks any percentage, including an unknown one.
  assert.equal(quotaTone(null, true), "critical");
});

test("a percent outside 0–100 is clamped for the bar but kept in the words", () => {
  const shown = quotaPresentation({
    label: "max",
    pending: false,
    quota: quota({ windows: [window({ usedPercent: 140 })] }),
  });
  assert.equal(shown.rows[0].percent, 100);
  assert.match(shown.rows[0].sentence, /140% used/);
});

test("a window without reset text drops the phrase rather than inventing one", () => {
  assert.equal(
    windowSentence({
      label: "Current session",
      usedPercent: 2,
      resetsAt: null,
    }),
    "Current session: 2% used",
  );
});
