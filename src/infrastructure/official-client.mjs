import { AppError, invalidInput, upstreamError } from "../domain/errors.mjs";
import { nowIso, parseIsoDate, validateStayDates } from "../domain/dates.mjs";
import { parseHouseType } from "../domain/query.mjs";
import { createConcurrencyLimiter, createRequestCache } from "./request-cache.mjs";

export const OFFICIAL_API_BASE_URL = "https://qnyz.shyouth.net/qnyzApi";
export const OFFICIAL_DETAILS_URL = "https://qnyz.shyouth.net/TWYouthInnV2/pages/houseDetails/houseDetails";
export const OFFICIAL_REQUESTS = Object.freeze({
  listings: Object.freeze({ path: "/hous/housList", method: "GET" }),
  calendar: Object.freeze({ path: "/hous/calendar", method: "GET" }),
  interval: Object.freeze({ path: "/into/idleHouseCnt", method: "POST" }),
});

const DETAIL_FIELDS = [
  "id", "xmid", "houseCount", "name", "lxfs", "dizhi", "projectPic", "projectPicBase64StrArr",
  "mianji", "zujin", "peitaosheshi", "fuwuyuanqu", "aptName", "freeDays", "blurb",
  "surroundingTraffic", "remark", "district", "street", "longitude", "latitude", "houseType",
  "applyType", "nextDay", "isHz", "isOnShelf", "dataSource",
];

export function normalizeCount(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && (!value.trim() || !/^\d+(?:\.0+)?$/.test(value.trim()))) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export function availabilityFromCount(value) {
  const count = normalizeCount(value);
  return { availabilityStatus: count === null ? "unknown" : "known", availableCount: count };
}

function coordinate(value, min, max) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function optionalBoolean(value) {
  if ([true, 1, "1", "true", "yes", "y"].includes(value)) return true;
  if ([false, 0, "0", "false", "no", "n"].includes(value)) return false;
  return null;
}

export function normalizeListing(raw) {
  const officialDetails = Object.fromEntries(DETAIL_FIELDS
    .filter((field) => Object.hasOwn(raw, field)).map((field) => [field, raw[field]]));
  return {
    id: String(raw.id ?? raw.xmid ?? "").trim(),
    name: String(raw.name ?? "").trim(),
    district: String(raw.district ?? "").trim(),
    street: String(raw.street ?? "").trim(),
    address: String(raw.dizhi ?? raw.address ?? "").trim(),
    longitude: coordinate(raw.longitude, -180, 180),
    latitude: coordinate(raw.latitude, -90, 90),
    houseCount: normalizeCount(raw.houseCount),
    isOnShelf: optionalBoolean(raw.isOnShelf),
    applyType: String(raw.applyType ?? ""),
    nextDay: String(raw.nextDay ?? ""),
    contact: String(raw.lxfs ?? raw.contact ?? "").trim(),
    officialUrl: `${OFFICIAL_DETAILS_URL}?passObj=${encodeURIComponent(JSON.stringify(officialDetails))}`,
  };
}

export function normalizeCalendar(rows) {
  if (!Array.isArray(rows)) throw upstreamError("官网日历数据格式异常", { code: "UPSTREAM_INVALID_DATA" });
  const calendar = Object.create(null);
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    let date;
    try { date = parseIsoDate(row.applyDate); } catch { continue; }
    const value = availabilityFromCount(row.applyNumber);
    if (calendar[date] && calendar[date].availableCount !== value.availableCount) {
      calendar[date] = availabilityFromCount(null);
    } else if (!calendar[date]) {
      calendar[date] = value;
    }
  }
  return calendar;
}

function houseIdValue(value) {
  if ((typeof value !== "string" && typeof value !== "number") ||
      !String(value).trim() || String(value).length > 128) {
    throw invalidInput("驿站 ID 无效", "houseId");
  }
  return String(value).trim();
}

