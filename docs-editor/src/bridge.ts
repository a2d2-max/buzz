import { mountEditor, type EditorInput } from "./editor";
import "./style.css";
import { createAsyncRecoveryJournal } from "./asyncRecoveryJournal";

const protocol = "a2d2.docs.editor.v1";
const nonce = location.hash.slice(1);
const origin = location.origin;
const targetOrigin = origin === "null" ? "*" : origin;
const container = document.getElementById("editor");
const status = document.getElementById("status");
if (!container || !status) throw Error("Missing editor host.");
let editor: Awaited<ReturnType<typeof mountEditor>> | undefined;
container.addEventListener("a2d2-open-linked-database", (event) => {
  if (event instanceof CustomEvent)
    send({ type: "open-database", ...event.detail });
});
let initialized = false;
let generation = 0;
let changed = false;
let journal: ReturnType<typeof createAsyncRecoveryJournal> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
const send = (message: Record<string, unknown>) =>
  parent.postMessage({ protocol, nonce, ...message }, targetOrigin);
const report = (error: unknown, requestId?: string) =>
  send({
    type: "error",
    requestId,
    message:
      error instanceof Error
        ? error.message
        : "Unable to open or save this document.",
  });
let runtimeError: Error | undefined;
function failRuntime(cause: unknown) {
  runtimeError = cause instanceof Error ? cause : new Error(String(cause));
  report(runtimeError);
}
window.addEventListener("error", (event) => {
  if (event.message) failRuntime(event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) =>
  failRuntime(event.reason),
);
async function snapshot(requestId?: string) {
  if (runtimeError) throw runtimeError;
  if (!editor || !journal) throw Error("Editor is still loading.");
  const current = generation;
  for (let attempt = 0; attempt < 3; attempt++) {
    const revision = journal.revision;
    const draft = await editor.snapshot();
    if (generation !== current) return;
    if (!(await journal.preview(draft, revision))) continue;
    send({ type: "draft", requestId, draft, changed, revision });
    return;
  }
  throw Error("Document changed during saving. Please retry.");
}
function onChanged() {
  changed = true;
  try {
    if (journal && editor)
      void journal
        .record(editor.recoverySnapshot())
        .catch((error) => report(error));
  } catch (error) {
    report(error);
  }
  send({ type: "dirty" });
  clearTimeout(timer);
  timer = setTimeout(() => {
    void snapshot().catch((error) => report(error));
  }, 300);
}
window.addEventListener("message", (event) => {
  if (
    event.source !== parent ||
    event.origin !== origin ||
    !event.data ||
    event.data.protocol !== protocol ||
    event.data.nonce !== nonce
  )
    return;
  const message = event.data;
  void (async () => {
    if (message.type === "init" && !initialized) {
      const input = message.input as EditorInput;
      if (
        !input ||
        typeof input.id !== "string" ||
        input.id.length > 256 ||
        typeof input.title !== "string" ||
        typeof input.body !== "string" ||
        input.body.length > 32 * 1024 * 1024
      )
        throw Error("Invalid document input.");
      if (
        typeof message.backupKey !== "string" ||
        !message.backupKey.startsWith("buzz.docs.affine-backup.v1.")
      )
        throw Error("Missing recovery storage scope.");
      journal = createAsyncRecoveryJournal(message.backupKey, nonce);
      initialized = true;
      editor = await mountEditor(container, input, onChanged);
      status.textContent = "";
      send({ type: "mounted" });
    } else if (message.type === "attach-database") {
      editor?.attachDatabase(message.reference);
    } else if (
      message.type === "database-view" &&
      typeof message.blockId === "string"
    ) {
      editor?.selectDatabaseView(message.blockId, message.reference);
    } else if (
      message.type === "saved" &&
      Number.isSafeInteger(message.revision) &&
      typeof message.data === "string"
    ) {
      await journal?.acknowledge(message.revision, message.data);
    } else if (
      message.type === "snapshot" &&
      typeof message.requestId === "string"
    ) {
      clearTimeout(timer);
      await snapshot(message.requestId);
    } else if (
      message.type === "mode" &&
      (message.mode === "page" || message.mode === "edgeless")
    ) {
      editor?.setMode(message.mode);
    }
  })().catch((error) => report(error, message.requestId));
});
window.addEventListener(
  "pagehide",
  () => {
    generation++;
    clearTimeout(timer);
    editor?.dispose();
  },
  { once: true },
);
if (parent !== window && /^[a-zA-Z0-9-]{16,64}$/.test(nonce)) {
  send({ type: "ready" });
  let attempts = 0;
  const readyTimer = setInterval(() => {
    if (initialized || ++attempts > 30) {
      clearInterval(readyTimer);
      return;
    }
    send({ type: "ready" });
  }, 500);
  window.addEventListener("pagehide", () => clearInterval(readyTimer), {
    once: true,
  });
} else status.textContent = "Open this editor from a2d2 Docs.";
