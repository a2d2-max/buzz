export type LinkedDatabaseReference = { databaseId: string; viewId: string | null };
const databasePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const viewPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export function linkedDatabaseReference(value: unknown): LinkedDatabaseReference | null {
  if (!value || typeof value !== "object") return null;
  const ref = value as Record<string, unknown>;
  return typeof ref.databaseId === "string" && databasePattern.test(ref.databaseId) &&
    (ref.viewId === null || (typeof ref.viewId === "string" && viewPattern.test(ref.viewId)))
    ? { databaseId: ref.databaseId, viewId: ref.viewId } : null;
}
export function directive(value: string) {
  const parts = value.split(" ");
  if (parts[0] !== ":::db" || (parts.length !== 2 && parts.length !== 3)) return null;
  return linkedDatabaseReference({ databaseId: parts[1], viewId: parts[2] ?? null });
}

type SnapshotBlock = { type: "block"; id: string; flavour: string; props: Record<string, unknown>; children: SnapshotBlock[] };
/** Upgrade plain directive paragraphs only; code, lists and quoted examples stay text. */
export function upgradeLinkedDatabaseBlocks(root: SnapshotBlock, createId: () => string) {
  for (const note of root.children) {
    if (note.flavour !== "affine:note") continue;
    note.children = note.children.flatMap(block => {
      if (block.flavour !== "affine:paragraph" || block.props.type !== "text" || block.children.length) return [block];
      const text = block.props.text as { delta?: Array<{ insert?: unknown; attributes?: unknown }> } | undefined;
      if (!text?.delta?.length) return [block];
      // Only inspect the unformatted prefix. A styled explanation after the
      // directive is independent content and must keep its original delta.
      let prefix = "";
      for (const part of text.delta) {
        if (typeof part.insert !== "string" || (part.attributes && Object.keys(part.attributes).length)) break;
        prefix += part.insert;
      }
      const fullLength = text.delta.reduce((sum, part) => sum + (typeof part.insert === "string" ? part.insert.length : 1), 0);
      let consumed = 0;
      const result: SnapshotBlock[] = [];
      while (consumed < prefix.length) {
        const end = prefix.indexOf("\n", consumed);
        // The end of an unformatted run is not necessarily a line boundary.
        if (end < 0 && prefix.length !== fullLength) break;
        const lineEnd = end < 0 ? prefix.length : end;
        const ref = directive(prefix.slice(consumed, lineEnd).replace(/\r$/, ""));
        if (!ref) break;
        consumed = end < 0 ? prefix.length : end + 1;
        result.push({ type: "block", id: createId(), flavour: "a2d2:linked-database", props: ref, children: [] });
      }
      if (!result.length) return [block];
      let remaining = consumed;
      const delta = text.delta.flatMap(part => {
        const length = typeof part.insert === "string" ? part.insert.length : 1;
        if (remaining >= length) { remaining -= length; return []; }
        if (!remaining) return [part];
        const insert = (part.insert as string).slice(remaining);
        remaining = 0;
        return [{ ...part, insert }];
      });
      if (delta.length) result.push({ ...block, props: { ...block.props, text: { ...text, "$blocksuite:internal:text$": true, delta } } });
      return result;
    });
  }
}
