import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  a2d2CloudBuildEnv,
  loadA2d2CloudConfig,
  parseA2d2CloudConfig,
  runWithA2d2CloudBuildEnv,
} from "./a2d2-cloud-build-env.mjs";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const wrapperPath = path.join(
  desktopRoot,
  "scripts",
  "a2d2-cloud-build-env.mjs",
);

const expectedConfig = {
  BUZZ_AFFINE_URL: "https://affine.a2d2.space",
  BUZZ_PLANE_URL: "https://plane.a2d2.space",
  BUZZ_RELAY_HTTP: "https://buzz.a2d2lab.com",
  BUZZ_RELAY_URL: "wss://buzz.a2d2lab.com",
};

test("tracked A2D2 cloud profile contains all public product origins", () => {
  assert.deepEqual(loadA2d2CloudConfig(), expectedConfig);
});

test("profile rejects missing, extra, shared, and unsafe origins", () => {
  for (const raw of [
    { BUZZ_AFFINE_URL: expectedConfig.BUZZ_AFFINE_URL },
    {
      ...expectedConfig,
      BUZZ_DESKTOP_AFFINE_URL: expectedConfig.BUZZ_AFFINE_URL,
    },
    { ...expectedConfig, BUZZ_AFFINE_URL: "http://affine.a2d2.space" },
    { ...expectedConfig, BUZZ_AFFINE_URL: "https://user@affine.a2d2.space" },
    { ...expectedConfig, BUZZ_AFFINE_URL: "https://affine.a2d2.space/app" },
    { ...expectedConfig, BUZZ_AFFINE_URL: "https://affine.a2d2.space?token=x" },
    { ...expectedConfig, BUZZ_AFFINE_URL: expectedConfig.BUZZ_PLANE_URL },
    { ...expectedConfig, BUZZ_RELAY_URL: "https://buzz.a2d2lab.com" },
    { ...expectedConfig, BUZZ_RELAY_URL: "wss://other.a2d2lab.com" },
    { ...expectedConfig, BUZZ_RELAY_HTTP: "http://buzz.a2d2lab.com" },
  ]) {
    assert.throws(() => parseA2d2CloudConfig(raw));
  }
});

test("wrapper injects every fixed public endpoint and preserves other production inputs", () => {
  const env = a2d2CloudBuildEnv(expectedConfig, {
    PATH: "/toolchain",
    BUZZ_RELAY_URL: "wss://relay.example.test",
    BUZZ_RELAY_HTTP: "https://relay.example.test",
  });
  assert.equal(env.BUZZ_AFFINE_URL, expectedConfig.BUZZ_AFFINE_URL);
  assert.equal(env.BUZZ_PLANE_URL, expectedConfig.BUZZ_PLANE_URL);
  assert.equal(env.BUZZ_RELAY_URL, expectedConfig.BUZZ_RELAY_URL);
  assert.equal(env.BUZZ_RELAY_HTTP, expectedConfig.BUZZ_RELAY_HTTP);
  assert.equal(env.PATH, "/toolchain");
  assert.equal(env.BUZZ_DESKTOP_AFFINE_URL, undefined);
  assert.equal(env.BUZZ_DESKTOP_PLANE_URL, undefined);
  assert.equal(env.BUZZ_BUILD_DEMO_SLUG, undefined);
});

test("wrapper fails closed when QA or demo identity inputs are present", () => {
  for (const key of [
    "BUZZ_BUILD_DEMO_SLUG",
    "BUZZ_DESKTOP_BUILD_DEMO_SLUG",
    "BUZZ_DESKTOP_AFFINE_URL",
    "BUZZ_DESKTOP_PLANE_URL",
    "BUZZ_PRIVATE_KEY",
    "BUZZ_SHARE_IDENTITY",
  ]) {
    assert.throws(
      () => a2d2CloudBuildEnv(expectedConfig, { [key]: "present" }),
      new RegExp(key),
    );
  }
});

