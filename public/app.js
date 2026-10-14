import { request, apiPath, isPending } from "./lib/api.mjs";
import { icon, hydrateIcons, escapeHtml as esc, todayInShanghai, addDays, validDate, shortDate, weekday, sampleTime, safeOfficialUrl, distanceKm, stationArt, readFavorites, writeFavorites, toast } from "./lib/ui.mjs";
import { setupReminders } from "./lib/reminders.mjs";
import { intervalFeedback, intervalRetry } from "./lib/interval-status.mjs";
import { createCollectionPump } from "./lib/collection-pump.mjs";
import { freshSample, favoriteForQuery, freshIntervalView } from "./lib/listing-state.mjs";

const $ = (selector) => document.querySelector(selector);
const today = todayInShanghai();
const state = { date: addDays(today, 2), endDate: null, district: "", q: "", houseType: "0", onlyOnShelf: true, minCount: 1, limit: 20, sort: "availability", coordinates: null, nearestDistances: new Map(), tab: "find", favorites: readFavorites(), calendar: null, calendarKey: "", calendarLoading: false, calendarError: "", interval: null };
const calendarCache = new Map(), intervalCache = new Map();
const collectionPump = createCollectionPump();
let stationDetailSequence = 0, collectionNotice = "";
let calendarController, intervalController, calendarSequence = 0, intervalSequence = 0, lastRefresh = 0, intervalTimer;
let lastCalendarAttemptAt = 0, lastIntervalAttemptAt = 0, lastIntervalAttemptKey = "", autoUpdateTimer;
const days = Array.from({ length: 21 }, (_, index) => addDays(today, index));
const calendarKey = () => `${today}|${state.houseType}|${state.onlyOnShelf}`;
const intervalKey = () => JSON.stringify([state.date, state.endDate, state.houseType, state.onlyOnShelf, state.district, state.q.toLocaleLowerCase("zh-CN")]);
const allStations = () => state.calendarKey === calendarKey() ? state.calendar?.stations || [] : [];
const stayNights = () => state.endDate ? Math.round((Date.parse(state.endDate) - Date.parse(state.date)) / 86_400_000) : null;
const conditions = () => ({ date: state.date, ...(state.endDate ? { endDate: state.endDate } : {}), district: state.district, houseType: state.houseType, onlyOnShelf: state.onlyOnShelf, minCount: state.minCount });
const measuredDistance = (station) => state.coordinates && state.nearestDistances.has(station.id) ? state.nearestDistances.get(station.id) : distanceKm(station, state.coordinates);
function scheduleInterval() {
  clearTimeout(intervalTimer); intervalController?.abort(); intervalSequence++;
  if (!state.endDate) return;
  const key = intervalKey(), cached = intervalCache.get(key);
  state.interval = { key, payload: cached?.payload || null, pending: cached?.pending || false, loading: true };
  renderResults(); intervalTimer = setTimeout(() => loadInterval(), 350);
}

