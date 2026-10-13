import { invalidInput } from "./errors.mjs";

let chineseNameCollator;

export function parseInteger(value, { field, label = field, fallback, min, max }) {
  if (value === undefined || value === null) value = fallback;
  if ((typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && !/^-?\d+$/.test(value))) {
    throw invalidInput(`${label}必须是 ${min} 到 ${max} 之间的整数`, field);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw invalidInput(`${label}必须是 ${min} 到 ${max} 之间的整数`, field);
  }
  return number;
}

export function parseBoolean(value, field, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if ([true, 1].includes(value)) return true;
  if ([false, 0].includes(value)) return false;
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (["true", "1", "on", "yes", "y"].includes(normalized)) return true;
    if (["false", "0", "off", "no", "n"].includes(normalized)) return false;
  }
  throw invalidInput(`${field}必须是 true 或 false`, field);
}

export function parseCoordinate(value, field, min, max) {
  if (value === undefined || value === null || value === "") return null;
  if ((typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))) {
    throw invalidInput(`${field}必须是 ${min} 到 ${max} 之间的数字`, field);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw invalidInput(`${field}必须是 ${min} 到 ${max} 之间的数字`, field);
  }
  return number;
}

export function parseHouseType(value = "0") {
  if (!["0", "1", 0, 1].includes(value)) {
    throw invalidInput("房源类型必须是 0（个人申请）或 1（全部房源）", "houseType");
  }
  return String(value);
}

function textField(value, field, maxLength) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > maxLength) {
    throw invalidInput(`${field}必须是不超过 ${maxLength} 字的文本`, field);
  }
  return value.trim();
}

export function parseCommonQuery(query = {}, { requireCoordinates = false } = {}) {
  if (!query || typeof query !== "object" || Array.isArray(query)) throw invalidInput("查询参数格式无效", "query");
  const latitude = parseCoordinate(query.lat, "lat", -90, 90);
  const longitude = parseCoordinate(query.lon, "lon", -180, 180);
  if ((latitude === null) !== (longitude === null) || (requireCoordinates && latitude === null)) {
    throw invalidInput("纬度和经度必须同时提供", "lat");
  }
  const sort = query.sort ?? (latitude === null ? "availability" : "distance");
  if (!["availability", "distance", "name"].includes(sort)) throw invalidInput("排序方式无效", "sort");
  if (sort === "distance" && latitude === null) throw invalidInput("按距离排序需要纬度和经度", "lat");
  return {
    latitude,
    longitude,
    houseType: parseHouseType(query.houseType),
    onlyOnShelf: parseBoolean(query.onlyOnShelf, "onlyOnShelf"),
    district: textField(query.district, "district", 50),
    keyword: textField(query.q ?? query.keyword, "q", 100).toLocaleLowerCase("zh-CN"),
    stationId: textField(query.stationId ?? query.houseId, "stationId", 128),
    minCount: parseInteger(query.minCount, { field: "minCount", fallback: 1, min: 1, max: 10_000 }),
    limit: parseInteger(query.limit, { field: "limit", fallback: 20, min: 1, max: 200 }),
    sort,
  };
}

export function filterListings(listings, query) {
  return listings.filter((item) =>
    (!query.district || item.district === query.district) &&
    (!query.onlyOnShelf || item.isOnShelf === true) &&
    (!query.stationId || item.id === query.stationId) &&
    (!query.keyword || [item.name, item.address, item.district, item.street]
      .some((value) => String(value ?? "").toLocaleLowerCase("zh-CN").includes(query.keyword))),
  );
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = (value) => value * Math.PI / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

export function withDistance(item, query) {
  if (query.latitude === null) return { ...item };
  const validCoordinate = typeof item.latitude === "number" && Number.isFinite(item.latitude) &&
    item.latitude >= -90 && item.latitude <= 90 && typeof item.longitude === "number" &&
    Number.isFinite(item.longitude) && item.longitude >= -180 && item.longitude <= 180;
  return {
    ...item,
    distanceKm: validCoordinate ? haversineKm(query.latitude, query.longitude, item.latitude, item.longitude) : null,
  };
}

export function sortListings(items, query, { nearestOnly = false } = {}) {
  let results = items.map((item) => withDistance(item, query));
  if (nearestOnly) results = results.filter((item) => item.distanceKm !== null);
  return results.sort((a, b) => {
    const byName = (chineseNameCollator ??= new Intl.Collator("zh-CN")).compare(a.name, b.name);
    if (nearestOnly || query.sort === "distance") {
      return (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || byName;
    }
    if (query.sort === "name") return byName;
    return (b.availableCount ?? 0) - (a.availableCount ?? 0) || byName;
  }).slice(0, query.limit);
}
