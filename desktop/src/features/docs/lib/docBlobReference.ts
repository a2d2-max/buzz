export const MAX_DOC_BLOB_BYTES = 32 * 1024 * 1024;
export type DocBlobReference = { url: string; sha256: string; size: number };
export function parseDocBlobReference(data: string): DocBlobReference {
  const ref = JSON.parse(data);
  if (
    !ref ||
    typeof ref.url !== "string" ||
    !/^https?:\/\//.test(ref.url) ||
    !/^[a-f0-9]{64}$/.test(ref.sha256) ||
    !Number.isSafeInteger(ref.size) ||
    ref.size < 1 ||
    ref.size > MAX_DOC_BLOB_BYTES
  )
    throw Error("Invalid document storage reference.");
  const url = new URL(ref.url);
  if (url.username || url.password || url.hash)
    throw Error("Invalid document storage URL.");
  return { url: ref.url, sha256: ref.sha256, size: ref.size };
}
