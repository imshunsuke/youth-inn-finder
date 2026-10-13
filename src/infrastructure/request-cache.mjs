import { clockDate } from "../domain/dates.mjs";

// Process-local query cache. Persistent polling snapshots belong in a storage adapter.
export function createRequestCache({ ttlMs = 60_000, maxEntries = 512, clock = () => new Date() } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs < 0 || !Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError("Invalid cache configuration");
  }
  const entries = new Map();
  const inFlight = new Map();
  return {
    async getOrLoad(key, loader) {
      const cached = entries.get(key);
      if (cached && cached.expiresAt > clockDate(clock).getTime()) return cached.value;
      if (cached) entries.delete(key);
      if (inFlight.has(key)) return inFlight.get(key);
      const pending = Promise.resolve().then(loader).then((value) => {
        if (ttlMs > 0) {
          while (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
          entries.set(key, { value, expiresAt: clockDate(clock).getTime() + ttlMs });
        }
        return value;
      }).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
      return pending;
    },
    clear() { entries.clear(); },
  };
}

export function createConcurrencyLimiter(concurrency = 3) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) throw new TypeError("concurrency must be 1–6");
  let active = 0;
  const queue = [];
  function drain() {
    while (active < concurrency && queue.length) {
      const { task, resolve, reject } = queue.shift();
      active += 1;
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        active -= 1;
        drain();
      });
    }
  }
  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    drain();
  });
}
