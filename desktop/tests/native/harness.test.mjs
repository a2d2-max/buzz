import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";

import {
  APP_IDENTIFIER,
  EVIDENCE_VIEWPORTS,
  artifactHandleRoot,
  assertNoArtifactHandleRemnants,
  assertOfflineEvidenceLog,
  assertOfflineStartupEffectsDisabled,
  assertOnlyLoopbackSockets,
  assertZeroSideEffects,
  buildTauriConfig,
  createIsolatedEnvironment,
  findElementIndex,
  findElementIndexByRoles,
  processGroupAlive,
  redactEvidenceLog,
  spawnOwnedProcess,
  validateOwnedProcessStartup,
  withRequiredCleanup,
} from "./harness.ts";

test("native evidence viewport matrix matches the approved responsive widths", () => {
  assert.deepEqual(EVIDENCE_VIEWPORTS, [
    { name: "desktop", width: 1280, height: 900 },
    { name: "compact", width: 736, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ]);
});

test("isolated environment contains no inherited credential or user-state variables", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "buzz-native-env-test-"));
  const inherited = {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    AWS_SECRET_ACCESS_KEY: "PRIVATE_AWS_VALUE",
    BUZZ_PRIVATE_KEY: "PRIVATE_NSEC_VALUE",
    GH_TOKEN: "PRIVATE_GITHUB_VALUE",
    HOME: "/Users/private",
  };
  const environment = createIsolatedEnvironment({
    inherited,
    root,
    hubPort: 31415,
    hubTokenFile: path.join(root, "hub", "hub.token"),
    vitePort: 31416,
    viewport: EVIDENCE_VIEWPORTS[2],
  });

  assert.equal(environment.HOME, path.join(root, "home"));
  assert.equal(environment.XDG_CACHE_HOME, path.join(root, "xdg-cache"));
  assert.equal(environment.TMPDIR, path.join(root, "tmp"));
  assert.equal(environment.BUZZ_OPS_HUB_PORT, "31415");
  assert.equal(environment.VITE_OPS_EVIDENCE_WIDTH, "390");
  assert.equal(environment.VITE_OPS_EVIDENCE_HEIGHT, "844");
  assert.equal(environment.BUZZ_RELAY_URL, "ws://127.0.0.1:1");
  assert.equal(environment.BUZZ_RELAY_HTTP, "http://127.0.0.1:1");
  assert.equal(environment.BUZZ_DEV_USE_KEYCHAIN, "0");
  assert.equal(environment.BUZZ_OPS_EVIDENCE_OFFLINE, "1");
  assert.equal(environment.CARGO_NET_OFFLINE, "true");
  assert.equal(environment.npm_config_offline, "true");
  assert.equal(environment.PNPM_CONFIG_OFFLINE, "true");
  assert.equal(environment.BUZZ_PRIVATE_KEY, undefined);
  assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(environment.GH_TOKEN, undefined);
  assert.equal(readdirSync(path.join(root, "home")).length > 0, true);
  const cache = path.dirname(artifactHandleRoot(environment, "darwin"));
  const cacheStat = lstatSync(cache);
  assert.equal(cacheStat.isDirectory(), true);
  assert.equal(cacheStat.isSymbolicLink(), false);
  assert.equal(cacheStat.mode & 0o777, 0o700);
});

test("isolated app cache creation rejects preexisting links and permissive directories", () => {
  for (const mode of ["symlink", "permissions"]) {
    const root = mkdtempSync(path.join(os.tmpdir(), "buzz-native-cache-test-"));
    const cache = path.join(root, "home", "Library", "Caches", APP_IDENTIFIER);
    mkdirSync(path.dirname(cache), { recursive: true, mode: 0o700 });
    if (mode === "symlink") {
      const outside = mkdtempSync(
        path.join(os.tmpdir(), "buzz-native-cache-outside-"),
      );
      symlinkSync(outside, cache);
    } else {
      mkdirSync(cache, { mode: 0o755 });
      chmodSync(cache, 0o755);
    }

    assert.throws(
      () =>
        createIsolatedEnvironment({
          inherited: { PATH: "/usr/bin:/bin" },
          root,
          hubPort: 31415,
          hubTokenFile: path.join(root, "hub", "hub.token"),
          vitePort: 31416,
          viewport: EVIDENCE_VIEWPORTS[2],
          platform: "darwin",
        }),
      /native_environment_directory_invalid/,
      mode,
    );
  }
});

