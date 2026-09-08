// 실제 Chromium 68 로 빌드 산출물을 검증하는 러너.
// 최신 Playwright 크로미움은 크롬 68 의 증거가 못 되므로(TV = webOS 5.x),
// 옛 스냅샷(Mac/561733 = 68.0.3440.0)을 헤드리스로 띄워 CDP 원명령으로
// 방향키·Enter·Escape 를 보내고 스크린샷을 남긴다.
//
// 사용법:
//   node scripts/verify-chrome68.mjs <Chromium.app 실행파일> <앱 URL> <스크린샷 폴더>
// 전제: pnpm build && pnpm preview (빌드 산출물 검증이 목적 — dev 서버는
// 트랜스파일 전 코드라 증거가 안 된다) + pnpm mock-relay.
// 스냅샷 출처: https://commondatastorage.googleapis.com/chromium-browser-snapshots/Mac/561733/chrome-mac.zip

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import WebSocket from "ws";

const [chromiumBin, appUrl, shotDir] = process.argv.slice(2);
if (!chromiumBin || !appUrl || !shotDir) {
  console.error(
    "사용법: verify-chrome68.mjs <chromium 실행파일> <URL> <스크린샷 폴더>",
  );
  process.exit(1);
}
fs.mkdirSync(shotDir, { recursive: true });

const DEBUG_PORT = 9268;
const chromium = spawn(
  "arch",
  [
    "-x86_64",
    chromiumBin,
    "--headless",
    "--disable-gpu",
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--window-size=1920,1080",
    "--no-first-run",
    "--user-data-dir=/tmp/chrome68-profile",
    appUrl,
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve(JSON.parse(body)));
      })
      .on("error", reject);
  });
}

let ws;
let msgId = 0;
const pending = new Map();
const exceptions = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    msgId += 1;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

async function evaluate(expression) {
  const { result } = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  return result.value;
}

async function waitFor(expression, label, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await evaluate(expression)) return;
    await sleep(300);
  }
  throw new Error(`대기 시간 초과: ${label}`);
}

// CDP 원명령 키 입력 (rawKeyDown → keyUp). 크롬 68 CDP 에 이미 있는 명령만 쓴다.
async function pressKey(key, keyCode) {
  const base = {
    key,
    code: key.startsWith("Arrow") ? key : key,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  };
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(400);
}

async function screenshot(name) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(shotDir, name), Buffer.from(data, "base64"));
  console.log(`  📸 ${name}`);
}

async function main() {
  // 디버그 포트가 열릴 때까지 대기
  let targets = null;
  for (let i = 0; i < 40; i++) {
    try {
      targets = await getJson(`http://localhost:${DEBUG_PORT}/json`);
      if (targets.length > 0) break;
    } catch {
      // 아직 안 떴다
    }
    await sleep(500);
  }
  if (!targets || targets.length === 0) {
    throw new Error("Chromium 68 디버그 포트에 연결 못 함");
  }
  const page = targets.find((t) => t.type === "page") ?? targets[0];
  console.log("연결:", page.title || page.url);

  ws = new WebSocket(page.webSocketDebuggerUrl, {
    maxPayload: 64 * 1024 * 1024,
  });
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method === "Runtime.exceptionThrown") {
      exceptions.push(
        msg.params.exceptionDetails.exception?.description ??
          msg.params.exceptionDetails.text,
      );
    }
  });

  await send("Runtime.enable");
  await send("Page.enable");

  const ua = await evaluate("navigator.userAgent");
  console.log("UA:", ua);
  if (!/Chrome\/68\./.test(ua)) {
    throw new Error("크롬 68 이 아니다 — 증거가 안 된다");
  }

  // 앱 URL 로 이동(해시 포함 새 로드)
  await send("Page.navigate", { url: appUrl });

  // 1) 채널 목록
  await waitFor(
    "!!document.querySelector('[data-testid=\"channel-list-screen\"]') && document.body.textContent.indexOf('general') !== -1",
    "채널 목록",
  );
  await screenshot("c68-01-channels.png");

  // 2) Enter → 타임라인 (첫 채널 autoFocus)
  await pressKey("Enter", 13);
  await waitFor(
    "!!document.querySelector('[data-testid=\"timeline-screen\"]') && document.body.textContent.indexOf('첫 메시지') !== -1",
    "타임라인",
  );
  // 포커스가 실제로 잡혔는지(5-way 규칙)
  await waitFor(
    "!!document.querySelector('.focusable.focused')",
    "타임라인 포커스",
  );
  await screenshot("c68-02-timeline.png");

  // 3) 위 방향키 → 포커스 이동 확인
  const before = await evaluate(
    "(document.querySelector('.focusable.focused')||{}).textContent||''",
  );
  await pressKey("ArrowUp", 38);
  const after = await evaluate(
    "(document.querySelector('.focusable.focused')||{}).textContent||''",
  );
  if (before === after) throw new Error("방향키로 포커스가 안 움직였다");
  console.log("  ↑ 포커스 이동 확인");

  // 4) 뒤로가기(Escape=개발용 461 겸용) → 채널 목록
  await pressKey("Escape", 27);
  await waitFor(
    "!!document.querySelector('[data-testid=\"channel-list-screen\"]')",
    "채널 목록 복귀",
  );

  // 5) ↑ → Docs 버튼 → Enter → Docs 목록
  await pressKey("ArrowUp", 38);
  await pressKey("Enter", 13);
  await waitFor(
    "!!document.querySelector('[data-testid=\"docs-list-screen\"]') && document.body.textContent.indexOf('시작하기') !== -1",
    "Docs 목록",
  );
  await screenshot("c68-03-docs.png");

  // 6) Enter → 문서 뷰어 (마크다운 표 렌더 확인)
  await pressKey("Enter", 13);
  await waitFor(
    "!!document.querySelector('[data-testid=\"doc-viewer-screen\"]') && !!document.querySelector('.markdown table')",
    "문서 뷰어",
  );
  await screenshot("c68-04-doc-viewer.png");

  // 7) 루트까지 뒤로 → 종료 확인 대화상자
  await pressKey("Escape", 27);
  await pressKey("Escape", 27);
  await pressKey("Escape", 27);
  await waitFor(
    "!!document.querySelector('[data-testid=\"exit-dialog\"]')",
    "종료 확인",
  );
  await screenshot("c68-05-exit-dialog.png");

  if (exceptions.length > 0) {
    console.error("잡힌 예외:", exceptions.slice(0, 5));
    throw new Error(`페이지 예외 ${exceptions.length}건`);
  }
  console.log("Chromium 68 실엔진 검증 통과 ✅");
}

main()
  .then(() => {
    chromium.kill();
    process.exit(0);
  })
  .catch((error) => {
    console.error("실패:", error.message);
    chromium.kill();
    process.exit(1);
  });
