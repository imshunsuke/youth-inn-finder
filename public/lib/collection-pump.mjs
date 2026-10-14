import { request } from "./api.mjs";
import { intervalRetry } from "./interval-status.mjs";

// One small POST per pending query tick. Keep collection in its own invocation so
// catalog parsing and upstream work do not share the same free CPU budget.
export function createCollectionPump({ requestImpl = request, clock = () => Date.now(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let inFlight = null, retryAt = 0, draining = null, burstKey = null, burstUntil = 0;
  const pump = {
    observe(key, meta) {
      if (meta?.pending && key !== burstKey) { burstKey = key; burstUntil = clock() + 60_000; }
      else if (!meta?.pending && key === burstKey) { burstKey = null; burstUntil = 0; }
    },
    pollDelay(key) { return key === burstKey && clock() < burstUntil ? 2000 : 10_000; },
    advance(meta, { visible = true } = {}) {
      if (!visible || !meta?.pending || meta.collection?.advanceUrl !== "/api/collection") return Promise.resolve(null);
      if (inFlight) return inFlight;
      if (clock() < retryAt) return Promise.resolve(null);
      // A small transit margin avoids arriving just before the server's one-second
      // lease clock and turning a successful batch into a long busy retry.
      retryAt = clock() + 1250;
      inFlight = requestImpl("/api/collection", { method: "POST", timeoutMs: 20_000 }).then((result) => {
        // Successful work already spent part of the start-to-start cooldown.
        // Waiting another full interval after its response skips every other tick.
        if (result.payload?.status === "throttled") {
          const delay = Number.isFinite(result.payload.retryAfterMs) ? result.payload.retryAfterMs
            : /^\d+$/.test(result.retryAfter ?? "") ? Number(result.retryAfter) * 1000 : 2000;
          retryAt = clock() + Math.max(100, Math.min(600_000, delay));
        } else if (result.payload?.status === "idle") retryAt = clock() + Math.max(1000,
          /^\d+$/.test(result.retryAfter ?? "") ? Number(result.retryAfter) * 1000 : 10_000);
        return result.payload;
      }).catch((error) => {
        retryAt = intervalRetry({ ...error, refreshAfterMs: 60_000 }, clock()).retryAt;
        throw error;
      }).finally(() => { inFlight = null; });
      return inFlight;
    },
    drain(key, read, onProgress = () => {}) {
      const current = read(); pump.observe(key, current?.meta);
      if (draining) return draining;
      if (pump.pollDelay(key) !== 2000) return pump.advance(current?.meta, { visible: current?.visible }).then(onProgress);
      draining = (async () => {
        while (clock() < burstUntil && key === burstKey) {
          const next = read();
          if (!next?.visible || !next.meta?.pending || next.meta.collection?.advanceUrl !== "/api/collection") break;
          const report = await pump.advance(next.meta, { visible: next.visible });
          if (report) onProgress(report);
          await wait(Math.min(1000, Math.max(50, retryAt - clock())));
        }
      })().finally(() => { draining = null; });
      return draining;
    },
  };
  return pump;
}
