/** Content equality intentionally excludes transport versions. */
export function equal(a, b) {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.title === b.title &&
      a.body === b.body &&
      !!a.deleted === !!b.deleted)
  );
}

/** Sync one mapped page; durable intent precedes every write. Adapters must recheck versions. */
export async function syncPage(io, record = {}) {
  const n = await io.readNotion(),
    d = await io.readDoc();
  if (n.deleted || d?.deleted) {
    await io.save({
      ...record,
      status: "blocked",
      reason: "deletion-or-out-of-scope",
    });
    return "blocked";
  }
  let pending = record.pending;
  if (!pending) {
    let direction;
    if (!record.n) {
      if (d && !equal(n, d)) {
        await io.save({
          ...record,
          status: "conflict",
          reason: "unmapped-existing-document",
        });
        return "conflict";
      }
      if (!d) direction = "doc";
    } else {
      const nc = !equal(n, record.n),
        dc = !equal(d, record.d);
      if (nc && dc && !equal(n, d)) {
        await io.save({
          ...record,
          status: "conflict",
          reason: "both-changed",
        });
        return "conflict";
      }
      if (nc && !dc) direction = "doc";
      if (dc && !nc) direction = "notion";
    }
    if (!direction || equal(n, d)) {
      await io.save({ n, d, status: "synced" });
      return "unchanged";
    }
    if (!d && record.d) {
      await io.save({
        ...record,
        status: "blocked",
        reason: "missing-document",
      });
      return "blocked";
    }
    pending = {
      direction,
      source: direction === "doc" ? n : d,
      before: direction === "doc" ? d : n,
    };
    record = { ...record, pending, status: "pending" };
    await io.save(record);
  }
  const source = pending.direction === "doc" ? n : d,
    dest = pending.direction === "doc" ? d : n;
  if (!equal(source, pending.source)) {
    await io.save({
      ...record,
      status: "conflict",
      reason: "source-changed-during-pending-write",
    });
    return "conflict";
  }
  if (!equal(dest, pending.source)) {
    const partialNotionWrite =
      pending.direction === "notion" &&
      dest &&
      pending.before &&
      dest.body === pending.source.body &&
      dest.title === pending.before.title &&
      !dest.deleted;
    if (!equal(dest, pending.before) && !partialNotionWrite) {
      await io.save({
        ...record,
        status: "conflict",
        reason: "destination-changed-during-pending-write",
      });
      return "conflict";
    }
    try {
      if (pending.direction === "doc") await io.writeDoc(pending.source, d);
      else await io.writeNotion(pending.source, n);
    } catch (error) {
      await io.save({ ...record, status: "error", reason: error.message });
      throw error;
    }
  }
  const nn = await io.readNotion(),
    dd = await io.readDoc();
  if (!equal(nn, dd)) {
    await io.save({
      ...record,
      status: "conflict",
      reason: "readback-differs",
    });
    return "conflict";
  }
  await io.save({ n: nn, d: dd, status: "synced" });
  return pending.direction === "doc" ? "notion-to-docs" : "docs-to-notion";
}
