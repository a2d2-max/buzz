import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
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
  type EvidenceViewport,
  type OwnedProcess,
} from "./harness.ts";

const BUZZ_ROOT = path.resolve(import.meta.dirname, "../../..");
const DESKTOP_ROOT = path.join(BUZZ_ROOT, "desktop");
const DEFAULT_HUB_ROOT = path.resolve(
  BUZZ_ROOT,
  "../orchestration-dashboard/.worktrees/feat-buzz-agent-room",
);
const EVIDENCE_OUTPUT = path.join(BUZZ_ROOT, "docs/reports/img/ops-artifacts");
const COMPATIBILITY_MATRIX = path.join(
  BUZZ_ROOT,
  "docs/reports/ops-bridge-compatibility-matrix.md",
);
const HUB_READY_PATTERN = /^\{"ready":true,"port":\d+\}$/m;
const INLINE_ARTIFACT_TITLE = "evidence-summary.md";
const INLINE_ARTIFACT_CONTENT = "Fixture-only evidence is ready for review.";
const LARGE_ARTIFACT_TITLE = "evidence-large.txt";
const ORCA_TIMEOUT_MS = 15_000;
const APP_START_TIMEOUT_MS = 10 * 60_000;
const UI_READY_TIMEOUT_MS = 60_000;
type JsonRecord = Record<string, unknown>;

type OrcaState = {
  treeText: string;
  focusedElementId: number | null;
  window: Record<string, unknown>;
  screenshotPath: string | null;
};

type HubFixture = {
  process: OwnedProcess;
  port: number;
  stateDir: string;
  token: string;
};

type ArtifactManifest = {
  artifact_id: string;
  title: string;
  mime: string;
  sha256: string;
  total_size: number;
  source: "inline" | "opaque";
};

type NativeManifest = {
  schema_version: 1;
  generated_at: string;
  fixture_hash: string;
  hub_sha: string;
  buzz_sha: string;
  hub_worktree_dirty: boolean;
  buzz_worktree_dirty: boolean;
  artifacts: {
    inline: ArtifactManifest;
    opaque: ArtifactManifest;
  };
  viewports: Array<{
    name: string;
    width: number;
    height: number;
    inline: {
      screenshot: string;
      screenshot_sha256: string;
      accessibility: string;
      accessibility_sha256: string;
      verified: true;
      focused_return: true;
    };
    opaque: {
      screenshot: string;
      screenshot_sha256: string;
      accessibility: string;
      accessibility_sha256: string;
      verified: true;
      focused_return: true;
    };
    log: string;
    log_sha256: string;
    process_cleanup: boolean;
    artifact_handle_remnants: number;
    non_loopback_sockets: 0;
    network_observations: number;
  }>;
  zero_side_effect_counters: Record<string, number>;
  assertions: {
    offline_mode: true;
    startup_effects_disabled: true;
    non_loopback_sockets: 0;
    logs_redacted: true;
    exact_process_cleanup: true;
    temporary_root_removed_after_process_exit: true;
  };
};

function fail(code: string): never {
  throw new Error(code);
}

function jsonRecord(value: unknown, code: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as JsonRecord;
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function safeOutputDirectory(): string {
  const resolved = path.resolve(EVIDENCE_OUTPUT);
  if (resolved !== EVIDENCE_OUTPUT) fail("native_evidence_output_invalid");
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(resolved)) {
    const owned =
      /^artifact-(?:(?:inline|opaque)-)?(?:1280|736|390)\.(?:png|accessibility\.json|log)$/u.test(
        name,
      ) || ["manifest.native.json", "manifest.md"].includes(name);
    if (!owned) continue;
    const target = path.join(resolved, name);
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink())
      fail("native_evidence_output_invalid");
    rmSync(target, { force: false });
  }
  return resolved;
}

function exactTemporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "buzz-ops-native-evidence-"));
  chmodSync(root, 0o700);
  return root;
}

function removeTemporaryRoot(root: string): void {
  const temporaryPrefix = `${path.resolve(os.tmpdir())}${path.sep}`;
  const resolved = path.resolve(root);
  if (
    !resolved.startsWith(temporaryPrefix) ||
    !path.basename(resolved).startsWith("buzz-ops-native-evidence-")
  ) {
    fail("native_temporary_root_invalid");
  }
  rmSync(resolved, { recursive: true, force: false });
}

async function freeLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!Number.isSafeInteger(port) || port < 1)
    fail("native_ephemeral_port_invalid");
  return port;
}

function hubEnvironment(root: string, stateDir: string): NodeJS.ProcessEnv {
  const home = path.join(root, "hub-home");
  const temporary = path.join(root, "hub-tmp");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    HOME: home,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    TZ: "UTC",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    OPS_EVIDENCE_STATE_DIR: stateDir,
    OPS_EVIDENCE_PORT: "0",
  };
}

