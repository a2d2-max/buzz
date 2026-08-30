import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

export const APP_IDENTIFIER = "xyz.block.buzz.app.dev.ops-evidence";
export const APP_PRODUCT_NAME = "Buzz Ops Evidence";
export const KEYRING_SERVICE = "buzz-desktop-dev.ops-evidence";
export const ARTIFACT_HANDLE_MARKER = ".buzz-ops-artifact-handles-v1";
export const ARTIFACT_HANDLE_MARKER_CONTENT = "buzz-ops-artifact-handles-v1\n";

export const EVIDENCE_VIEWPORTS = Object.freeze([
  Object.freeze({ name: "desktop", width: 1280, height: 900 }),
  Object.freeze({ name: "compact", width: 736, height: 900 }),
  Object.freeze({ name: "mobile", width: 390, height: 844 }),
] as const);

export type EvidenceViewport = (typeof EVIDENCE_VIEWPORTS)[number];

type IsolatedEnvironmentInput = {
  inherited: NodeJS.ProcessEnv;
  root: string;
  hubPort: number;
  hubTokenFile: string;
  vitePort: number;
  viewport: EvidenceViewport;
  platform?: NodeJS.Platform;
};

const INHERITED_TOOLCHAIN_KEYS = Object.freeze([
  "PATH",
  "LANG",
  "LC_ALL",
  "TERM",
  "RUSTUP_HOME",
  "CARGO_HOME",
  "HERMIT_STATE_DIR",
  "HERMIT_EXE",
  "SDKROOT",
  "DEVELOPER_DIR",
  "MACOSX_DEPLOYMENT_TARGET",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const);

function ensureDirectory(directory: string): void {
  const existed = existsSync(directory);
  if (!existed) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("native_environment_directory_invalid");
  }
  if (process.platform !== "win32") {
    if (existed && (stat.mode & 0o777) !== 0o700) {
      throw new Error("native_environment_directory_invalid");
    }
    if (!existed) chmodSync(directory, 0o700);
    const secured = lstatSync(directory);
    if (
      !secured.isDirectory() ||
      secured.isSymbolicLink() ||
      (secured.mode & 0o777) !== 0o700
    ) {
      throw new Error("native_environment_directory_invalid");
    }
  }
}

function appDataDirectory(
  home: string,
  xdgData: string,
  platform: NodeJS.Platform,
): string {
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", APP_IDENTIFIER);
  }
  if (platform === "win32") {
    return path.join(home, "AppData", "Roaming", APP_IDENTIFIER);
  }
  return path.join(xdgData, APP_IDENTIFIER);
}

function appCacheDirectory(
  home: string,
  xdgCache: string,
  platform: NodeJS.Platform,
): string {
  if (platform === "darwin") {
    return path.join(home, "Library", "Caches", APP_IDENTIFIER);
  }
  if (platform === "win32") {
    return path.join(home, "AppData", "Local", APP_IDENTIFIER);
  }
  return path.join(xdgCache, APP_IDENTIFIER);
}

export function artifactHandleRoot(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const home = environment.HOME;
  const cache = environment.XDG_CACHE_HOME;
  if (!home || !cache) throw new Error("native_environment_invalid");
  return path.join(
    appCacheDirectory(home, cache, platform),
    "ops-artifact-handles-v1",
  );
}

