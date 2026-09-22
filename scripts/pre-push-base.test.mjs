import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const resolver = path.join(repoRoot, "scripts/resolve-pre-push-base.sh");
const listFiles = path.join(repoRoot, "scripts/list-pre-push-files.sh");
const branchSkew = path.join(repoRoot, "scripts/check-branch-skew.sh");

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

function command(cwd, executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: cleanEnv,
    ...options,
  }).trim();
}

function git(cwd, ...args) {
  return command(cwd, "git", ["-c", "core.hooksPath=/dev/null", ...args]);
}

function run(cwd, script, args = []) {
  return spawnSync("bash", [script, ...args], {
    cwd,
    encoding: "utf8",
    env: cleanEnv,
  });
}

function commitFile(repo, relativePath, content, message) {
  const filePath = path.join(repo, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  git(repo, "add", relativePath);
  git(repo, "commit", "-m", message);
}

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pre-push-base-"));
  const repo = path.join(root, "repo");
  const origin = path.join(root, "origin.git");
  const personal = path.join(root, "personal.git");
  mkdirSync(repo);
  git(root, "init", "--bare", "-b", "main", origin);
  git(root, "init", "--bare", "-b", "main", personal);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Pre-push Test");
  git(repo, "config", "user.email", "pre-push@example.com");
  commitFile(repo, "shared.txt", "base\n", "base");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "remote", "add", "personal", personal);
  git(repo, "push", "-u", "origin", "main");
  git(repo, "push", "personal", "main:refs/heads/integration");
  git(
    repo,
    "fetch",
    "personal",
    "refs/heads/integration:refs/remotes/personal/integration",
  );
  git(repo, "switch", "-c", "feature");
  return { root, repo, origin, personal };
}

function updatePersonal({ root, personal }, relativePath, content) {
  const updater = path.join(root, "updater");
  git(root, "clone", personal, updater);
  git(updater, "config", "user.name", "Integration Test");
  git(updater, "config", "user.email", "integration@example.com");
  git(updater, "switch", "integration");
  commitFile(updater, relativePath, content, "advance integration");
  git(updater, "push", "origin", "integration");
  return git(updater, "rev-parse", "HEAD");
}

test("default base remains origin/main and all path gates share its merge base", () => {
  const { repo } = createFixture();
  commitFile(repo, "feature.txt", "feature\n", "feature");

  const resolved = run(repo, resolver);
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(resolved.stdout.trim(), "refs/remotes/origin/main");

  const files = run(repo, listFiles);
  assert.equal(files.status, 0, files.stderr);
  assert.deepEqual(files.stdout.trim().split("\n"), ["feature.txt"]);

  const mergeBase = run(repo, resolver, ["--merge-base"]);
  assert.equal(mergeBase.status, 0, mergeBase.stderr);
  assert.equal(
    mergeBase.stdout.trim(),
    git(repo, "merge-base", "HEAD", "origin/main"),
  );
  assert.equal(run(repo, branchSkew).status, 0);
});

test("configured personal remote base is refreshed and scopes feature files", () => {
  const fixture = createFixture();
  const { repo } = fixture;
  commitFile(repo, "feature.txt", "feature\n", "feature");
  git(
    repo,
    "config",
    "branch.feature.base",
    "refs/remotes/personal/integration",
  );
  const remoteTip = updatePersonal(fixture, "integration-only.txt", "remote\n");
  assert.notEqual(git(repo, "rev-parse", "personal/integration"), remoteTip);

  const resolved = run(repo, resolver, ["--fetch"]);
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(resolved.stdout.trim(), "refs/remotes/personal/integration");
  assert.equal(git(repo, "rev-parse", "personal/integration"), remoteTip);

  const files = run(repo, listFiles);
  assert.equal(files.status, 0, files.stderr);
  assert.deepEqual(files.stdout.trim().split("\n"), ["feature.txt"]);
  assert.equal(run(repo, branchSkew).status, 0);
});

test("configured base overlap still blocks the push", () => {
  const fixture = createFixture();
  const { repo } = fixture;
  commitFile(repo, "shared.txt", "feature\n", "feature changes shared");
  git(
    repo,
    "config",
    "branch.feature.base",
    "refs/remotes/personal/integration",
  );
  updatePersonal(fixture, "shared.txt", "integration\n");

  const result = run(repo, branchSkew);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refs\/remotes\/personal\/integration/);
  assert.match(result.stderr, /shared\.txt/);
});

test("invalid, missing, and HEAD-equivalent configured bases fail closed", () => {
  const { repo } = createFixture();
  commitFile(repo, "feature.txt", "feature\n", "feature");

  git(repo, "config", "branch.feature.base", "origin/main");
  let result = run(repo, resolver);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /full refs\/heads/);

  git(repo, "config", "branch.feature.base", "refs/remotes/personal/missing");
  result = run(repo, resolver);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing or is not a commit/);

  git(repo, "update-ref", "refs/heads/not-a-base", "HEAD");
  git(repo, "config", "branch.feature.base", "refs/heads/not-a-base");
  result = run(repo, resolver);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /resolves to HEAD/);
});

test("detached HEAD preserves the origin/main default for scoped lanes", () => {
  const { repo } = createFixture();
  commitFile(repo, "feature.txt", "feature\n", "feature");
  git(repo, "checkout", "--detach", "HEAD");

  const resolved = run(repo, resolver);
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(resolved.stdout.trim(), "refs/remotes/origin/main");
  const files = run(repo, listFiles);
  assert.equal(files.status, 0, files.stderr);
  assert.deepEqual(files.stdout.trim().split("\n"), ["feature.txt"]);
});

test("lefthook scopes every lane and file-size ratchet through the resolver", () => {
  const lefthook = readFileSync(path.join(repoRoot, "lefthook.yml"), "utf8");
  assert.equal(
    [...lefthook.matchAll(/files: \.\/scripts\/list-pre-push-files\.sh/g)]
      .length,
    6,
  );
  assert.match(lefthook, /run: \.\/scripts\/run-pre-push-file-size-check\.sh/);
  assert.doesNotMatch(lefthook, /files: git diff --name-only origin\/main/);

  const fileSizeWrapper = readFileSync(
    path.join(repoRoot, "scripts/run-pre-push-file-size-check.sh"),
    "utf8",
  );
  assert.match(fileSizeWrapper, /resolve-pre-push-base\.sh["']? --merge-base/);
  assert.match(fileSizeWrapper, /CHECK_FILE_SIZES_BASE=\$merge_base/);
});
