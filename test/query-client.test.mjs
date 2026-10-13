import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/domain/errors.mjs";
import { availabilityFromCount, createOfficialClient, normalizeCalendar, normalizeListing } from "../src/infrastructure/official-client.mjs";

const clock = () => new Date("2026-10-13T04:00:00Z");
const response = (data, { success = true, status = 200 } = {}) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => JSON.stringify({ success, data }),
});

test("upstream count normalization distinguishes explicit zero from missing and malformed values", () => {
  for (const value of [0, "0", "0.0", " 0 "]) assert.deepEqual(availabilityFromCount(value), { availabilityStatus: "known", availableCount: 0 });
  for (const value of [undefined, null, "", " ", "unknown", "-1", 1.5, true, {}, Infinity]) {
    assert.deepEqual(availabilityFromCount(value), { availabilityStatus: "unknown", availableCount: null });
  }
});

test("calendar missing dates remain missing and conflicting duplicate data is unknown", () => {
  const result = normalizeCalendar([
    { applyDate: "2026-10-15", applyNumber: "0" },
    { applyDate: "2026-10-16", applyNumber: 1 },
    { applyDate: "2026-10-16", applyNumber: 2 },
    { applyDate: "2026-10-16", applyNumber: 1 },
    { applyDate: "2026-10-17", applyNumber: "bad" },
    { applyDate: "2026-02-30", applyNumber: 9 },
  ]);
  assert.equal(result["2026-10-15"].availableCount, 0);
  assert.equal(result["2026-10-16"].availableCount, null);
  assert.equal(result["2026-10-17"].availabilityStatus, "unknown");
  assert.equal(result["2026-10-18"], undefined);
  assert.equal(result["2026-02-30"], undefined);
});

test("listing normalization preserves official detail payload and rejects invalid listing coordinates", () => {
  const item = normalizeListing({ id: 7, name: " 驿站 ", xmid: "x", projectPic: "https://example.com/a.png", latitude: 1000, longitude: "121.5", houseCount: "bad", isOnShelf: "1" });
  assert.equal(item.name, "驿站");
  assert.equal(item.latitude, null);
  assert.equal(item.longitude, 121.5);
  assert.equal(item.houseCount, null);
  assert.equal(item.isOnShelf, true);
  assert.equal(JSON.parse(new URL(item.officialUrl).searchParams.get("passObj")).xmid, "x");
});

test("client only issues allowlisted GET requests and authorized interval POST with exact dates", async () => {
  const calls = [];
  const client = createOfficialClient({ clock, fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (url.includes("housList")) return response([{ id: 7, name: "驿站" }]);
    if (url.includes("calendar")) return response([{ applyDate: "2026-10-15", applyNumber: 0 }]);
    return response({ idleCnt: 2 });
  } });
  await client.fetchListings({ houseType: "1" });
  assert.equal((await client.fetchDateAvailability("7", "2026-10-15")).availableCount, 0);
  assert.equal((await client.fetchDateAvailability("7", "2026-10-16")).availableCount, null);
  const interval = await client.fetchDateAvailability("7", "2026-10-15", "2026-10-18");
  assert.equal(interval.availableCount, 2);
  assert.equal(interval.fetchedAt, clock().toISOString());
  assert.deepEqual(calls.map(({ url, options }) => `${options.method} ${url.pathname}`), [
    "GET /qnyzApi/hous/housList", "GET /qnyzApi/hous/calendar", "POST /qnyzApi/into/idleHouseCnt",
  ]);
  assert.equal(calls[0].url.searchParams.get("housType"), "1");
  assert.deepEqual(JSON.parse(calls[2].options.body), { intoDate: "2026-10-15", endDate: "2026-10-18", houseId: "7" });
  assert.ok(calls.every(({ options }) => options.redirect === "manual"));
});