export function createIsolatedEnvironment(
  input: IsolatedEnvironmentInput,
): NodeJS.ProcessEnv {
  if (!path.isAbsolute(input.root) || !path.isAbsolute(input.hubTokenFile)) {
    throw new Error("native_environment_path_invalid");
  }
  if (
    !Number.isSafeInteger(input.hubPort) ||
    input.hubPort < 1 ||
    input.hubPort > 65_535
  ) {
    throw new Error("native_hub_port_invalid");
  }
  if (
    !Number.isSafeInteger(input.vitePort) ||
    input.vitePort < 1 ||
    input.vitePort > 65_535
  ) {
    throw new Error("native_vite_port_invalid");
  }

  const home = path.join(input.root, "home");
  const xdgCache = path.join(input.root, "xdg-cache");
  const xdgConfig = path.join(input.root, "xdg-config");
  const xdgData = path.join(input.root, "xdg-data");
  const xdgState = path.join(input.root, "xdg-state");
  const temporary = path.join(input.root, "tmp");
  for (const directory of [
    home,
    xdgCache,
    xdgConfig,
    xdgData,
    xdgState,
    temporary,
  ]) {
    ensureDirectory(directory);
  }

  const platform = input.platform ?? process.platform;
  const dataDirectory = appDataDirectory(home, xdgData, platform);
  const cacheDirectory = appCacheDirectory(home, xdgCache, platform);
  ensureDirectory(dataDirectory);
  ensureDirectory(cacheDirectory);
  const marker = path.join(
    dataDirectory,
    `identity.${KEYRING_SERVICE}.migrated`,
  );
  writeFileSync(marker, "1", { flag: "wx", mode: 0o600 });
  if (platform !== "win32") chmodSync(marker, 0o600);

  const environment: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_TOOLCHAIN_KEYS) {
    const value = input.inherited[key];
    if (value) environment[key] = value;
  }
  Object.assign(environment, {
    HOME: home,
    XDG_CACHE_HOME: xdgCache,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    BUZZ_DEV_KEYRING_SERVICE: KEYRING_SERVICE,
    BUZZ_DEV_USE_KEYCHAIN: "0",
    BUZZ_OPS_EVIDENCE_OFFLINE: "1",
    BUZZ_OPS_HUB_PORT: String(input.hubPort),
    BUZZ_OPS_HUB_TOKEN_FILE: input.hubTokenFile,
    BUZZ_RELAY_URL: "ws://127.0.0.1:1",
    BUZZ_RELAY_HTTP: "http://127.0.0.1:1",
    VITE_OPS_EVIDENCE_WIDTH: String(input.viewport.width),
    VITE_OPS_EVIDENCE_HEIGHT: String(input.viewport.height),
    VITE_PORT: String(input.vitePort),
    CARGO_NET_OFFLINE: "true",
    npm_config_offline: "true",
    PNPM_CONFIG_OFFLINE: "true",
  });
  return environment;
}

