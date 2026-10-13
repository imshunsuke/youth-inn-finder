const paths = {
  pin: '<path d="M19 10c0 5-7 10-7 10S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.2"/>',
  calendar: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4m8-4v4M4 10h16m-11 4h1m4 0h1m-6 3h1"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Zm-8 12h4"/>',
  leaf: '<path d="M20 4C9 2 2 9 5 15c3 7 15 5 15-11Z"/><path d="M4 21 16 9M8 17v-6m0 6h6"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  arrow: '<path d="M4 12h15m-5-5 5 5-5 5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.5"/>',
  sort: '<path d="M5 6h15M5 12h11M5 18h6"/>',
  bookmark: '<path d="M6 4h12v17l-6-4-6 4V4Z"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  trash: '<path d="M4 7h16M9 4h6l1 3H8l1-3Zm-3 3 1 14h10l1-14M10 11v6m4-6v6"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
};
export const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.info}</svg>`;
export function hydrateIcons(root = document) { root.querySelectorAll("[data-icon]").forEach((el) => { el.innerHTML = icon(el.dataset.icon); }); }
export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export function todayInShanghai() {
  const fields = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}
export function addDays(date, count) { const parsed = new Date(`${date}T12:00:00Z`); parsed.setUTCDate(parsed.getUTCDate() + count); return parsed.toISOString().slice(0, 10); }
export const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
export const shortDate = (date) => validDate(date) ? date.slice(5).replace("-", ".") : "—";
export const weekday = (date) => new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC", weekday: "short" }).format(new Date(`${date}T12:00:00Z`));
export function sampleTime(meta) {
  const timestamp = meta?.oldestFetchedAt || meta?.fetchedAt;
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return "";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(timestamp));
}
export function safeOfficialUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "qnyz.shyouth.net" && !url.username && !url.password && !url.port && ["/TWYouthInnV2/pages/houseDetails/houseDetails", "/TWYouthInnV2/static/onemap/index.html"].includes(url.pathname) ? url.href : null;
  } catch { return null; }
}
export function distanceKm(station, coordinates) {
  if (!coordinates || typeof station.latitude !== "number" || typeof station.longitude !== "number" || !Number.isFinite(station.latitude) || !Number.isFinite(station.longitude) || Math.abs(station.latitude) > 90 || Math.abs(station.longitude) > 180) return null;
  const rad = (n) => n * Math.PI / 180;
  const a = Math.sin(rad(station.latitude - coordinates.lat) / 2) ** 2 + Math.cos(rad(coordinates.lat)) * Math.cos(rad(station.latitude)) * Math.sin(rad(station.longitude - coordinates.lon) / 2) ** 2;
  return 12742.0176 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}
export function stationArt() {
  return '<svg viewBox="0 0 390 190" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="390" height="190" fill="#e8e5d6"/><circle cx="308" cy="39" r="25" fill="#e8c493"/><path d="M42 163V77h47v86M304 163V70h49v93" fill="#bbc0aa"/><path d="M110 168V44h166v124Z" fill="#d9b493"/><path d="m102 44 90-32 92 32" fill="none" stroke="#a08165" stroke-width="6" stroke-linejoin="round"/><path d="M130 60h25v29h-25zM180 60h25v29h-25zM230 60h25v29h-25zM130 106h25v29h-25zM230 106h25v29h-25z" fill="#f1e6c9"/><path d="M174 169v-39a19 19 0 0 1 38 0v39" fill="#5c765c"/><path d="M193 114v55M143 61v27m50-27v27m50-27v27" stroke="#c1b690" stroke-width="2"/><path d="M64 166v-43m0 15c-29-3-27-39-9-42 18-3 30 34 9 42Z" fill="#7e946e"/><path d="M64 161v-38" stroke="#607b57" stroke-width="3"/><path d="M0 174h390" stroke="#c5c5ae" stroke-width="3"/><path d="M312 162h23l-4 13h-15z" fill="#b28b6c"/><path d="M323 160v-25m0 9c-21-4-16-22-9-17 7 4 10 12 9 17Zm0 4c18-3 21-22 13-21-8 1-13 14-13 21Z" fill="#889d75"/></svg>';
}
const FAVORITES_KEY = "youth-inn-finder:favorites:v1";
function favoriteRecord(station) {
  const result = {};
  for (const key of ["id", "name", "district", "street", "address", "contact", "officialUrl"]) result[key] = typeof station[key] === "string" ? station[key] : "";
  for (const key of ["latitude", "longitude"]) result[key] = typeof station[key] === "number" && Number.isFinite(station[key]) ? station[key] : null;
  return result;
}
export function readFavorites() {
  try { const records = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]"); return new Map(Array.isArray(records) ? records.filter((item) => item && typeof item.id === "string" && item.id && typeof item.name === "string").slice(0, 1000).map((item) => [item.id, favoriteRecord(item)]) : []); } catch { return new Map(); }
}
export function writeFavorites(records) { try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...records.values()].map(favoriteRecord))); return true; } catch { return false; } }
let toastTimer;
export function toast(message) { const el = document.querySelector("#toast"); clearTimeout(toastTimer); el.textContent = message; el.classList.add("visible"); toastTimer = setTimeout(() => el.classList.remove("visible"), 3600); }
