import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runA2d2ReleaseBuild } from "./a2d2-release-build.mjs";

const target = "aarch64-apple-darwin";
const sidecars = [
  "buzz-acp",
  "buzz-agent",
  "buzz-backend-kubernetes",
  "buzz-dev-mcp",
  "git-credential-nostr",
  "buzz",
];

function executable(file, body) {
  writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(file, 0o755);
}

function fixture(mode) {
  const root = mkdtempSync(path.join(tmpdir(), "a2d2-release-recipe-"));
  const bin = path.join(root, "bin");
  const log = path.join(root, "commands.log");
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "desktop", "scripts"), { recursive: true });
  mkdirSync(path.join(root, "desktop", "src-tauri", "binaries"), {
    recursive: true,
  });
  executable(
    path.join(bin, "cargo"),
    `printf 'cargo %s\\n' "$*" >> "$A2D2_FIXTURE_LOG"
mkdir -p "target/$A2D2_FIXTURE_TARGET/release"
for name in ${sidecars.join(" ")}; do printf 'fresh-%s' "$name" > "target/$A2D2_FIXTURE_TARGET/release/$name"; chmod 755 "target/$A2D2_FIXTURE_TARGET/release/$name"; done`,
  );
  executable(
    path.join(bin, "pnpm"),
    `printf 'pnpm %s\\n' "$*" >> "$A2D2_FIXTURE_LOG"`,
  );
  executable(
    path.join(root, "scripts", "bundle-sidecars.sh"),
    `printf 'bundle %s\\n' "$*" >> "$A2D2_FIXTURE_LOG"
for name in ${sidecars.join(" ")}; do
  destination="desktop/src-tauri/binaries/$name-$1"
  case "$A2D2_FIXTURE_MODE" in
    good) cp "target/$1/release/$name" "$destination"; chmod 755 "$destination" ;;
    zero) : > "$destination"; chmod 755 "$destination" ;;
    stale) printf 'stale-%s' "$name" > "$destination"; chmod 755 "$destination" ;;
  esac
done`,
  );
  writeFileSync(
    path.join(root, "desktop", "scripts", "a2d2-cloud-build-env.mjs"),
    `import { appendFileSync } from "node:fs";
appendFileSync(process.env.A2D2_FIXTURE_LOG, "cloud " + process.argv.slice(2).join(" ") + "\\n");`,
  );
  return {
    root,
    log,
    env: {
      A2D2_FIXTURE_LOG: log,
      A2D2_FIXTURE_MODE: mode,
      A2D2_FIXTURE_TARGET: target,
      PATH: `${bin}:${process.env.PATH}`,
    },
  };
}

test("production recipe builds locked sidecars, verifies copies, freezes JS deps, then builds the normal app", () => {
  const run = fixture("good");
  try {
    runA2d2ReleaseBuild(target, { repoRoot: run.root, env: run.env });
    const log = readFileSync(run.log, "utf8");
    assert.match(log, /cargo build --release --locked --target/);
    for (const name of [
      "buzz-acp",
      "buzz-agent",
      "buzz-backend-kubernetes",
      "buzz-dev-mcp",
      "git-credential-nostr",
      "buzz-cli",
    ]) {
      assert.match(log, new RegExp(`-p ${name}(?: |\\n)`));
    }
    assert.match(log, /bundle aarch64-apple-darwin/);
    assert.match(log, /pnpm install --frozen-lockfile/);
    assert.match(
      log,
      /cloud --exec .*tauri-command\.mjs build --features mesh-llm/,
    );
    assert.match(log, /--target aarch64-apple-darwin --bundles app/);
  } finally {
    rmSync(run.root, { recursive: true, force: true });
  }
});

for (const mode of ["zero", "stale"]) {
  test(`production recipe rejects ${mode} bundled sidecars before dependency install`, () => {
    const run = fixture(mode);
    try {
      assert.throws(
        () => runA2d2ReleaseBuild(target, { repoRoot: run.root, env: run.env }),
        new RegExp(mode === "zero" ? "empty" : "stale"),
      );
      const log = readFileSync(run.log, "utf8");
      assert.doesNotMatch(log, /pnpm|cloud/);
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  });
}
