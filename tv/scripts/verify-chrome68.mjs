// 실제 Chromium 68 로 hosted 빌드와 실제 Buzz 릴레이를 검증하는 러너.
// 개인키는 BUZZ_PRIVATE_KEY 환경변수로만 받고, CDP 문서 초기화 스크립트로
// 페이지 메모리에 한 번 전달한다. URL, argv, 로그, 웹 저장소에는 넣지 않는다.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { getPublicKey } from "nostr-tools/pure";
import WebSocket from "ws";

const [chromiumBin, rawAppUrl, shotDir] = process.argv.slice(2);
if (!chromiumBin || !rawAppUrl || !shotDir) {
  console.error(
    "사용법: BUZZ_PRIVATE_KEY=… BUZZ_RELAY_URL=… node scripts/verify-chrome68.mjs <Chromium 실행파일> <앱 URL> <스크린샷 폴더>",
  );
  process.exit(1);
}

const privateKey = process.env.BUZZ_PRIVATE_KEY ?? "";
const relayUrl = process.env.BUZZ_RELAY_URL ?? "";
if (!/^[0-9a-f]{64}$/i.test(privateKey)) {
  console.error("BUZZ_PRIVATE_KEY 환경변수가 없거나 올바르지 않습니다");
  process.exit(1);
}
if (!/^wss?:\/\//.test(relayUrl)) {
  console.error("BUZZ_RELAY_URL 환경변수가 없거나 올바르지 않습니다");
  process.exit(1);
}

const EXPECTED = Object.freeze({
  viewerPubkey: requiredEnv("TV_EXPECTED_VIEWER_PUBKEY"),
  channelId: requiredEnv("TV_EXPECTED_CHANNEL_ID"),
  channelEventId: requiredEnv("TV_EXPECTED_CHANNEL_EVENT_ID"),
  channelName: requiredEnv("TV_EXPECTED_CHANNEL_NAME"),
  channelAbout: requiredEnv("TV_EXPECTED_CHANNEL_ABOUT"),
  messageId: requiredEnv("TV_EXPECTED_MESSAGE_ID"),
  messageContent: requiredEnv("TV_EXPECTED_MESSAGE_CONTENT"),
  docId: requiredEnv("TV_EXPECTED_DOC_ID"),
  docEventId: requiredEnv("TV_EXPECTED_DOC_EVENT_ID"),
  docTitle: requiredEnv("TV_EXPECTED_DOC_TITLE"),
  docBody: requiredEnv("TV_EXPECTED_DOC_BODY"),
});

let appUrl;
try {
  appUrl = new URL(rawAppUrl);
} catch {
  console.error("앱 URL이 올바르지 않습니다");
  process.exit(1);
}
if (appUrl.hash || appUrl.searchParams.has("key")) {
  console.error("앱 URL에는 개인키나 해시를 넣을 수 없습니다");
  process.exit(1);
}

const viewerPubkey = getPublicKey(hexToBytes(privateKey));
if (viewerPubkey !== EXPECTED.viewerPubkey) {
  console.error("관전 키의 공개키가 기대값과 다릅니다");
  process.exit(1);
}

const prefix = process.env.TV_SCREENSHOT_PREFIX ?? "relay";
if (!/^[a-z0-9-]+$/.test(prefix)) {
  console.error("TV_SCREENSHOT_PREFIX가 올바르지 않습니다");
  process.exit(1);
}

fs.mkdirSync(shotDir, { recursive: true });
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "buzz-tv-chrome68-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let chromium = null;
let ws = null;
let msgId = 0;
const pending = new Map();
let pageExceptionCount = 0;
let consoleErrorCount = 0;
let currentStage = "startup";
const pageExceptions = [];
const observed = {
  authChallenge: false,
  authResponse: false,
  authAccepted: false,
  channelEvent: false,
  messageEvent: false,
  docEvent: false,
};

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`필수 환경변수가 없습니다: ${name}`);
    process.exit(1);
  }
  return value;
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error("debug_target_response_invalid"));
          }
        });
      })
      .on("error", () => reject(new Error("debug_target_unavailable")));
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => reject(new Error("debug_port_unavailable")));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    msgId += 1;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error("runtime_evaluation_failed");
  return response.result.value;
}

async function waitFor(expression, code, timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(expression)) return;
    await sleep(300);
  }
  throw new Error(code);
}

async function pressKey(key, keyCode, code = key) {
  const base = {
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  };
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(350);
}

async function pressBack() {
  await pressKey("GoBack", 461, "BrowserBack");
}

