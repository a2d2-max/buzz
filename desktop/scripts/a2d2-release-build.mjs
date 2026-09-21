import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), "../..");
const packages = [
  "buzz-acp",
  "buzz-agent",
  "buzz-backend-kubernetes",
  "buzz-dev-mcp",
  "git-credential-nostr",
  "buzz-cli",
];
const sidecars = [
  ["buzz-acp", "buzz-acp"],
  ["buzz-agent", "buzz-agent"],
  ["buzz-backend-kubernetes", "buzz-backend-kubernetes"],
  ["buzz-dev-mcp", "buzz-dev-mcp"],
  ["git-credential-nostr", "git-credential-nostr"],
  ["buzz", "buzz"],
];

function validateTarget(target) {
  if (!/^[A-Za-z0-9_.-]+$/.test(target)) {
    throw new Error(`invalid Rust target ${JSON.stringify(target)}`);
  }
  return target;
}

function digest(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function assertReleaseSidecars(repoRoot, target) {
  for (const [sourceName, embeddedName] of sidecars) {
    const source = path.join(repoRoot, "target", target, "release", sourceName);
    const bundled = path.join(
      repoRoot,
      "desktop",
      "src-tauri",
      "binaries",
      `${embeddedName}-${target}`,
    );
    const sourceStat = statSync(source);
    const bundledStat = statSync(bundled);
    if (!sourceStat.isFile() || sourceStat.size === 0) {
      throw new Error(`release sidecar is empty or not a file: ${source}`);
    }
    if (!bundledStat.isFile() || bundledStat.size === 0) {
      throw new Error(`bundled sidecar is empty or not a file: ${bundled}`);
    }
    if (process.platform !== "win32" && (bundledStat.mode & 0o111) === 0) {
      throw new Error(`bundled sidecar is not executable: ${bundled}`);
    }
    if (
      sourceStat.size !== bundledStat.size ||
      digest(source) !== digest(bundled)
    ) {
      throw new Error(`bundled sidecar is stale: ${bundled}`);
    }
  }
}

function run(command, args, { cwd, env }) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} exited with ${result.status}`);
  }
}

export function runA2d2ReleaseBuild(
  requestedTarget = "aarch64-apple-darwin",
  options = {},
) {
  const target = validateTarget(requestedTarget);
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const env = { ...process.env, ...options.env };
  run(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--target",
      target,
      ...packages.flatMap((name) => ["-p", name]),
    ],
    { cwd: repoRoot, env },
  );
  run(path.join(repoRoot, "scripts", "bundle-sidecars.sh"), [target], {
    cwd: repoRoot,
    env,
  });
  assertReleaseSidecars(repoRoot, target);
  run("pnpm", ["install", "--frozen-lockfile"], { cwd: repoRoot, env });
  run(
    process.execPath,
    [
      path.join(repoRoot, "desktop", "scripts", "a2d2-cloud-build-env.mjs"),
      "--exec",
      process.execPath,
      path.join(repoRoot, "desktop", "scripts", "tauri-command.mjs"),
      "build",
      "--features",
      "mesh-llm",
      "--target",
      target,
      "--bundles",
      "app",
    ],
    { cwd: repoRoot, env },
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    runA2d2ReleaseBuild(process.argv[2]);
  } catch (error) {
    console.error(`A2D2 release build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
