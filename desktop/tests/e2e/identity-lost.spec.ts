import { hexToBytes } from "@noble/hashes/utils.js";
import { expect, test } from "@playwright/test";
import { nsecEncode } from "nostr-tools/nip19";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const GUEST_FORBIDDEN_COMMANDS = [
  "sign_event",
  "sign_nostr_identity_binding",
  "grant_approval",
  "deny_approval",
  "ops_bridge_create_draft",
  "ops_bridge_transition",
  "start_huddle",
  "join_huddle",
  "reconnect_huddle_audio",
  "start_stt_pipeline",
  "push_audio_pcm",
  "speak_agent_message",
  "preview_pocket_voice",
  "create_managed_agent",
  "start_managed_agent",
  "start_managed_agent_runtime",
  "restart_managed_agent_runtime",
  "mesh_start_node",
] as const;

async function enterLocalOpsGuestMode(page: import("@playwright/test").Page) {
  await page
    .getByRole("button", { name: "Continue in local Ops mode" })
    .click();
  await expect(page).toHaveURL(/#\/ops$/);
}

async function guestCommandLog(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    (window.__BUZZ_E2E_COMMAND_LOG__ ?? []).map(({ command }) => command),
  );
}

async function emitNostrBind(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    await window.__TAURI_INTERNALS__?.invoke?.("plugin:event|emit", {
      event: "deep-link-nostr-bind",
      payload: {
        action: "bind_nostr_identity",
        audience: "buzz:nostr-identity",
        challengeId: "550e8400-e29b-41d4-a716-446655440000",
        expiresAt: "2099-01-01T00:00:00Z",
        nonce: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi01234567",
        origin: "https://admin.example.com",
        protocol: "buzz-nostr-identity",
        returnMode: "clipboard",
        verificationCode: "123456",
        version: "1",
      },
    });
  });
}

test("normal first launch uses the already-persisted identity", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await installMockBridge(page, undefined, {
    skipCommunitySeed: true,
    skipOnboardingSeed: true,
  });
  await page.goto("/");

  const gate = page.getByTestId("machine-onboarding-gate");
  await expect(gate).toBeVisible();
  await expect(gate).toHaveCSS("background-color", "rgb(215, 215, 46)");
  // Landing carries a subtle dot-grid pattern over the chartreuse fill.
  await expect(gate).toHaveCSS("background-image", /radial-gradient/);
  await expect(gate).toHaveCSS("color", "rgb(23, 23, 23)");
  await expect(
    page.getByRole("button", { name: "Create a new identity key" }),
  ).toHaveCSS("background-color", "rgb(23, 23, 23)");
  await page.getByRole("button", { name: "Create a new identity key" }).click();

  await expect(
    page.getByRole("heading", {
      name: "Your unique identity key has been created",
    }),
  ).toBeVisible();
  // Non-landing pages layer the dot grid over the chartreuse→light-blue gradient.
  await expect(gate).toHaveCSS(
    "background-image",
    /radial-gradient\(.*\), linear-gradient\(.*rgb\(215, 215, 46\).*rgb\(215, 231, 246\)\)/s,
  );
  await expect(gate).toHaveCSS("color", "rgb(23, 23, 23)");
  const commands = await page.evaluate(
    () =>
      (
        window as Window & {
          __BUZZ_E2E_COMMAND_PAYLOADS__?: Array<{ command: string }>;
        }
      ).__BUZZ_E2E_COMMAND_PAYLOADS__ ?? [],
  );
  expect(commands.some((entry) => entry.command === "get_identity")).toBe(true);
  expect(
    commands.some((entry) => entry.command === "persist_current_identity"),
  ).toBe(false);
});

test("lost boot opens onboarding gate directly on the key-import page", async ({
  page,
}, testInfo) => {
  await installMockBridge(
    page,
    { identityLost: true },
    { seedPreviewFeatures: false, skipOnboardingSeed: true },
  );
  await page.goto("/");

  await expect(page.getByTestId("machine-onboarding-gate")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();
  await page.waitForTimeout(1_000);
  await page.screenshot({
    path: testInfo.outputPath("desktop-private-key-recovery.png"),
  });
});

test("local Ops guest entry is offered only for a lost identity", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLost: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  const localOpsButton = page.getByRole("button", {
    name: "Continue in local Ops mode",
  });
  await expect(localOpsButton).toBeVisible();
  await localOpsButton.focus();
  await expect(localOpsButton).toBeFocused();
});

