import { updateRecovery } from "./recoveryStorage.ts";
type Draft = {
  title: string;
  body: string;
  affine: { version: number; data: string };
};
/** Persist large drafts before emission; ACK deletion is an atomic session/revision comparison. */
export function createAsyncRecoveryJournal(
  key: string,
  session: string,
  update = updateRecovery,
) {
  let revision = 0;
  // Claim the key in one transaction before accepting writes from this frame.
  // A replaced frame may still have an IndexedDB open/request in flight.
  let queue = update(key, (current) =>
    JSON.stringify({
      ...(current ? JSON.parse(current) : {}),
      owner: session,
    }),
  );
  const ready = queue;
  // Retain the rejection for callers without creating an unhandled promise.
  void ready.catch(() => undefined);
  const write = (draft: Draft, expected: number) => {
    const task = queue.then(async () => {
      await ready;
      return update(key, (current) => {
        const existing = current ? JSON.parse(current) : null;
        if (existing?.owner !== session)
          throw Error("Recovery session was replaced.");
        if (expected !== revision) return current;
        return JSON.stringify({
          ...draft,
          owner: session,
          journal: { session, revision: expected },
        });
      });
    });
    queue = task.catch(() => undefined);
    return task;
  };
  return {
    get revision() {
      return revision;
    },
    record(draft: Draft) {
      revision++;
      return write(draft, revision);
    },
    async preview(draft: Draft, expected: number) {
      if (expected !== revision) return false;
      await write(draft, expected);
      return expected === revision;
    },
    async acknowledge(expected: number, data: string) {
      await queue;
      await update(key, (current) => {
        if (expected !== revision || current === null) return current;
        const stored = JSON.parse(current);
        return stored?.owner === session &&
          stored?.journal?.session === session &&
          stored.journal.revision === expected &&
          stored.affine?.data === data
          ? JSON.stringify({ owner: session })
          : current;
      });
    },
  };
}
