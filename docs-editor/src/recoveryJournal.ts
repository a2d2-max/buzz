/** A single editor frame owns recovery writes and acknowledges only its current revision. */
type Draft = {
  title: string;
  body: string;
  affine: { version: number; data: string };
};
export function createRecoveryJournal(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  key: string,
  session: string,
) {
  let revision = 0;
  function write(draft: Draft) {
    storage.setItem(
      key,
      JSON.stringify({ ...draft, journal: { session, revision } }),
    );
  }
  return {
    get revision() {
      return revision;
    },
    record(draft: Draft) {
      revision++;
      write(draft);
    },
    preview(draft: Draft, expectedRevision: number) {
      if (revision !== expectedRevision) return false;
      write(draft);
      return true;
    },
    acknowledge(expectedRevision: number, data: string) {
      if (revision !== expectedRevision) return false;
      const stored = JSON.parse(storage.getItem(key) ?? "null");
      if (
        stored?.journal?.session !== session ||
        stored.journal.revision !== revision ||
        stored.affine?.data !== data
      )
        return false;
      storage.removeItem(key);
      return true;
    },
  };
}