test("CLI injects all public endpoints into the child argv command", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "a2d2-cloud-env-test-"));
  const output = path.join(dir, "child-env.json");
  try {
    const child = [
      wrapperPath,
      "--exec",
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ affine: process.env.BUZZ_AFFINE_URL, plane: process.env.BUZZ_PLANE_URL, relayHttp: process.env.BUZZ_RELAY_HTTP, relayWs: process.env.BUZZ_RELAY_URL, demo: process.env.BUZZ_BUILD_DEMO_SLUG ?? null, key: process.env.BUZZ_PRIVATE_KEY ?? null }))",
      output,
    ];
    const result = spawnSync(process.execPath, child, {
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), {
      affine: expectedConfig.BUZZ_AFFINE_URL,
      plane: expectedConfig.BUZZ_PLANE_URL,
      relayHttp: expectedConfig.BUZZ_RELAY_HTTP,
      relayWs: expectedConfig.BUZZ_RELAY_URL,
      demo: null,
      key: null,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wrapper fails before executing a child when any endpoint is missing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "a2d2-cloud-env-test-"));
  const configPath = path.join(dir, "missing-plane.json");
  const marker = path.join(dir, "child-ran");
  writeFileSync(
    configPath,
    JSON.stringify({ BUZZ_AFFINE_URL: expectedConfig.BUZZ_AFFINE_URL }),
  );
  try {
    assert.throws(() =>
      runWithA2d2CloudBuildEnv(
        [
          process.execPath,
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'ran')",
          marker,
        ],
        { PATH: process.env.PATH },
        configPath,
      ),
    );
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI refuses an inherited identity before executing its child", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "a2d2-cloud-env-test-"));
  const marker = path.join(dir, "child-ran");
  try {
    const result = spawnSync(
      process.execPath,
      [
        wrapperPath,
        "--exec",
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], 'ran')",
        marker,
      ],
      {
        env: {
          PATH: process.env.PATH,
          BUZZ_PRIVATE_KEY: "synthetic-test-identity",
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /BUZZ_PRIVATE_KEY/);
    assert.doesNotMatch(result.stderr, /synthetic-test-identity/);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("public profile names remain connected to their build and runtime seams", () => {
  const buildRs = readFileSync(
    path.join(desktopRoot, "src-tauri", "build.rs"),
    "utf8",
  );
  const runtimeRs = readFileSync(
    path.join(desktopRoot, "src-tauri", "src", "commands", "upstream_apps.rs"),
    "utf8",
  );

  for (const [source, compiled] of [
    ["BUZZ_AFFINE_URL", "BUZZ_DESKTOP_AFFINE_URL"],
    ["BUZZ_PLANE_URL", "BUZZ_DESKTOP_PLANE_URL"],
  ]) {
    assert.ok(
      buildRs.includes(`("${source}", "${compiled}")`),
      `${source} must be baked as ${compiled}`,
    );
    assert.ok(
      runtimeRs.includes(`("${source}", option_env!("${compiled}"))`),
      `${source} must override the ${compiled} fallback at runtime`,
    );
  }
  for (const [source, compiled] of [
    ["BUZZ_RELAY_URL", "BUZZ_DESKTOP_BUILD_RELAY_URL"],
    ["BUZZ_RELAY_HTTP", "BUZZ_DESKTOP_BUILD_RELAY_HTTP"],
  ]) {
    assert.ok(buildRs.includes(source), `${source} must be read by build.rs`);
    assert.ok(
      buildRs.includes(`cargo:rustc-env=${compiled}`),
      `${source} must be baked as ${compiled}`,
    );
  }
  const relayRs = readFileSync(
    path.join(desktopRoot, "src-tauri", "src", "relay.rs"),
    "utf8",
  );
  assert.ok(relayRs.includes('option_env!("BUZZ_DESKTOP_BUILD_RELAY_URL")'));
  assert.ok(relayRs.includes('option_env!("BUZZ_DESKTOP_BUILD_RELAY_HTTP")'));
});
