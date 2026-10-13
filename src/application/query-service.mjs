import { AppError } from "../domain/errors.mjs";
import { addDays, nowIso, todayInShanghai, validateStayDates } from "../domain/dates.mjs";
import { filterListings, parseBoolean, parseCommonQuery, parseInteger, sortListings, withDistance } from "../domain/query.mjs";

async function mapSettledWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runner() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try { results[index] = { status: "fulfilled", value: await worker(items[index], index) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, runner));
  return results;
}

function checkedAvailability(value) {
  if (value?.availabilityStatus === "known" && Number.isSafeInteger(value.availableCount) && value.availableCount >= 0) {
    return { availabilityStatus: "known", availableCount: value.availableCount };
  }
  return { availabilityStatus: "unknown", availableCount: null };
}

function timeRange(timestamps) {
  const dates = timestamps.filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value))).sort();
  return { oldestFetchedAt: dates[0] ?? null, latestFetchedAt: dates.at(-1) ?? null };
}

// successfulStations + failedStations = totalStations for station observation queries.
// unknownStations is a separate quality measure: it INCLUDES failedStations and
// successful responses without a usable target date/count. Never sum all three.
// For calendars, a station is unknown if ANY requested open date is unknown.
// Fetch timestamps describe the range of successful samples, not an atomic snapshot.
function metadata(clock, listings, observations = [], { unknownStations = 0, partial = false } = {}) {
  const successfulStations = observations.filter((item) => item.status === "fulfilled").length;
  const failedStations = observations.length - successfulStations;
  const times = timeRange([listings.fetchedAt, ...observations
    .filter((item) => item.status === "fulfilled").map((item) => item.value.fetchedAt)]);
  return {
    generatedAt: nowIso(clock),
    fetchedAt: times.oldestFetchedAt,
    ...times,
    timeZone: "Asia/Shanghai",
    partial: partial || failedStations > 0 || unknownStations > 0,
    coverage: { totalStations: listings.items.length, successfulStations, failedStations, unknownStations },
  };
}

/**
 * HTTP-independent query entry point. Pass createOfficialClient() or an injected adapter.
 * findCalendar(query) -> { startDate, days, stations, meta }
 * findAvailable(query) / findNearest(query) -> { data, meta }
 *
 * Common input: houseType, onlyOnShelf, district, q/keyword, stationId/houseId,
 * minCount (1..10000), limit (1..200), lat + lon, sort (availability/distance/name).
 * Calendar adds startDate/date, days (1..31), and includeDayItems (default true).
 * includeDayItems=false omits duplicated days[].items; all aggregates and stations remain.
 * Availability adds date/endDate.
 * Missing dates default to today in Shanghai. endDate is exclusive checkout as
 * forwarded unchanged to the official interval endpoint; no daily-minimum inference.
 *
 * A partial day's aggregate counts are null. knownAvailableCount and knownStationCount
 * are LOWER BOUNDS from known matching stations; missing/failed samples are never zero.
 * stations[].availability uses known/unknown/not-open; days retain legacy open/not-open
 * for complete data and use unknown when incomplete. Inspect meta.partial + coverage.
 * minLeadDays is a configurable local rule, not a guarantee of official policy.
 *
 * This live query layer has no persistent snapshots or invocation request budget.
 * A Workers HTTP integration must read persisted snapshots or budget/split collection,
 * rather than calling a full 90-station live query in one free-tier invocation.
 */