test("client rejects every redirect without following Location or caching the redirect", async () => {
  for (const status of [300, 301, 302, 303, 304, 305, 307, 308, 399]) {
    let calls = 0;
    const client = createOfficialClient({ clock, fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(options.redirect, "manual");
      if (calls === 1) return { ok: false, status, headers: new Headers({ Location: "https://elsewhere.example.test/private" }),
        text: async () => { throw new Error("redirect body must not be consumed"); } };
      return response([]);
    } });
    await assert.rejects(client.fetchListings(), (error) => error.code === "UPSTREAM_REDIRECT" && error.status === 502 && error.retryable === false);
    assert.equal(calls, 1, "no second request follows Location");
    assert.deepEqual((await client.fetchListings()).items, []);
    assert.equal(calls, 2, "a new explicit query retries instead of caching a redirect");
  }
});

test("same inflight requests coalesce and successful data expires after TTL", async () => {
  let now = Date.parse("2026-10-13T04:00:00Z");
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = createOfficialClient({ clock: () => new Date(now), cacheTtlMs: 1000, fetchImpl: async () => {
    calls += 1;
    await gate;
    return response([{ id: 1 }]);
  } });
  const requests = [client.fetchListings(), client.fetchListings(), client.fetchListings()];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  const values = await Promise.all(requests);
  await client.fetchListings();
  assert.equal(calls, 1);
  assert.equal(values[0].fetchedAt, "2026-10-13T04:00:00.000Z");
  now += 1000;
  await client.fetchListings();
  assert.equal(calls, 2);
});

test("HTTP, invalid JSON, rejected and malformed payload failures are not cached or exposed verbatim", async () => {
  const brokenResponses = [
    { ok: false, status: 503, text: async () => "PRIVATE_UPSTREAM_BODY" },
    { ok: true, status: 200, text: async () => "PRIVATE_UPSTREAM_BODY" },
    response([], { success: false }), response({}),
  ];
  for (const broken of brokenResponses) {
    let calls = 0;
    const client = createOfficialClient({ clock, fetchImpl: async () => { calls += 1; return calls === 1 ? broken : response([]); } });
    await assert.rejects(client.fetchListings(), (error) => error instanceof AppError && error.status === 502 && !error.message.includes("PRIVATE_UPSTREAM_BODY"));
    assert.deepEqual((await client.fetchListings()).items, []);
    assert.equal(calls, 2);
  }
});

test("upstream timeout is classified and aborts the fetch", async () => {
  const client = createOfficialClient({ timeoutMs: 5, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }) });
  await assert.rejects(client.fetchListings(), (error) => error.code === "UPSTREAM_TIMEOUT" && error.status === 504);
});

test("timeout remains active while reading the response body", async () => {
  const client = createOfficialClient({ timeoutMs: 5, fetchImpl: async (_url, { signal }) => ({
    ok: true, status: 200,
    text: () => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("body aborted", "AbortError")), { once: true });
    }),
  }) });
  await assert.rejects(client.fetchListings(), (error) => error.code === "UPSTREAM_TIMEOUT" && error.status === 504);
});

test("client globally bounds upstream concurrency across independent queries", async () => {
  let active = 0;
  let maximum = 0;
  const client = createOfficialClient({ clock, concurrency: 2, fetchImpl: async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return response([]);
  } });
  await Promise.all(Array.from({ length: 9 }, (_, index) => client.fetchCalendar(String(index))));
  assert.equal(maximum, 2);
});

test("invalid client arguments fail before any upstream call", async () => {
  let calls = 0;
  const client = createOfficialClient({ fetchImpl: async () => { calls += 1; return response([]); } });
  await assert.rejects(client.fetchListings({ houseType: "2" }), (error) => error.status === 400);
  await assert.rejects(client.fetchCalendar(""), (error) => error.status === 400);
  await assert.rejects(client.fetchDateAvailability("1", "2026-10-15", "2026-10-14"), (error) => error.status === 400);
  assert.equal(calls, 0);
});
