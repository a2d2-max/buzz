import { getRelayWsUrl } from "@/shared/api/tauri";
import { getIdentity } from "@/shared/api/tauriIdentity";
import { uploadMediaFile, fetchMediaBytes } from "@/shared/api/tauriMedia";
import type { AffineDocPayload, DocPageContent } from "./docPageCodec";

import { MAX_DOC_BLOB_BYTES, parseDocBlobReference } from "./docBlobReference";
import { isAffineDocPayload } from "./docPageCodec";
async function hash(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
const transport = {
  upload: uploadMediaFile,
  fetch: fetchMediaBytes,
  relay: getRelayWsUrl,
  identity: getIdentity,
};
export type DocBlobTransport = typeof transport;
export type DocBlobScope = { relay: string; pubkey: string };
/** Upload complete state before publishing its reference. Failed uploads never replace a page. */
export async function storeDocBlob<T extends DocPageContent>(
  page: T,
  io: DocBlobTransport = transport,
  onScope?: (scope: DocBlobScope) => void,
): Promise<T> {
  if (!page.affine || page.affine.version === 3) return page;
  const bytes = new TextEncoder().encode(
    JSON.stringify({ body: page.body, affine: page.affine }),
  );
  if (bytes.byteLength <= 180000) return page;
  if (bytes.byteLength > MAX_DOC_BLOB_BYTES)
    throw Error("Document and attachments exceed 32 MiB.");
  const relay = await io.relay(),
    identity = await io.identity();
  onScope?.({ relay, pubkey: identity.pubkey });
  const sha256 = await hash(bytes);
  const blob = await io.upload(
    new File([bytes], "document.a2d2", { type: "application/octet-stream" }),
  );
  if (
    (await io.relay()) !== relay ||
    (await io.identity()).pubkey !== identity.pubkey
  )
    throw Error(
      "The active community or identity changed during document upload.",
    );
  if (blob.sha256 !== sha256 || blob.size !== bytes.byteLength)
    throw Error("Document upload integrity check failed.");
  const ref = parseDocBlobReference(JSON.stringify(blob));
  assertSameRelay(ref.url, relay);
  return {
    ...page,
    body: page.body.slice(0, 16000),
    affine: { version: 3, data: JSON.stringify(ref) },
  };
}
function assertSameRelay(url: string, relay: string) {
  const origin = new URL(relay.replace(/^ws/, "http")).origin;
  if (new URL(url).origin !== origin)
    throw Error("Document storage belongs to another community.");
}
/** Verify signed size/hash and community before decoding; never edit the abbreviated preview. */
export async function loadDocBlob<
  T extends { body: string; affine?: AffineDocPayload },
>(page: T, io: DocBlobTransport = transport): Promise<T> {
  if (page.affine?.version !== 3) return page;
  const ref = parseDocBlobReference(page.affine.data),
    relay = await io.relay();
  assertSameRelay(ref.url, relay);
  const bytes = await io.fetch(ref.url);
  if (bytes.byteLength !== ref.size || (await hash(bytes)) !== ref.sha256)
    throw Error("Document download integrity check failed.");
  if ((await io.relay()) !== relay)
    throw Error("The active community changed during document download.");
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (
    typeof value.body !== "string" ||
    !isAffineDocPayload(value.affine, MAX_DOC_BLOB_BYTES) ||
    value.affine.version === 3
  )
    throw Error("Invalid stored document.");
  return { ...page, body: value.body, affine: value.affine };
}
