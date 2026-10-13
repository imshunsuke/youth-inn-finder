import assert from "node:assert/strict";
import test from "node:test";
import { createQueryService } from "../src/application/query-service.mjs";
import { availabilityFromCount } from "../src/infrastructure/official-client.mjs";

const clock = () => new Date("2026-10-13T16:00:00Z"); // Shanghai: October 14.
const fetchedAt = "2026-10-13T15:59:00.000Z";
const listing = (id, extra = {}) => ({ id, name: `驿站${id}`, district: "浦东新区", street: "街道", address: "青年路", latitude: 31.23, longitude: 121.47, isOnShelf: true, ...extra });
function makeService({ items = [listing("1")], calendars = {}, availability = {}, ...options } = {}) {
  const calls = [];
  const client = {
    fetchListings: async (query) => { calls.push(["list", query]); return { items, fetchedAt }; },
    fetchCalendar: async (id) => { calls.push(["calendar", id]); if (calendars[id] instanceof Error) throw calendars[id]; return { calendar: calendars[id] ?? {}, fetchedAt }; },
    fetchDateAvailability: async (id, start, end) => {
      calls.push(["available", id, start, end]);
      if (availability[id] instanceof Error) throw availability[id];
      return { ...availabilityFromCount(availability[id]), fetchedAt };
    },
  };
  return { service: createQueryService({ client, clock, ...options }), calls };
}

test("calendar defaults to Shanghai today and masks local opening-rule days with null", async () => {
  const { service } = makeService({ calendars: { "1": { "2026-10-14": availabilityFromCount(9), "2026-10-15": availabilityFromCount(9), "2026-10-16": availabilityFromCount(0) } } });
  const result = await service.findCalendar({ days: 3 });
  assert.equal(result.startDate, "2026-10-14");
  assert.equal(result.meta.earliestOpenDate, "2026-10-16");
  assert.equal(result.meta.partial, false);
  assert.deepEqual(result.days.map(({ availabilityStatus, availableCount }) => ({ availabilityStatus, availableCount })), [
    { availabilityStatus: "not-open", availableCount: null },
    { availabilityStatus: "not-open", availableCount: null },
    { availabilityStatus: "open", availableCount: 0 },
  ]);
});

test("partial calendar preserves known results without presenting partial sums as full totals", async () => {
  const { service } = makeService({ items: [listing("1"), listing("2"), listing("3")], calendars: {
    "1": { "2026-10-16": availabilityFromCount(5) }, "2": {}, "3": new Error("failed"),
  } });
  const result = await service.findCalendar({ startDate: "2026-10-16", days: 1 });
  assert.equal(result.days[0].availableCount, null);
  assert.equal(result.days[0].stationCount, null);
  assert.equal(result.days[0].knownAvailableCount, 5);
  assert.equal(result.days[0].knownStationCount, 1);
  assert.deepEqual(result.days[0].items.map((item) => item.id), ["1"]);
  assert.equal(result.stations[1].availability[0].availableCount, null);
  assert.equal(result.stations[2].availability[0].availabilityStatus, "unknown");
  assert.deepEqual(result.meta.coverage, { totalStations: 3, successfulStations: 2, failedStations: 1, unknownStations: 2 });
  assert.equal(result.meta.partial, true);
  assert.equal(result.meta.oldestFetchedAt, fetchedAt);
});

test("compact calendar preserves aggregates, unknown coverage, dates and stations while default items remain compatible", async () => {
  for (const scenario of ["complete", "partial", "empty"]) {
    const items = scenario === "empty" ? [] : [listing("near"), listing("far", { latitude: 31.8 })];
    if (scenario === "partial") items.push(listing("missing"), listing("failed"));
    const { service } = makeService({ items, calendars: {
      near: { "2026-10-16": availabilityFromCount(2), "2026-10-17": availabilityFromCount(0) },
      far: { "2026-10-16": availabilityFromCount(5), "2026-10-17": availabilityFromCount(4) },
      missing: {}, failed: new Error("unavailable"),
    } });
    const query = { startDate: "2026-10-14", days: 4, minCount: 2, lat: "31.23", lon: "121.47", sort: "distance" };
    const legacy = await service.findCalendar(query);
    assert.deepEqual(await service.findCalendar({ ...query, includeDayItems: true }), legacy, scenario);
    const expected = { ...legacy, days: legacy.days.map(({ items, ...day }) => day) };
    for (const includeDayItems of [false, "false"]) {
      const compact = await service.findCalendar({ ...query, includeDayItems });
      assert.deepEqual(compact, expected, scenario);
      assert.equal(compact.days.some((day) => Object.hasOwn(day, "items")), false);
    }
    if (scenario !== "empty") {
      assert.deepEqual(legacy.days[2].items.map((item) => item.id), ["near", "far"]);
      assert.equal(legacy.days[2].knownAvailableCount, 7);
      assert.equal(legacy.days[3].knownAvailableCount, 4);
    }
    if (scenario === "partial") assert.deepEqual(legacy.meta.coverage,
      { totalStations: 4, successfulStations: 3, failedStations: 1, unknownStations: 2 });
  }
});

