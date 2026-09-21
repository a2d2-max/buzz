import { createHash } from "node:crypto";
/** Canonical fingerprints ignore object insertion order, never array order. */
export function fingerprint(value) {
  const canonical = (v) =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical(v[k])]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
/**
 * Reconcile a structured entity with durable, resumable per-operation intent.
 * Adapters expose semantic content and recheck destination versions before writes.
 * Missing entities are held; explicit deletion is a planned, fingerprint-checked operation.
 */
export async function syncStructuredEntity(io, record = {}) {
  const [notion, local] = await Promise.all([io.readNotion(), io.readLocal()]);
  if (!notion || notion.deleted || local?.deleted) {
    await io.save({
      ...record,
      status: "blocked",
      reason: "deletion-or-missing-source",
    });
    return "blocked";
  }
  const n = fingerprint(notion.content),
    d = local ? fingerprint(local.content) : null;
  let pending = record.pending;
  if (!pending) {
    const nc = n !== record.n,
      dc = d !== record.d;
    if (!record.n && local) {
      await io.save({
        ...record,
        status: "conflict",
        reason: "existing-unmapped-local",
      });
      return "conflict";
    }
    if (record.n && nc && dc) {
      await io.save({ ...record, status: "conflict", reason: "both-changed" });
      return "conflict";
    }
    if (!nc && !dc) {
      await io.save({ ...record, status: "synced" });
      return "unchanged";
    }
    const direction = !record.n || nc ? "local" : "notion";
    const source = direction === "local" ? notion : local;
    if (!source) {
      await io.save({ ...record, status: "blocked", reason: "missing-local" });
      return "blocked";
    }
    const operations = await io.plan(
      direction,
      source,
      direction === "local" ? local : notion,
      record,
    );
    pending = {
      direction,
      source: fingerprint(source.content),
      operations,
      index: 0,
    };
    record = { ...record, pending, status: "pending" };
    await io.save(record);
  }
  const source = pending.direction === "local" ? notion : local;
  if (!source || fingerprint(source.content) !== pending.source) {
    await io.save({
      ...record,
      status: "conflict",
      reason: "source-changed-during-pending",
    });
    return "conflict";
  }
  try {
    for (
      let index = pending.index;
      index < pending.operations.length;
      index++
    ) {
      const operation = pending.operations[index];
      const current = await io.readTarget(pending.direction, operation);
      const actual = fingerprint(current?.content ?? null);
      if (actual !== operation.after) {
        if (actual !== operation.before)
          throw Error("structured-destination-changed");
        // Source can change between separate external writes. Stop instead of finishing a stale plan.
        const latest =
          pending.direction === "local"
            ? await io.readNotion()
            : await io.readLocal();
        if (!latest || fingerprint(latest.content) !== pending.source)
          throw Error("structured-source-changed");
        await io.writeTarget(pending.direction, operation, current?.version);
        const after = await io.readTarget(pending.direction, operation);
        if (fingerprint(after?.content ?? null) !== operation.after)
          throw Error("structured-readback-differs");
      }
      pending = { ...pending, index: index + 1 };
      record = { ...record, pending };
      await io.save(record);
    }
    const [nn, dd] = await Promise.all([io.readNotion(), io.readLocal()]);
    await io.verify(nn, dd);
    await io.save({
      n: fingerprint(nn.content),
      d: fingerprint(dd.content),
      status: "synced",
      ...((await io.mapping?.(nn, dd)) ?? {}),
    });
    return pending.direction === "local"
      ? "notion-to-local"
      : "local-to-notion";
  } catch (error) {
    await io.save({ ...record, status: "error", reason: error.message });
    throw error;
  }
}
