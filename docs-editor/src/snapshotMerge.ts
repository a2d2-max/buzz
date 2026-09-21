import * as Y from "yjs";

const MAX_PAYLOAD_LENGTH = 32 * 1024 * 1024;
const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;
type DecodedSnapshot = {
  entry: string;
  root: Uint8Array;
  docs: Map<string, Uint8Array>;
  blobs: Map<string, { type: string; data: Uint8Array }>;
};

function encode(bytes: Uint8Array) {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}
function decode(value: unknown, allowEmpty = false): Uint8Array {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value.length) ||
    value.length > MAX_PAYLOAD_LENGTH ||
    value.length % 4 !== 0 ||
    !base64Pattern.test(value)
  )
    throw Error("Invalid structured document encoding.");
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
function decodeSnapshot(payload: { version: number; data: string }): DecodedSnapshot {
  if (payload.version !== 1 && payload.version !== 2)
    throw Error("This document requires a newer editor.");
  const snapshot: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(decode(payload.data)),
  );
  if (
    !record(snapshot) ||
    !identifier(snapshot.entry) ||
    typeof snapshot.root !== "string" ||
    !Array.isArray(snapshot.docs) ||
    snapshot.docs.length < 1 ||
    snapshot.docs.length > 1000 ||
    !Array.isArray(snapshot.blobs) ||
    snapshot.blobs.length > 1000
  )
    throw Error("Invalid structured document.");
  const docs = new Map<string, Uint8Array>();
  for (const value of snapshot.docs) {
    if (!record(value) || !identifier(value.id) || docs.has(value.id))
      throw Error("Invalid document identifiers.");
    docs.set(value.id, decode(value.state));
  }
  if (!docs.has(snapshot.entry)) throw Error("Invalid document identifiers.");
  const blobs = new Map<string, { type: string; data: Uint8Array }>();
  for (const value of snapshot.blobs) {
    if (
      !record(value) ||
      !identifier(value.id) ||
      typeof value.type !== "string" ||
      value.type.length > 256 ||
      blobs.has(value.id)
    )
      throw Error("Invalid document attachment.");
    blobs.set(value.id, { type: value.type, data: decode(value.data, true) });
  }
  return { entry: snapshot.entry, root: decode(snapshot.root), docs, blobs };
}
function encodeSnapshot(snapshot: DecodedSnapshot) {
  const data = encode(
    new TextEncoder().encode(
      JSON.stringify({
        entry: snapshot.entry,
        root: encode(snapshot.root),
        docs: [...snapshot.docs]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, state]) => ({ id, state: encode(state) })),
        blobs: [...snapshot.blobs]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, value]) => ({
            id,
            type: value.type,
            data: encode(value.data),
          })),
      }),
    ),
  );
  if (data.length > MAX_PAYLOAD_LENGTH)
    throw Error("Structured document exceeds the storage limit.");
  return { version: 2 as const, data };
}

/** Merge independent full snapshots by Yjs state while refusing blob collisions. */
export function mergeSnapshotPayloads(
  payloads: ReadonlyArray<{ version: number; data: string }>,
) {
  if (payloads.length < 1) throw Error("No structured documents to merge.");
  const decoded = payloads.map(decodeSnapshot);
  const entry = decoded[0].entry;
  if (decoded.some((snapshot) => snapshot.entry !== entry))
    throw Error("Structured document entry points do not match.");
  const docUpdates = new Map<string, Uint8Array[]>();
  for (const snapshot of decoded) {
    for (const [id, state] of snapshot.docs) {
      const updates = docUpdates.get(id) ?? [];
      updates.push(state);
      docUpdates.set(id, updates);
    }
  }
  const docs = new Map<string, Uint8Array>();
  for (const [id, updates] of docUpdates) docs.set(id, Y.mergeUpdates(updates));
  const blobs = new Map<string, { type: string; data: Uint8Array }>();
  for (const snapshot of decoded) {
    for (const [id, incoming] of snapshot.blobs) {
      const current = blobs.get(id);
      if (
        current &&
        (current.type !== incoming.type || !sameBytes(current.data, incoming.data))
      )
        throw Error("Structured document attachment collision.");
      if (!current) blobs.set(id, incoming);
    }
  }
  const root = Y.mergeUpdates(decoded.map((snapshot) => snapshot.root));
  const rootDoc = new Y.Doc();
  Y.applyUpdate(rootDoc, root);
  const spaces = rootDoc.getMap<Y.Doc>("spaces");
  if (spaces.size !== docs.size || [...docs.keys()].some((id) => !spaces.has(id)))
    throw Error("Incomplete nested documents.");
  return encodeSnapshot({ entry, root, docs, blobs });
}
