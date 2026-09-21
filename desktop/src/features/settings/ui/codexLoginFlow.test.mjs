import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptCodexLoginPoll,
  codexLoginPollInterval,
  describeCodexLogin,
  LOGIN_COMMAND_GUIDANCE,
} from "./codexLoginFlow.ts";

function session(overrides) {
  return {
    generation: "generation-1",
    state: "running",
    message: null,
    authUrl: null,
    startedAt: "2026-09-09T05:00:00Z",
    finishedAt: null,
    ...overrides,
  };
}

test("no session → nothing to show", () => {
  assert.equal(describeCodexLogin(null), null);
});

test("running: waits on the browser, offers Cancel, and the sign-in link only once the CLI printed one", () => {
  const plain = describeCodexLogin(session({}));
  assert.equal(plain.running, true);
  assert.equal(plain.tone, "neutral");
  assert.match(plain.headline, /browser/i);
  assert.equal(plain.offerSignInLink, false);
  assert.equal(plain.justFinishedOk, false);

  const withLink = describeCodexLogin(
    session({ authUrl: "https://auth.example/authorize?x=1" }),
  );
  assert.equal(withLink.offerSignInLink, true);
});

test("succeeded: success tone and a refresh trigger", () => {
  const view = describeCodexLogin(
    session({ state: "succeeded", finishedAt: "2026-09-09T05:01:00Z" }),
  );
  assert.equal(view.tone, "success");
  assert.equal(view.running, false);
  assert.equal(view.justFinishedOk, true);
  assert.match(view.headline, /signed in/i);
});

test("failed: error tone with the CLI's (scrubbed) line as detail", () => {
  const view = describeCodexLogin(
    session({
      state: "failed",
      message: "Error: refused key=…",
      finishedAt: "2026-09-09T05:01:00Z",
    }),
  );
  assert.equal(view.tone, "error");
  assert.equal(view.detail, "Error: refused key=…");
  assert.equal(view.justFinishedOk, false);
  assert.equal(view.retryStopping, false);
});

test("failed without finishedAt remains a finite explicit stop retry", () => {
  const pending = session({
    state: "failed",
    message: "Couldn't fully stop the sign-in process.",
    finishedAt: null,
  });
  const view = describeCodexLogin(pending);
  assert.equal(view.running, false);
  assert.equal(view.retryStopping, true);
  assert.match(view.headline, /could not be fully stopped/i);
  assert.equal(
    codexLoginPollInterval(pending),
    false,
    "persistent containment failure must not create an unbounded poll loop",
  );

  for (const state of ["succeeded", "cancelled", "timed_out"]) {
    const terminal = describeCodexLogin(
      session({
        state,
        finishedAt: "2026-09-09T05:02:00Z",
      }),
    );
    assert.equal(terminal.retryStopping, false, state);
    assert.equal(terminal.justFinishedOk, state === "succeeded", state);
  }
});

test("cancelled and timed out are terminal, not successes", () => {
  const cancelled = describeCodexLogin(session({ state: "cancelled" }));
  assert.equal(cancelled.running, false);
  assert.equal(cancelled.tone, "neutral");
  assert.match(cancelled.headline, /cancel/i);

  const timedOut = describeCodexLogin(
    session({ state: "timed_out", message: "no sign-in within 600s" }),
  );
  assert.equal(timedOut.tone, "error");
  assert.equal(timedOut.justFinishedOk, false);
  assert.match(timedOut.headline, /timed out/i);
});

test("polling runs only while the login is running", () => {
  assert.equal(codexLoginPollInterval(null), false);
  assert.equal(codexLoginPollInterval(session({})), 1000);
  assert.equal(codexLoginPollInterval(session({ state: "succeeded" })), false);
  assert.equal(codexLoginPollInterval(session({ state: "failed" })), false);
});

test("the copy-command guidance names straight quotes and the full path", () => {
  assert.match(LOGIN_COMMAND_GUIDANCE, /full path/i);
  assert.match(LOGIN_COMMAND_GUIDANCE, /straight quotes/i);
  assert.ok(
    !/[“”‘’]/.test(LOGIN_COMMAND_GUIDANCE),
    "guidance itself must not carry typographic quotes",
  );
});

test("a late poll from the cancelled generation cannot overwrite a restarted login", () => {
  const current = session({
    generation: "generation-2",
    startedAt: "2026-09-21T07:00:02Z",
  });
  const stale = session({
    generation: "generation-1",
    state: "cancelled",
    startedAt: "2026-09-21T07:00:01Z",
  });
  assert.equal(
    acceptCodexLoginPoll(current.generation, current, stale),
    current,
  );
});

test("a poll from the active generation is accepted", () => {
  const current = session({
    generation: "generation-2",
    startedAt: "2026-09-21T07:00:02Z",
  });
  const finished = session({
    generation: current.generation,
    state: "succeeded",
    startedAt: current.startedAt,
  });
  assert.equal(
    acceptCodexLoginPoll(current.generation, current, finished),
    finished,
  );
});
