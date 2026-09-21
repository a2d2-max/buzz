import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  connect,
  RELAY,
  SIGNER,
  SOURCE,
  DATABASE,
  idKey,
} from "./adapters.mjs";
import { structuredRelay } from "./structuredRelay.mjs";
import { createStructuredAdapter } from "./structuredAdapter.mjs";
import { syncStructuredEntity } from "./structuredSync.mjs";
import { prepareMigration } from "./migration.mjs";
const { values: v } = parseArgs({
  options: {
    cli: { type: "string" },
    state: { type: "string" },
    legacy: { type: "string" },
    only: { type: "string" },
    watch: { type: "boolean" },
  },
});
if (!v.cli || !v.state || !v.legacy)
  throw Error("--cli --state --legacy required");
process.umask(0o077);
const dir = path.resolve(v.state),
  old = path.resolve(v.legacy);
if (dir === old) throw Error("separate-state-required");
await fs.mkdir(dir, { recursive: true });
async function read(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
async function write(file, data) {
  const tmp = file + ".new";
  const h = await fs.open(tmp, "w", 0o600);
  try {
    await h.writeFile(JSON.stringify(data));
    await h.sync();
  } finally {
    await h.close();
  }
  await fs.rename(tmp, file);
  const d = await fs.open(path.dirname(file), "r");
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}
const binding = {
  database: DATABASE,
  source: SOURCE,
  relay: RELAY,
  signer: SIGNER,
};
if (
  JSON.stringify(await read(path.join(old, "manifest.json"), null)) !==
  JSON.stringify(binding)
)
  throw Error("legacy-binding-mismatch");
const manifest = { ...binding, mode: "structured-cutover-v1", legacy: old };
const prior = await read(path.join(dir, "manifest.json"), null);
if (prior && JSON.stringify(prior) !== JSON.stringify(manifest))
  throw Error("cutover-binding-mismatch");
await write(path.join(dir, "manifest.json"), manifest);
const locks = [];
let relay,
  stopping = false;
process.on("SIGTERM", () => (stopping = true));
process.on("SIGINT", () => (stopping = true));
try {
  for (const root of [old, dir]) {
    const lock = path.join(root, "lock");
    // Stale locks require explicit owner verification; never steal one automatically.
    await fs.mkdir(lock);
    locks.push(lock);
    await fs.writeFile(path.join(lock, "pid"), String(process.pid));
  }
  const api = await connect(path.resolve(v.cli));
  do {
    relay = await structuredRelay(RELAY, SIGNER);
    const { pages } = await api.list();
    if (new Set(pages.map((p) => idKey(p.id))).size !== pages.length)
      throw Error("duplicate-pages");
    if (v.only && !pages.some((p) => idKey(p.id) === idKey(v.only)))
      throw Error("page-outside-approved-source");
    const report = {
      startedAt: new Date().toISOString(),
      pid: process.pid,
      total: pages.length,
      processed: 0,
      results: {},
      issues: [],
    };
    for (const p of pages) {
      if (stopping) break;
      const id = idKey(p.id);
      if (v.only && id !== idKey(v.only)) continue;
      const file = path.join(dir, id + ".json");
      let record = await read(file, {});
      try {
        const save = (r) => write(file, r);
        let io = createStructuredAdapter({
          request: api.request,
          relay,
          pageId: p.id,
          record,
          save,
        });
        if (!record.n && !record.pending) {
          const local = await io.readLocal();
          if (local) {
            const legacy = await read(path.join(old, id + ".json"), {});
            // Cheap checks avoid expensive source reads for known held documents.
            if (legacy.pending) throw Error("legacy-pending");
            if (!legacy.n || !legacy.d) throw Error("legacy-baseline-missing");
            const n = await api.readNotion(p.id),
              d = await api.doc(id),
              notion = await io.readNotion();
            record = await prepareMigration({
              legacy,
              n,
              d,
              notion,
              local,
              io,
              backup: async (data) => {
                const backupDir = path.join(dir, "backups");
                await fs.mkdir(backupDir, { recursive: true });
                // Unique backup per attempt; never replace the last pre-migration snapshot.
                await write(
                  path.join(backupDir, id + "-" + Date.now() + ".json"),
                  data,
                );
              },
            });
            await save(record);
            io = createStructuredAdapter({
              request: api.request,
              relay,
              pageId: p.id,
              record,
              save,
            });
          }
        }
        const result = await syncStructuredEntity(io, record);
        report.results[result] = (report.results[result] ?? 0) + 1;
        if (["blocked", "conflict"].includes(result)) {
          const latest = await read(file, {});
          report.issues.push({ id, status: result, reason: latest.reason });
        }
      } catch (e) {
        const latest = await read(file, record);
        await write(file, { ...latest, status: "held", reason: e.message });
        report.issues.push({ id, status: "held", reason: e.message });
      }
      report.processed++;
      await write(path.join(dir, "report.json"), report);
      console.log(
        JSON.stringify({
          processed: report.processed,
          total: report.total,
          results: report.results,
          held: report.issues.length,
        }),
      );
    }
    report.finishedAt = new Date().toISOString();
    report.interrupted = stopping;
    await write(path.join(dir, "report.json"), report);
    relay.close();
    relay = null;
    if (!v.watch || stopping) break;
    for (let i = 0; i < 60 && !stopping; i++)
      await new Promise((r) => setTimeout(r, 1000));
  } while (!stopping);
} finally {
  relay?.close();
  for (const lock of locks.reverse()) await fs.rm(lock, { recursive: true });
}
