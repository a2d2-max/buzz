import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const desktopRoot = path.resolve(path.dirname(scriptPath), "..");
const repoRoot = path.resolve(desktopRoot, "..");

export const defaultA2d2CloudConfigPath = path.join(
  desktopRoot,
  "config",
  "a2d2-cloud.json",
);

const httpsEndpointKeys = [
  "BUZZ_AFFINE_URL",
  "BUZZ_PLANE_URL",
  "BUZZ_RELAY_HTTP",
];
const websocketEndpointKeys = ["BUZZ_RELAY_URL"];
const endpointKeys = [...httpsEndpointKeys, ...websocketEndpointKeys];
const prohibitedBuildEnv = [
  "BUZZ_BUILD_DEMO_SLUG",
  "BUZZ_DESKTOP_BUILD_DEMO_SLUG",
  "BUZZ_DESKTOP_AFFINE_URL",
  "BUZZ_DESKTOP_PLANE_URL",
  "BUZZ_PRIVATE_KEY",
  "BUZZ_SHARE_IDENTITY",
];

function validateRootOrigin(key, value, protocol) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty URL`);
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid URL`);
  }

  if (
    url.protocol !== protocol ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      `${key} must be a root ${protocol} origin without credentials, path, query, or fragment`,
    );
  }

  return url.origin;
}

export function parseA2d2CloudConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("A2D2 cloud config must be a JSON object");
  }

  const keys = Object.keys(raw).sort();
  const expected = [...endpointKeys].sort();
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new Error(
      `A2D2 cloud config must contain exactly: ${endpointKeys.join(", ")}`,
    );
  }

  const config = Object.fromEntries([
    ...httpsEndpointKeys.map((key) => [
      key,
      validateRootOrigin(key, raw[key], "https:"),
    ]),
    ...websocketEndpointKeys.map((key) => [
      key,
      validateRootOrigin(key, raw[key], "wss:"),
    ]),
  ]);
  if (config.BUZZ_AFFINE_URL === config.BUZZ_PLANE_URL) {
    throw new Error("AFFiNE and Plane must use distinct HTTPS origins");
  }
  if (
    config.BUZZ_RELAY_URL.replace(/^wss:/, "https:") !== config.BUZZ_RELAY_HTTP
  ) {
    throw new Error("Buzz WebSocket and HTTP origins must use the same host");
  }
  return Object.freeze(config);
}

export function loadA2d2CloudConfig(configPath = defaultA2d2CloudConfigPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read A2D2 cloud config: ${error.message}`);
  }
  return parseA2d2CloudConfig(parsed);
}

export function a2d2CloudBuildEnv(config, inheritedEnv = process.env) {
  const prohibited = prohibitedBuildEnv.filter(
    (key) => inheritedEnv[key] !== undefined && inheritedEnv[key] !== "",
  );
  if (prohibited.length > 0) {
    throw new Error(
      `A2D2 production build refuses QA/demo environment: ${prohibited.join(", ")}`,
    );
  }

  return { ...inheritedEnv, ...config };
}

export function runWithA2d2CloudBuildEnv(
  command,
  inheritedEnv = process.env,
  configPath = defaultA2d2CloudConfigPath,
) {
  if (command.length === 0) {
    throw new Error("--exec requires a command");
  }
  const config = loadA2d2CloudConfig(configPath);
  const result = spawnSync(command[0], command.slice(1), {
    cwd: repoRoot,
    env: a2d2CloudBuildEnv(config, inheritedEnv),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function main(args) {
  const config = loadA2d2CloudConfig();
  a2d2CloudBuildEnv(config);

  if (args.length === 1 && args[0] === "--check") {
    console.log(
      `A2D2 cloud build endpoints verified: ${endpointKeys.join(", ")}`,
    );
    return 0;
  }
  if (args[0] === "--exec") {
    return runWithA2d2CloudBuildEnv(args.slice(1));
  }
  throw new Error(
    "Usage: a2d2-cloud-build-env.mjs --check | --exec <command> [args...]",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`Invalid A2D2 cloud build: ${error.message}`);
    process.exitCode = 1;
  }
}