export function buildTauriConfig(
  vitePort: number,
  viewport: EvidenceViewport,
): Record<string, unknown> {
  if (!Number.isSafeInteger(vitePort) || vitePort < 1 || vitePort > 65_535) {
    throw new Error("native_vite_port_invalid");
  }
  if (
    !EVIDENCE_VIEWPORTS.some(
      (candidate) =>
        candidate.width === viewport.width &&
        candidate.height === viewport.height,
    )
  ) {
    throw new Error("native_viewport_invalid");
  }
  return {
    app: {
      windows: [
        {
          backgroundThrottling: "disabled",
          dragDropEnabled: false,
          height: viewport.height,
          hiddenTitle: true,
          label: "main",
          maximized: false,
          minHeight: 500,
          minWidth: 360,
          title: "",
          titleBarStyle: "Overlay",
          transparent: false,
          visible: false,
          width: viewport.width,
        },
      ],
    },
    build: {
      beforeDevCommand: `exec ./node_modules/.bin/vite --host 127.0.0.1 --port ${vitePort} --strictPort`,
      devUrl: `http://127.0.0.1:${vitePort}?resetDevState=1`,
    },
    identifier: APP_IDENTIFIER,
    productName: APP_PRODUCT_NAME,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findElementIndex(
  treeText: string,
  role: string,
  label: string,
): number {
  if (!role || !label || role.includes("\n") || label.includes("\n")) {
    throw new Error("native_element_query_invalid");
  }
  const expression = new RegExp(
    `^\\s*(\\d+) ${escapeRegex(role)}(?: ${escapeRegex(label)}|, Text: ${escapeRegex(label)})(?:,.*)?$`,
    "gm",
  );
  const matches = Array.from(treeText.matchAll(expression));
  if (matches.length === 0) throw new Error("native_element_missing");
  if (matches.length !== 1) throw new Error("native_element_ambiguous");
  const index = Number(matches[0][1]);
  if (!Number.isSafeInteger(index) || index < 0)
    throw new Error("native_element_query_invalid");
  return index;
}

export function findElementIndexByRoles(
  treeText: string,
  roles: readonly string[],
  label: string,
): number {
  const indexes: number[] = [];
  for (const role of roles) {
    try {
      indexes.push(findElementIndex(treeText, role, label));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "native_element_missing"
      ) {
        continue;
      }
      throw error;
    }
  }
  const unique = [...new Set(indexes)];
  if (unique.length === 0) throw new Error("native_element_missing");
  if (unique.length !== 1) throw new Error("native_element_ambiguous");
  return unique[0];
}

export function redactEvidenceLog(
  input: string,
  options: { roots?: readonly string[]; secrets?: readonly string[] } = {},
): string {
  let output = input;
  for (const secret of options.secrets ?? []) {
    if (secret) output = output.replaceAll(secret, "<redacted-token>");
  }
  for (const root of [...(options.roots ?? [])]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)) {
    output = output.replaceAll(root, "<evidence-root>");
  }
  output = output
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s"']+/gi, "$1<redacted-token>")
    .replace(/(BUZZ_PRIVATE_KEY\s*=\s*)[^\s"']+/gi, "$1<redacted-private-key>")
    .replace(
      /\bnsec1[023456789acdefghjklmnpqrstuvwxyz]+\b/gi,
      "<redacted-private-key>",
    )
    .replace(/\bfile:\/\/\/(?:Users|home)\/[^\s"'`]+/g, "<redacted-path>")
    .replace(/\/(?:Users|home)\/[^\s"'`]+/g, "<redacted-path>")
    .replace(/[A-Za-z]:\\(?:[^\s"'`\\]+\\)*[^\s"'`\\]*/g, "<redacted-path>");
  return output;
}

function loopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "127.0.0.1"
  );
}

export function assertOfflineEvidenceLog(input: string): void {
  if (
    /downloading STT model|downloading Pocket TTS|downloaded \d+ bytes|extracting STT archive|github\.com|huggingface\.co/iu.test(
      input,
    )
  ) {
    throw new Error("native_offline_log_violation");
  }
  for (const match of input.matchAll(/\b(?:https?|wss?):\/\/[^\s"'`]+/giu)) {
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      throw new Error("native_offline_log_violation");
    }
    if (!loopbackHost(url.hostname)) {
      throw new Error("native_offline_log_violation");
    }
  }
}

const REQUIRED_OFFLINE_STARTUP_MARKERS = Object.freeze([
  "buzz-desktop: evidence offline mode enabled",
  "buzz-desktop: evidence offline mode: STT model fetch disabled",
  "buzz-desktop: evidence offline mode: TTS model fetch disabled",
  "buzz-desktop: evidence offline mode: managed-agent system sweep disabled",
  "buzz-desktop: evidence offline mode: periodic event publish disabled",
]);

export function assertOfflineStartupEffectsDisabled(input: string): void {
  for (const marker of REQUIRED_OFFLINE_STARTUP_MARKERS) {
    if (!input.includes(marker)) {
      throw new Error("native_offline_startup_policy_missing");
    }
  }
}

function socketEndpointHost(endpoint: string): string | null {
  if (endpoint.startsWith("[")) {
    const closing = endpoint.indexOf("]:");
    return closing > 1 ? endpoint.slice(1, closing) : null;
  }
  const separator = endpoint.lastIndexOf(":");
  return separator > 0 ? endpoint.slice(0, separator) : null;
}

export function assertOnlyLoopbackSockets(lsofFields: string): void {
  for (const line of lsofFields.split(/\r?\n/u)) {
    if (!line.startsWith("n") || line.length < 2) continue;
    for (const endpoint of line.slice(1).split("->")) {
      const host = socketEndpointHost(endpoint);
      if (!host || !loopbackHost(host)) {
        throw new Error("native_non_loopback_socket_detected");
      }
    }
  }
}

export async function withRequiredCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let result: T | undefined;
  let completed = false;
  let primaryError: unknown;
  let primaryFailed = false;
  try {
    result = await operation();
    completed = true;
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  }

  let cleanupError: unknown;
  let cleanupFailed = false;
  try {
    await cleanup();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }

  if (primaryFailed && cleanupFailed) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "native_operation_and_cleanup_failed",
    );
  }
  if (primaryFailed) throw primaryError;
  if (cleanupFailed) throw cleanupError;
  if (!completed) throw new Error("native_operation_incomplete");
  return result as T;
}

export async function validateOwnedProcessStartup<T>(
  owned: OwnedProcess,
  validation: () => Promise<T>,
): Promise<T> {
  let validated = false;
  return withRequiredCleanup(
    async () => {
      const result = await validation();
      validated = true;
      return result;
    },
    async () => {
      if (validated) return;
      await owned.stop(10_000);
      if (processGroupAlive(owned.processGroupId)) {
        throw new Error("native_process_cleanup_failed");
      }
    },
  );
}

const COUNTER_KEYS = Object.freeze([
  "delivery_callback_count",
  "external_network_client_count",
  "mutation_request_count",
  "provider_execution_count",
]);

export function assertZeroSideEffects(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("native_counter_contract_invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(COUNTER_KEYS)
  ) {
    throw new Error("native_counter_contract_invalid");
  }
  for (const key of COUNTER_KEYS) {
    if (record[key] !== 0) throw new Error("native_side_effect_detected");
  }
}

export function assertNoArtifactHandleRemnants(root: string): void {
  if (!path.isAbsolute(root) || !existsSync(root))
    throw new Error("native_artifact_root_missing");
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("native_artifact_root_invalid");
  const entries = readdirSync(root).sort();
  if (JSON.stringify(entries) !== JSON.stringify([ARTIFACT_HANDLE_MARKER])) {
    throw new Error("native_artifact_remnant_detected");
  }
  const marker = path.join(root, ARTIFACT_HANDLE_MARKER);
  const markerStat = lstatSync(marker);
  if (
    !markerStat.isFile() ||
    markerStat.isSymbolicLink() ||
    readFileSync(marker, "utf8") !== ARTIFACT_HANDLE_MARKER_CONTENT
  ) {
    throw new Error("native_artifact_marker_invalid");
  }
}

type SpawnOwnedProcessInput = {
  command: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
};

export type OwnedProcess = {
  child: ChildProcessWithoutNullStreams;
  processGroupId: number;
  output(): string;
  waitForOutput(pattern: RegExp, timeoutMs: number): Promise<string>;
  stop(timeoutMs?: number): Promise<void>;
};

const MAX_CAPTURED_PROCESS_OUTPUT = 32 * 1024 * 1024;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function processGroupAlive(processGroupId: number): boolean {
  if (!Number.isSafeInteger(processGroupId) || processGroupId < 1) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupAlive(processGroupId)) return true;
    await delay(25);
  }
  return !processGroupAlive(processGroupId);
}

export function spawnOwnedProcess(input: SpawnOwnedProcessInput): OwnedProcess {
  if (process.platform === "win32")
    throw new Error("native_process_group_unsupported");
  if (!path.isAbsolute(input.command) || !path.isAbsolute(input.cwd)) {
    throw new Error("native_process_path_invalid");
  }
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    detached: true,
    env: input.environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.pid) throw new Error("native_process_spawn_failed");
  const processGroupId = child.pid;
  let captured = "";
  let captureOverflow = false;
  let spawnError: Error | null = null;
  let exited = false;
  let closed = false;
  let stdoutEnded = false;
  let stderrEnded = false;
  const append = (prefix: string, chunk: Buffer | string): void => {
    if (captureOverflow) return;
    const next = `${prefix}${chunk.toString()}`;
    if (
      Buffer.byteLength(captured, "utf8") + Buffer.byteLength(next, "utf8") >
      MAX_CAPTURED_PROCESS_OUTPUT
    ) {
      captureOverflow = true;
      return;
    }
    captured += next;
  };
  child.stdout.on("data", (chunk) => append("", chunk));
  child.stderr.on("data", (chunk) => append("[stderr] ", chunk));
  child.stdout.once("end", () => {
    stdoutEnded = true;
  });
  child.stderr.once("end", () => {
    stderrEnded = true;
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  child.once("exit", () => {
    exited = true;
  });
  child.once("close", () => {
    closed = true;
  });

  const stop = async (timeoutMs = 10_000): Promise<void> => {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 60_000
    ) {
      throw new Error("native_process_timeout_invalid");
    }
    const deadline = Date.now() + timeoutMs;
    if (processGroupAlive(processGroupId)) {
      try {
        process.kill(-processGroupId, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    const gracefulBudget = Math.max(25, Math.floor(timeoutMs * 0.6));
    if (!(await waitForProcessGroupExit(processGroupId, gracefulBudget))) {
      try {
        process.kill(-processGroupId, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    while (processGroupAlive(processGroupId) && Date.now() < deadline) {
      await delay(25);
    }
    if (processGroupAlive(processGroupId)) {
      throw new Error("native_process_cleanup_failed");
    }
    while (!(closed && stdoutEnded && stderrEnded) && Date.now() < deadline) {
      await delay(25);
    }
    if (!(closed && stdoutEnded && stderrEnded)) {
      throw new Error("native_process_output_drain_failed");
    }
  };

  return {
    child,
    processGroupId,
    output: () => {
      if (captureOverflow) throw new Error("native_process_output_too_large");
      return captured;
    },
    async waitForOutput(pattern, timeoutMs) {
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 10 * 60_000
      ) {
        throw new Error("native_process_timeout_invalid");
      }
      const stablePattern = new RegExp(
        pattern.source,
        pattern.flags.replaceAll("g", ""),
      );
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (captureOverflow) throw new Error("native_process_output_too_large");
        if (stablePattern.test(captured)) return captured;
        if (spawnError) throw spawnError;
        if (exited) throw new Error("native_process_exited_before_ready");
        await delay(25);
      }
      throw new Error("native_process_ready_timeout");
    },
    stop,
  };
}