async function focusedAttribute(name) {
  return evaluate(
    `(document.querySelector('.focusable.focused')||{getAttribute:function(){return null}}).getAttribute(${JSON.stringify(name)})`,
  );
}

async function moveFocusTo(attribute, value, keys, maxSteps = 40) {
  let steps = 0;
  for (const key of keys) {
    const keyCode = key === "ArrowDown" ? 40 : key === "ArrowUp" ? 38 : 37;
    for (let index = 0; index < maxSteps; index += 1) {
      if ((await focusedAttribute(attribute)) === value) return steps;
      await pressKey(key, keyCode);
      steps += 1;
    }
  }
  throw new Error("focus_target_not_reached");
}

async function screenshot(name) {
  const filename = `${prefix}-${name}.png`;
  const result = await send("Page.captureScreenshot", { format: "png" });
  const bytes = Buffer.from(result.data, "base64");
  fs.writeFileSync(path.join(shotDir, filename), bytes);
  return {
    filename,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function inspectWebSocketFrame(method, params) {
  const raw = params?.response?.payloadData;
  if (typeof raw !== "string") return;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(data)) return;
  const type = data[0];
  if (method === "Network.webSocketFrameReceived" && type === "AUTH") {
    observed.authChallenge = true;
    return;
  }
  if (method === "Network.webSocketFrameSent" && type === "AUTH") {
    observed.authResponse = Boolean(data[1]?.id);
    return;
  }
  if (
    method === "Network.webSocketFrameReceived" &&
    type === "OK" &&
    data[2] === true
  ) {
    observed.authAccepted = true;
    return;
  }
  if (
    method !== "Network.webSocketFrameReceived" ||
    type !== "EVENT" ||
    !data[2]
  ) {
    return;
  }
  const event = data[2];
  if (
    event.id === EXPECTED.channelEventId &&
    event.kind === 39000 &&
    hasTag(event, "d", EXPECTED.channelId) &&
    hasTag(event, "name", EXPECTED.channelName) &&
    hasTag(event, "about", EXPECTED.channelAbout)
  ) {
    observed.channelEvent = true;
  }
  if (
    event.id === EXPECTED.messageId &&
    (event.kind === 9 || event.kind === 40002) &&
    event.content === EXPECTED.messageContent &&
    hasTag(event, "h", EXPECTED.channelId)
  ) {
    observed.messageEvent = true;
  }
  if (
    event.id === EXPECTED.docEventId &&
    event.kind === 30623 &&
    hasTag(event, "d", `doc:${EXPECTED.docId}`) &&
    hasTag(event, "t", "community-doc")
  ) {
    try {
      const content = JSON.parse(event.content);
      observed.docEvent =
        content.title === EXPECTED.docTitle &&
        content.body === EXPECTED.docBody;
    } catch {
      observed.docEvent = false;
    }
  }
}

function hasTag(event, name, value) {
  return Array.isArray(event.tags)
    ? event.tags.some((tag) => tag[0] === name && tag[1] === value)
    : false;
}

function recordPageException(details) {
  pageExceptionCount += 1;
  const className = details?.exception?.className;
  const allowedClassNames = new Set([
    "Error",
    "TypeError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "URIError",
  ]);
  const frames = Array.isArray(details?.stackTrace?.callFrames)
    ? details.stackTrace.callFrames.slice(0, 5).map((frame) => ({
        functionName:
          typeof frame.functionName === "string" &&
          /^[A-Za-z0-9_$<>. -]{0,80}$/.test(frame.functionName)
            ? frame.functionName
            : "unknown",
        source: safeSource(frame.url),
        line: Number.isInteger(frame.lineNumber) ? frame.lineNumber : null,
        column: Number.isInteger(frame.columnNumber)
          ? frame.columnNumber
          : null,
      }))
    : [];
  const description =
    typeof details?.exception?.description === "string"
      ? details.exception.description
      : "";
  pageExceptions.push({
    stage: currentStage,
    className: allowedClassNames.has(className) ? className : "unknown",
    source: safeSource(details?.url),
    line: Number.isInteger(details?.lineNumber) ? details.lineNumber : null,
    column: Number.isInteger(details?.columnNumber)
      ? details.columnNumber
      : null,
    descriptionSha256: createHash("sha256").update(description).digest("hex"),
    frames,
  });
}

function safeSource(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

async function attach(debugPort) {
  let targets = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      targets = await getJson(`http://127.0.0.1:${debugPort}/json`);
      if (Array.isArray(targets) && targets.length > 0) break;
    } catch {
      // Chromium 이 디버그 포트를 열 때까지 기다린다.
    }
    await sleep(500);
  }
  if (!targets?.length) throw new Error("chromium_debug_target_missing");
  const page = targets.find((target) => target.type === "page") ?? targets[0];
  ws = new WebSocket(page.webSocketDebuggerUrl, {
    maxPayload: 64 * 1024 * 1024,
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", () => reject(new Error("cdp_connection_failed")));
  });
  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.id && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error("cdp_command_failed"));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      recordPageException(message.params?.exceptionDetails);
    } else if (
      message.method === "Runtime.consoleAPICalled" &&
      message.params?.type === "error"
    ) {
      consoleErrorCount += 1;
    }
    inspectWebSocketFrame(message.method, message.params);
  });
}

