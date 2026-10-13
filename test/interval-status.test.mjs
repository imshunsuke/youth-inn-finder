import assert from "node:assert/strict";
import test from "node:test";
import { intervalFeedback, intervalRetry } from "../public/lib/interval-status.mjs";

const coverage = { totalStations: 90, freshStations: 12, lastFailedStations: 0 };
test("rejected and partially admitted ranges never claim all work is being collected", () => {
  const full = intervalFeedback({ snapshotCoverage: coverage, collection: { status: "capacity-limited", requested: 78, accepted: 0, capacityLimited: true } });
  assert.equal(full.title, "查询队列已满"); assert.match(full.description, /暂未入队/); assert.match(full.summary, /已更新 12\/90/);
  const partial = intervalFeedback({ snapshotCoverage: coverage, collection: { status: "capacity-limited", requested: 78, accepted: 20, capacityLimited: true } });
  assert.equal(partial.title, "部分查询尚未入队"); assert.match(partial.description, /20\/78/); assert.match(partial.summary, /58 个/);
});
test("queued zero-room partial data and failed observations remain distinct from no-room success", () => {
  const queued = intervalFeedback({ snapshotCoverage: coverage, collection: { status: "queued", requested: 78, accepted: 78 } });
  assert.equal(queued.title, "已更新部分驿站"); assert.match(queued.description, /陆续显示/);
  const cold = intervalFeedback({ snapshotCoverage: { ...coverage, freshStations: 0 }, collection: { status: "queued", requested: 90, accepted: 90 } });
  assert.equal(cold.title, "等待首批查询结果"); assert.match(cold.summary, /等待首批结果/);
  const failed = intervalFeedback({ snapshotCoverage: { ...coverage, lastFailedStations: 2 }, collection: { status: "queued", requested: 78, accepted: 78 } });
  assert.match(failed.title, /暂时查不到数据/); assert.match(failed.description, /查询失败/);
  assert.equal(intervalFeedback({ pending: true }).title, "区间结果尚未准备好");
});
test("automatic retry honors Retry-After seconds and dates, and stops on permanent input errors", () => {
  const now = Date.parse("2026-10-13T04:00:00Z");
  assert.deepEqual(intervalRetry({ status: 429, retryAfter: "180" }, now), { retryable: true, retryAt: now + 180_000 });
  assert.equal(intervalRetry({ status: 503, retryAfter: new Date(now + 300_000).toUTCString() }, now).retryAt, now + 300_000);
  for (const status of [400, 401, 403, 404, 422]) assert.equal(intervalRetry({ status }, now).retryable, false);
  for (const status of [0, 408, 429, 500, 503]) assert.equal(intervalRetry({ status }, now).retryable, true);
  assert.equal(intervalRetry({ refreshAfterMs: 90_000, retryAfter: "invalid" }, now).retryAt, now + 90_000);
  assert.equal(intervalRetry({ refreshAfterMs: 10_000, retryAfter: "10" }, now).retryAt, now + 10_000);
  assert.equal(intervalRetry({ status: 429, refreshAfterMs: 10_000, retryAfter: "600" }, now).retryAt, now + 600_000);
});