test("Tauri override has a unique dev identity, loopback Vite, and an unmaximized evidence window", () => {
  assert.deepEqual(buildTauriConfig(43123, EVIDENCE_VIEWPORTS[2]), {
    app: {
      windows: [
        {
          backgroundThrottling: "disabled",
          dragDropEnabled: false,
          height: 844,
          hiddenTitle: true,
          label: "main",
          maximized: false,
          minHeight: 500,
          minWidth: 360,
          title: "",
          titleBarStyle: "Overlay",
          transparent: false,
          visible: false,
          width: 390,
        },
      ],
    },
    build: {
      beforeDevCommand:
        "exec ./node_modules/.bin/vite --host 127.0.0.1 --port 43123 --strictPort",
      devUrl: "http://127.0.0.1:43123?resetDevState=1",
    },
    identifier: APP_IDENTIFIER,
    productName: "Buzz Ops Evidence",
  });
});

test("accessibility element lookup requires one exact visible control", () => {
  const tree = [
    "App=buzz-desktop (pid 123)",
    "0 standard window",
    "\t7 button Continue in local Ops mode",
    "\t9 button evidence-large.txt 아티팩트 열기",
  ].join("\n");
  assert.equal(
    findElementIndex(tree, "button", "Continue in local Ops mode"),
    7,
  );
  assert.equal(
    findElementIndex(tree, "button", "evidence-large.txt 아티팩트 열기"),
    9,
  );
  assert.throws(
    () =>
      findElementIndex(
        `${tree}\n\t10 button Continue in local Ops mode`,
        "button",
        "Continue in local Ops mode",
      ),
    /native_element_ambiguous/,
  );
  assert.throws(
    () => findElementIndex(tree, "button", "missing"),
    /native_element_missing/,
  );
  assert.equal(
    findElementIndexByRoles(
      "3 radio button 컨텍스트",
      ["tab", "button", "radio button"],
      "컨텍스트",
    ),
    3,
  );
});

test("log redaction removes tokens, bearer values, private keys, and canonical paths", () => {
  const root = "/var/folders/private/native-evidence";
  const token = "a".repeat(64);
  const text = [
    `state=${root}/hub token=${token}`,
    `Authorization: Bearer ${token}`,
    "BUZZ_PRIVATE_KEY=nsec1private",
    "source=/Users/private/project/file.ts",
  ].join("\n");
  const redacted = redactEvidenceLog(text, { roots: [root], secrets: [token] });
  assert.equal(redacted.includes(token), false);
  assert.equal(redacted.includes(root), false);
  assert.equal(redacted.includes("nsec1private"), false);
  assert.equal(redacted.includes("/Users/private"), false);
  assert.match(redacted, /<redacted-token>/);
  assert.match(redacted, /<evidence-root>/);
});

test("offline evidence logs reject model downloads and non-loopback URLs", () => {
  assert.doesNotThrow(() =>
    assertOfflineEvidenceLog(
      "Local: http://127.0.0.1:43123/\nevidence offline mode enabled",
    ),
  );
  for (const log of [
    "buzz-desktop: downloading STT model from https://github.com/model",
    "buzz-desktop: downloading Pocket TTS bundle.json from https://huggingface.co/model",
    "buzz-desktop: downloaded 104337827 bytes, wrote to disk",
    "unexpected https://example.com/network",
  ]) {
    assert.throws(
      () => assertOfflineEvidenceLog(log),
      /native_offline_log_violation/,
    );
  }
});

test("offline evidence startup proves model, process sweep, and publish effects are disabled", () => {
  const markers = [
    "buzz-desktop: evidence offline mode enabled",
    "buzz-desktop: evidence offline mode: STT model fetch disabled",
    "buzz-desktop: evidence offline mode: TTS model fetch disabled",
    "buzz-desktop: evidence offline mode: managed-agent system sweep disabled",
    "buzz-desktop: evidence offline mode: periodic event publish disabled",
  ];
  assert.doesNotThrow(() =>
    assertOfflineStartupEffectsDisabled(markers.join("\n")),
  );
  for (const omitted of markers) {
    assert.throws(
      () =>
        assertOfflineStartupEffectsDisabled(
          markers.filter((marker) => marker !== omitted).join("\n"),
        ),
      /native_offline_startup_policy_missing/,
    );
  }
});