export function createQueryService({ client, clock = () => new Date(), concurrency = 3, minLeadDays = 2 } = {}) {
  if (!client || !["fetchListings", "fetchCalendar", "fetchDateAvailability"]
    .every((method) => typeof client[method] === "function")) throw new TypeError("A complete official client is required");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) throw new TypeError("concurrency must be 1–6");
  if (!Number.isInteger(minLeadDays) || minLeadDays < 0 || minLeadDays > 31) throw new TypeError("Invalid minimum lead days");

  async function getListings(query) {
    const result = await client.fetchListings({ houseType: query.houseType });
    if (!result || !Array.isArray(result.items)) throw new AppError("房源适配器返回格式无效");
    return { ...result, items: filterListings(result.items, query) };
  }

  async function findNearest(input = {}) {
    const query = parseCommonQuery(input, { requireCoordinates: true });
    const listings = await getListings(query);
    const meta = metadata(clock, listings);
    meta.coverage.successfulStations = listings.items.length;
    return { data: sortListings(listings.items, query, { nearestOnly: true }), meta };
  }

  async function findAvailable(input = {}) {
    const query = parseCommonQuery(input);
    const dates = validateStayDates(input.date ?? todayInShanghai(clock), input.endDate ?? null);
    const listings = await getListings(query);
    const open = dates.startDate >= addDays(todayInShanghai(clock), minLeadDays);
    if (!open) return {
      data: [],
      meta: { ...metadata(clock, listings), date: dates.startDate, endDate: dates.endDate,
        availabilityStatus: "not-open", coverage: { totalStations: listings.items.length, successfulStations: 0,
          failedStations: 0, unknownStations: 0, notOpenStations: listings.items.length } },
    };
    const observations = await mapSettledWithConcurrency(listings.items, concurrency, (item) =>
      client.fetchDateAvailability(item.id, dates.startDate, dates.endDate));
    const known = observations.map((observation) => observation.status === "fulfilled"
      ? checkedAvailability(observation.value) : checkedAvailability(null));
    const unknownStations = known.filter((item) => item.availabilityStatus === "unknown").length;
    const items = listings.items.flatMap((listing, index) => known[index].availableCount !== null &&
      known[index].availableCount >= query.minCount
      ? [{ ...listing, ...known[index], fetchedAt: observations[index].value.fetchedAt ?? null }] : []);
    return {
      data: sortListings(items, query),
      meta: { ...metadata(clock, listings, observations, { unknownStations }), date: dates.startDate,
        endDate: dates.endDate, availabilityStatus: unknownStations ? "partial" : "known",
        matchedStations: items.length },
    };
  }

  async function findCalendar(input = {}) {
    const query = parseCommonQuery(input);
    const startDate = validateStayDates(input.startDate ?? input.date ?? todayInShanghai(clock)).startDate;
    const length = parseInteger(input.days, { field: "days", fallback: 21, min: 1, max: 31 });
    const includeDayItems = parseBoolean(input.includeDayItems, "includeDayItems", true);
    const dates = Array.from({ length }, (_, offset) => addDays(startDate, offset));
    const listings = await getListings(query);
    const observations = await mapSettledWithConcurrency(listings.items, concurrency, (item) => client.fetchCalendar(item.id));
    const earliestOpenDate = addDays(todayInShanghai(clock), minLeadDays);
    const stationDays = listings.items.map((listing, index) => {
      const observation = observations[index];
      const calendar = observation.status === "fulfilled" ? observation.value.calendar ?? {} : {};
      return {
        ...withDistance(listing, query),
        fetchedAt: observation.status === "fulfilled" ? observation.value.fetchedAt ?? null : null,
        availability: dates.map((date) => {
          const state = date < earliestOpenDate
            ? { availabilityStatus: "not-open", availableCount: null }
            : checkedAvailability(calendar[date]);
          return { date, ...state };
        }),
      };
    });
    // Only legacy clients need station metadata repeated for every day's positive items.
    const stationDetails = includeDayItems ? stationDays.map(({ availability, ...station }) => station) : null;
    const days = dates.map((date, index) => {
      const notOpen = date < earliestOpenDate;
      let unknownStations = 0, knownAvailableCount = 0, knownStationCount = 0;
      const available = includeDayItems ? [] : null;
      for (let stationIndex = 0; stationIndex < stationDays.length; stationIndex++) {
        const state = stationDays[stationIndex].availability[index];
        if (!notOpen && state.availabilityStatus === "unknown") unknownStations++;
        if (state.availableCount === null || state.availableCount < query.minCount) continue;
        knownAvailableCount += state.availableCount;
        knownStationCount++;
        if (includeDayItems) available.push({ ...stationDetails[stationIndex], ...state });
      }
      return {
        date,
        availabilityStatus: notOpen ? "not-open" : unknownStations ? "unknown" : "open",
        availableCount: notOpen || unknownStations ? null : knownAvailableCount,
        stationCount: notOpen || unknownStations ? null : knownStationCount,
        knownAvailableCount: notOpen ? null : knownAvailableCount,
        knownStationCount: notOpen ? null : knownStationCount,
        coverage: { totalStations: listings.items.length, knownStations: notOpen ? 0 : listings.items.length - unknownStations,
          unknownStations, ...(notOpen ? { notOpenStations: listings.items.length } : {}) },
        ...(includeDayItems ? { items: sortListings(available, { ...query, limit: 200 }) } : {}),
      };
    });
    const unknownStations = stationDays.filter((item) => item.availability.some((day) => day.availabilityStatus === "unknown")).length;
    return { startDate, days, stations: stationDays, meta: {
      ...metadata(clock, listings, observations, { unknownStations }), earliestOpenDate,
      minLeadDays, openingRule: "configured-minimum-lead-days", // This is a local rule, not a claimed upstream guarantee.
    } };
  }

  return Object.freeze({ findNearest, findAvailable, findCalendar });
}
