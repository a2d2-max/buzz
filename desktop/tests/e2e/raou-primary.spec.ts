import { expect, test, type Locator, type Page } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";
import { createOpsRoomFixture } from "../../src/features/ops-room/testing/opsRoomFixture.mjs";

const VIEWPORTS = [
  { height: 900, name: "desktop", width: 1280 },
  { height: 900, name: "compact", width: 736 },
  { height: 844, name: "mobile", width: 390 },
] as const;

const FORBIDDEN_IDENTITY_ACTION =
  /create identity|use identity|restore identity|recover identity/i;
const FORBIDDEN_KEY_COPY =
  /private key|nsec|back up your identity|identity recovery/i;
const FORBIDDEN_BOOT_COMMAND =
  /identity|account|relay|community|network|profile|onboarding|backup|recovery|updater?/i;
const OPS_CAPABILITIES = {
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
};
const OPS_ARTIFACT_PAGE = {
  contract_version: 1 as const,
  revision: 19,
  generated_at: "2026-08-30T00:00:00.000Z",
  next_cursor: null,
  items: [
    {
      id: "artifact:0123456789abcdef0123456789abcdef",
      work_item_id: "work:configured-redacted",
      title: "Parity report",
      kind: "markdown",
      status: "ready",
      version: 1,
      source_event_id: null,
      created_at: "2026-08-30T00:00:00.000Z",
      updated_at: "2026-08-30T00:00:00.000Z",
    },
  ],
};

async function contrastRatio(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const rgba = (value: string) => {
      const parts = value.match(/-?[\d.]+/g)?.map(Number) ?? [];
      const fromOklab = (
        rawLightness: number,
        axisA: number,
        axisB: number,
        rawAlpha: number,
      ) => {
        const lightness = rawLightness > 1 ? rawLightness / 100 : rawLightness;
        const alpha = rawAlpha > 1 ? rawAlpha / 100 : rawAlpha;
        const l =
          (lightness + 0.3963377774 * axisA + 0.2158037573 * axisB) ** 3;
        const m =
          (lightness - 0.1055613458 * axisA - 0.0638541728 * axisB) ** 3;
        const s = (lightness - 0.0894841775 * axisA - 1.291485548 * axisB) ** 3;
        const gamma = (channel: number) => {
          const value =
            channel <= 0.0031308
              ? 12.92 * channel
              : 1.055 * channel ** (1 / 2.4) - 0.055;
          return Math.max(0, Math.min(255, value * 255));
        };
        return {
          a: alpha,
          b: gamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
          g: gamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
          r: gamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        };
      };
      if (value.startsWith("oklab")) {
        const [lightness = 0, axisA = 0, axisB = 0, alpha = 1] = parts;
        return fromOklab(lightness, axisA, axisB, alpha);
      }
      if (value.startsWith("oklch")) {
        const [lightness = 0, chroma = 0, hue = 0, alpha = 1] = parts;
        const radians = (hue * Math.PI) / 180;
        return fromOklab(
          lightness,
          chroma * Math.cos(radians),
          chroma * Math.sin(radians),
          alpha,
        );
      }
      if (value.startsWith("color(srgb")) {
        const [red = 0, green = 0, blue = 0, alpha = 1] = parts;
        return { a: alpha, b: blue * 255, g: green * 255, r: red * 255 };
      }
      return {
        a: parts[3] ?? 1,
        b: parts[2] ?? 0,
        g: parts[1] ?? 0,
        r: parts[0] ?? 0,
      };
    };
    const composite = (
      foreground: ReturnType<typeof rgba>,
      background: ReturnType<typeof rgba>,
    ) => ({
      a: 1,
      b: foreground.b * foreground.a + background.b * (1 - foreground.a),
      g: foreground.g * foreground.a + background.g * (1 - foreground.a),
      r: foreground.r * foreground.a + background.r * (1 - foreground.a),
    });
    const backgrounds = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      backgrounds.push(rgba(getComputedStyle(node).backgroundColor));
    }
    let background = { a: 1, b: 255, g: 255, r: 255 };
    for (const layer of backgrounds.reverse()) {
      background = composite(layer, background);
    }
    const foreground = rgba(getComputedStyle(element).color);
    const luminance = ({ r, g, b }: typeof foreground) => {
      const channel = (value: number) => {
        const normalized = value / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const light = Math.max(luminance(foreground), luminance(background));
    const dark = Math.min(luminance(foreground), luminance(background));
    return (light + 0.05) / (dark + 0.05);
  });
}