async function verify() {
  currentStage = "launch";
  const debugPort = await getFreePort();
  chromium = spawn(
    "arch",
    [
      "-x86_64",
      chromiumBin,
      "--headless",
      "--disable-gpu",
      `--remote-debugging-port=${debugPort}`,
      "--window-size=1920,1080",
      "--no-first-run",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  await attach(debugPort);
  await Promise.all([
    send("Runtime.enable"),
    send("Page.enable"),
    send("Network.enable"),
  ]);
  const version = await send("Browser.getVersion");
  if (!/^(?:Headless)?Chrome\/68\./.test(version.product ?? "")) {
    throw new Error("wrong_chromium_version");
  }

  const bootstrap = JSON.stringify({
    relayUrl,
    secretKeyHex: privateKey,
  });
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `Object.defineProperty(window,"__BUZZ_TV_SESSION__",{configurable:true,writable:true,value:${bootstrap}});`,
  });
  currentStage = "navigate";
  await send("Page.navigate", { url: appUrl.toString() });

  currentStage = "channels";
  await waitFor(
    `!!document.querySelector('[data-testid="channel-list-screen"]') && !!Array.from(document.querySelectorAll('[data-channel-id]')).find(function(el){return el.getAttribute('data-channel-id')===${JSON.stringify(EXPECTED.channelId)} && el.textContent.indexOf(${JSON.stringify(EXPECTED.channelName)})!==-1})`,
    "channel_screen_missing",
  );
  await waitFor(
    "!!document.querySelector('.focusable.focused')",
    "channel_focus_missing",
  );
  const screenshots = [await screenshot("01-channels")];

  const channelFocusSteps = await moveFocusTo(
    "data-channel-id",
    EXPECTED.channelId,
    ["ArrowDown", "ArrowUp"],
  );
  currentStage = "open-timeline";
  await pressKey("Enter", 13);
  currentStage = "timeline";
  await waitFor(
    `!!document.querySelector('[data-testid="timeline-screen"]') && !!document.querySelector('[data-event-id=${JSON.stringify(EXPECTED.messageId)}]')`,
    "timeline_event_missing",
  );
  await waitFor(
    "!!document.querySelector('.focusable.focused')",
    "timeline_focus_missing",
  );
  const timelineFocusBefore = await focusedAttribute("data-event-id");
  await pressKey("ArrowUp", 38);
  const timelineFocusAfter = await focusedAttribute("data-event-id");
  if (
    (await evaluate("document.querySelectorAll('[data-event-id]').length")) >
      1 &&
    timelineFocusBefore === timelineFocusAfter
  ) {
    throw new Error("timeline_arrow_navigation_failed");
  }
  screenshots.push(await screenshot("02-timeline"));

  currentStage = "back-to-channels";
  await pressBack();
  await waitFor(
    "!!document.querySelector('[data-testid=\"channel-list-screen\"]')",
    "channel_back_failed",
  );
  const docsFocusSteps = await moveFocusTo("data-testid", "open-docs", [
    "ArrowUp",
    "ArrowLeft",
  ]);
  currentStage = "open-docs";
  await pressKey("Enter", 13);
  currentStage = "docs";
  await waitFor(
    `!!document.querySelector('[data-testid="docs-list-screen"]') && !!document.querySelector('[data-doc-id=${JSON.stringify(EXPECTED.docId)}][data-doc-event-id=${JSON.stringify(EXPECTED.docEventId)}]')`,
    "docs_event_missing",
  );
  const docFocusSteps = await moveFocusTo("data-doc-id", EXPECTED.docId, [
    "ArrowDown",
    "ArrowUp",
  ]);
  screenshots.push(await screenshot("03-docs"));

  currentStage = "open-doc-viewer";
  await pressKey("Enter", 13);
  currentStage = "doc-viewer";
  await waitFor(
    `!!document.querySelector('[data-testid="doc-viewer-screen"][data-doc-id=${JSON.stringify(EXPECTED.docId)}][data-doc-event-id=${JSON.stringify(EXPECTED.docEventId)}]') && document.querySelector('[data-testid="doc-viewer-screen"]').textContent.indexOf(${JSON.stringify(EXPECTED.docTitle)})!==-1`,
    "doc_viewer_missing",
  );
  await pressKey("ArrowDown", 40);
  screenshots.push(await screenshot("04-doc-viewer"));

  currentStage = "back-from-doc-viewer";
  await pressBack();
  await waitFor(
    "!!document.querySelector('[data-testid=\"docs-list-screen\"]')",
    "docs_back_failed",
  );
  currentStage = "back-to-root";
  await pressBack();
  await waitFor(
    "!!document.querySelector('[data-testid=\"channel-list-screen\"]')",
    "root_back_failed",
  );
  currentStage = "exit-dialog";
  await pressBack();
  await waitFor(
    "!!document.querySelector('[data-testid=\"exit-dialog\"]')",
    "exit_dialog_missing",
  );
  screenshots.push(await screenshot("05-exit-dialog"));

  if (!Object.values(observed).every(Boolean)) {
    throw new Error("relay_evidence_incomplete");
  }
  if (pageExceptionCount !== 0 || consoleErrorCount !== 0) {
    throw new Error("browser_error_detected");
  }

  currentStage = "storage-check";
  const storageSafe = await evaluate(`(function(){
    var needle=${JSON.stringify(privateKey)};
    var values=[];
    for(var i=0;i<localStorage.length;i+=1){values.push(localStorage.getItem(localStorage.key(i))||'');}
    for(var j=0;j<sessionStorage.length;j+=1){values.push(sessionStorage.getItem(sessionStorage.key(j))||'');}
    return location.href.indexOf(needle)===-1 && values.every(function(value){return value.indexOf(needle)===-1;}) && typeof globalThis.__BUZZ_TV_SESSION__==='undefined';
  })()`);
  if (!storageSafe) throw new Error("private_key_persistence_detected");

  const hashes = screenshots.map((item) => item.sha256);
  if (new Set(hashes).size !== hashes.length) {
    throw new Error("duplicate_screenshots_detected");
  }

  return {
    status: "passed",
    chromium: version.product,
    appOrigin: appUrl.origin,
    appPath: appUrl.pathname,
    relayOrigin: new URL(relayUrl).origin,
    viewerPubkey,
    authenticated: observed.authAccepted,
    authChallengeReceived: observed.authChallenge,
    authResponseSent: observed.authResponse,
    channel: {
      id: EXPECTED.channelId,
      eventId: EXPECTED.channelEventId,
      name: EXPECTED.channelName,
      about: EXPECTED.channelAbout,
      exactEventMatched: observed.channelEvent,
      exactAboutMatched: observed.channelEvent,
    },
    message: {
      id: EXPECTED.messageId,
      content: EXPECTED.messageContent,
      exactContentMatched: observed.messageEvent,
    },
    doc: {
      id: EXPECTED.docId,
      eventId: EXPECTED.docEventId,
      title: EXPECTED.docTitle,
      body: EXPECTED.docBody,
      kind: 30623,
      exactContentMatched: observed.docEvent,
    },
    navigation: {
      channelFocusSteps,
      timelineArrowMoved: timelineFocusBefore !== timelineFocusAfter,
      docsFocusSteps,
      docFocusSteps,
      enter: true,
      webOsBack461: true,
    },
    pageExceptionCount,
    pageExceptions,
    consoleErrorCount,
    privateKeyAbsentFromUrlAndWebStorage: storageSafe,
    screenshotHashesDistinct: true,
    screenshots,
  };
}

async function cleanup() {
  try {
    ws?.close();
  } catch {
    // 이미 닫혔다.
  }
  if (chromium && chromium.exitCode === null) {
    chromium.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => chromium.once("exit", resolve)),
      sleep(2_000),
    ]);
    if (chromium.exitCode === null) chromium.kill("SIGKILL");
  }
  fs.rmSync(profileDir, { recursive: true, force: true });
}

let evidence;
let failureCode = null;
try {
  evidence = await verify();
} catch (error) {
  failureCode = error instanceof Error ? error.message : "unknown_failure";
} finally {
  await cleanup();
}

if (failureCode) {
  console.error(
    JSON.stringify({
      status: "failed",
      failureCode,
      observed,
      pageExceptionCount,
      pageExceptions,
      consoleErrorCount,
      ephemeralProfileRemoved: !fs.existsSync(profileDir),
    }),
  );
  process.exit(1);
}

evidence.ephemeralProfileRemoved = !fs.existsSync(profileDir);
console.log(JSON.stringify(evidence, null, 2));
