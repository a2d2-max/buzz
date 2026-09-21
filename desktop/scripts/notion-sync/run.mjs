import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { syncPage } from "./engine.mjs";
import {
  connect,
  DATABASE,
  SOURCE,
  RELAY,
  SIGNER,
  idKey,
} from "./adapters.mjs";

const { values } = parseArgs({
  options: {
    cli: { type: "string" },
    state: { type: "string" },
    watch: { type: "boolean" },
    inspect: { type: "boolean" },
    only: { type: "string" },
  },
});
if (!values.cli || !values.state) throw Error("--cli and --state required");
process.umask(0o077);
const directory = path.resolve(values.state);
await fs.mkdir(directory, { recursive: true, mode: 0o700 });
const lock = path.join(directory, "lock");
try {
  await fs.mkdir(lock);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  const pid = Number(await fs.readFile(path.join(lock, "pid"), "utf8"));
  if (!Number.isSafeInteger(pid) || pid < 1) throw Error("sync-lock-invalid");
  try {
    process.kill(pid, 0);
    throw Error("sync-already-running");
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
  await fs.rm(lock, { recursive: true });
  await fs.mkdir(lock);
}
await fs.writeFile(path.join(lock, "pid"), String(process.pid), {
  mode: 0o600,
});
async function write(file, value) {
  const tmp = `${file}.new`;
  const h = await fs.open(tmp, "w", 0o600);
  try {
    await h.writeFile(JSON.stringify(value));
    await h.sync();
  } finally {
    await h.close();
  }
  await fs.rename(tmp, file);
  const dir = await fs.open(path.dirname(file), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
async function read(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
try {
  const expected = {
    database: DATABASE,
    source: SOURCE,
    relay: RELAY,
    signer: SIGNER,
  };
  const manifest = path.join(directory, "manifest.json");
  const existing = await read(manifest, null);
  if (existing && JSON.stringify(existing) !== JSON.stringify(expected))
    throw Error("sync-state-target-mismatch");
  await write(manifest, expected);
  const api = await connect(path.resolve(values.cli));
  do {
    const { db, pages } = await api.list();
    const unique = new Map(pages.map((p) => [idKey(p.id), p]));
    if (unique.size !== pages.length) throw Error("notion-duplicate-page-ids");
    console.log(JSON.stringify({ phase: "inventory", pages: pages.length }));
    if (values.inspect) {
      await write(path.join(directory, "inventory.json"), {
        at: new Date().toISOString(),
        database: db.id,
        pages: pages.map((p) => ({
          id: p.id,
          last_edited_time: p.last_edited_time,
        })),
      });
      break;
    }
    const root = await api.doc(DATABASE);
    const rootTitle = db.title.map((t) => t.plain_text).join("");
    const rootBody = `[Notion 데이터베이스 열기](https://app.notion.com/p/${DATABASE})\n\nNotion과 연결된 문서입니다. 제목과 본문은 양방향으로 반영됩니다. DB 속성 영역은 Notion에서 관리합니다. 동시 수정과 삭제는 자동 반영하지 않습니다.`;
    if (!root)
      await api.publish(
        DATABASE,
        { title: rootTitle, body: rootBody },
        null,
        null,
      );
    const report = {
      startedAt: new Date().toISOString(),
      total: pages.length,
      processed: 0,
      results: {},
      issues: [],
    };
    if (values.only && !unique.has(idKey(values.only)))
      throw Error("only-page-outside-source");
    for (const p of pages) {
      if (stopping) break;
      const id = idKey(p.id);
      if (values.only && id !== idKey(values.only)) continue;
      const file = path.join(directory, `${id}.json`);
      const previous = await read(file, {});
      try {
        const result = await syncPage(
          api.pageIO(p.id, (r) => write(file, r)),
          previous,
        );
        report.results[result] = (report.results[result] ?? 0) + 1;
        if (result === "conflict" || result === "blocked")
          report.issues.push({ id, status: result });
      } catch (error) {
        report.issues.push({ id, status: "error", reason: error.message });
        // Preserve pending intent written by the engine; do not replace it with stale state.
        const latest = await read(file, previous);
        await write(file, {
          ...latest,
          status: "error",
          reason: error.message,
        });
      }
      report.processed++;
      await write(path.join(directory, "report.json"), report);
      if (report.processed % 10 === 0)
        console.log(
          JSON.stringify({
            phase: "progress",
            processed: report.processed,
            total: report.total,
            results: report.results,
            issues: report.issues.length,
          }),
        );
    }
    report.finishedAt = new Date().toISOString();
    report.interrupted = stopping;
    await write(path.join(directory, "report.json"), report);
    console.log(
      JSON.stringify({
        phase: "finished",
        ...report,
        issues: report.issues.length,
      }),
    );
    if (!values.watch || stopping) break;
    for (let i = 0; i < 60 && !stopping; i++)
      await new Promise((r) => setTimeout(r, 1000));
  } while (!stopping);
} finally {
  await fs.rm(lock, { recursive: true, force: true });
}
