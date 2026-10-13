export const COLLECTION_CRON = "* * * * *";
export const MONITOR_CRON = "*/2 * * * *";
// Same average upstream budget as 20 requests every two minutes, with smaller
// per-invocation CPU peaks. Reminder due times remain independently persisted.
export const COLLECTION_POLICY = Object.freeze({ budget: 10, maxCatalogRefreshes: 1, leaseWaitMs: 25_000 });
