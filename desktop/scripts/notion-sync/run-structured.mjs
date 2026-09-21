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
const { values } = parseArgs({
  options: {
    cli: { type: "string" },
    state: { type: "string" },
    only: { type: "string" },
    inspect: { type: "boolean" },
  },
});
if (!values.cli || !values.state || !values.only)
  throw Error(
    "--cli --state --only required; structured cutover is explicit per page",
  );
if (!/^[0-9a-f-]{32,36}$/i.test(values.only)) throw Error("invalid-page-id");
process.umask(0o077);
const dir = path.resolve(values.state);
await fs.mkdir(dir, { recursive: true, mode: 0o700 });
const lock = path.join(dir, "lock");
try {
  await fs.mkdir(lock);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  throw Error("structured-lock-exists; preserve it and verify its owner");
}
await fs.writeFile(path.join(lock, "pid"), String(process.pid), {
  mode: 0o600,
});
async function read(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
async function write(file, data) {
  const tmp = file + ".new",
    handle = await fs.open(tmp, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(data));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
  const directory = await fs.open(path.dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
let relay;
try {
  const binding = {
    mode: "structured-v1",
    relay: RELAY,
    signer: SIGNER,
    source: SOURCE,
    database: DATABASE,
  };
  const manifest = path.join(dir, "manifest.json"),
    existing = await read(manifest, null);
  if (existing && JSON.stringify(existing) !== JSON.stringify(binding))
    throw Error(
      "structured-state-target-mismatch; do not reuse Markdown worker state",
    );
  await write(manifest, binding);
  const api = await connect(path.resolve(values.cli));
  const { pages } = await api.list();
  if (!pages.some((p) => idKey(p.id) === idKey(values.only)))
    throw Error("structured-page-outside-approved-source");
  relay = await structuredRelay(RELAY, SIGNER);
  const stateFile = path.join(dir, `${idKey(values.only)}.json`),
    record = await read(stateFile, {});
  const io = createStructuredAdapter({
    request: api.request,
    relay,
    pageId: values.only,
    record,
    save: (r) => write(stateFile, r),
  });
  if (values.inspect) {
    const [n, d] = await Promise.all([io.readNotion(), io.readLocal()]);
    await write(path.join(dir, "inspection.json"), { notion: n, local: d });
    console.log(
      JSON.stringify({ status: "inspected", pageId: idKey(values.only) }),
    );
  } else {
    const result = await syncStructuredEntity(io, record);
    await write(path.join(dir, "report.json"), {
      at: new Date().toISOString(),
      pageId: idKey(values.only),
      result,
    });
    console.log(JSON.stringify({ result, pageId: idKey(values.only) }));
  }
} finally {
  relay?.close();
  await fs.rm(lock, { recursive: true });
}