async function startHubFixture(
  root: string,
  hubRoot: string,
  onSpawn: (process: OwnedProcess) => void,
): Promise<HubFixture> {
  const stateDir = path.join(root, "hub-state");
  const script = path.join(hubRoot, "scripts/serve_ops_room_fixture.ts");
  if (!existsSync(script)) fail("native_hub_fixture_missing");
  const hubProcess = spawnOwnedProcess({
    command: process.execPath,
    args: [
      "--experimental-strip-types",
      "--no-warnings=ExperimentalWarning",
      script,
    ],
    cwd: hubRoot,
    environment: hubEnvironment(root, stateDir),
  });
  onSpawn(hubProcess);
  return validateOwnedProcessStartup(hubProcess, async () => {
    const output = await hubProcess.waitForOutput(HUB_READY_PATTERN, 30_000);
    const line = output
      .split(/\r?\n/)
      .find((candidate) => HUB_READY_PATTERN.test(candidate));
    if (!line) fail("native_hub_ready_invalid");
    let ready: Record<string, unknown>;
    try {
      ready = jsonRecord(JSON.parse(line), "native_hub_ready_invalid");
    } catch {
      fail("native_hub_ready_invalid");
    }
    const port = Number(ready.port);
    if (
      ready.ready !== true ||
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65_535
    ) {
      fail("native_hub_ready_invalid");
    }
    const tokenFile = path.join(stateDir, "hub.token");
    let token: string;
    try {
      token = readFileSync(tokenFile, "utf8").trim();
    } catch {
      fail("native_hub_token_invalid");
    }
    if (!/^[0-9a-f]{64}$/.test(token)) fail("native_hub_token_invalid");
    return { process: hubProcess, port, stateDir, token };
  });
}

async function execJson(
  command: string,
  args: readonly string[],
  timeout = ORCA_TIMEOUT_MS,
): Promise<JsonRecord> {
  const { stdout, stderr } = await new Promise<{
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd: BUZZ_ROOT,
        env: process.env,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout,
      },
      (error, stdout, stderr) =>
        error ? reject(error) : resolve({ stdout, stderr }),
    );
  });
  if (stderr.trim()) fail("native_orca_stderr");
  const parsed = jsonRecord(JSON.parse(stdout), "native_orca_result_invalid");
  if (parsed.ok !== true) fail("native_orca_result_invalid");
  return jsonRecord(parsed.result, "native_orca_result_invalid");
}

async function orcaState(
  orca: string,
  pid: number,
  screenshot: boolean,
): Promise<OrcaState> {
  const args = [
    "computer",
    "get-app-state",
    "--app",
    `pid:${pid}`,
    "--restore-window",
  ];
  if (!screenshot) args.push("--no-screenshot");
  args.push("--json");
  const result = await execJson(orca, args);
  const snapshot = jsonRecord(result.snapshot, "native_orca_snapshot_invalid");
  if (typeof snapshot.treeText !== "string")
    fail("native_orca_snapshot_invalid");
  const window = jsonRecord(snapshot.window, "native_orca_snapshot_invalid");
  const screenshotRecord = result.screenshot
    ? jsonRecord(result.screenshot, "native_orca_snapshot_invalid")
    : null;
  const screenshotPath = screenshotRecord?.path;
  return {
    treeText: snapshot.treeText,
    focusedElementId: Number.isSafeInteger(snapshot.focusedElementId)
      ? snapshot.focusedElementId
      : null,
    window,
    screenshotPath: typeof screenshotPath === "string" ? screenshotPath : null,
  };
}

async function orcaClick(
  orca: string,
  pid: number,
  index: number,
): Promise<void> {
  await execJson(orca, [
    "computer",
    "click",
    "--app",
    `pid:${pid}`,
    "--element-index",
    String(index),
    "--no-screenshot",
    "--json",
  ]);
}

async function orcaPress(
  orca: string,
  pid: number,
  key: string,
): Promise<void> {
  await execJson(orca, [
    "computer",
    "press-key",
    "--app",
    `pid:${pid}`,
    "--key",
    key,
    "--no-screenshot",
    "--json",
  ]);
}

async function orcaQuit(orca: string, pid: number): Promise<void> {
  await execJson(orca, [
    "computer",
    "hotkey",
    "--app",
    `pid:${pid}`,
    "--key",
    "CmdOrCtrl+Q",
    "--no-screenshot",
    "--json",
  ]).catch(() => undefined);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

function findAppPid(processGroupId: number): number | null {
  const output = requireProcessList();
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || Number(match[2]) !== processGroupId) continue;
    const command = path.basename(match[3].trim());
    if (command === "buzz-desktop") return Number(match[1]);
  }
  return null;
}