function switchTab(tab, { scroll = true } = {}) {
  state.tab = tab;
  document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("hidden", panel.id !== `${tab}-panel`));
  document.querySelectorAll("[data-tab]").forEach((button) => { const active = button.dataset.tab === tab; button.classList.toggle("active", active); if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); });
  if (scroll) window.scrollTo({ top: 0, behavior: "auto" });
}
function matches(station) {
  const keyword = state.q.toLocaleLowerCase("zh-CN");
  return (!state.district || station.district === state.district) && (!keyword || [station.name, station.address, station.district, station.street].some((value) => String(value || "").toLocaleLowerCase("zh-CN").includes(keyword)));
}
function sortAndLimit(items) {
  return items.filter((item) => Number.isSafeInteger(item.availableCount) && item.availableCount >= state.minCount).map((station) => ({ ...station, distanceKm: measuredDistance(station) })).sort((a, b) => {
    const byName = String(a.name).localeCompare(String(b.name), "zh-CN");
    if (state.sort === "name") return byName;
    if (state.sort === "distance") return (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || byName;
    return (b.availableCount ?? -1) - (a.availableCount ?? -1) || byName;
  }).slice(0, state.limit);
}
function dayView(date) {
  const base = state.calendarKey === calendarKey() ? state.calendar?.days?.find((day) => day.date === date) : null;
  const stations = allStations().filter(matches);
  if (base?.availabilityStatus === "not-open") return { date, status: "not-open", items: [], count: null, unknown: 0, total: stations.length };
  if (!base) return { date, status: "unknown", items: [], count: null, knownCount: null, unknown: stations.length, total: stations.length };
  let unknown = 0;
  const items = [];
  for (const station of stations) {
    const observation = station.availability?.find((day) => day.date === date);
    if (!freshSample(station) || !observation || !["known", "open"].includes(observation.availabilityStatus) || !Number.isSafeInteger(observation.availableCount) || observation.availableCount < 0) { unknown++; continue; }
    if (observation.availableCount >= state.minCount) items.push({ ...station, availableCount: observation.availableCount, availabilityStatus: "known" });
  }
  const knownCount = items.reduce((sum, station) => sum + station.availableCount, 0);
  return { date, status: unknown ? "unknown" : "open", items, count: unknown ? null : knownCount, knownCount, unknown, total: stations.length };
}
function renderCalendar() {
  $("#calendar").setAttribute("aria-busy", String(state.calendarLoading));
  $("#calendar").innerHTML = days.map((date) => {
    const view = dayView(date), selected = date === state.date;
    const text = view.status === "not-open" ? "待开放" : view.status === "unknown" ? (view.knownCount > 0 ? `≥${view.knownCount} 间` : "待确认") : view.count > 0 ? `${view.count} 间` : "暂无";
    return `<button class="day${view.status === "not-open" ? " not-open" : view.status === "unknown" ? " uncertain" : view.count === 0 ? " no-rooms" : ""}${selected ? " selected" : ""}" type="button" data-day="${date}" aria-pressed="${selected}" aria-label="${date}，${weekday(date)}，${view.status === "unknown" && view.knownCount > 0 ? `已知至少${view.knownCount}间，其余待确认` : text}${selected ? "，已选择" : ""}"><span class="day-date">${shortDate(date)}<span class="day-week">${weekday(date)}</span></span><span class="day-count">${text}</span></button>`;
  }).join("");
  const label = state.endDate ? `${shortDate(state.date)} — ${shortDate(state.endDate)}` : `${shortDate(state.date)} · 单日`;
  $("#search-date-label").innerHTML = `<span>${label}</span>${state.endDate ? `<span class="stay-length"> · ${stayNights()} 晚</span>` : ""}`;
  $("#date-jump").setAttribute("aria-label", `入住 ${state.date}${state.endDate ? `，离店 ${state.endDate}，${stayNights()}晚` : "，查询单日"}`);
  const startMonth = `${days[0].slice(0, 4)} 年 ${Number(days[0].slice(5, 7))} 月`;
  $("#calendar-month").textContent = days[0].slice(0, 7) === days.at(-1).slice(0, 7) ? startMonth : `${startMonth} — ${Number(days.at(-1).slice(5, 7))} 月`;
}
function displaySource() {
  if (!state.endDate) { const view = dayView(state.date); return { ...view, meta: state.calendarKey === calendarKey() ? state.calendar?.meta : null, loading: state.calendarLoading, error: state.calendarError }; }
  const entry = state.interval?.key === intervalKey() ? state.interval : null, payload = entry?.payload;
  const status = payload?.meta?.availabilityStatus, partial = payload?.meta?.partial || status === "partial" || status === "unknown";
  const pending = entry?.pending || payload?.pending === true || payload?.meta?.pending === true;
  const view = freshIntervalView(payload), items = view.items.filter(matches), total = payload?.meta?.coverage?.totalStations ?? 0;
  return { status: status === "not-open" ? "not-open" : view.stale ? "unknown" : pending ? "pending" : payload ? partial ? "unknown" : "open" : "unknown", items, meta: payload?.meta, loading: entry?.loading, error: entry?.error, stale: view.stale, unknown: view.stale ? Math.max(0,total-items.length) : payload?.meta?.coverage?.unknownStations ?? 0, total };
}
function stationCard(station, { favorite = false } = {}) {
  const saved = state.favorites.has(station.id), known = Number.isSafeInteger(station.availableCount) && station.availableCount >= 0, distance = measuredDistance(station);
  return `<article class="station-card"><div class="station-art">${stationArt()}<span class="room-badge">${known ? `可用 ${station.availableCount} 间` : "房源待确认"}</span><button class="bookmark${saved ? " saved" : ""}" type="button" data-favorite="${esc(station.id)}" aria-pressed="${saved}" aria-label="${saved ? "取消收藏" : "收藏"}${esc(station.name)}">${icon("bookmark")}</button><span class="illustration-note">插画示意</span></div><div class="station-body"><div class="station-category">${esc(station.district || "上海")}${distance !== null ? `<span class="distance-label">直线 ${distance.toFixed(1)} km</span>` : ""}</div><h3>${esc(station.name || "青年驿站")}</h3><p class="station-address">${esc(station.address || "地址暂未提供")}</p><div class="station-foot"><p>${favorite && !known ? "选择日期后确认房源" : "以官方申请结果为准"}</p><button class="detail-link" type="button" data-detail="${esc(station.id)}">查看详情${icon("arrow")}</button></div></div></article>`;
}
function emptyState(title, description, action = "retry") {
  const buttons = action === "find" ? '<button class="button button-outline" type="button" data-go-find>去找驿站</button>' : action === "filters" ? '<button class="button button-outline" type="button" data-reset-filters>重置筛选</button>' : action === "reminder" ? '<button class="button button-outline" type="button" data-open-reminder>建立有房提醒</button>' : '<button class="button button-outline" type="button" data-retry>重试查询</button>';
  return `<div class="empty-state"><span class="empty-symbol">${icon(action === "find" ? "bookmark" : "search")}</span><h3>${esc(title)}</h3><p>${esc(description)}</p>${buttons}</div>`;
}
function renderResults() {
  const source = displaySource(), items = sortAndLimit(source.items), partial = ["unknown", "pending"].includes(source.status);
  const selection = state.endDate ? `${shortDate(state.date)} — ${shortDate(state.endDate)} · ${stayNights()} 晚` : `${shortDate(state.date)} · 单日`;
  const matchedCount = source.items.filter((item) => item.availableCount >= state.minCount).length;
  $("#results-summary").textContent = `${selection} · ${state.district || "上海全市"}${items.length ? ` · ${matchedCount} 个${partial ? "已确认有房的" : ""}驿站${matchedCount > items.length ? `，显示前 ${items.length} 个` : ""}` : ""}`;
  $("#results").setAttribute("aria-busy", String(Boolean(source.loading)));
  if (items.length) $("#results").innerHTML = items.map((station) => stationCard(station)).join("");
  else if (source.status === "not-open") $("#results").innerHTML = emptyState("尚未开放申请", "请换一个日期。开放时间以官方申请页面为准。", "filters");
  else if (source.loading) $("#results").innerHTML = '<div class="empty-state loading-state"><span class="loading-dot"></span><p>正在查询房源…</p></div>';
  else if (source.error) $("#results").innerHTML = emptyState("暂时无法查询", source.error);
  else if (source.status === "pending") { const feedback = intervalFeedback(source.meta); $("#results").innerHTML = emptyState(feedback.title, feedback.description); }
  else if (partial || !state.calendar) $("#results").innerHTML = emptyState("部分房源尚待确认", "暂未确认有房，不代表没有房源，请稍后重试。");
  else $("#results").innerHTML = emptyState("暂无匹配房源", "试试其他日期或区域，也可以建立有房提醒。", state.district || state.q || state.minCount > 1 ? "filters" : "reminder");
  const currentById = new Map(allStations().map((station) => [station.id, station])), confirmed = new Map(source.items.map((station) => [station.id, station]));
  $("#favorites").innerHTML = state.favorites.size ? [...state.favorites.values()].map((station) => stationCard(favoriteForQuery(station, currentById.get(station.id), confirmed.get(station.id)), { favorite: true })).join("") : emptyState("还没有收藏", "点击驿站卡片上的收藏图标，方便下次对比。", "find");
  $("#favorite-count").textContent = state.favorites.size;
  const pieces = [];
  if (source.loading) pieces.push("正在更新");
  else if (source.meta?.pending && source.status !== "pending") pieces.push("仍在更新");
  if (source.error) pieces.push(`${source.error}${items.length ? "，保留上次结果" : ""}`);
  else if (source.stale) pieces.push("上次房源结果已过期，等待更新");
  else if (source.status === "pending") pieces.push(intervalFeedback(source.meta).summary);
  else if (partial && source.meta) pieces.push(source.total > 0 ? `部分数据 · ${Math.max(0, source.total - source.unknown)}/${source.total} 个驿站已更新` : "部分数据待确认");
  else if (source.status === "not-open") pieces.push("尚未开放，具体以官方页面为准");
  if (state.endDate && state.calendarError) pieces.push("日历暂未更新");
  if (state.endDate && source.meta?.pending && collectionNotice) pieces.push(collectionNotice);
  const sample = sampleTime(source.meta); if (sample) pieces.push(`最早采样 ${sample}`);
  if (!pieces.length) pieces.push(state.calendar ? "数据已更新" : "等待房源数据");
  $("#data-status").textContent = pieces.join(" · "); $("#data-status").classList.toggle("status-error", Boolean(source.error));
  $("#refresh-button").disabled = Boolean(state.calendarLoading || source.loading);
}
function renderFilters() {
  const districts = [...new Set(allStations().map((station) => station.district).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  if (state.district && !districts.includes(state.district)) districts.unshift(state.district);
  $("#district-filter").innerHTML = '<option value="">上海全市</option>' + districts.map((district) => `<option value="${esc(district)}">${esc(district)}</option>`).join(""); $("#district-filter").value = state.district;
  $("#filter-pills").innerHTML = ["", ...districts].map((district) => `<button class="filter-pill${district === state.district ? " active" : ""}" type="button" data-district="${esc(district)}" aria-pressed="${district === state.district}">${esc(district || "全部区域")}</button>`).join("");
}
function render() { renderCalendar(); renderFilters(); renderResults(); }
async function loadCalendar({ force = false } = {}) {
  const key = calendarKey(), cached = calendarCache.get(key);
  if (!force && cached && Date.now() - cached.at < 60_000) { calendarController?.abort(); calendarSequence++; state.calendarLoading = false; state.calendar = cached.payload; state.calendarKey = key; state.calendarError = ""; reminders.refreshStations(); render(); return; }
  calendarController?.abort(); calendarController = new AbortController(); const sequence = ++calendarSequence;
  lastCalendarAttemptAt = Date.now();
  state.calendarLoading = true; state.calendarError = ""; if (cached) { state.calendar = cached.payload; state.calendarKey = key; } render();
  try {
    const result = await request(apiPath("/api/calendar", { startDate: today, days: 21, houseType: state.houseType, onlyOnShelf: state.onlyOnShelf, minCount: 1, limit: 200, includeDayItems: false, includeOfficialDetails: false }), { signal: calendarController.signal });
    if (sequence !== calendarSequence || key !== calendarKey()) return;
    if (!Array.isArray(result.payload?.days) || !result.payload.days.length || !Array.isArray(result.payload?.stations)) {
      if (isPending(result)) throw new Error("全市数据正在准备，请稍后重试");
      throw new Error("房源数据格式暂时异常，请稍后重试");
    }
    state.calendar = result.payload; state.calendarKey = key; calendarCache.set(key, { at: Date.now(), payload: result.payload });
    reminders.refreshStations();
  } catch (error) { if (error.name === "AbortError" || sequence !== calendarSequence) return; state.calendarError = error.status === 503 ? "房源数据正在准备，请稍后重试" : error.message; }
  finally { if (sequence === calendarSequence) { state.calendarLoading = false; render(); } }
}
function advanceInterval(key) {
  collectionPump.drain(key, () => ({ meta: key === intervalKey() ? state.interval?.payload?.meta : null, visible: !document.hidden }), (report) => {
    if (key !== intervalKey() || !report) return;
    collectionNotice = report.reason === "daily-budget" ? "今日即时补查额度已用完，后台仍会定时更新" : "";
    renderResults();
  }).catch(() => { if (key === intervalKey()) { collectionNotice = "即时补查暂缓，稍后自动重试"; renderResults(); } });
}
async function loadInterval({ force = false } = {}) {
  clearTimeout(intervalTimer); intervalTimer = null; intervalController?.abort(); const sequence = ++intervalSequence;
  if (!state.endDate) { state.interval = null; render(); return; }
  const key = intervalKey(), cached = intervalCache.get(key);
  if (!force && cached && Date.now() - cached.at < (cached.pending ? 2000 : 60_000)) {
    state.interval = { ...cached, key }; collectionPump.observe(key, cached.payload.meta);
    advanceInterval(key); render(); scheduleAutoUpdate(); return;
  }
  intervalController = new AbortController(); state.interval = { key, payload: cached?.payload || null, loading: true, pending: false, error: "" }; render();
  lastIntervalAttemptAt = Date.now(); lastIntervalAttemptKey = key;
  try {
    const result = await request(apiPath("/api/available", { date: state.date, endDate: state.endDate, district: state.district, q: state.q, houseType: state.houseType, onlyOnShelf: state.onlyOnShelf, minCount: 1, limit: 200, sort: "availability", includeOfficialDetails: false }), { signal: intervalController.signal });
    if (sequence !== intervalSequence || key !== intervalKey()) return;
    const pending = isPending(result);
    if (!Array.isArray(result.payload?.data)) throw new Error("区间房源数据格式异常，请稍后重试");
    collectionPump.observe(key, result.payload.meta);
    state.interval = { key, payload: result.payload, pending, ...intervalRetry({ status: result.status, retryAfter: result.retryAfter,
      refreshAfterMs: Math.max(result.payload.meta?.refreshAfterMs || 0, collectionPump.pollDelay(key)) }, Date.now(), { minimumMs: 1000 }) };
    intervalCache.set(key, { ...state.interval, at: Date.now() });
    advanceInterval(key);
  } catch (error) { if (error.name === "AbortError" || sequence !== intervalSequence) return; state.interval = { key, payload: cached?.payload || null, error: error.message, ...intervalRetry(error) }; }
  finally { if (sequence === intervalSequence) { if (state.interval) state.interval.loading = false; render(); scheduleAutoUpdate(); } }
}
function findStation(id) { return allStations().find((station) => station.id === id) || displaySource().items.find((station) => station.id === id) || state.favorites.get(id); }
async function openStation(id) {
  const sequence = ++stationDetailSequence;
  let station = findStation(id); if (!station) return;
  if (!station.officialUrl) {
    try { station = { ...station, ...(await request(apiPath("/api/station", { stationId: id, houseType: state.houseType }))).payload.data }; }
    catch (error) { toast(error.message); return; }
  }
  if (sequence !== stationDetailSequence) return;
  const officialUrl = safeOfficialUrl(station.officialUrl), sourceStation = displaySource().items.find((item) => item.id === id), distance = measuredDistance(station);
  const available = sourceStation && Number.isSafeInteger(sourceStation.availableCount) ? `${sourceStation.availableCount} 间可用房源` : "所选日期房源待确认";
  $("#station-dialog-content").innerHTML = `<div class="dialog-top"><span></span><button class="icon-button" type="button" data-close-dialog aria-label="关闭驿站详情">${icon("close")}</button></div><div class="station-art">${stationArt()}<span class="illustration-note">插画示意</span></div><h2 id="station-dialog-title">${esc(station.name)}</h2><p class="detail-description">${esc(station.district)}${station.street ? ` · ${esc(station.street)}` : ""}<br />${esc(station.address || "地址暂未提供")}</p><p class="detail-description">${available}${distance !== null ? `<br />距离定位点直线 ${distance.toFixed(1)} km` : ""}${station.contact ? `<br />联系信息：${esc(station.contact)}` : ""}</p><div class="detail-actions">${officialUrl ? `<a class="button button-forest" href="${esc(officialUrl)}" target="_blank" rel="noopener noreferrer">官方详情与申请 ${icon("arrow")}</a>` : '<span class="data-status">官方链接暂不可用</span>'}<button class="button button-outline" type="button" data-station-reminder="${esc(station.id)}">关注这家驿站</button></div><p class="dialog-fineprint">房源会变化，最终以官方申请页面及审核为准。</p>`;
  $("#station-dialog").showModal();
}
const reminders = setupReminders({ getConditions: conditions, getStations: () => [...new Map([...state.favorites, ...allStations().map((station) => [station.id, station])]).values()], switchTab });
document.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]"); if (tab) switchTab(tab.dataset.tab);
  if (event.target.closest("[data-go-find]") || event.target.closest(".brand")) { event.preventDefault(); switchTab("find"); }
  const dayButton = event.target.closest("[data-day]"); if (dayButton) { state.date = dayButton.dataset.day; if (state.endDate && state.endDate <= state.date) state.endDate = addDays(state.date, 1); render(); $("#calendar").querySelector(`[data-day="${state.date}"]`)?.focus({ preventScroll: true }); if (state.endDate) scheduleInterval(); }
  const district = event.target.closest("[data-district]"); if (district) { state.district = district.dataset.district; render(); if (state.endDate) scheduleInterval(); }
  const favorite = event.target.closest("[data-favorite]"); if (favorite) {
    const id = favorite.dataset.favorite, station = findStation(id), saved = !state.favorites.has(id);
    if (saved && station) state.favorites.set(id, station); else state.favorites.delete(id);
    const persisted = writeFavorites(state.favorites); renderResults();
    [...document.querySelectorAll(`#${state.tab === "favorites" ? "favorites" : "results"} [data-favorite]`)].find((button) => button.dataset.favorite === id)?.focus({ preventScroll: true });
    toast(persisted ? saved ? "已收藏到当前设备。" : "已取消收藏。" : "浏览器暂不允许保存，收藏仅保留到本次关闭。");
  }
  const detail = event.target.closest("[data-detail]"); if (detail) openStation(detail.dataset.detail);
  const stationReminder = event.target.closest("[data-station-reminder]"); if (stationReminder) { $("#station-dialog").close(); reminders.open(stationReminder.dataset.stationReminder); }
  if (event.target.closest("[data-open-reminder]")) reminders.open();
  if (event.target.closest("[data-close-dialog]")) event.target.closest("dialog").close();
  if (event.target.closest("[data-retry]")) refresh();
  if (event.target.closest("[data-reset-filters]")) { state.district = ""; state.q = ""; state.minCount = 1; state.date = addDays(today, 2); $("#keyword-filter").value = ""; $("#min-count").value = "1"; if (state.endDate && state.endDate <= state.date) state.endDate = addDays(state.date, 1); render(); if (state.endDate) loadInterval(); }
});
$("#district-filter").addEventListener("change", (event) => { state.district = event.target.value; render(); if (state.endDate) scheduleInterval(); });
$("#keyword-filter").addEventListener("input", (event) => { state.q = event.target.value.trim(); renderCalendar(); renderResults(); if (state.endDate) scheduleInterval(); });
$("#sort-filter").addEventListener("change", (event) => { state.sort = event.target.value; renderResults(); });
$("#result-limit").addEventListener("change", (event) => { state.limit = Number(event.target.value); renderResults(); });
$("#min-count").addEventListener("change", (event) => { const count = Number(event.target.value); if (!Number.isInteger(count) || count < 1 || count > 10000) { event.target.value = String(state.minCount); toast("请输入 1 到 10000 之间的整数。"); return; } state.minCount = count; render(); });
for (const selector of ["#house-type", "#only-on-shelf"]) $(selector).addEventListener("change", () => { state.houseType = $("#house-type").value; state.onlyOnShelf = $("#only-on-shelf").checked; state.nearestDistances.clear(); loadCalendar(); if (state.endDate) scheduleInterval(); });
$("#date-jump").addEventListener("click", () => { $("#stay-start").value = state.date; $("#stay-start").min = today; $("#stay-end").value = state.endDate || ""; $("#stay-end").min = addDays(state.date, 1); $("#stay-error").textContent = ""; $("#stay-dialog").showModal(); });
$("#stay-start").addEventListener("change", () => { if (validDate($("#stay-start").value)) $("#stay-end").min = addDays($("#stay-start").value, 1); });
$("#stay-form").addEventListener("submit", (event) => {
  event.preventDefault(); const start = $("#stay-start").value, end = $("#stay-end").value;
  if (!validDate(start) || (end && (!validDate(end) || end <= start))) { $("#stay-error").textContent = "请选择有效日期，离店日期需晚于入住日期。"; return; }
  state.date = start; state.endDate = end || null; $("#stay-dialog").close(); render();
  if (!state.endDate && !days.includes(state.date)) { toast("单日查询请从未来 21 天中选择日期。"); state.date = addDays(today, 2); render(); }
  loadInterval();
});
$("#search-button").addEventListener("click", () => { if (state.endDate) loadInterval(); else if (!state.calendar) loadCalendar(); $(".results-section").scrollIntoView({ behavior: "smooth", block: "start" }); });
function refresh() { if (Date.now() - lastRefresh < 15_000) { toast("请稍候再刷新，避免重复请求。"); return; } lastRefresh = Date.now(); loadCalendar({ force: true }); if (state.endDate) loadInterval({ force: true }); }
$("#refresh-button").addEventListener("click", refresh);
$("#locate-button").addEventListener("click", () => {
  if (!navigator.geolocation) { toast("浏览器不支持定位，请按区域查找。"); return; }
  const button = $("#locate-button"); button.disabled = true; button.textContent = "正在获取位置…";
  navigator.geolocation.getCurrentPosition(async ({ coords }) => {
    state.coordinates = { lat: coords.latitude, lon: coords.longitude }; state.nearestDistances.clear(); state.sort = "distance"; $("#sort-filter option[value=distance]").disabled = false; $("#sort-filter").value = "distance"; $("#clear-location").classList.remove("hidden"); renderResults();
    const key = calendarKey();
    try { const { payload } = await request(apiPath("/api/nearest", { lat: coords.latitude, lon: coords.longitude, houseType: state.houseType, onlyOnShelf: state.onlyOnShelf, limit: 200, includeOfficialDetails: false })); if (key === calendarKey() && state.coordinates?.lat === coords.latitude && state.coordinates?.lon === coords.longitude) { state.nearestDistances = new Map((Array.isArray(payload?.data) ? payload.data : []).filter((station) => typeof station.distanceKm === "number" && Number.isFinite(station.distanceKm)).map((station) => [station.id, station.distanceKm])); renderResults(); } toast("按直线距离排序，路线距离请参考地图。"); }
    catch { toast("已按现有坐标估算直线距离；附近驿站查询暂未完成。"); }
    finally { button.disabled = false; button.innerHTML = `${icon("pin")}离我最近`; }
  }, () => { button.disabled = false; button.innerHTML = `${icon("pin")}离我最近`; toast("未获得位置，可继续按区域查找。"); }, { timeout: 12_000, maximumAge: 60_000, enableHighAccuracy: false });
});
$("#clear-location").addEventListener("click", () => { state.coordinates = null; state.nearestDistances.clear(); state.sort = "availability"; $("#sort-filter").value = "availability"; $("#sort-filter option[value=distance]").disabled = true; $("#clear-location").classList.add("hidden"); renderResults(); });
document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("click", (event) => { if (event.target !== dialog) return; const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); }));
window.addEventListener("storage", () => { state.favorites = readFavorites(); renderResults(); });