export function createOfficialClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  clock = () => new Date(),
  timeoutMs = 12_000,
  cacheTtlMs = 60_000,
  cacheMaxEntries = 512,
  concurrency = 3,
  baseUrl = OFFICIAL_API_BASE_URL,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError("Invalid upstream timeout");
  const base = new URL(baseUrl);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new TypeError("Invalid trusted upstream base URL");
  }
  const trustedBase = base.href.replace(/\/$/, "");
  const cache = createRequestCache({ ttlMs: cacheTtlMs, maxEntries: cacheMaxEntries, clock });
  const runLimited = createConcurrencyLimiter(concurrency);

  async function request(kind, query, body) {
    const route = OFFICIAL_REQUESTS[kind];
    if (!route) throw new AppError("禁止调用非只读官网接口");
    const url = new URL(`${trustedBase}${route.path}`);
    if (query) url.search = new URLSearchParams(query).toString();
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    const key = `${route.method} ${url.href} ${serializedBody ?? ""}`;
    return cache.getOrLoad(key, () => runLimited(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url.href, {
          method: route.method,
          // workerd supports manual/follow, not redirect:"error". Keep redirects
          // manual and reject every 3xx below so the allowlist is never bypassed.
          redirect: "manual",
          headers: {
            Accept: "application/json",
            ...(serializedBody === undefined ? {} : { "Content-Type": "application/json; charset=UTF-8" }),
          },
          ...(serializedBody === undefined ? {} : { body: serializedBody }),
          signal: controller.signal,
        });
        if (response.status >= 300 && response.status < 400) {
          throw upstreamError("官网接口返回了非预期跳转", { code: "UPSTREAM_REDIRECT", retryable: false });
        }
        if (!response.ok) {
          throw upstreamError("官网接口暂时不可用，请稍后重试", {
            code: response.status === 429 ? "UPSTREAM_RATE_LIMITED" : "UPSTREAM_HTTP_ERROR",
            retryable: response.status === 429 || response.status >= 500,
          });
        }
        const text = await response.text();
        if (text.length > 4_000_000) throw upstreamError("官网返回的数据过大", { code: "UPSTREAM_INVALID_DATA" });
        let payload;
        try { payload = JSON.parse(text); } catch (cause) {
          throw upstreamError("官网返回的数据格式异常", { code: "UPSTREAM_INVALID_DATA", cause });
        }
        if (!payload || payload.success !== true) {
          throw upstreamError("官网接口未成功返回数据", { code: "UPSTREAM_REJECTED" });
        }
        // Validate before caching; failed/malformed upstream responses must be retried.
        let data;
        if (kind === "listings") {
          if (!Array.isArray(payload.data)) throw upstreamError("官网房源数据格式异常", { code: "UPSTREAM_INVALID_DATA" });
          data = payload.data.filter((row) => row && typeof row === "object" && !Array.isArray(row))
            .map(normalizeListing).filter((item) => item.id);
        } else if (kind === "calendar") {
          data = normalizeCalendar(payload.data);
        } else {
          if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
            throw upstreamError("官网区间数据格式异常", { code: "UPSTREAM_INVALID_DATA" });
          }
          data = availabilityFromCount(payload.data.idleCnt);
        }
        return { data, fetchedAt: nowIso(clock) };
      } catch (cause) {
        if (controller.signal.aborted) throw upstreamError("官网查询超时，请稍后重试", {
          code: "UPSTREAM_TIMEOUT", status: 504, cause,
        });
        if (cause instanceof AppError) throw cause;
        throw upstreamError(undefined, { cause });
      } finally {
        clearTimeout(timer);
      }
    }));
  }

  async function fetchListings({ houseType = "0" } = {}) {
    const result = await request("listings", { userType: "0", housType: parseHouseType(houseType) });
    return { items: result.data, fetchedAt: result.fetchedAt };
  }

  async function fetchCalendar(houseId) {
    const result = await request("calendar", { id: houseIdValue(houseId) });
    return { calendar: result.data, fetchedAt: result.fetchedAt };
  }

  async function fetchDateAvailability(houseId, startDate, endDate = null) {
    const id = houseIdValue(houseId);
    const dates = validateStayDates(startDate, endDate);
    if (dates.endDate) {
      const result = await request("interval", null, { intoDate: dates.startDate, endDate: dates.endDate, houseId: id });
      return { ...result.data, fetchedAt: result.fetchedAt };
    }
    const result = await fetchCalendar(id);
    return { ...(result.calendar[dates.startDate] ?? availabilityFromCount(null)), fetchedAt: result.fetchedAt };
  }

  return Object.freeze({ fetchListings, fetchCalendar, fetchDateAvailability, clearCache: () => cache.clear() });
}