test("normal key-import page never offers local Ops guest entry", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLost: false },
    { skipCommunitySeed: true, skipOnboardingSeed: true },
  );
  await page.goto("/?machineOnboarding=1");

  await page.getByRole("button", { name: "Use an existing key" }).click();
  await expect(
    page.getByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();

  await expect(
    page.getByRole("button", { name: "Continue in local Ops mode" }),
  ).toHaveCount(0);
});

test("local Ops guest boundary ignores global Nostr binding requests", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLost: true },
    { seedPreviewFeatures: false, skipOnboardingSeed: true },
  );
  await page.goto("/");
  await enterLocalOpsGuestMode(page);

  await emitNostrBind(page);

  await expect(page.getByTestId("nostr-bind-page")).toHaveCount(0);
  expect(await guestCommandLog(page)).not.toContain(
    "sign_nostr_identity_binding",
  );
});

test("local Ops banner clears macOS traffic lights at the minimum window width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 500 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
  });
  await installMockBridge(
    page,
    { identityLost: true },
    { seedPreviewFeatures: false, skipOnboardingSeed: true },
  );
  await page.goto("/");
  await enterLocalOpsGuestMode(page);

  const label = page.getByText("Local Ops mode", { exact: true });
  const restore = page.getByRole("button", { name: "Restore identity" });
  await expect(label).toBeVisible();
  await expect(restore).toBeVisible();
  const labelBox = await label.boundingBox();
  const restoreBox = await restore.boundingBox();
  expect(labelBox).not.toBeNull();
  expect(restoreBox).not.toBeNull();

  // With native controls positioned at x:16, their visible right edge is
  // approximately 72px. Both label text and the restore control must remain
  // readable inside the minimum supported 800px-wide window.
  expect(labelBox?.x ?? 0).toBeGreaterThanOrEqual(72);
  expect((restoreBox?.x ?? 0) + (restoreBox?.width ?? 0)).toBeLessThanOrEqual(
    800,
  );
});

test("local Ops guest bridge rejects every signed external provider and audio command family", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLost: true },
    { seedPreviewFeatures: false, skipOnboardingSeed: true },
  );
  await page.goto("/");
  await enterLocalOpsGuestMode(page);

  const results = await page.evaluate(async (commands) => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (!invoke) throw new Error("Tauri E2E invoke bridge unavailable");
    return Promise.all(
      commands.map(async (command) => {
        try {
          await invoke(command, {});
          return { command, error: null };
        } catch (error) {
          return { command, error: String(error) };
        }
      }),
    );
  }, GUEST_FORBIDDEN_COMMANDS);

  expect(results).toHaveLength(GUEST_FORBIDDEN_COMMANDS.length);
  for (const result of results) {
    expect(result.error, `${result.command} must reject`).toContain(
      "identity is in recovery mode",
    );
  }
});

test("a restored durable identity clears a persisted local Ops guest preference", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLost: true },
    { seedPreviewFeatures: false, skipOnboardingSeed: true },
  );
  await page.goto("/");
  await enterLocalOpsGuestMode(page);

  await page.evaluate(
    async (nsec) => {
      await window.__TAURI_INTERNALS__?.invoke?.("import_identity", { nsec });
    },
    nsecEncode(hexToBytes(TEST_IDENTITIES.tyler.privateKey)),
  );
  await page.reload();

  await expect(page.getByText("Local Ops mode", { exact: true })).toHaveCount(
    0,
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.localStorage.getItem("buzz-local-ops-guest.v1"),
      ),
    )
    .toBeNull();
});

test("clearing local Ops guest mode in another window removes the session fallback", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLost: true },
    { seedPreviewFeatures: false, skipOnboardingSeed: true },
  );
  await page.goto("/");
  await enterLocalOpsGuestMode(page);

  const secondPage = await page.context().newPage();
  await installMockBridge(
    secondPage,
    { identityLost: true },
    { seedPreviewFeatures: false, skipOnboardingSeed: true },
  );
  await secondPage.goto("/");
  await expect(
    secondPage.getByText("Local Ops mode", { exact: true }),
  ).toBeVisible();
  await secondPage.getByRole("button", { name: "Restore identity" }).click();

  await expect(
    page.getByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();
  await secondPage.close();
});

