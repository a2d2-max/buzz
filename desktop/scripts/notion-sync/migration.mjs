import { equal } from "./engine.mjs";
import { fingerprint } from "./structuredSync.mjs";
/** Stage adoption only when the saved Markdown baseline proves local edits are absent. */
export async function prepareMigration({
  legacy,
  n,
  d,
  notion,
  local,
  io,
  backup,
}) {
  if (legacy.pending) throw Error("legacy-pending");
  if (!legacy.n || !legacy.d) throw Error("legacy-baseline-missing");
  if (!n || n.deleted || !d || d.deleted || notion.deleted || local?.deleted)
    throw Error("legacy-deleted");
  if (d.page?.affine || d.page?.unsupportedEditor)
    throw Error("migration-already-structured");
  if (!equal(legacy.n, legacy.d)) throw Error("legacy-baseline-diverged");
  if (local?.entities.row) throw Error("migration-existing-unmapped-row");
  if (!equal(d, legacy.d)) throw Error("legacy-local-changed");
  if (n.version !== notion.version) throw Error("migration-source-changed");
  if (d.version !== local?.entities.doc?.version)
    throw Error("migration-local-changed");
  // Preserve exact source, signed destination events and both old baselines before planning any writes.
  await backup({ legacy, markdownNotion: n, markdownDoc: d, notion, local });
  const operations = await io.plan("local", notion, local, {});
  return {
    status: "pending",
    migration: { from: "markdown", version: d.version },
    pending: {
      direction: "local",
      source: fingerprint(notion.content),
      operations,
      index: 0,
    },
  };
}
