const calendarElement = document.querySelector("#calendar");
const detailsElement = document.querySelector("#details");
const statusElement = document.querySelector("#status");
const rangeLabelElement = document.querySelector("#range-label");
const detailsTitleElement = document.querySelector("#details-title");
const detailsCountElement = document.querySelector("#details-count");
const shelfCheckbox = document.querySelector("#only-on-shelf");
const houseTypeSelect = document.querySelector("#house-type");
const refreshButton = document.querySelector("#refresh-button");
const FIXED_CALENDAR_DAYS = 21;
const OFFICIAL_MAP_URL = "https://qnyz.shyouth.net/TWYouthInnV2/static/onemap/index.html";

let calendarDays = [];
let stationCalendars = [];
let selectedDate = null;

function localIsoDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDay(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  return {
    weekday: new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(date),
    monthDay: new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date),
  };
}

function weekdayIndex(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  return (date.getUTCDay() + 6) % 7;
}

function monthLabel(dateString) {
  const [year, month] = dateString.split("-");
  return `${year}年${Number(month)}月`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStatus(message, kind = "") {
  statusElement.textContent = message;
  statusElement.className = `status ${kind}`.trim();
}

function renderCalendar(days) {
  const today = localIsoDate();
  calendarElement.innerHTML = days.map((day) => {
    const display = formatDay(day.date);
    const isToday = day.date === today;
    const isSelected = day.date === selectedDate;
    const notOpen = day.availabilityStatus === "not-open";
    const countClass = notOpen ? "not-open" : day.availableCount > 0 ? "has-rooms" : "no-rooms";
    const countText = notOpen ? "暂未开放" : day.availableCount;
    const roomLabel = notOpen ? "官网尚未开放申请" : "间可用房源";
    const stationText = notOpen ? "最早可选：今天后第 2 天" : `${day.stationCount} 个驿站有房`;
    return `
      <button class="day-card ${isToday ? "today" : ""} ${isSelected ? "selected" : ""}"
        type="button" data-date="${escapeHtml(day.date)}" aria-pressed="${isSelected}">
        <span class="day-top">
          <span class="weekday">${escapeHtml(display.weekday)}</span>
          ${isToday ? '<span class="today-badge">今天</span>' : ""}
        </span>
        <strong class="month-day">${escapeHtml(display.monthDay)}</strong>
        <span class="room-count ${countClass}">${escapeHtml(countText)}</span>
        <span class="room-label">${escapeHtml(roomLabel)}</span>
        <span class="station-count">${escapeHtml(stationText)}</span>
      </button>`;
  }).join("");

  calendarElement.querySelectorAll(".day-card").forEach((button) => {
    button.addEventListener("click", () => selectDate(button.dataset.date));
  });
}

function renderStationCalendar(availability) {
  const groups = [];
  for (const item of availability) {
    const key = item.date.slice(0, 7);
    let group = groups.at(-1);
    if (!group || group.key !== key) {
      group = { key, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }

  const weekdayLabels = ["一", "二", "三", "四", "五", "六", "日"];
  const months = groups.map((group) => {
    const leadingCells = Array.from(
      { length: weekdayIndex(group.items[0].date) },
      () => '<span class="mini-day empty" aria-hidden="true"></span>',
    ).join("");
    const cells = group.items.map((item) => {
      const isSelected = item.date === selectedDate;
      const notOpen = item.availabilityStatus === "not-open";
      const hasRooms = !notOpen && item.availableCount > 0;
      const statusClass = notOpen ? "not-open" : hasRooms ? "available" : "unavailable";
      const statusText = notOpen ? "待开放" : hasRooms ? "有房" : "无房";
      const countText = hasRooms ? `${item.availableCount}间` : "";
      const title = notOpen ? "暂未开放" : `${item.availableCount} 间可用房源`;
      return `
        <button class="mini-day ${statusClass} ${isSelected ? "selected" : ""}"
          type="button" data-date="${escapeHtml(item.date)}" title="${escapeHtml(`${item.date}：${title}`)}">
          <span class="mini-day-number">${escapeHtml(Number(item.date.slice(-2)))}</span>
          <span class="mini-day-status">${escapeHtml(statusText)}</span>
          <span class="mini-day-count">${escapeHtml(countText)}</span>
        </button>`;
    }).join("");
    return `
      <section class="mini-month" aria-label="${escapeHtml(monthLabel(`${group.key}-01`))}">
        <h4>${escapeHtml(monthLabel(`${group.key}-01`))}</h4>
        <div class="mini-weekdays">${weekdayLabels.map((label) => `<span>${label}</span>`).join("")}</div>
        <div class="mini-days">${leadingCells}${cells}</div>
      </section>`;
  }).join("");

  return `
    <div class="station-calendar">
      <div class="station-calendar-heading">
        <span>未来 20 天房源情况</span>
        <span class="station-calendar-tip">点击日期可切换查看</span>
      </div>
      <div class="mini-calendar">${months}</div>
    </div>`;
}

function renderDetails(day) {
  const display = formatDay(day.date);
  detailsTitleElement.textContent = `${display.monthDay}（${display.weekday}）的可用驿站`;
  if (day.availabilityStatus === "not-open") {
    detailsCountElement.textContent = "尚未开放申请";
    detailsElement.innerHTML = `
      <div class="details-empty">
        <span>◷</span>
        <p>官网最早可选为今天后第 2 天，这一天暂不统计房源数量</p>
      </div>`;
    return;
  }
  detailsCountElement.textContent = `${day.availableCount} 间 · ${day.stationCount} 个驿站`;
  if (!day.items.length) {
    detailsElement.innerHTML = `
      <div class="details-empty">
        <span>—</span>
        <p>这一天暂时没有可用房源</p>
      </div>`;
    return;
  }
  const stationMap = new Map(stationCalendars.map((station) => [station.id, station]));
  detailsElement.innerHTML = day.items.map((item) => {
    const station = stationMap.get(item.id);
    const availability = station?.availability || [];
    return `
      <article class="listing-card">
        <div class="listing-top">
          <span class="available-badge">可用 ${escapeHtml(item.availableCount)} 间</span>
          <span class="district-tag">${escapeHtml(item.district)}</span>
        </div>
        <h3>${escapeHtml(item.name)}</h3>
        <p class="address">${escapeHtml(item.address)}</p>
        ${renderStationCalendar(availability)}
        <div class="card-foot">
          <span>${escapeHtml(item.street)}</span>
          <a href="${escapeHtml(item.officialUrl || OFFICIAL_MAP_URL)}" target="_blank" rel="noreferrer">申请入驻 ↗</a>
        </div>
      </article>`;
  }).join("");

  detailsElement.querySelectorAll(".mini-day[data-date]").forEach((button) => {
    button.addEventListener("click", () => selectDate(button.dataset.date));
  });
}

function selectDate(date) {
  const day = calendarDays.find((item) => item.date === date);
  if (!day) return;
  selectedDate = date;
  renderCalendar(calendarDays);
  renderDetails(day);
}

async function loadCalendar() {
  refreshButton.disabled = true;
  refreshButton.textContent = "读取中…";
  setStatus("正在读取全市未来房源…");
  calendarElement.classList.add("loading");
  const query = new URLSearchParams({
    startDate: localIsoDate(),
    days: String(FIXED_CALENDAR_DAYS),
    onlyOnShelf: shelfCheckbox.checked ? "true" : "false",
    houseType: houseTypeSelect.value,
  });
  try {
    const response = await fetch(`/api/calendar?${query.toString()}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "日历查询失败");
    calendarDays = payload.days;
    stationCalendars = payload.stations || [];
    selectedDate = calendarDays.some((day) => day.date === selectedDate)
      ? selectedDate
      : calendarDays[0]?.date;
    renderCalendar(calendarDays);
    if (selectedDate) renderDetails(calendarDays.find((day) => day.date === selectedDate));
    const endDate = calendarDays.at(-1)?.date || payload.startDate;
    rangeLabelElement.textContent = `${payload.startDate} — ${endDate}`;
    setStatus("全市数据更新完成", "success");
  } catch (error) {
    setStatus(error.message || "日历查询失败，请稍后重试", "error");
    calendarElement.innerHTML = `<div class="load-error">${escapeHtml(error.message || "查询失败")}</div>`;
    detailsElement.innerHTML = "";
  } finally {
    calendarElement.classList.remove("loading");
    refreshButton.disabled = false;
    refreshButton.textContent = "刷新数据";
  }
}

shelfCheckbox.addEventListener("change", loadCalendar);
houseTypeSelect.addEventListener("change", loadCalendar);
refreshButton.addEventListener("click", loadCalendar);
loadCalendar();
