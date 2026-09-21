import * as Y from "yjs";
import type { EditorWorkspace } from "./runtime";

export const MAX_PAYLOAD_LENGTH = 32 * 1024 * 1024;
type Snapshot = {
  entry: string;
  root: string;
  docs: Array<{ id: string; state: string }>;
  blobs: Array<{ id: string; type: string; data: string }>;
};
type DecodedSnapshot = {
  entry: string;
  root: Uint8Array;
  docs: Map<string, Uint8Array>;
  blobs: Map<string, { type: string; data: Uint8Array }>;
};
const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;
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
  ) {
    throw Error("Invalid structured document encoding.");
  }
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
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
    if (!record(value) || !identifier(value.id))
      throw Error("Invalid nested document.");
    if (docs.has(value.id)) throw Error("Invalid document identifiers.");
    docs.set(value.id, decode(value.state));
  }
  if (!docs.has(snapshot.entry)) throw Error("Invalid document identifiers.");
  const blobs = new Map<string, { type: string; data: Uint8Array }>();
  for (const value of snapshot.blobs) {
    if (
      !record(value) ||
      !identifier(value.id) ||
      typeof value.type !== "string" ||
      value.type.length > 256
    ) {
      throw Error("Invalid document attachment.");
    }
    if (blobs.has(value.id)) throw Error("Duplicate document attachment.");
    blobs.set(value.id, {
      type: value.type,
      data: decode(value.data, true),
    });
  }
  return {
    entry: snapshot.entry,
    root: decode(snapshot.root),
    docs,
    blobs,
  };
}

/** Capture documents, workspace metadata and embedded assets in one bounded payload. */
export function saveSnapshot(workspace: EditorWorkspace, entry: string) {
  if (!workspace.getDoc(entry)) throw Error("Missing entry document.");
  const snapshot: Snapshot = {
    entry,
    root: encode(Y.encodeStateAsUpdate(workspace.doc)),
    docs: [...workspace.docs.values()].map((doc) => ({
      id: doc.id,
      state: encode(Y.encodeStateAsUpdate(doc.spaceDoc)),
    })),
    blobs: [...workspace.blobs.encoded.values()],
  };
  const data = encode(new TextEncoder().encode(JSON.stringify(snapshot)));
  if (data.length > MAX_PAYLOAD_LENGTH)
    throw Error("Structured document exceeds the storage limit.");
  return { version: 2 as const, data };
}

/** Restore only into a new, isolated runtime; validation failures never publish a replacement. */
export async function restoreSnapshot(
  workspace: EditorWorkspace,
  payload: { version: number; data: string },
) {
  if (workspace.docs.size) throw Error("Restore requires an empty workspace.");
  const snapshot = decodeSnapshot(payload);
  Y.applyUpdate(workspace.doc, snapshot.root);
  // Missing nested state would turn a linked document into an empty one.
  const spaces = workspace.doc.getMap<Y.Doc>("spaces");
  if (
    spaces.size !== snapshot.docs.size ||
    [...snapshot.docs.keys()].some((id) => !spaces.has(id))
  )
    throw Error("Incomplete nested documents.");
  for (const [id, state] of snapshot.docs) {
    const doc = workspace.createDoc(id);
    doc.load(() => Y.applyUpdate(doc.spaceDoc, state));
  }
  for (const [id, value] of snapshot.blobs) {
    await workspace.blobs.set(
      id,
      new Blob([Uint8Array.from(value.data)], { type: value.type }),
    );
  }
  const entry = workspace.getDoc(snapshot.entry);
  if (!entry) throw Error("Missing entry document.");
  return entry;
}
