/**
 * Serializes writes per card.
 *
 * Two writes to one card inside the same second would carry equal
 * `updatedAt` and `created_at` stamps (both are whole seconds), and both the
 * relay's replacement rule and the board's merge settle such a tie by event
 * id — a coin toss over which write survives. Chaining the writes of one
 * card means the second is built and stamped only after the first has
 * settled and been folded into the cache, so it strictly follows it.
 * A failed write does not block the ones queued behind it.
 */
export class CommunityTaskWriteQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /** Runs `job` after every earlier job for `key`; resolves with its result. */
  enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.then(() => job());
    const settled: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, settled);
    void settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return run;
  }

  /** Whether a write for `key` is still in flight or waiting. */
  isBusy(key: string): boolean {
    return this.tails.has(key);
  }
}