test("local Ops guest mode persists without mutating identity recovery", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLost: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  await enterLocalOpsGuestMode(page);

  await expect(page).toHaveURL(/#\/ops$/);
  await expect(page.getByRole("heading", { name: "Ops Room" })).toBeVisible();
  await expect(page.getByText("Local Ops mode", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Messaging, signed actions, and external actions are unavailable until you restore your identity.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Restore identity" }),
  ).toBeVisible();

  expect(
    await page.evaluate(() =>
      window.localStorage.getItem("buzz-local-ops-guest.v1"),
    ),
  ).toBe("true");
  const recoveryIdentity = await page.evaluate(() =>
    window.__TAURI_INTERNALS__?.invoke?.("get_identity"),
  );
  expect(recoveryIdentity).toMatchObject({ lost: true });

  const commandsBeforeReload = await guestCommandLog(page);
  expect(
    commandsBeforeReload.filter((command) =>
      GUEST_FORBIDDEN_COMMANDS.includes(
        command as (typeof GUEST_FORBIDDEN_COMMANDS)[number],
      ),
    ),
  ).toEqual([]);

  await page.reload();
  await expect(page).toHaveURL(/#\/ops$/);
  await expect(page.getByRole("heading", { name: "Ops Room" })).toBeVisible();
  await expect(page.getByText("Local Ops mode", { exact: true })).toBeVisible();
  const commandsAfterReload = await guestCommandLog(page);
  expect(
    commandsAfterReload.filter((command) =>
      GUEST_FORBIDDEN_COMMANDS.includes(
        command as (typeof GUEST_FORBIDDEN_COMMANDS)[number],
      ),
    ),
  ).toEqual([]);

  await page.getByRole("button", { name: "Restore identity" }).click();
  await expect(
    page.getByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.localStorage.getItem("buzz-local-ops-guest.v1"),
    ),
  ).toBeNull();
});

test("lost boot keeps the pairing-code action stable while generating", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLost: true, pairingStartDelayMs: 2_500 },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  await page.getByTestId("nostr-import-phone-link").click();
  const copyButton = page.getByTestId("copy-identity-recovery-code");
  await expect(copyButton).toBeVisible();
  await expect(copyButton).toBeDisabled();
  await expect(copyButton).toHaveText("Generating pairing code...");
  const loadingButton = await copyButton.elementHandle();

  await expect(copyButton).toBeEnabled();
  await expect(copyButton).toHaveText("Copy pairing code");
  expect(
    await copyButton.evaluate(
      (button, loading) => button === loading,
      loadingButton,
    ),
  ).toBe(true);
});

