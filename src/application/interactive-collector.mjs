import { AppError } from "../domain/errors.mjs";
import { createOfficialClient } from "../infrastructure/official-client.mjs";
import { createSnapshotStore } from "../infrastructure/snapshot-store.mjs";

export const INTERACTIVE_REFRESH_MS = 10_000;

/** A small, request-triggered supplement to Cron. No email/reminder scans or large
 * catalog parsing. Shared lease, cooldown, daily quota and durable retry state
 * bound work even when many visitors poll the same range at once. */
export async function collectInteractiveIntervals({ db, clock = () => new Date(), fetchImpl,
  budget = 9, cooldownMs = INTERACTIVE_REFRESH_MS, dailyLimit = 6000, timeoutMs = 6000 } = {}) {
  if (!Number.isInteger(budget) || budget < 1 || budget > 9 || !Number.isFinite(cooldownMs) || cooldownMs < 10_000 ||
      !Number.isInteger(dailyLimit) || dailyLimit < budget || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 6000) {
    throw new TypeError("Invalid interactive collection budget");
  }
  const store = createSnapshotStore({ db, clock });
  const lease = await store.acquireInteractiveLease({ budget, cooldownMs, dailyLimit });
  if (!lease) return { status: "throttled", attempted: 0, succeeded: 0 };
  try {
    const jobs = await store.dueIntervalJobs(budget);
    const client = createOfficialClient({ clock, fetchImpl, concurrency: 3, cacheTtlMs: 0, timeoutMs });
    const successes = [], failures = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        const task = { stationId: job.station_id, startDate: job.start_date, endDate: job.end_date };
        try {
          successes.push({ ...task, ...await client.fetchDateAvailability(task.stationId, task.startDate, task.endDate) });
        } catch (error) {
          const failureCount = job.failure_count + 1;
          failures.push({ ...task, failureCount, code: error instanceof AppError ? error.code : "COLLECTION_ERROR",
            nextAttemptAt: new Date(clock()).getTime() + Math.min(900_000, 60_000 * 2 ** Math.min(8, failureCount - 1)) });
        }
      }
    }));
    await store.saveIntervalBatch(successes, failures, { lease });
    return { status: "collected", attempted: jobs.length, succeeded: successes.length, failed: failures.length };
  } finally {
    await store.releaseLease(lease);
  }
}
