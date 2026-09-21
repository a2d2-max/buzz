/** IndexedDB recovery shared by the iframe and its same-origin host. */
const DATABASE = "buzz.docs.structured-recovery.v1";
async function open() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? Error("Recovery storage unavailable."));
  });
}
export async function readRecovery(key: string): Promise<string | null> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("drafts", "readonly");
      const request = tx.objectStore("drafts").get(key);
      tx.oncomplete = () => {
        try {
          const value = request.result;
          resolve(value && JSON.parse(value).affine ? value : null);
        } catch (error) {
          reject(error);
        }
      };
      tx.onabort = () => reject(tx.error ?? Error("Recovery read failed."));
    });
  } finally {
    db.close();
  }
}
export async function updateRecovery(
  key: string,
  update: (current: string | null) => string | null,
): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("drafts", "readwrite");
      const store = tx.objectStore("drafts"),
        request = store.get(key);
      request.onsuccess = () => {
        try {
          const next = update(request.result ?? null);
          if (next === null) store.delete(key);
          else store.put(next, key);
        } catch (error) {
          tx.abort();
          reject(error);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? Error("Recovery write failed."));
    });
  } finally {
    db.close();
  }
}
export const removeRecovery = (key: string) =>
  updateRecovery(key, () =>
    JSON.stringify({ owner: `discarded-${crypto.randomUUID()}` }),
  );
