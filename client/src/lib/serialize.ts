/**
 * Run work one-at-a-time per key.
 *
 * Everything that changes a day's entries does load → modify → save. Those are
 * three awaits against async storage, so two of them interleave freely: both
 * read the same file, and whichever saves second writes back a snapshot taken
 * before the other's change. The lost write is silent. A sync landing while an
 * entry is being written is the everyday version, and a partner's entry
 * vanishing from a phone is the version that matters.
 */
const queues = new Map<string, Promise<unknown>>();

export function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // Chain onto whatever is queued for this key, running either way — one
  // caller's failure must not strand the rest.
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.then(fn, fn);

  const settled = result.then(
    () => {},
    () => {}
  );
  queues.set(key, settled);
  settled.then(() => {
    // Only drop the queue if nothing joined behind us in the meantime.
    if (queues.get(key) === settled) queues.delete(key);
  });

  return result;
}