function requireProcessList(): string {
  return execFileSync("/bin/ps", ["-axo", "pid=,pgid=,comm="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
}

function loopbackSocketFields(processGroupId: number): string {
  try {
    return execFileSync(
      "/usr/sbin/lsof",
      ["-nP", "-a", "-g", String(processGroupId), "-i", "-FpcnT"],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      status?: number;
      stdout?: Buffer | string;
    };
    if (failure.status === 1) return failure.stdout?.toString() ?? "";
    throw error;
  }
}

function startLoopbackNetworkMonitor(processGroupId: number): {
  check(): void;
  stop(): Promise<number>;
} {
  let stopRequested = false;
  let observations = 0;
  let violation: unknown;
  let stopPromise: Promise<number> | null = null;
  const sample = (): void => {
    if (violation !== undefined) return;
    try {
      assertOnlyLoopbackSockets(loopbackSocketFields(processGroupId));
      observations += 1;
    } catch (error) {
      violation = error;
    }
  };
  const task = (async () => {
    while (!stopRequested) {
      sample();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })();
  return {
    check() {
      if (violation !== undefined) throw violation;
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        stopRequested = true;
        await task;
        sample();
        if (violation !== undefined) throw violation;
        if (observations < 1) fail("native_network_observation_missing");
        return observations;
      })();
      return stopPromise;
    },
  };
}

async function waitForAppPid(groupId: number): Promise<number> {
  const deadline = Date.now() + APP_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const pid = findAppPid(groupId);
    if (pid) return pid;
    if (!processGroupAlive(groupId)) fail("native_tauri_exited_before_app");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail("native_app_start_timeout");
}

async function waitForState(
  orca: string,
  pid: number,
  predicate: (state: OrcaState) => boolean,
  timeout = UI_READY_TIMEOUT_MS,
): Promise<OrcaState> {
  const deadline = Date.now() + timeout;
  let last: OrcaState | null = null;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) fail("native_app_exited_during_ui_probe");
    try {
      last = await orcaState(orca, pid, false);
      if (predicate(last)) return last;
    } catch {
      /* the window may not be visible yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (last) fail("native_ui_state_timeout");
  fail("native_ui_unavailable");
}

function assertFixtureTreeSafe(
  treeText: string,
  roots: readonly string[],
  secrets: readonly string[],
): void {
  const redacted = redactEvidenceLog(treeText, { roots, secrets });
  if (
    redacted !== treeText ||
    /Bearer |nsec1|BUZZ_PRIVATE_KEY|\/Users\/|\bfile:\/\//i.test(treeText)
  ) {
    fail("native_accessibility_secret_or_path_detected");
  }
}

async function enterLocalOps(orca: string, pid: number): Promise<OrcaState> {
  const onboarding = await waitForState(orca, pid, (state) =>
    state.treeText.includes("Continue in local Ops mode"),
  );
  await orcaClick(
    orca,
    pid,
    findElementIndex(
      onboarding.treeText,
      "button",
      "Continue in local Ops mode",
    ),
  );
  return waitForState(
    orca,
    pid,
    (state) =>
      state.treeText.includes("Local Ops mode") &&
      state.treeText.includes("Agent Room"),
  );
}

async function revealArtifacts(
  orca: string,
  pid: number,
  viewport: EvidenceViewport,
): Promise<OrcaState> {
  const sizedState = await waitForState(
    orca,
    pid,
    (candidate) =>
      candidate.treeText.includes(`${LARGE_ARTIFACT_TITLE} 아티팩트 열기`) ||
      candidate.treeText.includes("컨텍스트 열기") ||
      candidate.treeText.includes("컨텍스트"),
  );
  const actualWidth = Number(sizedState.window.width);
  if (actualWidth !== viewport.width) {
    fail(`native_viewport_size_mismatch:${actualWidth}:${viewport.width}`);
  }
  if (sizedState.treeText.includes(`${LARGE_ARTIFACT_TITLE} 아티팩트 열기`))
    return sizedState;
  if (sizedState.treeText.includes("컨텍스트 열기")) {
    await orcaClick(
      orca,
      pid,
      findElementIndex(sizedState.treeText, "button", "컨텍스트 열기"),
    );
  } else if (viewport.name === "mobile") {
    await orcaClick(
      orca,
      pid,
      findElementIndexByRoles(
        sizedState.treeText,
        ["tab", "button", "radio button", "toggle button"],
        "컨텍스트",
      ),
    );
  } else {
    fail("native_large_artifact_missing");
  }
  return waitForState(orca, pid, (next) =>
    next.treeText.includes(`${LARGE_ARTIFACT_TITLE} 아티팩트 열기`),
  );
}

async function artifactManifests(hub: HubFixture): Promise<{
  inline: ArtifactManifest;
  opaque: ArtifactManifest;
}> {
  const headers = { Authorization: `Bearer ${hub.token}` };
  const snapshotResponse = await fetch(
    `http://127.0.0.1:${hub.port}/ops-bridge/v1/snapshot`,
    { headers },
  );
  if (snapshotResponse.status !== 200) fail("native_fixture_snapshot_failed");
  const snapshot = jsonRecord(
    await snapshotResponse.json(),
    "native_fixture_snapshot_invalid",
  );
  const room = jsonRecord(snapshot.room, "native_fixture_snapshot_invalid");
  const context = jsonRecord(room.context, "native_fixture_snapshot_invalid");
  if (!Array.isArray(context.artifacts))
    fail("native_fixture_snapshot_invalid");
  const artifacts = context.artifacts.map((row) =>
    jsonRecord(row, "native_fixture_snapshot_invalid"),
  );
  const readManifest = async (
    title: string,
    mime: string,
    source: ArtifactManifest["source"],
  ): Promise<ArtifactManifest> => {
    const artifact = artifacts.find((row) => row.title === title);
    if (!artifact || typeof artifact.id !== "string")
      fail("native_fixture_artifact_missing");
    const response = await fetch(
      `http://127.0.0.1:${hub.port}/ops-bridge/v1/artifacts/${artifact.id}/versions/1/preview/manifest`,
      { headers },
    );
    if (response.status !== 200) fail("native_fixture_manifest_failed");
    const manifest = jsonRecord(
      await response.json(),
      "native_fixture_manifest_invalid",
    );
    const size = Number(manifest.total_size);
    if (
      manifest.artifact_id !== artifact.id ||
      manifest.mime !== mime ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > 16 * 1024 * 1024 ||
      (source === "inline" && size > 1024 * 1024) ||
      (source === "opaque" && size <= 1024 * 1024) ||
      typeof manifest.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(manifest.sha256)
    ) {
      fail("native_fixture_manifest_invalid");
    }
    return {
      artifact_id: artifact.id,
      title,
      mime,
      sha256: manifest.sha256,
      total_size: size,
      source,
    };
  };
  return {
    inline: await readManifest(
      INLINE_ARTIFACT_TITLE,
      "text/markdown",
      "inline",
    ),
    opaque: await readManifest(LARGE_ARTIFACT_TITLE, "text/plain", "opaque"),
  };
}

function gitStatus(root: string): { sha: string; dirty: boolean } {
  const sha = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const dirty =
    execFileSync("/usr/bin/git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim().length > 0;
  if (!/^[0-9a-f]{40}$/.test(sha)) fail("native_git_sha_invalid");
  return { sha, dirty };
}

async function captureArtifact(input: {
  orca: string;
  pid: number;
  initial: OrcaState;
  title: string;
  mime: string;
  verification: string;
  expectedContent: string;
  output: string;
  fileKind: "inline" | "opaque";
  viewport: EvidenceViewport;
  privateRoots: readonly string[];
  secrets: readonly string[];
}): Promise<{
  restored: OrcaState;
  evidence: NativeManifest["viewports"][number]["inline"];
}> {
  const triggerLabel = `${input.title} 아티팩트 열기`;
  const trigger = findElementIndex(
    input.initial.treeText,
    "button",
    triggerLabel,
  );
  await orcaClick(input.orca, input.pid, trigger);
  await waitForState(
    input.orca,
    input.pid,
    (next) =>
      next.treeText.includes(input.title) &&
      next.treeText.includes(input.verification) &&
      next.treeText.includes(input.mime) &&
      next.treeText.includes(input.expectedContent),
  );
  const captured = await orcaState(input.orca, input.pid, true);
  assertFixtureTreeSafe(captured.treeText, input.privateRoots, input.secrets);
  if (!captured.screenshotPath || !existsSync(captured.screenshotPath))
    fail("native_screenshot_missing");
  const screenshotStat = lstatSync(captured.screenshotPath);
  if (!screenshotStat.isFile() || screenshotStat.isSymbolicLink())
    fail("native_screenshot_invalid");

  const base = `artifact-${input.fileKind}-${input.viewport.width}`;
  const screenshotName = `${base}.png`;
  const accessibilityName = `${base}.accessibility.json`;
  const screenshotPath = path.join(input.output, screenshotName);
  const accessibilityPath = path.join(input.output, accessibilityName);
  copyFileSync(captured.screenshotPath, screenshotPath);
  writeFileSync(
    accessibilityPath,
    `${JSON.stringify(
      {
        artifact_kind: input.fileKind,
        viewport: input.viewport,
        window: captured.window,
        focused_element_id: captured.focusedElementId,
        tree_text: captured.treeText,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  await orcaPress(input.orca, input.pid, "Escape");
  const restored = await waitForState(
    input.orca,
    input.pid,
    (next) =>
      next.treeText.includes(triggerLabel) &&
      !next.treeText.includes("읽기 전용 네이티브 아티팩트"),
  );
  const restoredTrigger = findElementIndex(
    restored.treeText,
    "button",
    triggerLabel,
  );
  if (restored.focusedElementId !== restoredTrigger)
    fail("native_artifact_focus_not_restored");

  return {
    restored,
    evidence: {
      screenshot: screenshotName,
      screenshot_sha256: sha256File(screenshotPath),
      accessibility: accessibilityName,
      accessibility_sha256: sha256File(accessibilityPath),
      verified: true,
      focused_return: true,
    },
  };
}

async function runViewport(input: {
  viewport: EvidenceViewport;
  root: string;
  hub: HubFixture;
  output: string;
  orca: string;
  buzzRoot: string;
  hubRoot: string;
}): Promise<NativeManifest["viewports"][number]> {
  const viewRoot = path.join(input.root, `view-${input.viewport.width}`);
  mkdirSync(viewRoot, { recursive: true, mode: 0o700 });
  const vitePort = await freeLoopbackPort();
  const hostHome = os.homedir();
  const inherited = {
    ...process.env,
    CARGO_HOME: process.env.CARGO_HOME ?? path.join(hostHome, ".cargo"),
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(hostHome, ".rustup"),
    HERMIT_STATE_DIR:
      process.env.HERMIT_STATE_DIR ??
      (process.platform === "darwin"
        ? path.join(hostHome, "Library/Caches/hermit")
        : path.join(hostHome, ".cache/hermit")),
  };
  const environment = createIsolatedEnvironment({
    inherited,
    root: viewRoot,
    hubPort: input.hub.port,
    hubTokenFile: path.join(input.hub.stateDir, "hub.token"),
    vitePort,
    viewport: input.viewport,
  });
  environment.PATH = `${path.join(input.buzzRoot, "bin")}:${environment.PATH ?? "/usr/bin:/bin"}`;
  const pnpm = path.join(input.buzzRoot, "bin", "pnpm");
  const tauri = spawnOwnedProcess({
    command: pnpm,
    args: [
      "exec",
      "tauri",
      "dev",
      "--no-watch",
      "--config",
      JSON.stringify(buildTauriConfig(vitePort, input.viewport)),
    ],
    cwd: DESKTOP_ROOT,
    environment,
  });
  const networkMonitor = startLoopbackNetworkMonitor(tauri.processGroupId);

  let appPid: number | null = null;
  return withRequiredCleanup(
    async () => {
      appPid = await waitForAppPid(tauri.processGroupId);
      networkMonitor.check();
      await enterLocalOps(input.orca, appPid);
      const initial = await revealArtifacts(input.orca, appPid, input.viewport);
      const common = {
        orca: input.orca,
        pid: appPid,
        output: input.output,
        viewport: input.viewport,
        privateRoots: [input.root, input.buzzRoot, input.hubRoot],
        secrets: [input.hub.token],
      } as const;
      const inline = await captureArtifact({
        ...common,
        initial,
        title: INLINE_ARTIFACT_TITLE,
        mime: "text/markdown",
        verification: "인라인 검증됨",
        expectedContent: INLINE_ARTIFACT_CONTENT,
        fileKind: "inline",
      });
      networkMonitor.check();
      const opaque = await captureArtifact({
        ...common,
        initial: inline.restored,
        title: LARGE_ARTIFACT_TITLE,
        mime: "text/plain",
        verification: "보안 스트림 검증됨",
        expectedContent:
          "Fixture-only deterministic native handle evidence. No external action.",
        fileKind: "opaque",
      });
      networkMonitor.check();

      await orcaQuit(input.orca, appPid);
      const quitDeadline = Date.now() + 15_000;
      while (processAlive(appPid) && Date.now() < quitDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await tauri.stop(15_000);
      if (processGroupAlive(tauri.processGroupId))
        fail("native_tauri_process_remnant");
      const networkObservations = await networkMonitor.stop();
      assertNoArtifactHandleRemnants(artifactHandleRoot(environment));
      assertZeroSideEffects(
        JSON.parse(
          readFileSync(
            path.join(input.hub.stateDir, "ops-evidence-counters.json"),
            "utf8",
          ),
        ),
      );

      const rawLog = tauri.output();
      assertOfflineEvidenceLog(rawLog);
      assertOfflineStartupEffectsDisabled(rawLog);
      const token = input.hub.token;
      const redactedLog = redactEvidenceLog(rawLog, {
        roots: [input.root, input.buzzRoot, input.hubRoot, os.homedir()],
        secrets: [token],
      });
      if (
        redactedLog.includes(token) ||
        /nsec1|BUZZ_PRIVATE_KEY=|\/Users\//i.test(redactedLog)
      )
        fail("native_log_redaction_failed");
      const logName = `artifact-${input.viewport.width}.log`;
      const logPath = path.join(input.output, logName);
      writeFileSync(logPath, redactedLog, { mode: 0o600 });

      return {
        name: input.viewport.name,
        width: input.viewport.width,
        height: input.viewport.height,
        inline: inline.evidence,
        opaque: opaque.evidence,
        log: logName,
        log_sha256: sha256File(logPath),
        process_cleanup: true,
        artifact_handle_remnants: 0,
        non_loopback_sockets: 0,
        network_observations: networkObservations,
      };
    },
    async () => {
      if (appPid && processAlive(appPid)) await orcaQuit(input.orca, appPid);
      await tauri.stop(15_000);
      if (processGroupAlive(tauri.processGroupId))
        fail("native_tauri_process_remnant");
      await networkMonitor.stop();
    },
  );
}

function fixtureHash(hub: HubFixture): string {
  const marker = jsonRecord(
    JSON.parse(
      readFileSync(
        path.join(hub.stateDir, ".ops-room-fixture-owned.json"),
        "utf8",
      ),
    ),
    "native_fixture_marker_invalid",
  );
  if (
    typeof marker.fixture_hash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(marker.fixture_hash)
  ) {
    fail("native_fixture_marker_invalid");
  }
  return marker.fixture_hash;
}

function shellCommand(): string {
  const quote = (value: string): string =>
    `'${value.replaceAll("'", `'\\''`)}'`;
  return ["pnpm", "test:native:ops-artifact", ...process.argv.slice(2)]
    .map(quote)
    .join(" ");
}

function manifestMarkdown(
  manifest: NativeManifest,
  jsonSha256: string,
  command: string,
): string {
  const rows = manifest.viewports
    .map(
      (viewport) =>
        `| ${viewport.name} | ${viewport.width}×${viewport.height} | ${viewport.inline.screenshot} | ${viewport.inline.screenshot_sha256} | ${viewport.opaque.screenshot} | ${viewport.opaque.screenshot_sha256} | ${viewport.network_observations} | 0 | yes |`,
    )
    .join("\n");
  const counterRows = Object.entries(manifest.zero_side_effect_counters)
    .map(([name, value]) => `| ${name} | ${value} |`)
    .join("\n");
  const fileRows = manifest.viewports
    .flatMap((viewport) => [
      [viewport.inline.screenshot, viewport.inline.screenshot_sha256],
      [viewport.inline.accessibility, viewport.inline.accessibility_sha256],
      [viewport.opaque.screenshot, viewport.opaque.screenshot_sha256],
      [viewport.opaque.accessibility, viewport.opaque.accessibility_sha256],
      [viewport.log, viewport.log_sha256],
    ])
    .map(([name, hash]) => `| ${name} | ${hash} |`)
    .join("\n");
  return `# Native Ops artifact evidence

## Reproduction

- Working directory: \`desktop\`
- Evidence command: \`${command}\`
- Native harness contracts: \`pnpm test:native:ops-artifact-harness\`
- Ops bridge contracts: \`node --import ./test-loader.mjs --experimental-strip-types --test src/features/ops-room/opsBridge.test.mjs\`
- Hub fixture contracts: \`npm run test:one -- tests/hub/testing/ops-room-fixture.test.ts\`
- Rust offline focus: \`CARGO_NET_OFFLINE=true cargo test --lib --no-default-features evidence_offline\`
- Rust full no-default-features: \`CARGO_NET_OFFLINE=true cargo test --lib --no-default-features\`
- Static gates: \`cargo fmt --check\`, \`pnpm typecheck\`, and \`pnpm exec biome check tests/native src/features/ops-room/opsBridge.test.mjs src/features/ops-room/types.ts\`

## Immutable inputs

- Buzz SHA: \`${manifest.buzz_sha}\` (dirty: \`${manifest.buzz_worktree_dirty}\`)
- Hub SHA: \`${manifest.hub_sha}\` (dirty: \`${manifest.hub_worktree_dirty}\`)
- Fixture hash: \`${manifest.fixture_hash}\`
- JSON manifest SHA-256: \`${jsonSha256}\`

| Read path | Fixture | MIME | Bytes | SHA-256 |
| --- | --- | --- | ---: | --- |
| inline | ${manifest.artifacts.inline.title} | ${manifest.artifacts.inline.mime} | ${manifest.artifacts.inline.total_size} | ${manifest.artifacts.inline.sha256} |
| opaque handle | ${manifest.artifacts.opaque.title} | ${manifest.artifacts.opaque.mime} | ${manifest.artifacts.opaque.total_size} | ${manifest.artifacts.opaque.sha256} |

## Viewport evidence

| Layout | Logical viewport | Inline screenshot | Inline SHA-256 | Opaque screenshot | Opaque SHA-256 | Network observations | Non-loopback sockets | Cleanup/focus |
| --- | --- | --- | --- | --- | --- | ---: | ---: | --- |
${rows}

Each viewport also has matching accessibility JSON and a redacted process log; their hashes are recorded in \`manifest.native.json\`. Both readers returned focus to their exact trigger. Every Tauri process group exited, stdout/stderr drained, and each opaque handle directory contained only its owned marker.

| Evidence file | SHA-256 |
| --- | --- |
${fileRows}

## Side-effect counters

| Counter | Value |
| --- | ---: |
${counterRows}

Offline evidence mode was enabled before Tauri startup. Cargo and pnpm were forced offline, shared HTTP clients were routed to a fail-closed loopback proxy, STT/TTS/mesh startup fetches, managed-agent restore/spawn, the system process sweep/reaper, and periodic event publishing were disabled. Process-group sockets were continuously sampled, and logs were rejected on missing offline-policy markers, download markers, or non-loopback URLs before redaction.

## Limitations

- This run proves the macOS Tauri/Orca lane and the tested Buzz/Hub SHA pair only.
- Retina screenshots are 2× pixels while the accessibility manifest records exact logical viewport dimensions.
- A dirty SHA pair is development evidence and must be regenerated from a clean integrated worktree before release acceptance.
`;
}

function compatibilityMatrixMarkdown(manifest: NativeManifest): string {
  return `# Ops bridge compatibility matrix

Tested pair: Buzz \`${manifest.buzz_sha}\` (dirty: \`${manifest.buzz_worktree_dirty}\`) ↔ Hub \`${manifest.hub_sha}\` (dirty: \`${manifest.hub_worktree_dirty}\`). Fixture \`${manifest.fixture_hash}\`.

Tested artifacts: inline \`${manifest.artifacts.inline.sha256}\`; opaque \`${manifest.artifacts.opaque.sha256}\`.

| Surface | Contract | Hub support | Buzz support | Evidence |
| --- | --- | --- | --- | --- |
| Capabilities | v1 exact reads and module metadata | snapshot, events, artifact | strict v1 parse | native startup + Ops bridge unit tests |
| Snapshot | \`/ops-bridge/v1/snapshot\` | room/session/checklist/decisions | fail-closed schemas | all three native viewports |
| Events | \`/ops-bridge/v1/events\` | SSE sequence | generation-bound watch/ack | bridge contract tests |
| Timeline page | \`/ops-bridge/v1/timeline\` | paged v1 + revision/cursor | page-endpoint-only module | bridge contract tests |
| Artifact page | \`/ops-bridge/v1/artifacts\` | paged v1 + revision/cursor | page-endpoint-only module | bridge contract tests |
| Artifact inline | preview manifest/content | text/markdown | inline text verification | ${manifest.viewports.map((row) => `${row.width}px`).join(", ")} |
| Artifact opaque | preview manifest/content chunks | text/plain >1 MiB | bounded handle reads + release | ${manifest.viewports.map((row) => `${row.width}px`).join(", ")} |
| Artifact errors | stable public error enum | invalid/not found/denied/integrity/size/media | typed fail-closed mapping | bridge/Rust tests |
| Mutations | disabled fixture | drafts/transitions empty | local Ops read-only | counters all zero |

Paged modules are not interpreted as inline snapshot payloads. Non-paged advertised payloads remain fail-closed when absent or invalid. Replace the tested SHA pair and dirty flags after the final clean integration run.
`;
}

function writeEvidenceReports(output: string, manifest: NativeManifest): void {
  const jsonPath = path.join(output, "manifest.native.json");
  writeFileSync(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
  if (JSON.stringify(parsed) !== JSON.stringify(manifest))
    fail("native_manifest_crosscheck_failed");
  const jsonSha256 = sha256File(jsonPath);
  const markdown = manifestMarkdown(manifest, jsonSha256, shellCommand());
  for (const required of [
    manifest.buzz_sha,
    manifest.hub_sha,
    manifest.fixture_hash,
    manifest.artifacts.inline.sha256,
    manifest.artifacts.opaque.sha256,
    jsonSha256,
    ...manifest.viewports.flatMap((viewport) => [
      viewport.inline.screenshot_sha256,
      viewport.inline.accessibility_sha256,
      viewport.opaque.screenshot_sha256,
      viewport.opaque.accessibility_sha256,
      viewport.log_sha256,
    ]),
  ]) {
    if (!markdown.includes(required)) fail("native_manifest_crosscheck_failed");
  }
  writeFileSync(path.join(output, "manifest.md"), markdown, { mode: 0o600 });
  const compatibilityMatrix = compatibilityMatrixMarkdown(manifest);
  for (const required of [
    manifest.buzz_sha,
    manifest.hub_sha,
    manifest.fixture_hash,
    manifest.artifacts.inline.sha256,
    manifest.artifacts.opaque.sha256,
    ...manifest.viewports.map((viewport) => `${viewport.width}px`),
  ]) {
    if (!compatibilityMatrix.includes(required))
      fail("native_compatibility_matrix_crosscheck_failed");
  }
  writeFileSync(COMPATIBILITY_MATRIX, compatibilityMatrix, {
    mode: 0o600,
  });
}

async function main(): Promise<void> {
  if (process.platform !== "darwin") fail("native_evidence_requires_macos");
  const parsed = parseArgs({
    options: {
      "allow-dirty": { type: "boolean", default: false },
      "hub-root": { type: "string", default: DEFAULT_HUB_ROOT },
      orca: {
        type: "string",
        default: process.env.ORCA_CLI_COMMAND ?? "/usr/local/bin/orca",
      },
      viewport: { type: "string", default: "all" },
    },
  });
  const hubRootValue = parsed.values["hub-root"];
  const orcaValue = parsed.values.orca;
  const requested = parsed.values.viewport;
  if (
    typeof hubRootValue !== "string" ||
    typeof orcaValue !== "string" ||
    typeof requested !== "string"
  ) {
    fail("native_argument_invalid");
  }
  const hubRoot = path.resolve(hubRootValue);
  const orca = path.resolve(orcaValue);
  const viewports =
    requested === "all"
      ? [...EVIDENCE_VIEWPORTS]
      : EVIDENCE_VIEWPORTS.filter(
          (viewport) => String(viewport.width) === requested,
        );
  if (viewports.length === 0) fail("native_viewport_invalid");
  if (!existsSync(orca)) fail("native_orca_missing");

  await execJson(orca, ["status", "--json"]);
  const capabilities = await execJson(orca, [
    "computer",
    "capabilities",
    "--json",
  ]);
  const supports = jsonRecord(
    capabilities.supports,
    "native_orca_capability_missing",
  );
  const observation = jsonRecord(
    supports.observation,
    "native_orca_capability_missing",
  );
  const actions = jsonRecord(
    supports.actions,
    "native_orca_capability_missing",
  );
  if (
    capabilities.platform !== "darwin" ||
    observation.screenshot !== true ||
    actions.click !== true ||
    actions.pressKey !== true
  ) {
    fail("native_orca_capability_missing");
  }

  const buzzGit = gitStatus(BUZZ_ROOT);
  const hubGit = gitStatus(hubRoot);
  if (!parsed.values["allow-dirty"] && (buzzGit.dirty || hubGit.dirty))
    fail("native_evidence_worktree_dirty");

  const output = safeOutputDirectory();
  const root = exactTemporaryRoot();
  let hub: HubFixture | null = null;
  let hubProcess: OwnedProcess | null = null;
  let hubNetworkMonitor: ReturnType<typeof startLoopbackNetworkMonitor> | null =
    null;
  const result = await withRequiredCleanup(
    async () => {
      hub = await startHubFixture(root, hubRoot, (process) => {
        hubProcess = process;
        hubNetworkMonitor = startLoopbackNetworkMonitor(process.processGroupId);
      });
      const artifacts = await artifactManifests(hub);
      const seededFixtureHash = fixtureHash(hub);
      const completed: NativeManifest["viewports"] = [];
      for (const viewport of viewports) {
        completed.push(
          await runViewport({
            viewport,
            root,
            hub,
            output,
            orca,
            buzzRoot: BUZZ_ROOT,
            hubRoot,
          }),
        );
      }
      await hub.process.stop(10_000);
      if (processGroupAlive(hub.process.processGroupId))
        fail("native_hub_process_remnant");
      await hubNetworkMonitor?.stop();
      assertOfflineEvidenceLog(hub.process.output());
      const counters = JSON.parse(
        readFileSync(
          path.join(hub.stateDir, "ops-evidence-counters.json"),
          "utf8",
        ),
      );
      assertZeroSideEffects(counters);
      const zeroCounters = counters as Record<string, number>;
      const manifest: NativeManifest = {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        fixture_hash: seededFixtureHash,
        hub_sha: hubGit.sha,
        buzz_sha: buzzGit.sha,
        hub_worktree_dirty: hubGit.dirty,
        buzz_worktree_dirty: buzzGit.dirty,
        artifacts,
        viewports: completed,
        zero_side_effect_counters: zeroCounters,
        assertions: {
          offline_mode: true,
          startup_effects_disabled: true,
          non_loopback_sockets: 0,
          logs_redacted: true,
          exact_process_cleanup: true,
          temporary_root_removed_after_process_exit: true,
        },
      };
      return { completed, manifest };
    },
    async () => {
      if (hubProcess) {
        await hubProcess.stop(10_000);
        if (processGroupAlive(hubProcess.processGroupId))
          fail("native_hub_process_remnant");
      }
      await hubNetworkMonitor?.stop();
      removeTemporaryRoot(root);
    },
  );
  writeEvidenceReports(output, result.manifest);
  console.log(
    JSON.stringify({
      ok: true,
      output,
      viewports: result.completed.map((run) => run.width),
    }),
  );
}

await main();
