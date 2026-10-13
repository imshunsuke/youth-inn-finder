import { createApp, mailConfigured } from "./http/app.mjs";
import { createCollector } from "./application/collector.mjs";
import { createQueryService } from "./application/query-service.mjs";
import { createSnapshotClient } from "./infrastructure/snapshot-store.mjs";
import { runMonitor } from "./application/monitor.mjs";
import { createReminderStore } from "./infrastructure/reminder-store.mjs";

export async function runScheduled(env, { clock = () => new Date(), fetchImpl = (...args) => globalThis.fetch(...args), phase = "all" } = {}) {
  if (!env.DB) return { disabled: true, reason: "storage-unavailable" };
  const result = {};
  if (["all", "collection"].includes(phase)) {
    try {
      result.collection = await createCollector({ db: env.DB, clock, fetchImpl, budget: 20, maxCatalogRefreshes: 1, leaseWaitMs: 25_000 }).run();
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
    const response = await createApp({ env, interactiveCollection: true })(request);
    if (env.CF_VERSION_METADATA?.id) response.headers.set("X-Deployment-Id", env.CF_VERSION_METADATA.id);
    return response;
  },
  async scheduled(controller, env) {
    const phase = controller.cron === "*/2 * * * *" ? "collection" : controller.cron === "0 19 * * *" ? "cleanup" : "monitor";
    return runScheduled(env, { phase });
  },
};
