import assert from "node:assert/strict";
import test from "node:test";

import {
  filterListings,
  haversineKm,
  normalizeHouseType,
  sortAvailable,
  sortNearest,
  validateStayDates,
} from "../public/src/domain.mjs";
import { normalizeListing } from "../public/src/api.mjs";
import { findAvailable, findCalendar } from "../public/src/service.mjs";

function plusDays(offset) {
  const now = new Date();
  now.setDate(now.getDate() + offset);
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((value, index) => (index === 0 ? String(value) : String(value).padStart(2, "0")))
    .join("-");
}

test("same coordinate has zero distance", () => {
  assert.equal(haversineKm(31.23, 121.47, 31.23, 121.47), 0);
});

test("nearest results are sorted by distance", () => {
  const results = sortNearest(
    [
      { id: "far", name: "远", latitude: 31.3, longitude: 121.47 },
      { id: "near", name: "近", latitude: 31.231, longitude: 121.471 },
    ],
    31.23,
    121.47,
    10,
  );
  assert.deepEqual(results.map((item) => item.id), ["near", "far"]);
});

test("stay dates require checkout after check-in", () => {
  assert.deepEqual(validateStayDates("2026-09-06", "2026-09-10"), {
    startDate: "2026-09-06",
    endDate: "2026-09-10",
  });
  assert.throws(
    () => validateStayDates("2026-09-10", "2026-09-06"),
    /离店日期必须晚于入住日期/,
  );
});

test("available service filters by date and sorts by distance", async () => {
  const listings = [
    { id: "far", name: "远", district: "测试区", isOnShelf: true, latitude: 31.3, longitude: 121.47 },
    { id: "near", name: "近", district: "测试区", isOnShelf: true, latitude: 31.231, longitude: 121.471 },
  ];
  const result = await findAvailable(
    { date: "2026-09-06", lat: "31.23", lon: "121.47", limit: "10" },
    {
      fetchListings: async () => listings,
      fetchDateAvailability: async (id) => (id === "near" ? 2 : 0),
    },
  );
  assert.deepEqual(result.items.map((item) => item.id), ["near"]);
  assert.equal(result.items[0].availableCount, 2);
});

test("available results without location prefer larger availability", () => {
  const results = sortAvailable(
    [
      { id: "one", name: "一", availableCount: 1 },
      { id: "three", name: "三", availableCount: 3 },
    ],
    { limit: 10 },
  );
  assert.deepEqual(results.map((item) => item.id), ["three", "one"]);
});

test("the string false does not enable the shelf filter", () => {
  const listings = [
    { id: "on", isOnShelf: true },
    { id: "off", isOnShelf: false },
  ];
  assert.deepEqual(
    filterListings(listings, { onlyOnShelf: "false" }).map((item) => item.id),
    ["on", "off"],
  );
});

test("personal application rooms are the default house type", () => {
  assert.equal(normalizeHouseType(), "0");
  assert.equal(normalizeHouseType("1"), "1");
  assert.throws(() => normalizeHouseType("2"), /房源类型必须是/);
});

test("listing builds an official detail URL with the original station object", () => {
  const listing = normalizeListing({
    id: 196,
    xmid: "bzfa4110",
    houseCount: 30,
    name: "测试驿站",
    lxfs: "12345678901",
    dizhi: "测试地址",
    projectPic: "https://example.com/house.png",
    houseType: "2",
    applyType: "1",
    isOnShelf: "1",
  });
  const url = new URL(listing.officialUrl);
  const passObj = JSON.parse(url.searchParams.get("passObj"));
  assert.equal(url.pathname, "/TWYouthInnV2/pages/houseDetails/houseDetails");
  assert.equal(passObj.id, 196);
  assert.equal(passObj.xmid, "bzfa4110");
  assert.equal(passObj.projectPic, "https://example.com/house.png");
  assert.equal(passObj.houseType, "2");
});

test("calendar aggregates all stations by date", async () => {
  // Use dates relative to today: days before today+2 are reported as
  // "not-open" by design, so fixed dates would make this test rot.
  const dayOne = plusDays(5);
  const dayTwo = plusDays(6);
  const listings = [
    { id: "one", name: "一号驿站", isOnShelf: true },
    { id: "two", name: "二号驿站", isOnShelf: true },
  ];
  const result = await findCalendar(
    { startDate: dayOne, days: "2" },
    {
      fetchListings: async () => listings,
      fetchCalendar: async (id) =>
        id === "one"
          ? { [dayOne]: 2, [dayTwo]: 1 }
          : { [dayOne]: 0, [dayTwo]: 3 },
    },
  );
  assert.deepEqual(
    result.days.map(({ date, availableCount, stationCount }) => ({
      date,
      availableCount,
      stationCount,
    })),
    [
      { date: dayOne, availableCount: 2, stationCount: 1 },
      { date: dayTwo, availableCount: 4, stationCount: 2 },
    ],
  );
  assert.equal(result.days[1].items[0].id, "two");
  assert.deepEqual(
    result.stations.find((station) => station.id === "one").availability,
    [
      { date: dayOne, availabilityStatus: "open", availableCount: 2 },
      { date: dayTwo, availabilityStatus: "open", availableCount: 1 },
    ],
  );
});

test("today and tomorrow are marked as not open", async () => {
  const now = new Date();
  const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((value, index) => (index === 0 ? String(value) : String(value).padStart(2, "0")))
    .join("-");
  const result = await findCalendar(
    { startDate: today, days: "3" },
    {
      fetchListings: async () => [{ id: "one", name: "一号驿站" }],
      fetchCalendar: async () => ({ [today]: 5 }),
    },
  );
  assert.deepEqual(
    result.days.map(({ availabilityStatus, availableCount }) => ({
      availabilityStatus,
      availableCount,
    })),
    [
      { availabilityStatus: "not-open", availableCount: null },
      { availabilityStatus: "not-open", availableCount: null },
      { availabilityStatus: "open", availableCount: 0 },
    ],
  );
});