async function openPrimary(page: Page, viewport: (typeof VIEWPORTS)[number]) {
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  page.on("pageerror", (error) => console.error(error));
  await page.setViewportSize(viewport);
  await installMockBridge(
    page,
    {
      identityLost: true,
      opsCapabilities: OPS_CAPABILITIES,
      opsPages: { artifacts: OPS_ARTIFACT_PAGE },
    },
    {
      seedPreviewFeatures: false,
      skipCommunitySeed: true,
      skipOnboardingSeed: true,
    },
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?raouPrimary=1");
  await expect(page.getByTestId("app-top-chrome")).toBeVisible();
  if (viewport.width < 768) {
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  }
  await expect(page.getByTestId("raou-workspace-sidebar")).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "RAOU workspace" }),
  ).toBeVisible();
  await expect(page.getByText("RAOU", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Local workspace", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("raou-workspace-id")).toHaveText(
    /^[0-9a-f]{8}$/i,
  );
  await expect(page.getByText("Buzz", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: FORBIDDEN_IDENTITY_ACTION }),
  ).toHaveCount(0);
  await expect(page.getByText(FORBIDDEN_KEY_COPY)).toHaveCount(0);
  await expect(page).toHaveURL(/raouPrimary=1#\/ops\?view=room$/);
  await expect(page.getByTestId("ops-room-view")).toBeVisible();
  await expect(page.getByText("Sections", { exact: true })).toHaveCount(0);
}

test("default launch keeps the complete Buzz shell and opens RAOU Ops inside it", async ({
  page,
}) => {
  await installMockBridge(page, undefined, { seedPreviewFeatures: true });
  await page.goto("/");

  await expect(page.getByTestId("app-sidebar-layer")).toBeVisible();
  await expect(page.getByTestId("app-sidebar")).toBeVisible();
  await expect(page.getByTestId("open-ops-view")).toBeVisible();
  await expect(page.getByTestId("raou-workspace-sidebar")).toHaveCount(0);

  await page.getByTestId("open-ops-view").click();
  await expect(page).toHaveURL(/#\/ops/);
  await expect(page.getByTestId("ops-room-view")).toBeVisible();
  await expect(page.getByTestId("app-sidebar")).toBeVisible();
});

for (const viewport of VIEWPORTS) {
  test(`RAOU boots directly into the local workspace at ${viewport.width}`, async ({
    page,
  }, testInfo) => {
    await openPrimary(page, viewport);

    const topChrome = page.getByTestId("app-top-chrome");
    const box = await topChrome.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.height).toBeLessThanOrEqual(40);

    await topChrome.dispatchEvent("pointerdown", {
      bubbles: true,
      button: 0,
      clientY: 20,
      detail: 1,
      pointerType: "mouse",
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window.__BUZZ_E2E_COMMANDS__ ?? []).includes(
            "plugin:window|start_dragging",
          ),
        ),
      )
      .toBe(true);

    const commands = await page.evaluate(
      () => window.__BUZZ_E2E_COMMANDS__ ?? [],
    );
    expect(
      commands.filter((command) => FORBIDDEN_BOOT_COMMAND.test(command)),
    ).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(page.getByTestId("ops-room-view")).toHaveAttribute(
      "data-reduced-motion",
      "true",
    );

    await page.getByRole("button", { name: "Artifacts" }).click();
    await expect(page).toHaveURL(/view=artifacts/);
    await expect(page.getByTestId("ops-artifacts-view")).toBeVisible();

    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: testInfo.outputPath(`raou-primary-${viewport.name}.png`),
    });
  });
}