test("lost boot offers phone recovery with a single-use QR", async ({
  page,
}, testInfo) => {
  await installMockBridge(
    page,
    { identityLost: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  await page.getByTestId("nostr-import-phone-link").click();
  await expect(page.getByTestId("identity-recovery-pairing")).toBeVisible();
  await expect(page.getByTestId("identity-recovery-qr")).toBeVisible();
  await expect(
    page.getByText("Scan this code with a signed-in Buzz phone."),
  ).toBeVisible();
  await expect(
    page.getByText("On your phone, open Settings → Send identity to desktop."),
  ).toBeVisible();
  await page.waitForTimeout(1_000); // Let the onboarding entrance motion settle.
  await page.screenshot({
    path: testInfo.outputPath("desktop-phone-recovery-qr.png"),
    fullPage: true,
  });

  const copyButton = page.getByTestId("copy-identity-recovery-code");
  await expect(copyButton).toHaveText("Copy pairing code");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await copyButton.click();
  await expect(copyButton).toHaveText("Copied");

  const copiedPayload = await page.evaluate(() => {
    const log = (
      window as Window & {
        __BUZZ_E2E_COMMAND_LOG__?: Array<{
          command: string;
          payload: Record<string, unknown> | null;
        }>;
      }
    ).__BUZZ_E2E_COMMAND_LOG__;
    return log?.findLast(({ command }) => command === "copy_text_to_clipboard")
      ?.payload;
  });
  expect(copiedPayload?.text).toMatch(/^nostrpair:\/\/.+&mode=recover$/);

  const commands = await page.evaluate(
    () =>
      (
        window as Window & {
          __BUZZ_E2E_COMMAND_PAYLOADS__?: Array<{ command: string }>;
        }
      ).__BUZZ_E2E_COMMAND_PAYLOADS__ ?? [],
  );
  expect(
    commands.some(
      (entry) => entry.command === "start_identity_recovery_pairing",
    ),
  ).toBe(true);
});

test("phone recovery uses the desktop pairing card semantics", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLost: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  await page.getByTestId("nostr-import-phone-link").click();
  const card = page.getByTestId("identity-recovery-pairing");
  const qrContainer = card.getByTestId("identity-recovery-qr-container");
  const qrCode = card.getByTestId("identity-recovery-qr");
  const copyButton = card.getByTestId("copy-identity-recovery-code");
  await expect(qrCode).toBeVisible();
  await expect(qrCode).toHaveAttribute("data-qr-matrix-size", "57");
  await expect(qrCode.locator("[data-qr-finder-pattern]")).toHaveCount(3);
  await expect(qrCode.locator(".buzz-qr-cell-reveal").first()).toHaveCSS(
    "animation-name",
    "buzz-qr-cell-reveal",
  );
  const qrBox = await qrContainer.boundingBox();
  const copyBox = await copyButton.boundingBox();
  expect(qrBox).not.toBeNull();
  expect(copyBox).not.toBeNull();
  expect(Math.abs((copyBox?.x ?? 0) - (qrBox?.x ?? 0))).toBeLessThan(1);
  expect(Math.abs((copyBox?.width ?? 0) - (qrBox?.width ?? 0))).toBeLessThan(1);

  await page.evaluate(async () => {
    await window.__TAURI_INTERNALS__?.invoke?.("plugin:event|emit", {
      event: "pairing-sas-received",
      payload: { sas: "123456" },
    });
  });

  await expect(
    card.getByText("Does this code match your phone?"),
  ).toBeVisible();
  await expect(
    page.getByText("Confirm the code before sharing your identity."),
  ).toBeVisible();
  await expect(
    card.getByText(
      "This gives this desktop permanent access to your Buzz identity. Only continue if you trust it.",
    ),
  ).toBeVisible();
  await expect(
    card.getByText(/On your phone, open Settings/),
  ).not.toBeVisible();
  await expect(card.getByTestId("identity-recovery-sas")).toHaveText("123 456");
  await expect(card.getByTestId("confirm-identity-recovery-sas")).toHaveText(
    "Codes match",
  );
  await expect(card.getByTestId("deny-identity-recovery-sas")).toHaveText(
    "Cancel",
  );
  const cancelBox = await card
    .getByTestId("deny-identity-recovery-sas")
    .boundingBox();
  const confirmBox = await card
    .getByTestId("confirm-identity-recovery-sas")
    .boundingBox();
  expect(cancelBox).not.toBeNull();
  expect(confirmBox).not.toBeNull();
  expect((cancelBox?.y ?? 0) - (confirmBox?.y ?? 0)).toBeGreaterThan(
    confirmBox?.height ?? 0,
  );
});

test("canceling recovery uses the standard pairing cancellation state", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLost: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");
  await page.getByTestId("nostr-import-phone-link").click();
  await expect(page.getByTestId("identity-recovery-qr")).toBeVisible();

  await page.evaluate(async () => {
    await window.__TAURI_INTERNALS__?.invoke?.("plugin:event|emit", {
      event: "pairing-sas-received",
      payload: { sas: "123456" },
    });
  });
  await page.getByTestId("deny-identity-recovery-sas").click();

  await expect(
    page.getByText("The codes didn't match. Pairing was canceled."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window.__BUZZ_E2E_COMMAND_LOG__ ?? []).filter(
            ({ command }) => command === "cancel_pairing",
          ).length,
      ),
    )
    .toBeGreaterThan(0);
});

test("phone recovery continues to harness setup without creating or restarting", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLost: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");
  await page.getByTestId("nostr-import-phone-link").click();
  await expect(page.getByTestId("identity-recovery-qr")).toBeVisible();

  await page.evaluate(async () => {
    await window.__TAURI_INTERNALS__?.invoke?.(
      "complete_identity_recovery_pairing",
    );
  });

  await expect(
    page.getByRole("heading", { name: "Set up your agent harnesses" }),
  ).toBeVisible();
  await expect(page.getByTestId("relaunch-required")).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: "Your unique identity key has been created",
    }),
  ).toHaveCount(0);
});

