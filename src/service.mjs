import { fetchCalendar, fetchDateAvailability, fetchListings } from "./api.mjs";
import {
  filterListings,
  normalizeHouseType,
  parseOptionalCoordinate,
  sortAvailable,
  sortNearest,
  validateStayDates,
  withDistance,
} from "./domain.mjs";

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runner() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runner(),
  );
  await Promise.all(runners);
  return results;
}

function addDays(startDate, offset) {
  const date = new Date(`${startDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function localIsoDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function findNearest(query, deps = { fetchListings }) {
  const latitude = parseOptionalCoordinate(query.lat, "纬度");
  const longitude = parseOptionalCoordinate(query.lon, "经度");
  if (latitude === null || longitude === null) throw new Error("纬度和经度必须同时提供");
  const limit = Math.max(0, Number(query.limit ?? 20));
  const houseType = normalizeHouseType(query.houseType);
  const listings = filterListings(await deps.fetchListings({ houseType }), query);
  return sortNearest(listings, latitude, longitude, limit);
}

export async function findAvailable(
  query,
  deps = { fetchListings, fetchDateAvailability },
) {
  const { startDate, endDate } = validateStayDates(query.date, query.endDate || null);
  const latitude = parseOptionalCoordinate(query.lat, "纬度");
  const longitude = parseOptionalCoordinate(query.lon, "经度");
  if ((latitude === null) !== (longitude === null)) {
    throw new Error("纬度和经度必须同时提供");
  }
  const minCount = Math.trunc(Number(query.minCount ?? 1));
  if (!Number.isFinite(minCount) || minCount < 1) throw new Error("至少需要 1 间可用房源");
  const limit = Math.max(0, Math.trunc(Number(query.limit ?? 20)));
  const houseType = normalizeHouseType(query.houseType);
  const listings = filterListings(await deps.fetchListings({ houseType }), query);
  const withAvailability = await mapWithConcurrency(listings, 6, async (listing) => {
    const availableCount = await deps.fetchDateAvailability(listing.id, startDate, endDate);
    if (availableCount < minCount) return null;
    return {
      ...listing,
      availableCount,
      ...(latitude === null ? {} : withDistance(listing, latitude, longitude)),
    };
  });
  const matches = withAvailability.filter(Boolean);
  return {
    startDate,
    endDate,
    items: sortAvailable(matches, { latitude, longitude, limit }),
  };
}

export async function findCalendar(
  query,
  deps = { fetchListings, fetchCalendar },
) {
  const startDate = validateStayDates(query.startDate || query.date).startDate;
  const days = Math.trunc(Number(query.days ?? 21));
  if (!Number.isFinite(days) || days < 1 || days > 31) {
    throw new Error("days 必须是 1 到 31 之间的整数");
  }
  const houseType = normalizeHouseType(query.houseType);
  const listings = filterListings(await deps.fetchListings({ houseType }), query);
  const calendars = await mapWithConcurrency(listings, 6, async (listing) => ({
    listing,
    calendar: await deps.fetchCalendar(listing.id),
  }));
  const earliestOpenDate = addDays(localIsoDate(), 2);
  const dateItems = Array.from({ length: days }, (_, offset) => {
    const date = addDays(startDate, offset);
    const availabilityStatus = date < earliestOpenDate ? "not-open" : "open";
    const items = calendars
      .map(({ listing, calendar }) => {
        const availableCount = calendar[date] ?? 0;
        return availableCount > 0 ? { ...listing, availableCount } : null;
      })
      .filter(Boolean)
      .sort(
        (a, b) =>
          b.availableCount - a.availableCount || a.name.localeCompare(b.name, "zh-CN"),
      );
    return {
      date,
      availabilityStatus,
      availableCount:
        availabilityStatus === "not-open"
          ? null
          : items.reduce((total, item) => total + item.availableCount, 0),
      stationCount: availabilityStatus === "not-open" ? null : items.length,
      items: availabilityStatus === "not-open" ? [] : items,
    };
  });
  const stations = calendars.map(({ listing, calendar }) => ({
    ...listing,
    availability: dateItems.map(({ date, availabilityStatus }) => ({
      date,
      availabilityStatus,
      availableCount:
        availabilityStatus === "not-open" ? null : calendar[date] ?? 0,
    })),
  }));
  return { startDate, days: dateItems, stations };
}
