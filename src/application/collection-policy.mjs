export const COLLECTION_CRON = "* * * * *";
export const MONITOR_CRON = "*/2 * * * *";
// Public cold ranges use bounded foreground bursts. Cron keeps the shared
// calendar and invite-only reminders warm with a smaller CPU/request slice.
export const COLLECTION_POLICY = Object.freeze({ budget: 6, maxCatalogRefreshes: 1, leaseWaitMs: 25_000 });