test("recovery turns relay failures into actionable copy", async ({ page }) => {
  await installMockBridge(
    page,
    { identityLost: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");
  await page.getByTestId("nostr-import-phone-link").click();
  await expect(page.getByTestId("identity-recovery-qr")).toBeVisible();

  await page.evaluate(async () => {
    await window.__TAURI_INTERNALS__?.invoke?.("plugin:event|emit", {
      event: "pairing-error",
      payload: { message: "failed to send sas-confirm" },
    });
  });

  await expect(
    page.getByText(
      "This pairing code expired or lost its connection. Create a new code and try again.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("desktop refreshes recovery codes before the relay expires them", async ({
  page,
}) => {
  await page.clock.install();
  await installMockBridge(
    page,
    { identityLost: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");
  await page.getByTestId("nostr-import-phone-link").click();
  await expect(page.getByTestId("identity-recovery-qr")).toBeVisible();

  const recoveryStarts = () =>
    page.evaluate(
      () =>
        (window.__BUZZ_E2E_COMMAND_LOG__ ?? []).filter(
          ({ command }) => command === "start_identity_recovery_pairing",
        ).length,
    );
  await expect.poll(recoveryStarts).toBe(1);

  await page.clock.fastForward(90_000);
  await expect.poll(recoveryStarts).toBe(2);
  await expect(page.getByTestId("identity-recovery-qr")).toBeVisible();
});

test("importing a key from lost mode shows the relaunch-required screen", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLost: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();

  const importedNsec = nsecEncode(hexToBytes(TEST_IDENTITIES.alice.privateKey));
  await page.getByTestId("nostr-import-nsec-input").fill(importedNsec);
  await expect(page.getByTestId("nostr-import-npub-preview")).toBeVisible();
  await page.getByTestId("nostr-import-submit").click();

  await expect(page.getByTestId("relaunch-required")).toBeVisible();
});

test("start-new-identity from lost mode persists the ephemeral key after confirmation", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLost: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();

  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Start new identity" }).click();

  await expect(page.getByTestId("relaunch-required")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __BUZZ_E2E_COMMAND_PAYLOADS__?: Array<{ command: string }>;
            }
          ).__BUZZ_E2E_COMMAND_PAYLOADS__?.some(
            (e) => e.command === "persist_current_identity",
          ) ?? false,
      ),
    )
    .toBe(true);
});

test("cancelling start-new-identity in lost mode stays on the import screen", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLost: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();

  page.on("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Start new identity" }).click();

  // Still on the import screen — no navigation, no persist
  await expect(
    page.getByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();
  await expect(page.getByTestId("relaunch-required")).toHaveCount(0);
});

test("locked boot shows the keyring-locked screen without the onboarding gate or key-import UI", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLocked: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  await expect(page.getByTestId("keyring-locked")).toBeVisible();
  await expect(page.getByTestId("onboarding-gate")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Enter your private key" }),
  ).toHaveCount(0);
});

test("locked boot can re-import a key and requires relaunch", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLocked: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  await expect(page.getByTestId("keyring-locked")).toBeVisible();
  page.on("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Re-import your key instead" })
    .click();

  const importedNsec = nsecEncode(hexToBytes(TEST_IDENTITIES.alice.privateKey));
  await page.getByTestId("nostr-import-nsec-input").fill(importedNsec);
  await expect(page.getByTestId("nostr-import-npub-preview")).toBeVisible();
  await page.getByTestId("nostr-import-submit").click();

  await expect(page.getByTestId("relaunch-required")).toBeVisible();
  await expect(page.getByTestId("keyring-locked")).toHaveCount(0);
});

test("locked screen relaunch button records the process-restart invoke", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { identityLocked: true },
    { skipOnboardingSeed: true },
  );
  await page.goto("/");

  await expect(page.getByTestId("keyring-locked")).toBeVisible();
  await page.getByTestId("relaunch-app").click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __BUZZ_E2E_COMMAND_PAYLOADS__?: Array<{ command: string }>;
            }
          ).__BUZZ_E2E_COMMAND_PAYLOADS__?.some(
            (e) => e.command === "plugin:process|restart",
          ) ?? false,
      ),
    )
    .toBe(true);
});
