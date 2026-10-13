import { request } from "./api.mjs";
import { icon, escapeHtml as esc, todayInShanghai, addDays, validDate, shortDate, toast } from "./ui.mjs";

const $ = (selector) => document.querySelector(selector);
const validToken = (token) => typeof token === "string" && /^[A-Za-z0-9_-]{16,1024}$/.test(token);

export function setupReminders({ getConditions, getStations, switchTab }) {
  let mailConfigured = false, invitationRequired = false, healthCheckedAt = 0, healthBusy = false;
  let verificationToken = null, managementToken = null, records = [], listLoading = false, listSequence = 0;
  let formBusy = false, accessBusy = false, verificationBusy = false;
  let editSession = null, formGeneration = 0, mutationBusy = false, listReloadQueued = false;

  function updateMailState() {
    const inviteNeeded = invitationRequired && !editSession && !managementToken;
    const memberCreate = invitationRequired && !editSession && Boolean(managementToken);
    $("#reminder-invite-field").classList.toggle("hidden", !inviteNeeded);
    $("#reminder-invite-note").classList.toggle("hidden", !invitationRequired || Boolean(editSession));
    $("#reminder-invite-code").required = inviteNeeded;
    if (!inviteNeeded) $("#reminder-invite-code").value = "";
    $("#mail-status").textContent = healthBusy ? "正在检查邮件服务…" : mailConfigured ? "" : "邮件服务暂不可用，请稍后重试。";
    $("#mail-status").classList.toggle("hidden", Boolean(editSession) || (mailConfigured && !healthBusy));
    $("#retry-mail-health").classList.toggle("hidden", Boolean(editSession) || healthBusy || mailConfigured);
    $("#management-health-retry").classList.toggle("hidden", healthBusy || mailConfigured);
    $("#reminder-submit").disabled = formBusy || (editSession ? editSession.token !== managementToken : !mailConfigured || healthBusy);
    if (!editSession) {
      $("#reminder-submit").innerHTML = memberCreate ? "启用提醒" : `${icon("mail")}发送验证邮件`;
      $("#reminder-description").textContent = memberCreate ? "符合条件时发送邮件提醒，可随时通过管理链接取消。" : "有房时发邮件，通过邮件链接随时取消。";
      $("#reminder-footer-note").textContent = memberCreate ? "每 15 分钟检查，可在管理列表中暂停或取消。" : "验证邮箱后启用，每 15 分钟检查一次。";
    }
    $("#reminder-form").querySelectorAll("input, select").forEach((field) => { field.disabled = formBusy || (Boolean(editSession) && field.id === "reminder-email") || (field.id === "reminder-invite-code" && !inviteNeeded); });
    $("#management-submit").disabled = accessBusy || !mailConfigured || healthBusy;
  }
  async function checkHealth({ force = false } = {}) {
    if (healthBusy || (!force && Date.now() - healthCheckedAt < 60_000)) return;
    healthBusy = true; updateMailState();
    try { const { payload } = await request("/api/health", { timeoutMs: 10_000 }); mailConfigured = payload?.mailConfigured === true || payload?.data?.mailConfigured === true; invitationRequired = payload?.invitationRequired === true || payload?.data?.invitationRequired === true; healthCheckedAt = Date.now(); }
    catch { mailConfigured = false; }
    finally { healthBusy = false; updateMailState(); }
    if (!mailConfigured && !managementToken && !verificationToken) $("#management-message").textContent = "邮件服务暂不可用，请稍后再试。";
  }

  function syncStayConditions() {
    const continuous = Boolean($("#reminder-end").value);
    const select = $("#reminder-station");
    select.required = continuous;
    $("#reminder-station-label").textContent = continuous ? "指定驿站" : "指定驿站（选填）";
    $("#continuous-reminder-hint").classList.toggle("hidden", !continuous);
    const empty = select.querySelector('option[value=""]');
    if (empty) { empty.disabled = continuous; empty.textContent = continuous ? "请选择一个驿站" : "该区域所有驿站"; }
  }
  function populateDistrictOptions(selected, stations = getStations()) {
    const districts = [...new Set(stations.map((station) => station.district).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    if (selected && !districts.includes(selected)) districts.push(selected);
    $("#reminder-district").innerHTML = '<option value="">上海全市</option>' + districts.map((district) => `<option value="${esc(district)}">${esc(district)}</option>`).join("");
    $("#reminder-district").value = selected;
  }
  function populateStationOptions(selected = "", { preserveSelected = false, label = "" } = {}) {
    const district = $("#reminder-district").value;
    const candidates = getStations().filter((station) => !district || station.district === district);
    const retained = selected && (preserveSelected || editSession?.conditions.stationId === selected) && !candidates.some((station) => station.id === selected);
    $("#reminder-station").innerHTML = '<option value="">该区域所有驿站</option>' + candidates.map((station) => `<option value="${esc(station.id)}">${esc(station.name)}</option>`).join("") + (retained ? `<option value="${esc(selected)}">${esc(label || "已选驿站（当前列表未显示）")}</option>` : "");
    $("#reminder-station").value = retained || candidates.some((station) => station.id === selected) ? selected : "";
    syncStayConditions();
  }
  function refreshStations() {
    if (!$("#reminder-dialog").open || formBusy) return;
    const district = $("#reminder-district").value, station = $("#reminder-station");
    const selected = station.value, label = station.selectedOptions?.[0]?.textContent || "";
    populateDistrictOptions(district);
    populateStationOptions(selected, { preserveSelected: true, label });
  }
  function open(stationId = "") {
    if (formBusy || mutationBusy) { toast("正在保存提醒，请稍候。"); return; }
    editSession = null; formGeneration++;
    showForm(getConditions(), stationId);
    checkHealth();
  }
  function openEdit(id) {
    if (!managementToken || formBusy || mutationBusy || listLoading) return;
    const record = records.find((item) => item.id === id && ["active", "paused"].includes(item.status));
    if (!record?.conditions) return;
    editSession = { id, token: managementToken, conditions: { ...record.conditions } };
    formGeneration++;
    showForm(editSession.conditions, editSession.conditions.stationId || "");
  }
  function showForm(conditions, stationId) {
    const stations = getStations();
    const station = stations.find((item) => item.id === stationId);
    const selectedDistrict = editSession ? conditions.district || "" : station?.district || conditions.district || "";
    populateDistrictOptions(selectedDistrict, stations);
    populateStationOptions(stationId);
    $("#reminder-start").value = conditions.date;
    $("#reminder-start").min = todayInShanghai();
    $("#reminder-end").value = conditions.endDate || "";
    $("#reminder-end").min = addDays(conditions.date, 1);
    syncStayConditions();
    $("#reminder-min-count").value = String(conditions.minCount);
    const editing = Boolean(editSession);
    $("#reminder-title").textContent = editing ? "修改提醒条件" : "建立有房提醒";
    $("#reminder-description").textContent = editing ? "保存后使用新的条件，无需再次验证邮箱。" : "有房时发邮件，通过邮件链接随时取消。";
    $("#reminder-email-field").classList.toggle("hidden", editing);
    $("#reminder-email").disabled = editing;
    $("#reminder-email").required = !editing;
    $("#reminder-invite-code").value = "";
    $("#reminder-submit").innerHTML = editing ? "保存修改" : `${icon("mail")}发送验证邮件`;
    $("#reminder-footer-note").textContent = editing ? "原有暂停或启用状态保持不变。" : "验证邮箱后启用，每 15 分钟检查一次。";
    $("#reminder-error").textContent = ""; $("#reminder-message").textContent = "";
    updateMailState(); $("#reminder-dialog").showModal();
  }

  $("#retry-mail-health").addEventListener("click", () => checkHealth({ force: true }));
  $("#management-health-retry").addEventListener("click", () => checkHealth({ force: true }));
  $("#reminder-district").addEventListener("change", () => populateStationOptions());
  $("#reminder-start").addEventListener("change", () => { if (validDate($("#reminder-start").value)) $("#reminder-end").min = addDays($("#reminder-start").value, 1); syncStayConditions(); });
  $("#reminder-end").addEventListener("input", syncStayConditions);
  $("#reminder-end").addEventListener("change", syncStayConditions);
  $("#reminder-dialog").addEventListener("close", () => { $("#reminder-invite-code").value = ""; });
  $("#reminder-form").addEventListener("submit", async (event) => {
    event.preventDefault(); if (formBusy || mutationBusy || (!editSession && !mailConfigured)) return;
    const editing = editSession, generation = formGeneration;
    const creationToken = editing ? null : managementToken;
    const memberCreation = !editing && invitationRequired && Boolean(creationToken);
    const requiresInvite = !editing && invitationRequired && !creationToken;
    if (editing && editing.token !== managementToken) { $("#reminder-error").textContent = "管理链接已变更，请重新打开提醒。"; return; }
    const values = Object.fromEntries(new FormData(event.target));
    const inviteCode = requiresInvite ? String(values.inviteCode || "").trim() : "";
    if (requiresInvite && !inviteCode) { $("#reminder-error").textContent = "请输入邀请码。"; $("#reminder-invite-code").focus(); return; }
    if (values.endDate && !values.stationId) { $("#reminder-error").textContent = "连续入住提醒请选择一个驿站。"; $("#reminder-station").focus(); return; }
    const minCount = Number(values.minCount);
    if (!validDate(values.date) || (values.endDate && (!validDate(values.endDate) || values.endDate <= values.date)) || !Number.isInteger(minCount) || minCount < 1 || minCount > 10000) { $("#reminder-error").textContent = "请检查入住、离店日期及房源数量。"; return; }
    const current = editing ? editing.conditions : getConditions();
    const conditions = { ...(editing ? current : {}), date: values.date, endDate: values.endDate || null, district: values.district || "", stationId: values.stationId || "", houseType: current.houseType, onlyOnShelf: current.onlyOnShelf, minCount };
    formBusy = true; $("#reminder-error").textContent = ""; $("#reminder-message").textContent = "正在提交…"; updateMailState();
    if (editing || memberCreation) mutationBusy = true;
    if (memberCreation && listLoading) { listSequence++; listLoading = false; listReloadQueued = true; }
    try {
      if (editing) {
        const { payload } = await request(`/api/reminders/${encodeURIComponent(editing.id)}`, { method: "PATCH", token: editing.token, body: { conditions } });
        if (generation !== formGeneration || editing.token !== managementToken) return;
        if (payload?.data?.id === editing.id) { records = records.map((record) => record.id === editing.id ? payload.data : record); renderRecords(); }
        $("#reminder-dialog").close(); editSession = null; formGeneration++;
        toast("提醒条件已修改。"); mutationBusy = false; await loadRecords();
      } else {
        const { payload } = await request("/api/reminders", { method: "POST", ...(creationToken ? { token: creationToken } : {}), body: { email: values.email.trim(), conditions, ...(requiresInvite ? { inviteCode } : {}) } });
        if (generation !== formGeneration || (creationToken && creationToken !== managementToken)) return;
        $("#reminder-invite-code").value = "";
        const created = payload?.data;
        if (creationToken && created && typeof created.id === "string" && created.conditions && typeof created.status === "string") {
          records = records.some((record) => record.id === created.id) ? records.map((record) => record.id === created.id ? created : record) : [created, ...records];
          renderRecords(); $("#reminder-dialog").close(); formGeneration++; switchTab("monitors");
          const message = typeof payload.message === "string" ? payload.message.trim().slice(0, 300) : "";
          toast(created.status === "paused" ? "这份提醒当前已暂停。" : message || (created.status === "active" ? "提醒已启用。" : "提醒已保存。"));
          mutationBusy = false; await loadRecords();
        } else {
          $("#reminder-message").textContent = "如果此地址可用，你会收到验证邮件。请检查收件箱及垃圾邮件，点击邮件链接后启用提醒。";
        }
      }
    } catch (error) {
      if (generation === formGeneration) {
        $("#reminder-message").textContent = "";
        $("#reminder-error").textContent = editing ? [401, 403].includes(error.status) ? "管理链接已失效，请重新获取链接。" : error.message : error.code === "REMINDER_CAPACITY" ? "提醒名额暂满，请稍后再试。查房仍可正常使用。" : error.status === 503 ? "邮件服务暂不可用，未能提交，请稍后重试。" : error.message;
      }
    } finally { formBusy = false; if (editing || memberCreation) mutationBusy = false; updateMailState(); if (listReloadQueued) loadRecords(); }
  });

  $("#management-form").addEventListener("submit", async (event) => {
    event.preventDefault(); if (accessBusy) return;
    if (!mailConfigured) { await checkHealth({ force: true }); if (!mailConfigured) return; }
    accessBusy = true; updateMailState(); $("#management-message").textContent = "正在请求管理链接…";
    try { await request("/api/reminders/access", { method: "POST", body: { email: $("#management-email").value.trim() } }); $("#management-message").textContent = "如果该邮箱有可管理的提醒，你会收到专属管理链接。请检查收件箱及垃圾邮件。"; }
    catch (error) { $("#management-message").textContent = error.status === 503 ? "邮件服务暂不可用，请稍后重试。" : error.message; }
    finally { accessBusy = false; updateMailState(); }
  });

  function renderRecords() {
    $("#monitor-count").textContent = records.length; $("#monitor-count").classList.toggle("hidden", !records.length);
    const states = { active: "已启用", paused: "已暂停", pending: "待验证", pending_verification: "待验证", expired: "已过期", cancelled: "已取消", canceled: "已取消" };
    $("#monitors").innerHTML = records.length ? records.map((record) => {
      const conditions = record.conditions && typeof record.conditions === "object" ? record.conditions : {};
      const station = getStations().find((item) => item.id === conditions.stationId);
      const title = station?.name || (conditions.stationId ? "指定驿站" : conditions.district || "上海全市");
      const dates = `${shortDate(conditions.date)}${conditions.endDate ? ` — ${shortDate(conditions.endDate)}` : " · 单日"}`;
      const status = states[record.status] || "状态待确认";
      const toggle = ["active", "paused"].includes(record.status) ? `<button class="quiet-button" type="button" data-toggle-reminder="${esc(record.id)}" data-next-status="${record.status === "active" ? "paused" : "active"}">${record.status === "active" ? "暂停" : "恢复"}</button>` : "";
      const edit = ["active", "paused"].includes(record.status) ? `<button class="quiet-button" type="button" data-edit-reminder="${esc(record.id)}">修改</button>` : "";
      return `<article class="monitor-card"><span class="monitor-symbol">${icon("bell")}</span><div class="monitor-content"><h3>${esc(title)}</h3><div class="monitor-meta"><span>${dates}</span><span>至少 ${esc(conditions.minCount ?? 1)} 间</span><span>每 15 分钟检查</span></div></div><span class="draft-badge">${status}</span><div class="monitor-actions">${edit}${toggle}<button class="quiet-button danger-button" type="button" data-delete-reminder="${esc(record.id)}">取消提醒</button></div></article>`;
    }).join("") : '<div class="empty-state"><span class="empty-symbol">' + icon("bell") + '</span><h3>还没有提醒</h3><p>选择入住日期和区域，建立一份有房提醒。</p><button class="button button-outline" type="button" data-open-reminder>建立提醒</button></div>';
  }
  async function loadRecords() {
    if (!managementToken || listLoading) return;
    if (mutationBusy) { listReloadQueued = true; return; }
    listReloadQueued = false;
    const token = managementToken, sequence = ++listSequence;
    listLoading = true; $("#management-drafts").classList.remove("hidden"); $("#reload-reminders").disabled = true; $("#reminder-list-status").textContent = "正在读取提醒…";
    try {
      const { payload } = await request("/api/reminders", { token });
      if (token !== managementToken || sequence !== listSequence) return;
      if (!Array.isArray(payload?.data)) throw new Error("提醒数据格式异常，请稍后重试。");
      records = payload.data.filter((record) => record && typeof record.id === "string"); renderRecords(); $("#reminder-list-status").textContent = "";
    } catch (error) { if (sequence === listSequence) $("#reminder-list-status").textContent = [401, 403].includes(error.status) ? "管理链接已失效，请用邮箱获取新的链接。" : `${error.message}${records.length ? "，保留已有列表。" : ""}`; }
    finally { if (sequence === listSequence) { listLoading = false; $("#reload-reminders").disabled = false; } }
  }
  $("#reload-reminders").addEventListener("click", loadRecords);
  $("#monitors").addEventListener("click", async (event) => {
    const edit = event.target.closest("[data-edit-reminder]");
    if (edit) { openEdit(edit.dataset.editReminder); return; }
    const toggle = event.target.closest("[data-toggle-reminder]"), remove = event.target.closest("[data-delete-reminder]");
    const button = toggle || remove;
    if (!button || !managementToken || button.disabled || listLoading || mutationBusy || formBusy) return;
    const token = managementToken;
    const id = toggle ? toggle.dataset.toggleReminder : remove.dataset.deleteReminder;
    if (remove && !window.confirm("取消这份有房提醒？取消后将停止检查和邮件通知。")) return;
    button.disabled = true; mutationBusy = true;
    try {
      await request(`/api/reminders/${encodeURIComponent(id)}`, { method: remove ? "DELETE" : "PATCH", token, ...(toggle ? { body: { status: toggle.dataset.nextStatus } } : {}) });
      if (token !== managementToken) return;
      toast(remove ? "已取消提醒。" : toggle.dataset.nextStatus === "paused" ? "已暂停提醒。" : "已恢复提醒。"); mutationBusy = false; await loadRecords();
    } catch (error) { if (token === managementToken) $("#reminder-list-status").textContent = error.message; button.disabled = false; }
    finally { mutationBusy = false; if (listReloadQueued) loadRecords(); }
  });
  $("#confirm-verification").addEventListener("click", async () => {
    if (!verificationToken || verificationBusy) return;
    const verifying = verificationToken;
    verificationBusy = true; $("#confirm-verification").disabled = true; $("#verification-status").textContent = "正在验证…";
    try {
      const { payload } = await request("/api/reminders/verify", { method: "POST", body: { token: verifying } });
      if (verificationToken !== verifying) return;
      verificationToken = null; $("#verification-status").textContent = "邮箱已验证，提醒已启用。"; $("#confirm-verification").classList.add("hidden");
      const token = payload?.managementToken || payload?.data?.managementToken;
      if (validToken(token)) { managementToken = token; updateMailState(); records = []; listLoading = false; listSequence++; await loadRecords(); }
    } catch (error) { $("#verification-status").textContent = error.message; $("#confirm-verification").disabled = false; }
    finally { verificationBusy = false; }
  });
  function consumeFragment() {
    const params = new URLSearchParams(location.hash.slice(1));
    const verify = params.get("verify"), manage = params.get("manage");
    if (!verify && !manage) return;
    if (editSession) { editSession = null; formGeneration++; $("#reminder-dialog").close(); }
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    switchTab("monitors");
    if (verify) {
      if (!validToken(verify)) { $("#management-message").textContent = "验证链接无效，请重新建立提醒。"; return; }
      verificationToken = verify; $("#verification-box").classList.remove("hidden"); $("#confirm-verification").classList.remove("hidden"); $("#confirm-verification").disabled = false; $("#verification-status").textContent = "";
    } else if (manage) {
      if (!validToken(manage)) { $("#management-message").textContent = "管理链接无效，请重新获取。"; return; }
      managementToken = manage; updateMailState(); records = []; listLoading = false; listSequence++; $("#monitors").innerHTML = ""; $("#verification-box").classList.add("hidden"); loadRecords();
    }
  }
  function initialize() { checkHealth(); consumeFragment(); window.addEventListener("hashchange", consumeFragment); }
  return { open, initialize, refreshStations };
}
