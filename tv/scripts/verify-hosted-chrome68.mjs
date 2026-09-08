// Secret Manager 값을 파일이나 argv에 쓰지 않고 verify-chrome68 자식의
// 환경변수로만 넘기는 hosted 검증 진입점. stdout은 자식의 allowlist JSON뿐이다.

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const [chromiumBin, appUrl, shotDir] = args;
if (!chromiumBin || !appUrl || !shotDir) {
  console.error(
    "사용법: node scripts/verify-hosted-chrome68.mjs <Chromium 실행파일> <앱 URL> <스크린샷 폴더>",
  );
  process.exit(1);
}

const account = runGcloud(["config", "get", "account"]);
if (account.trim() !== "cs@ailex.co.kr") {
  console.error("활성 gcloud 계정이 cs@ailex.co.kr가 아닙니다");
  process.exit(1);
}

const rawSecret = runGcloud([
  "secrets",
  "versions",
  "access",
  "latest",
  "--secret",
  "a2d2-buzz-tv-viewer-env",
  "--project",
  "a2d2-lab",
]);
const secretEnv = parseSecretEnv(rawSecret);
if (secretEnv.BUZZ_RELAY_URL !== "wss://buzz.a2d2lab.com") {
  console.error("Secret Manager의 릴레이 주소가 기대값과 다릅니다");
  process.exit(1);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(
  process.execPath,
  [path.join(scriptDir, "verify-chrome68.mjs"), chromiumBin, appUrl, shotDir],
  {
    env: { ...process.env, ...secretEnv },
    stdio: "inherit",
  },
);

child.once("error", () => {
  console.error("Chromium 68 검증 자식을 시작하지 못했습니다");
  process.exit(1);
});
child.once("exit", (code) => process.exit(code ?? 1));

function runGcloud(args) {
  const result = spawnSync("gcloud", args, {
    encoding: "utf8",
    maxBuffer: 4096,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    console.error("gcloud 조회에 실패했습니다");
    process.exit(1);
  }
  return result.stdout;
}

function parseSecretEnv(raw) {
  const allowed = new Set(["BUZZ_RELAY_URL", "BUZZ_PRIVATE_KEY"]);
  const parsed = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      console.error("Secret Manager env 형식이 올바르지 않습니다");
      process.exit(1);
    }
    const name = line.slice(0, separator);
    if (!allowed.has(name) || Object.hasOwn(parsed, name)) {
      console.error("Secret Manager env 키 구성이 올바르지 않습니다");
      process.exit(1);
    }
    parsed[name] = line.slice(separator + 1);
  }
  if (
    Object.keys(parsed).length !== allowed.size ||
    !/^wss?:\/\//.test(parsed.BUZZ_RELAY_URL ?? "") ||
    !/^[0-9a-f]{64}$/i.test(parsed.BUZZ_PRIVATE_KEY ?? "")
  ) {
    console.error("Secret Manager env 값 구성이 올바르지 않습니다");
    process.exit(1);
  }
  return parsed;
}
