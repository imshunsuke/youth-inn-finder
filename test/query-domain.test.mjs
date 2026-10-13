import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/domain/errors.mjs";
import { addDays, parseIsoDate, todayInShanghai, validateStayDates } from "../src/domain/dates.mjs";
import { haversineKm, parseCommonQuery, parseInteger, sortListings } from "../src/domain/query.mjs";

test("Shanghai business date crosses midnight independently of host timezone", () => {
  assert.equal(todayInShanghai(() => new Date("2026-10-13T15:59:59Z")), "2026-10-13");
  assert.equal(todayInShanghai(() => new Date("2026-10-13T16:00:00Z")), "2026-10-14");
});

test("dates preserve leap days, month and year boundaries", () => {
  assert.equal(parseIsoDate("2024-02-29"), "2024-02-29");
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  for (const date of ["2026-02-29", "2026-02-30", "2026-13-01", "2026-1-01", "", null]) {
    assert.throws(() => parseIsoDate(date), (error) => error instanceof AppError && error.status === 400);
  }
  assert.throws(() => validateStayDates("2026-10-14", "2026-10-14"), /晚于/);
});

test("bounded integers reject truncation, NaN, nondecimal and oversized inputs", () => {
  const options = { field: "days", fallback: 21, min: 1, max: 31 };
  assert.equal(parseInteger(undefined, options), 21);
  assert.equal(parseInteger("31", options), 31);
  for (const value of [0, -1, 32, 1.9, "1.9", "1e1", "0x10", "", " ", "abc", Infinity, true]) {
    assert.throws(() => parseInteger(value, options), (error) => error.code === "INVALID_INPUT");
  }
});

test("query validates coordinate boundaries, pairs, sort, booleans and house type", () => {
  assert.equal(parseCommonQuery({ lat: "-90", lon: "180" }).latitude, -90);
  assert.equal(parseCommonQuery({ onlyOnShelf: "false" }).onlyOnShelf, false);
  assert.equal(parseCommonQuery({ onlyOnShelf: "true", houseType: 1 }).houseType, "1");
  for (const query of [
    { lat: "91", lon: "121" }, { lat: "31", lon: "181" }, { lat: "31" },
    { lat: "NaN", lon: "0" }, { lat: "0x10", lon: "0" }, { sort: "distance" },
    { limit: "abc" }, { minCount: "1.5" }, { houseType: "2" },
    { onlyOnShelf: "maybe" }, { q: "x".repeat(101) }, { sort: "random" },
  ]) assert.throws(() => parseCommonQuery(query), (error) => error.status === 400);
});

test("distance is finite for antipodal points and zero for same coordinate", () => {
  assert.equal(haversineKm(31.23, 121.47, 31.23, 121.47), 0);
  assert.ok(Number.isFinite(haversineKm(90, 180, -90, 0)));
});

test("reused Shanghai formatter reads the injected clock on every call", () => {
  let time = new Date("2026-12-31T15:59:59Z");
  const clock = () => time;
  assert.equal(todayInShanghai(clock), "2026-12-31");
  time = new Date("2026-12-31T16:00:00Z");
  assert.equal(todayInShanghai(clock), "2027-01-01");
  time = new Date("2024-02-29T15:59:59Z");
  assert.equal(todayInShanghai(clock), "2024-02-29");
});

test("cached Chinese sorting preserves default localeCompare ordering and tie breaks", () => {
  const names = ["静安驿站", "长宁驿站", "徐汇驿站", "青年2号", "青年10号", "Alpha", "alpha", "Álpha", "青年-驿站", "青年驿站"];
  const items = names.map((name, index) => ({ id: String(index), name, availableCount: index % 3, latitude: 31.23, longitude: 121.47 }));
  const expectedNames = items.slice().sort((a, b) => a.name.localeCompare(b.name, "zh-CN")).map((item) => item.id);
  assert.deepEqual(sortListings(items, parseCommonQuery({ sort: "name" })).map((item) => item.id), expectedNames);
  assert.deepEqual(sortListings(items, parseCommonQuery({ sort: "distance", lat: 31.23, lon: 121.47 })).map((item) => item.id), expectedNames);
  const expectedAvailability = items.slice().sort((a, b) => b.availableCount - a.availableCount || a.name.localeCompare(b.name, "zh-CN")).map((item) => item.id);
  assert.deepEqual(sortListings(items, parseCommonQuery()).map((item) => item.id), expectedAvailability);
});
