import { AppError } from "../domain/errors.mjs";
import { createOfficialClient } from "../infrastructure/official-client.mjs";
import { createSnapshotStore } from "../infrastructure/snapshot-store.mjs";

export const INTERACTIVE_REFRESH_MS = 2000;
export const INTERACTIVE_COOLDOWN_MS = 1000;

/** A small, request-triggered supplement to Cron. No email/reminder scans or large
 * catalog parsing. Shared lease, cooldown, daily quota and durable retry state
 * bound work even when many visitors poll the same range at once. */
export async function collectInteractiveIntervals({ db, clock = () => new Date(), fetchImpl,
  budget = 9, cooldownMs = INTERACTIVE_COOLDOWN_MS, dailyLimit = 6000, timeoutMs = 6000 } = {}) {
  if (!Number.isInteger(budget) || budget < 1 || budget > 9 || !Number.isFinite(cooldownMs) || cooldownMs < INTERACTIVE_COOLDOWN_MS ||
      !Number.isInteger(dailyLimit) || dailyLimit < budget || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 6000) {
    throw new TypeError("Invalid interactive collection budget");
  }
  const store = createSnapshotStore({ db, clock });
  if (!(await store.dueIntervalJobs(1)).length) {
    const nextAttemptAt = await store.nextIntervalAttemptAt();
    return { status: "idle", attempted: 0, succeeded: 0,
      retryAfterMs: nextAttemptAt === null ? 10_000 : Math.max(1000, Math.min(60_000, nextAttemptAt - new Date(clock()).getTime())) };
  }
  const lease = await store.acquireInteractiveLease({ budget, cooldownMs, dailyLimit });
  if (!lease) {
    const row = await db.prepare("SELECT interactive_day,interactive_requests,interactive_started_at,lease_until,collection_wait_until FROM query_collector_state WHERE name='official'").first();
    const at = new Date(clock()).getTime();
    const exhausted = row?.interactive_day === Math.floor(new Date(clock()).getTime() / 86_400_000) && row.interactive_requests >= dailyLimit;
    return { status: "throttled", reason: exhausted ? "daily-budget" : "busy", attempted: 0, succeeded: 0,
      retryAfterMs: exhausted ? 60_000 : row?.lease_until > at || row?.collection_wait_until > at ? 2000
        : Math.max(100, Math.min(1000, (row?.interactive_started_at ?? at) + cooldownMs - at)) };
  }
  let attempted = 0;
  try {
    const jobs = await store.dueIntervalJobs(lease.interactiveReserved);
    const client = createOfficialClient({ clock, fetchImpl, concurrency: 6, cacheTtlMs: 0, timeoutMs });
    const successes = [], failures = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        const task = { stationId: job.station_id, startDate: job.start_date, endDate: job.end_date };
        try {
          attempted++;
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
    await store.releaseLease(lease, { interactiveUsed: attempted });
  }
}
