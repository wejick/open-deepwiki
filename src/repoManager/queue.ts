/**
 * Bounded-concurrency work queue (batch import, nightly updates).
 * `maxParallel` items in flight; every item's promise is awaited before the
 * queue resolves. First error is rethrown after in-flight work settles.
 */
export async function runQueue<T>(
  items: T[],
  maxParallel: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  let inFlight = 0;
  let firstError: unknown = null;

  await new Promise<void>((resolve) => {
    const pump = () => {
      while (inFlight < maxParallel && idx < items.length) {
        inFlight++;
        const item = items[idx];
        idx++;
        worker(item as T)
          .catch((err) => {
            firstError ??= err;
          })
          .finally(() => {
            inFlight--;
            if (idx >= items.length && inFlight === 0) resolve();
            else pump();
          });
      }
    };
    pump();
  });

  if (firstError !== null) throw firstError;
}