test("network evidence accepts only loopback lsof socket names", () => {
  assert.doesNotThrow(() =>
    assertOnlyLoopbackSockets(
      [
        "p123",
        "n127.0.0.1:43123",
        "TST=LISTEN",
        "n[::1]:43123->[::1]:52341",
      ].join("\n"),
    ),
  );
  for (const socket of [
    "n192.168.1.10:52341->140.82.112.4:443",
    "n127.0.0.1:52341->140.82.112.4:443",
    "n*:43123",
  ]) {
    assert.throws(
      () => assertOnlyLoopbackSockets(socket),
      /native_non_loopback_socket_detected/,
    );
  }
});

test("side-effect counters are exact and all zero", () => {
  const counters = {
    delivery_callback_count: 0,
    provider_execution_count: 0,
    external_network_client_count: 0,
    mutation_request_count: 0,
  };
  assert.doesNotThrow(() => assertZeroSideEffects(counters));
  assert.throws(
    () => assertZeroSideEffects({ ...counters, provider_execution_count: 1 }),
    /native_side_effect_detected/,
  );
  assert.throws(
    () => assertZeroSideEffects({ ...counters, extra: 0 }),
    /native_counter_contract_invalid/,
  );
});

test("artifact handle cleanup permits only the owned marker", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "buzz-native-handle-test-"));
  writeFileSync(
    path.join(root, ".buzz-ops-artifact-handles-v1"),
    "buzz-ops-artifact-handles-v1\n",
    { mode: 0o600 },
  );
  assert.doesNotThrow(() => assertNoArtifactHandleRemnants(root));
  writeFileSync(path.join(root, ".tmp123456"), "remnant", { mode: 0o600 });
  assert.throws(
    () => assertNoArtifactHandleRemnants(root),
    /native_artifact_remnant_detected/,
  );
});

test("owned process cleanup terminates the exact detached process group", async () => {
  if (process.platform === "win32") return;
  const owned = spawnOwnedProcess({
    command: process.execPath,
    args: [
      "-e",
      "const{spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('native-owned-ready');setInterval(()=>{},1000)",
    ],
    cwd: process.cwd(),
    environment: process.env,
  });
  await owned.waitForOutput(/native-owned-ready/, 5_000);
  assert.equal(processGroupAlive(owned.processGroupId), true);
  await owned.stop(5_000);
  assert.equal(processGroupAlive(owned.processGroupId), false);
});

test("owned process cleanup drains exit-time stdout and stderr before output is read", async () => {
  const owned = spawnOwnedProcess({
    command: process.execPath,
    args: [
      "-e",
      "process.on('SIGTERM',()=>process.stdout.write('x'.repeat(1024*1024),()=>process.stderr.write('native-final-marker\\n',()=>process.exit(0))));console.log('native-drain-ready');setInterval(()=>{},1000)",
    ],
    cwd: process.cwd(),
    environment: process.env,
  });
  await owned.waitForOutput(/native-drain-ready/, 5_000);
  await owned.stop(10_000);
  assert.equal(processGroupAlive(owned.processGroupId), false);
  assert.match(owned.output(), /native-final-marker/);
});

test("required cleanup preserves a primary failure after killing the owned process group", async () => {
  const owned = spawnOwnedProcess({
    command: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: process.cwd(),
    environment: process.env,
  });
  await assert.rejects(
    withRequiredCleanup(
      async () => {
        throw new Error("native_primary_failure");
      },
      async () => owned.stop(5_000),
    ),
    /native_primary_failure/,
  );
  assert.equal(processGroupAlive(owned.processGroupId), false);
});

test("required cleanup aggregates primary and cleanup failures", async () => {
  await assert.rejects(
    withRequiredCleanup(
      async () => {
        throw new Error("native_primary_failure");
      },
      async () => {
        throw new Error("native_cleanup_failure");
      },
    ),
    (error) =>
      error instanceof AggregateError &&
      error.errors.some(
        (nested) => nested.message === "native_primary_failure",
      ) &&
      error.errors.some(
        (nested) => nested.message === "native_cleanup_failure",
      ),
  );
});

test("owned startup validation kills the new group on missing ready, malformed ready, or token failure", async () => {
  for (const failure of [
    "native_hub_ready_missing",
    "native_hub_ready_invalid",
    "native_hub_token_invalid",
  ]) {
    const owned = spawnOwnedProcess({
      command: process.execPath,
      args: ["-e", "console.log('fixture-started');setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      environment: process.env,
    });
    await assert.rejects(
      validateOwnedProcessStartup(owned, async () => {
        await owned.waitForOutput(/fixture-started/, 5_000);
        throw new Error(failure);
      }),
      new RegExp(failure),
    );
    assert.equal(processGroupAlive(owned.processGroupId), false, failure);
  }
});
