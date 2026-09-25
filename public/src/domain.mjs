export function parseIsoDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label}必须是 YYYY-MM-DD，例如 2026-09-06`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label}不是有效日期: ${value}`);
  }
  return value;
}

export function validateStayDates(startDate, endDate = null) {
  const start = parseIsoDate(startDate, "入住日期");
  if (!endDate) return { startDate: start, endDate: null };
  const end = parseIsoDate(endDate, "离店日期");
  if (end <= start) throw new Error("离店日期必须晚于入住日期");
  return { startDate: start, endDate: end };
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const radiusKm = 6371.0088;
  const toRadians = (value) => (value * Math.PI) / 180;
  const firstLat = toRadians(lat1);
  const secondLat = toRadians(lat2);
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(firstLat) * Math.cos(secondLat) * Math.sin(deltaLon / 2) ** 2;
  return 2 * radiusKm * Math.asin(Math.sqrt(a));
}

export function parseOptionalCoordinate(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label}必须是数字`);
  return number;
}

export function normalizeHouseType(value = "0") {
  const houseType = String(value);
  if (!["0", "1"].includes(houseType)) {
    throw new Error("房源类型必须是 0（可供个人申请房源）或 1（全部房源）");
  }
  return houseType;
}

export function filterListings(listings, { district = "", onlyOnShelf = false } = {}) {
  const shelfFilter = [true, 1, "1", "true", "on", "yes", "y"].includes(
    typeof onlyOnShelf === "string" ? onlyOnShelf.toLowerCase() : onlyOnShelf,
  );
  return listings.filter((listing) => {
    if (district && listing.district !== district) return false;
    if (shelfFilter && listing.isOnShelf !== true) return false;
    return true;
  });
}

export function withDistance(listing, latitude, longitude) {
  if (listing.latitude === null || listing.longitude === null) {
    return { ...listing, distanceKm: null };
  }
  return {
    ...listing,
    distanceKm: haversineKm(latitude, longitude, listing.latitude, listing.longitude),
  };
}

export function sortNearest(listings, latitude, longitude, limit = 20) {
  return listings
    .map((listing) => withDistance(listing, latitude, longitude))
    .filter((listing) => listing.distanceKm !== null)
    .sort((a, b) => a.distanceKm - b.distanceKm || a.name.localeCompare(b.name, "zh-CN"))
    .slice(0, Math.max(0, limit));
}

export function sortAvailable(listings, { latitude = null, longitude = null, limit = 20 } = {}) {
  const sorted =
    latitude !== null && longitude !== null
      ? listings.map((listing) => withDistance(listing, latitude, longitude))
      : [...listings];
  if (latitude !== null && longitude !== null) {
    sorted.sort((a, b) => {
      const aDistance = a.distanceKm ?? Number.POSITIVE_INFINITY;
      const bDistance = b.distanceKm ?? Number.POSITIVE_INFINITY;
      return aDistance - bDistance || a.name.localeCompare(b.name, "zh-CN");
    });
  } else {
    sorted.sort(
      (a, b) =>
        b.availableCount - a.availableCount || a.name.localeCompare(b.name, "zh-CN"),
    );
  }
  return sorted.slice(0, Math.max(0, limit));
}
