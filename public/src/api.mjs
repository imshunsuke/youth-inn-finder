const DEFAULT_BASE_URL = "https://qnyz.shyouth.net/qnyzApi";
const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT = "youth-inn-finder/0.2 (+public-read-only-monitor)";
const OFFICIAL_DETAILS_URL =
  "https://qnyz.shyouth.net/TWYouthInnV2/pages/houseDetails/houseDetails";

const OFFICIAL_DETAIL_FIELDS = [
  "id",
  "xmid",
  "houseCount",
  "name",
  "lxfs",
  "dizhi",
  "projectPic",
  "projectPicBase64StrArr",
  "mianji",
  "zujin",
  "peitaosheshi",
  "fuwuyuanqu",
  "aptName",
  "freeDays",
  "blurb",
  "surroundingTraffic",
  "remark",
  "district",
  "street",
  "longitude",
  "latitude",
  "houseType",
  "applyType",
  "nextDay",
  "isHz",
  "isOnShelf",
  "dataSource",
];

export const HOUSE_TYPES = Object.freeze({
  PERSONAL: "0",
  ALL: "1",
});

export class UpstreamError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "UpstreamError";
  }
}

function apiBaseUrl() {
  // Node 环境可用环境变量覆盖接口地址；浏览器静态托管时无 process，退回默认值。
  const envBaseUrl =
    typeof process !== "undefined" && process.env ? process.env.YOUTH_INN_API_BASE_URL : undefined;
  return (envBaseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
}

async function requestJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const headers = {
    Accept: "application/json",
    ...(options.headers || {}),
  };
  // User-Agent 是浏览器禁止设置的请求头，仅在 Node 侧发送。
  if (typeof process !== "undefined" && process.versions?.node) {
    headers["User-Agent"] = USER_AGENT;
  }
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new UpstreamError(`请求青年驿站接口失败: ${error.message}`, { cause: error });
  }

  const text = await response.text();
  if (!response.ok) {
    throw new UpstreamError(`青年驿站接口 HTTP ${response.status}: ${text.slice(0, 180)}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new UpstreamError("青年驿站接口返回的不是有效 JSON", { cause: error });
  }
  if (!payload || payload.success !== true) {
    throw new UpstreamError(`青年驿站接口返回失败: ${payload?.msg || "未知错误"}`);
  }
  return payload.data;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  const number = numberOrNull(value);
  return number === null ? null : Math.trunc(number);
}

function booleanOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  return [1, "1", true, "true", "yes", "y"].includes(value);
}

function officialDetailsFromRaw(raw) {
  return Object.fromEntries(
    OFFICIAL_DETAIL_FIELDS
      .filter((field) => Object.prototype.hasOwnProperty.call(raw, field))
      .map((field) => [field, raw[field]]),
  );
}

function officialDetailsUrl(raw) {
  const details = officialDetailsFromRaw(raw);
  return `${OFFICIAL_DETAILS_URL}?passObj=${encodeURIComponent(JSON.stringify(details))}`;
}

export function normalizeListing(raw) {
  return {
    id: String(raw.id ?? raw.xmid ?? ""),
    name: String(raw.name ?? "").trim(),
    district: String(raw.district ?? "").trim(),
    street: String(raw.street ?? "").trim(),
    address: String(raw.dizhi ?? raw.address ?? "").trim(),
    longitude: numberOrNull(raw.longitude),
    latitude: numberOrNull(raw.latitude),
    houseCount: integerOrNull(raw.houseCount),
    isOnShelf: booleanOrNull(raw.isOnShelf),
    applyType: String(raw.applyType ?? ""),
    nextDay: String(raw.nextDay ?? ""),
    contact: String(raw.lxfs ?? raw.contact ?? "").trim(),
    officialUrl: officialDetailsUrl(raw),
  };
}

export async function fetchListings({ houseType = HOUSE_TYPES.PERSONAL } = {}) {
  const normalizedHouseType = String(houseType);
  if (![HOUSE_TYPES.PERSONAL, HOUSE_TYPES.ALL].includes(normalizedHouseType)) {
    throw new UpstreamError("房源类型必须是 0（可供个人申请房源）或 1（全部房源）");
  }
  const url = new URL(`${apiBaseUrl()}/hous/housList`);
  url.search = new URLSearchParams({ userType: "0", housType: normalizedHouseType });
  const rows = await requestJson(url);
  if (!Array.isArray(rows)) throw new UpstreamError("房源接口缺少 data 列表");
  return rows
    .filter((row) => row && typeof row === "object")
    .map(normalizeListing)
    .filter((listing) => listing.id || listing.name);
}

export async function fetchCalendar(houseId) {
  const url = new URL(`${apiBaseUrl()}/hous/calendar`);
  url.search = new URLSearchParams({ id: String(houseId) });
  const rows = await requestJson(url);
  if (!Array.isArray(rows)) throw new UpstreamError("日期接口缺少 data 列表");
  return Object.fromEntries(
    rows
      .filter((row) => row && row.applyDate)
      .map((row) => [String(row.applyDate), integerOrNull(row.applyNumber) ?? 0]),
  );
}

export async function fetchIdleHouseCount(houseId, startDate, endDate) {
  const data = await requestJson(`${apiBaseUrl()}/into/idleHouseCnt`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ intoDate: startDate, endDate, houseId: String(houseId) }),
  });
  if (!data || typeof data !== "object") throw new UpstreamError("区间日期接口返回格式错误");
  return integerOrNull(data.idleCnt) ?? 0;
}

export async function fetchDateAvailability(houseId, startDate, endDate = null) {
  if (endDate) return fetchIdleHouseCount(houseId, startDate, endDate);
  const calendar = await fetchCalendar(houseId);
  return calendar[startDate] ?? 0;
}