test("availability filters positive known counts, exposes partial coverage and sorts by distance", async () => {
  const { service } = makeService({ items: [listing("far", { latitude: 31.8 }), listing("near"), listing("zero"), listing("unknown"), listing("failed")], availability: {
    far: 3, near: 2, zero: 0, unknown: undefined, failed: new Error("failed"),
  } });
  const result = await service.findAvailable({ date: "2026-10-16", lat: "31.23", lon: "121.47" });
  assert.deepEqual(result.data.map((item) => item.id), ["near", "far"]);
  assert.equal(result.data[0].availabilityStatus, "known");
  assert.equal(result.data[0].distanceKm, 0);
  assert.equal(result.meta.partial, true);
  assert.deepEqual(result.meta.coverage, { totalStations: 5, successfulStations: 4, failedStations: 1, unknownStations: 2 });
});

test("interval lookup forwards genuine start/end dates rather than deriving daily minima", async () => {
  const { service, calls } = makeService({ availability: { "1": 4 } });
  const result = await service.findAvailable({ date: "2026-10-16", endDate: "2026-10-20" });
  assert.equal(result.data[0].availableCount, 4);
  assert.deepEqual(calls[1], ["available", "1", "2026-10-16", "2026-10-20"]);
  assert.equal(calls.some(([method]) => method === "calendar"), false);
});

test("unopened availability performs no station query and default date follows Shanghai", async () => {
  const { service, calls } = makeService();
  const result = await service.findAvailable();
  assert.equal(result.meta.date, "2026-10-14");
  assert.equal(result.meta.availabilityStatus, "not-open");
  assert.deepEqual(result.data, []);
  assert.equal(calls.length, 1);
});

test("keyword, district, shelf and station filters run before availability requests", async () => {
  const { service, calls } = makeService({ items: [
    listing("keep", { name: "青年人才驿站" }), listing("off", { name: "青年人才驿站", isOnShelf: false }),
    listing("other", { name: "青年人才驿站", district: "徐汇区" }), listing("unmatched", { address: "其他路" }),
  ], availability: { keep: 2 } });
  const result = await service.findAvailable({ date: "2026-10-16", q: "人才", district: "浦东新区", onlyOnShelf: "true", stationId: "keep" });
  assert.deepEqual(result.data.map((item) => item.id), ["keep"]);
  assert.equal(calls.filter(([method]) => method === "available").length, 1);
  assert.equal(result.meta.coverage.totalStations, 1);
});

test("nearest excludes invalid coordinates while availability may still show that station", async () => {
  const { service } = makeService({ items: [listing("missing", { latitude: null }), listing("good")], availability: { missing: 2, good: 1 } });
  const nearest = await service.findNearest({ lat: "31.23", lon: "121.47" });
  assert.deepEqual(nearest.data.map((item) => item.id), ["good"]);
  const available = await service.findAvailable({ date: "2026-10-16", lat: "31.23", lon: "121.47" });
  assert.deepEqual(available.data.map((item) => item.id), ["good", "missing"]);
  assert.equal(available.data[1].distanceKm, null);
});

test("validation happens before official calls, including fractional days and bad limit", async () => {
  const { service, calls } = makeService();
  for (const run of [
    () => service.findCalendar({ days: "1.9" }), () => service.findCalendar({ startDate: "2026-02-30" }),
    () => service.findCalendar({ includeDayItems: "maybe" }),
    () => service.findAvailable({ date: "2026-10-16", limit: "abc" }), () => service.findNearest({ lat: "1000", lon: "1000" }),
  ]) await assert.rejects(run(), (error) => error.status === 400);
  assert.equal(calls.length, 0);
});

test("all station failures are explicit partial unknown data, never fabricated zeros", async () => {
  const { service } = makeService({ calendars: { "1": new Error("failed") }, availability: { "1": new Error("failed") } });
  const calendar = await service.findCalendar({ startDate: "2026-10-16", days: 1 });
  assert.equal(calendar.days[0].availableCount, null);
  assert.equal(calendar.meta.coverage.failedStations, 1);
  const available = await service.findAvailable({ date: "2026-10-16" });
  assert.deepEqual(available.data, []);
  assert.equal(available.meta.partial, true);
  assert.equal(available.meta.coverage.unknownStations, 1);
});

test("service worker concurrency is bounded and a station failure does not abandon later stations", async () => {
  let active = 0;
  let maximum = 0;
  let finished = 0;
  const client = {
    fetchListings: async () => ({ items: Array.from({ length: 8 }, (_, index) => listing(String(index))), fetchedAt }),
    fetchCalendar: async () => ({ calendar: {}, fetchedAt }),
    fetchDateAvailability: async (id) => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1; finished += 1;
      if (id === "0") throw new Error("failed");
      return { ...availabilityFromCount(1), fetchedAt };
    },
  };
  const service = createQueryService({ client, clock, concurrency: 2 });
  const result = await service.findAvailable({ date: "2026-10-16" });
  assert.equal(maximum, 2);
  assert.equal(finished, 8);
  assert.equal(result.data.length, 7);
});
