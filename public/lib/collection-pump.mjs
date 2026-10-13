import { request } from "./api.mjs";
import { intervalRetry } from "./interval-status.mjs";

// One small POST per pending query tick. Keep collection in its own invocation so
// catalog parsing and upstream work do not share the same free CPU budget.
export function createCollectionPump({ requestImpl = request, clock = () => Date.now() } = {}) {
  let inFlight = null, retryAt = 0;
  return {
    advance(meta, { visible = true } = {}) {
      if (!visible || !meta?.pending || meta.collection?.advanceUrl !== "/api/collection" || clock() < retryAt) return Promise.resolve(null);
      if (inFlight) return inFlight;
      retryAt = clock() + 10_000;
      inFlight = requestImpl("/api/collection", { method: "POST", timeoutMs: 20_000 }).then((result) => {
        retryAt = intervalRetry({ retryAfter: result.retryAfter, refreshAfterMs: 10_000 }, clock()).retryAt;
        return result.payload;
      }).catch((error) => {
        retryAt = intervalRetry({ ...error, refreshAfterMs: 60_000 }, clock()).retryAt;
        throw error;
      }).finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