// Re-read same-origin snapshots gently while the page is visible. No location or mail actions.
function needsSnapshotUpdate(payload, error = false, pending = false) {
  if (!payload || error || pending || payload.meta?.pending) return true;
  const sample = payload.meta?.oldestFetchedAt || payload.meta?.fetchedAt;
  return !sample || !Number.isFinite(Date.parse(sample)) || Date.now() - Date.parse(sample) >= 15 * 60_000;
}
function autoUpdate() {
  if (document.hidden) return;
  const currentCalendar = state.calendarKey === calendarKey() ? state.calendar : null;
  if (!state.calendarLoading && Date.now() - lastCalendarAttemptAt >= 60_000 && needsSnapshotUpdate(currentCalendar, state.calendarError)) loadCalendar({ force: true });
  if (state.endDate && !intervalTimer) {
    const key = intervalKey(), current = state.interval?.key === key ? state.interval : null;
    const sinceAttempt = key === lastIntervalAttemptKey ? Date.now() - lastIntervalAttemptAt : Infinity;
    if (!current?.loading && current?.retryable !== false && Date.now() >= (current?.retryAt || 0) && sinceAttempt >= collectionPump.pollDelay(key) && needsSnapshotUpdate(current?.payload, current?.error, current?.pending)) loadInterval({ force: true });
  }
}
function scheduleAutoUpdate() {
  clearTimeout(autoUpdateTimer);
  if (!document.hidden) autoUpdateTimer = setTimeout(() => { autoUpdateTimer = null; autoUpdate(); scheduleAutoUpdate(); }, state.endDate ? collectionPump.pollDelay(intervalKey()) : 60_000);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) autoUpdate(); scheduleAutoUpdate(); });
window.addEventListener("pagehide", () => clearTimeout(autoUpdateTimer));
window.addEventListener("pageshow", () => { autoUpdate(); scheduleAutoUpdate(); });
hydrateIcons(); render(); loadCalendar(); reminders.initialize(); scheduleAutoUpdate();
