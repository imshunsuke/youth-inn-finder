import { createApp, mailConfigured } from "./http/app.mjs";
import { createCollector } from "./application/collector.mjs";
import { createQueryService } from "./application/query-service.mjs";
import { createSnapshotClient } from "./infrastructure/snapshot-store.mjs";
import { runMonitor } from "./application/monitor.mjs";
import { createReminderStore } from "./infrastructure/reminder-store.mjs";
import { COLLECTION_CRON, COLLECTION_POLICY } from "./application/collection-policy.mjs";
import { createQueryResponseCache } from "./infrastructure/query-response-cache.mjs";
import { measureD1Usage } from "./infrastructure/d1-usage.mjs";

const queryCaches = new WeakMap();
async function withUsage(env, phase, work) {
  if (!env.DB || env.D1_USAGE_METRICS === "false") return work(env);
  const usage = measureD1Usage(env.DB);
  try { return await work({ ...env, DB: usage.db }); }
  finally { console.info(JSON.stringify({ event: "d1_usage", phase, ...usage.summary() })); }
}

export async function runScheduled(env, { clock = () => new Date(), fetchImpl = (...args) => globalThis.fetch(...args), phase = "all" } = {}) {
  if (!env.DB) return { disabled: true, reason: "storage-unavailable" };
  const result = {};
  if (["all", "collection"].includes(phase)) {
    try {
      result.collection = await createCollector({ db: env.DB, clock, fetchImpl, ...COLLECTION_POLICY }).run();
      const { status, requestsUsed, catalogs, calendars, intervals } = result.collection;
      console.info(JSON.stringify({ event: "collection_summary", status, requestsUsed, catalogs, calendars, intervals }));
    } catch {
      result.collection = { failed: true };
      console.error(JSON.stringify({ event: "collection_failed", code: "COLLECTION_ERROR" }));
    }
  }
  if (["all", "monitor"].includes(phase) && env.ENABLE_MONITORING !== "false" && mailConfigured(env)) {
    const queryService = createQueryService({ client: createSnapshotClient({ db: env.DB, clock }), clock });
    result.monitoring = await runMonitor({ db: env.DB, env, queryService, clock, limit: 3, sendLimit: 2, cleanup: false });
  }
  if (phase === "cleanup") {
    await createReminderStore(env.DB, { clock }).cleanup(new Date(clock()).toISOString());
    await env.DB.prepare("DELETE FROM http_rate_limits WHERE expires_at < ?").bind(new Date(clock()).getTime()).run();
    result.cleaned = true;
  }
  return result;
}

export default {
  async fetch(request, env) {
    if (env.DB && !queryCaches.has(env.DB)) queryCaches.set(env.DB, createQueryResponseCache());
    const response = await withUsage(env, "fetch", (measuredEnv) => createApp({ env: measuredEnv, interactiveCollection: true,
      queryCache: env.DB ? queryCaches.get(env.DB) : undefined })(request));
    if (env.CF_VERSION_METADATA?.id) response.headers.set("X-Deployment-Id", env.CF_VERSION_METADATA.id);
    return response;
  },
  async scheduled(controller, env) {
    const phase = controller.cron === COLLECTION_CRON ? "collection" : controller.cron === "0 19 * * *" ? "cleanup" : "monitor";
    return withUsage(env, phase, (measuredEnv) => runScheduled(measuredEnv, { phase }));
  },
};