test("Hub absence keeps the Buzz workspace shell and a useful room surface", async ({
  page,
}, testInfo) => {
  await page.setViewportSize(VIEWPORTS[0]);
  await installMockBridge(
    page,
    { identityLost: true, opsCapabilitiesError: "not_configured" },
    {
      seedPreviewFeatures: false,
      skipCommunitySeed: true,
      skipOnboardingSeed: true,
    },
  );
  await page.goto("/?raouPrimary=1");

  await expect(page.getByTestId("app-top-chrome")).toBeVisible();
  await expect(page.getByTestId("raou-workspace-sidebar")).toBeVisible();
  await expect(page.getByRole("button", { name: "Agent room" })).toBeVisible();
  await expect(
    page.getByTestId("app-top-chrome").getByText("Agent room", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("ops-connection-card")).toBeVisible();
  await expect(
    page.getByText("Local Ops Hub가 설정되지 않았습니다"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "연결 다시 확인" }),
  ).toBeVisible();
  await expect(page.getByText("Sections", { exact: true })).toHaveCount(0);
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: testInfo.outputPath("raou-hub-waiting.png"),
  });
});

test("the local workspace UUID is stable across reloads", async ({ page }) => {
  await openPrimary(page, VIEWPORTS[0]);
  const first = await page.getByTestId("raou-workspace-id").textContent();
  await page.reload();
  await expect(page.getByTestId("raou-workspace-id")).toHaveText(first ?? "");
});

test("light OS keeps RAOU status, artifact, error, and document surfaces dark and contrast-safe", async ({
  context,
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await installMockBridge(
    page,
    {
      identityLost: true,
      opsCapabilities: OPS_CAPABILITIES,
      opsPages: { artifacts: OPS_ARTIFACT_PAGE },
      opsSnapshot: createOpsRoomFixture(),
    },
    {
      seedPreviewFeatures: false,
      skipCommunitySeed: true,
      skipOnboardingSeed: true,
    },
  );
  await page.goto("/?raouPrimary=1");

  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).not.toHaveClass(/light/);
  expect(
    await page.evaluate(() => ({
      background: getComputedStyle(document.documentElement)
        .getPropertyValue("--background")
        .trim(),
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      bodyBackground: getComputedStyle(document.body)
        .getPropertyValue("--background")
        .trim(),
    })),
  ).toEqual({
    background: "204 13% 7%",
    bodyBackground: "204 13% 7%",
    colorScheme: "dark",
  });
  await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "bg-popover text-popover-foreground";
    probe.dataset.testid = "raou-portal-probe";
    probe.textContent = "Portal palette probe";
    document.body.append(probe);
  });
  const portalProbe = page.getByTestId("raou-portal-probe");
  expect(await contrastRatio(portalProbe)).toBeGreaterThanOrEqual(4.5);
  await expect(portalProbe).toHaveCSS("color-scheme", "dark");

  const compatibility = page.getByTestId("ops-watch-compatibility");
  await expect(compatibility).toBeVisible();
  expect(await contrastRatio(compatibility)).toBeGreaterThanOrEqual(4.5);
  await page.getByRole("button", { name: "Artifacts" }).click();
  const artifactStatus = page.getByText("v1 · ready", { exact: true });
  await expect(artifactStatus).toBeVisible();
  expect(await contrastRatio(artifactStatus)).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: testInfo.outputPath("raou-primary-light-os.png"),
  });

  const errorPage = await context.newPage();
  await errorPage.emulateMedia({ colorScheme: "light" });
  await installMockBridge(
    errorPage,
    {
      identityLost: true,
      opsCapabilities: { ...OPS_CAPABILITIES, contract_version: 999 },
    },
    {
      seedPreviewFeatures: false,
      skipCommunitySeed: true,
      skipOnboardingSeed: true,
    },
  );
  await errorPage.goto("/?raouPrimary=1");
  await expect(errorPage.locator("html")).toHaveClass(/dark/);
  await expect(
    errorPage.getByText("Ops 계약 버전이 맞지 않습니다"),
  ).toBeVisible();
  const errorDescription = errorPage.getByText(
    "RAOU와 Local Ops Hub의 계약 버전을 맞춘 뒤 다시 여세요.",
  );
  await expect(errorDescription).toBeVisible();
  await expect(errorPage.getByText(/Buzz/)).toHaveCount(0);
  expect(await contrastRatio(errorDescription)).toBeGreaterThanOrEqual(4.5);
  await errorPage.screenshot({
    animations: "disabled",
    fullPage: true,
    path: testInfo.outputPath("raou-primary-light-error.png"),
  });
});
