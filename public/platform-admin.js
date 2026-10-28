"use strict";

const tokenKey = "bobo_platform_session";
const loginPanel = document.getElementById("loginPanel");
const appPanel = document.getElementById("appPanel");
const logoutButton = document.getElementById("logout");
const message = document.getElementById("message");
const createDialog = document.getElementById("createTenantDialog");
const tenantDetailsDialog = document.getElementById("tenantDetailsDialog");
const resetPasswordDialog = document.getElementById("resetPasswordDialog");
const createForm = document.getElementById("createForm");
const resetPasswordForm = document.getElementById("resetPasswordForm");
let tenants = [];
let plans = [];
let modules = [];
let releases = [];
let rebatePeriods = [];
let currentVersion = "";
let resetPasswordTenant = null;
let currentTenantDetails = null;
let createStep = 1;

function showMessage(text) {
  message.textContent = text;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const token = localStorage.getItem(tokenKey) || "";
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch (error) {
    throw new Error(`${path}：网络请求失败（${error.message}）`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}（HTTP ${response.status}）：${body.error || "请求失败"}`);
  return body;
}

function setLoggedIn(value) {
  loginPanel.classList.toggle("hidden", value);
  appPanel.classList.toggle("hidden", !value);
  logoutButton.classList.toggle("hidden", !value);
}

function formObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function money(fen) {
  if (fen === null || fen === undefined) return "未授权";
  return `¥${(Number(fen) / 100).toFixed(2)}`;
}

function todayInShanghai() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function licenseStatus(tenant) {
  if (!tenant.startsAt || !tenant.endsAt) return "expired";
  const today = new Date().toISOString().slice(0, 10);
  if (tenant.startsAt > today) return "upcoming";
  return tenant.endsAt < today ? "expired" : "active";
}

function paymentText(value) {
  return { unpaid: "未收款", paid: "已收款", waived: "免费授权", not_required: "无需收款" }[value] || "—";
}

function rebateTierText(period) {
  if (period.rebateTier === 2) return period.paymentStatus === "paid" ? "全额返还" : "第二档已达标";
  if (period.rebateTier === 1) return period.paymentStatus === "paid" ? "返还 50%" : "第一档已达标";
  return "未达标";
}

function rebateProgressPercent(output, target) {
  if (!target) return 0;
  return Math.min(100, Number((output * 100 / target).toFixed(2)));
}

function filteredTenants() {
  const search = document.getElementById("tenantSearch").value.trim().toLowerCase();
  const status = document.getElementById("tenantStatusFilter").value;
  const license = document.getElementById("tenantLicenseFilter").value;
  const payment = document.getElementById("tenantPaymentFilter").value;
  return tenants.filter((tenant) => {
    const matchesSearch = !search || [tenant.name, tenant.slug, tenant.tenantId].some((value) => String(value || "").toLowerCase().includes(search));
    return matchesSearch && (!status || tenant.status === status) && (!license || licenseStatus(tenant) === license) && (!payment || tenant.paymentStatus === payment);
  });
}

function renderTenants() {
  const rows = document.getElementById("tenantRows");
  rows.replaceChildren();
  const visibleTenants = filteredTenants();
  for (const tenant of visibleTenants) {
    const row = document.createElement("tr");
    const cells = [
      `${tenant.name}\n${tenant.slug}`,
      `${tenant.tenantId}`,
      `${{ active: "正常", suspended: "已暂停", closed: "已关闭" }[tenant.status] || tenant.status}\n${licenseStatus(tenant) === "active" ? "授权有效" : licenseStatus(tenant) === "upcoming" ? "授权未开始" : "授权已到期"}`,
      tenant.databaseConfigured ? "已配置" : "未配置",
      tenant.planName || "兼容全功能",
      `${money(tenant.annualAmountFen)} · ${paymentText(tenant.paymentStatus)}\n${tenant.startsAt || "—"} 至 ${tenant.endsAt || "—"}`,
    ];
    for (const value of cells) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    const actionCell = document.createElement("td");
    actionCell.innerHTML = `<div class="row-actions"><button class="row-button" data-action="details" data-tenant-id="${escapeHtml(tenant.tenantId)}">详情</button><button class="row-button" data-action="password" data-tenant-id="${escapeHtml(tenant.tenantId)}">重置密码</button><button class="row-button" data-action="status" data-tenant-id="${escapeHtml(tenant.tenantId)}" data-status="${tenant.status === "active" ? "suspended" : "active"}">${tenant.status === "active" ? "暂停" : "恢复"}</button></div>`;
    row.append(actionCell);
    rows.append(row);
  }
  document.getElementById("tenantCount").textContent = `显示 ${visibleTenants.length} / ${tenants.length} 家租户`;
}

function moduleCheckboxes(container, selected = [], name = "modules") {
  container.innerHTML = modules.map((item) => `<label class="check-item"><input type="checkbox" name="${name}" value="${escapeHtml(item.key)}" ${selected.includes(item.key) ? "checked" : ""}><span>${escapeHtml(item.name)}</span></label>`).join("");
}

function renderPlanList() {
  const container = document.getElementById("planList");
  container.innerHTML = plans.map((plan) => {
    const names = modules.filter((item) => plan.modules.includes(item.key)).map((item) => item.name).join("、") || "未开放模块";
    return `<article class="list-card"><div class="card-title"><strong>${escapeHtml(plan.name)}</strong><button class="row-button" data-action="edit-plan" data-plan-id="${escapeHtml(plan.planId)}">编辑</button></div><p>${escapeHtml(plan.description || "无说明")}</p><p class="muted">${plan.modules.length} 个模块 · ${escapeHtml(names)}</p></article>`;
  }).join("") || `<p class="empty">尚未配置套餐。</p>`;
}

function renderReleaseTenantCheckboxes(selected = []) {
  const eligibleTenants = tenants.filter((tenant) => tenant.slug !== "future-machinery");
  document.getElementById("releaseTenants").innerHTML = eligibleTenants.map((tenant) => `<label class="check-item"><input type="checkbox" name="tenantIds" value="${escapeHtml(tenant.tenantId)}" ${selected.includes(tenant.tenantId) ? "checked" : ""}><span>${escapeHtml(tenant.name)}</span></label>`).join("") || `<p class="muted">暂无可灰度租户</p>`;
}

function releaseStatusText(status) {
  return { draft: "草稿", gray: "灰度中", stable: "全量稳定", paused: "已暂停", rolled_back: "已回滚" }[status] || status;
}

function renderReleases() {
  document.getElementById("currentVersion").textContent = `当前部署版本 ${currentVersion || "未知"}`;
  const container = document.getElementById("releaseList");
  container.innerHTML = releases.map((release) => {
    const moduleNames = modules.filter((item) => release.modules.includes(item.key)).map((item) => item.name).join("、");
    const included = release.rollouts.filter((item) => item.status === "included").map((item) => item.tenantId);
    const rolloutOptions = tenants.filter((tenant) => tenant.slug !== "future-machinery").map((tenant) => `<label class="check-item"><input type="checkbox" data-rollout-tenant="${escapeHtml(tenant.tenantId)}" data-release-id="${escapeHtml(release.releaseId)}" ${included.includes(tenant.tenantId) ? "checked" : ""}><span>${escapeHtml(tenant.name)}</span></label>`).join("");
    const actions = release.status === "stable" ? `<button class="row-button" data-action="pause-release" data-release-id="${escapeHtml(release.releaseId)}">暂停</button><button class="row-button danger" data-action="rollback-release" data-release-id="${escapeHtml(release.releaseId)}">回滚</button>`
      : release.status === "rolled_back" ? `<button class="row-button" data-action="gray-release" data-release-id="${escapeHtml(release.releaseId)}">重新灰度</button>`
        : `<button class="row-button" data-action="stable-release" data-release-id="${escapeHtml(release.releaseId)}">全量稳定</button>${release.status !== "paused" ? `<button class="row-button" data-action="pause-release" data-release-id="${escapeHtml(release.releaseId)}">暂停</button>` : ""}<button class="row-button danger" data-action="rollback-release" data-release-id="${escapeHtml(release.releaseId)}">回滚</button>`;
    return `<article class="list-card"><div class="card-title"><strong>v${escapeHtml(release.version)}</strong><span class="status-pill ${escapeHtml(release.status)}">${releaseStatusText(release.status)}</span></div><p>${escapeHtml(release.notes || "无变更说明")}</p><p class="muted">模块：${escapeHtml(moduleNames)} · 灰度租户：${included.length}</p><div class="row-actions">${actions}</div>${release.status === "gray" || release.status === "paused" ? `<details class="rollout-editor"><summary>调整灰度租户</summary><div class="check-grid">${rolloutOptions}</div><button class="row-button" data-action="save-rollout" data-release-id="${escapeHtml(release.releaseId)}">保存名单</button></details>` : ""}</article>`;
  }).join("") || `<p class="empty">尚无发布记录。</p>`;
}

async function loadTenants() {
  const data = await api("/api/platform/tenants");
  tenants = data.tenants || [];
  renderTenants();
  renderReleaseTenantCheckboxes();
}

async function loadPlans() {
  const [planData, moduleData] = await Promise.all([api("/api/platform/plans"), api("/api/platform/feature-modules")]);
  plans = planData.plans || [];
  modules = moduleData.modules || [];
  moduleCheckboxes(document.getElementById("planModules"), modules.map((item) => item.key));
  moduleCheckboxes(document.getElementById("releaseModules"), []);
  renderPlanList();
  const select = document.getElementById("createPlanSelect");
  select.innerHTML = plans.filter((plan) => plan.active).map((plan) => `<option value="${escapeHtml(plan.planId)}">${escapeHtml(plan.name)}</option>`).join("");
}

async function loadReleases() {
  const data = await api("/api/platform/releases");
  releases = data.releases || [];
  currentVersion = data.currentVersion || "";
  renderReleases();
}

function renderRebates() {
  const host = document.getElementById("rebatePeriods");
  host.innerHTML = rebatePeriods.map((period) => {
    const first = Number(period.firstTargetFen || 0);
    const full = Number(period.fullTargetFen || 0);
    const output = Number(period.outputFen || 0);
    const annualAmount = Number(period.annualAmountFen || 0);
    const tierRefundFen = period.rebateTier === 2 ? annualAmount : period.rebateTier === 1 ? Math.floor(annualAmount / 2) : 0;
    const progress = (target) => rebateProgressPercent(output, target);
    const ended = period.endsAt < todayInShanghai();
    const configured = first > 0 && full > first;
    const settlement = ended && configured && period.settledRefundFen == null
      ? `<form class="rebate-settlement" data-rebate-settlement="${escapeHtml(period.entitlementId)}"><strong>周期已结束，登记线下退款</strong><div class="rebate-form-grid"><label>退款金额（元）<input name="refundAmount" type="number" min="0" step="0.01" value="${(Number(period.estimatedRefundFen || 0) / 100).toFixed(2)}" required></label><label>退款日期<input name="settledAt" type="date" required></label><label class="rebate-note">备注<input name="note" maxlength="500"></label><button class="row-button">登记退款</button></div></form>` : period.settledRefundFen != null
        ? `<p class="rebate-settled">已登记退款 ${money(period.settledRefundFen)} · ${escapeHtml(period.settledAt || "")} · ${escapeHtml(period.settlementNote || "无备注")}</p>` : "";
    const refundLabel = period.paymentStatus === "unpaid" && tierRefundFen > 0 && period.settledRefundFen == null
      ? `${Number(period.acceptedTaskCount || 0)} 单 · 预计现金返还 ${money(period.estimatedRefundFen)}（年费未收）· 收款后该档可返 ${money(tierRefundFen)}`
      : `${Number(period.acceptedTaskCount || 0)} 单 · 预计返还 ${money(period.estimatedRefundFen)}`;
    return `<article class="rebate-card"><div class="card-title"><div><strong>${escapeHtml(period.partnerName)} · ${escapeHtml(period.partnerSlug)}</strong><p class="muted">授权周期 ${escapeHtml(period.startsAt)} 至 ${escapeHtml(period.endsAt)} · 年费 ${money(period.annualAmountFen)} · ${paymentText(period.paymentStatus)}</p></div><span class="status-pill ${period.rebateTier ? "stable" : "draft"}">${rebateTierText(period)}</span></div>
      <div class="rebate-output"><strong>已验收产值 ${money(output)}</strong><span>${refundLabel}</span></div>
      <div class="rebate-progress"><div><span>第一档 ${first ? money(first) : "未设置"} · ${progress(first)}%</span><div class="progress-track"><i style="width:${progress(first)}%"></i></div></div><div><span>全额档 ${full ? money(full) : "未设置"} · ${progress(full)}%</span><div class="progress-track"><i style="width:${progress(full)}%"></i></div></div></div>
      ${period.settledRefundFen == null ? `<form class="rebate-targets" data-rebate-targets="${escapeHtml(period.entitlementId)}"><label>半额门槛（元）<input name="firstTarget" type="number" min="0.01" step="0.01" value="${first ? (first / 100).toFixed(2) : ""}" required></label><label>全额门槛（元）<input name="fullTarget" type="number" min="0.02" step="0.01" value="${full ? (full / 100).toFixed(2) : ""}" required></label><button class="row-button">保存门槛</button></form>` : ""}${settlement}</article>`;
  }).join("") || `<p class="empty">暂无外协租户授权周期。</p>`;
  host.querySelectorAll("input[name=settledAt]").forEach((input) => { input.value = todayInShanghai(); });
}

async function loadRebates() {
  const data = await api("/api/platform/outsourcing-rebates");
  rebatePeriods = data.periods || [];
  renderRebates();
}

async function loadAll() {
  await Promise.all([loadTenants(), loadPlans()]);
  await Promise.all([loadReleases(), loadRebates()]);
}

document.getElementById("rebatePeriods").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const entitlementId = form.dataset.rebateTargets || form.dataset.rebateSettlement;
  if (!entitlementId) return;
  try {
    if (form.dataset.rebateTargets) {
      const values = formObject(form);
      await api(`/api/platform/outsourcing-rebates/${encodeURIComponent(entitlementId)}/targets`, { method: "POST", body: JSON.stringify({ firstTargetFen: Math.round(Number(values.firstTarget) * 100), fullTargetFen: Math.round(Number(values.fullTarget) * 100) }) });
      showMessage("产值门槛已保存");
    } else {
      const values = formObject(form);
      await api(`/api/platform/outsourcing-rebates/${encodeURIComponent(entitlementId)}/settlement`, { method: "POST", body: JSON.stringify({ refundFen: Math.round(Number(values.refundAmount) * 100), settledAt: values.settledAt, note: values.note }) });
      showMessage("线下退款已登记");
    }
    await loadRebates();
  } catch (error) { showMessage(error.message); }
});
document.getElementById("refreshRebates").addEventListener("click", () => loadRebates().catch((error) => showMessage(error.message)));

function setCreateStep(step) {
  createStep = step;
  document.querySelectorAll("[data-create-step]").forEach((section) => section.classList.toggle("hidden", Number(section.dataset.createStep) !== step));
  document.getElementById("createStepLabel").textContent = step === 1 ? "第 1 步，共 2 步 · 公司和管理员" : "第 2 步，共 2 步 · 套餐和授权";
  document.getElementById("createBack").classList.toggle("hidden", step === 1);
  document.getElementById("createNext").classList.toggle("hidden", step === 2);
  document.getElementById("createSubmit").classList.toggle("hidden", step !== 2);
}

function resetPlanEditor() {
  const form = document.getElementById("planForm");
  form.reset();
  form.elements.planId.value = "";
  document.getElementById("planFormTitle").textContent = "新建套餐";
  moduleCheckboxes(document.getElementById("planModules"), []);
}

async function openTenantDetails(tenantId) {
  const details = await api(`/api/platform/tenants/${encodeURIComponent(tenantId)}/details`);
  currentTenantDetails = details;
  document.getElementById("tenantDetailsTitle").textContent = details.tenant.name;
  document.getElementById("tenantDetailsSubtitle").textContent = `${details.tenant.slug} · ${details.tenant.tenantId}`;
  renderTenantDetails(details);
  tenantDetailsDialog.showModal();
}

function renderTenantDetails(details) {
  const mainTenant = details.tenant.slug === "future-machinery";
  const planOptions = plans.filter((plan) => plan.active).map((plan) => `<option value="${escapeHtml(plan.planId)}" ${details.plan.planId === plan.planId ? "selected" : ""}>${escapeHtml(plan.name)}</option>`).join("");
  const entitlements = details.entitlements.map((item) => `<tr><td>${escapeHtml(item.startsAt)} 至 ${escapeHtml(item.endsAt)}</td><td>${money(item.annualAmountFen)}</td><td><form class="inline-payment-form" data-entitlement-payment="${escapeHtml(item.entitlementId)}"><select name="paymentStatus" aria-label="收款状态">${[["unpaid", "未收款"], ["paid", "已收款"], ["waived", "免费授权"], ["not_required", "无需收款"]].map(([value, label]) => `<option value="${value}" ${item.paymentStatus === value ? "selected" : ""}>${label}</option>`).join("")}</select><button class="button button-small" type="submit">保存</button></form></td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.note || "")}</td></tr>`).join("") || `<tr><td colspan="5">暂无授权记录</td></tr>`;
  const audits = details.auditLogs.map((item) => `<li><strong>${escapeHtml(item.action)}</strong><span>${escapeHtml(item.createdAt)} · ${escapeHtml(item.actorUserId)}</span><pre>${escapeHtml(JSON.stringify(item.details))}</pre></li>`).join("") || `<li>暂无操作记录</li>`;
  const releaseRows = details.releases.map((item) => `<li>v${escapeHtml(item.version)} · ${releaseStatusText(item.status)} · 本租户：${escapeHtml(item.rolloutStatus)}</li>`).join("") || `<li>暂无灰度发布</li>`;
  const selected = details.features || [];
  document.getElementById("tenantDetailsBody").innerHTML = `
    <section class="detail-section"><h3>公司与管理员</h3><div class="detail-grid"><div><span>公司状态</span><strong>${escapeHtml(details.tenant.status)}</strong></div><div><span>管理员</span><strong>${escapeHtml(details.admin.name || "未找到")}</strong></div><div><span>管理员手机号</span><strong>${escapeHtml(details.admin.phone || "—")}</strong></div><div><span>独立数据库</span><strong>${details.database.configured ? "已配置" : "未配置"}</strong><small>${escapeHtml(details.database.name || "")}</small></div></div></section>
    <section class="detail-section"><h3>套餐与单户模块</h3>${mainTenant ? `<p class="notice">宁波未来机械是主程序租户，固定开放全部功能，套餐配置不限制其功能。</p>` : `<label>VIP 套餐<select id="tenantPlanSelect">${planOptions}</select></label><div id="tenantModuleChecks" class="check-grid module-checks"></div><button id="saveTenantFeatures" class="button">保存模块授权</button>`}</section>
    <section class="detail-section"><h3>授权历史</h3><div class="table-wrap"><table><thead><tr><th>期限</th><th>年费</th><th>收款</th><th>状态</th><th>备注</th></tr></thead><tbody>${entitlements}</tbody></table></div><form id="tenantEntitlementForm" class="grid entitlement-form"><label>年费（元）<input name="annualAmount" type="number" min="0" step="0.01" value="0" required></label><label>收款状态<select name="paymentStatus"><option value="unpaid">未收款</option><option value="paid">已收款</option></select></label><label>开始日期<input name="startsAt" type="date" required></label><label>结束日期<input name="endsAt" type="date" required></label><label class="full">备注<input name="note" maxlength="500"></label><button class="button">追加授权记录</button></form></section>
    <section class="detail-section"><h3>软件灰度</h3><ul class="simple-list">${releaseRows}</ul><p class="muted">同一服务统一部署；此处显示功能灰度开放状态。</p></section>
    <section class="detail-section"><h3>操作记录（最近 100 条）</h3><ul class="audit-list">${audits}</ul></section>`;
  if (!mainTenant) {
    const planSelect = document.getElementById("tenantPlanSelect");
    const renderChecks = (chosen) => {
      const selectedPlan = plans.find((item) => item.planId === chosen) || plans[0];
      const baseModules = selectedPlan?.modules || [];
      const effective = chosen === details.plan.planId ? selected : baseModules;
      moduleCheckboxes(document.getElementById("tenantModuleChecks"), effective, "tenantModule");
    };
    renderChecks(details.plan.planId);
    planSelect.addEventListener("change", () => renderChecks(planSelect.value));
    document.getElementById("saveTenantFeatures").addEventListener("click", async () => {
      const plan = plans.find((item) => item.planId === planSelect.value);
      const enabled = [...document.querySelectorAll("#tenantModuleChecks input:checked")].map((input) => input.value);
      const overrides = Object.fromEntries(modules.filter((item) => Boolean(plan?.modules.includes(item.key)) !== enabled.includes(item.key)).map((item) => [item.key, enabled.includes(item.key)]));
      await api(`/api/platform/tenants/${encodeURIComponent(details.tenant.tenantId)}/features`, { method: "POST", body: JSON.stringify({ planId: planSelect.value, overrides }) });
      await openTenantDetails(details.tenant.tenantId);
      await loadTenants();
      showMessage("套餐与模块授权已保存");
    });
  }
  const entitlementForm = document.getElementById("tenantEntitlementForm");
  document.querySelectorAll("[data-entitlement-payment]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const entitlementId = form.dataset.entitlementPayment;
      try {
        await api(`/api/platform/tenants/${encodeURIComponent(details.tenant.tenantId)}/entitlements/${encodeURIComponent(entitlementId)}/payment-status`, {
          method: "POST",
          body: JSON.stringify({ paymentStatus: form.elements.paymentStatus.value }),
        });
        await openTenantDetails(details.tenant.tenantId);
        await loadTenants();
        await loadRebates();
        showMessage("授权收款状态已更新");
      } catch (error) { showMessage(error.message); }
    });
  });
  const today = new Date();
  const dateValue = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  entitlementForm.elements.startsAt.value = dateValue(today);
  const yearLater = new Date(today);
  yearLater.setFullYear(yearLater.getFullYear() + 1);
  entitlementForm.elements.endsAt.value = dateValue(yearLater);
  entitlementForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = formObject(entitlementForm);
    values.annualAmountFen = Math.round(Number(values.annualAmount) * 100);
    delete values.annualAmount;
    try {
      await api(`/api/platform/tenants/${encodeURIComponent(details.tenant.tenantId)}/entitlements`, { method: "POST", body: JSON.stringify(values) });
      await openTenantDetails(details.tenant.tenantId);
      await loadTenants();
      showMessage("授权记录已追加");
    } catch (error) { showMessage(error.message); }
  });
}

async function updateReleaseStatus(releaseId, status) {
  await api(`/api/platform/releases/${encodeURIComponent(releaseId)}/status`, { method: "POST", body: JSON.stringify({ status }) });
  await loadReleases();
  showMessage("发布状态已更新");
}

document.getElementById("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const response = await fetch("/api/platform/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(formObject(event.currentTarget)) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "登录失败");
    localStorage.setItem(tokenKey, data.sessionToken);
    setLoggedIn(true);
    await loadAll();
    showMessage("");
  } catch (error) { showMessage(error.message); }
});

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
  document.querySelectorAll(".admin-panel").forEach((panel) => panel.classList.toggle("hidden", panel.id !== `${tab.dataset.panel}Panel`));
}));

document.getElementById("createTenantButton").addEventListener("click", () => {
  createForm.reset();
  const today = new Date();
  const dateValue = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  createForm.elements.startsAt.value = dateValue(today);
  const yearLater = new Date(today);
  yearLater.setFullYear(yearLater.getFullYear() + 1);
  createForm.elements.endsAt.value = dateValue(yearLater);
  setCreateStep(1);
  createDialog.showModal();
});
document.getElementById("createNext").addEventListener("click", () => {
  const stepFields = [...document.querySelectorAll('[data-create-step="1"] input')];
  if (stepFields.some((field) => !field.reportValidity())) return;
  setCreateStep(2);
});
document.getElementById("createBack").addEventListener("click", () => setCreateStep(1));
createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!createForm.reportValidity()) return;
  const values = formObject(createForm);
  values.slug = String(values.slug || "").trim().toLowerCase();
  values.annualAmountFen = Math.round(Number(values.annualAmount) * 100);
  delete values.annualAmount;
  try {
    const data = await api("/api/platform/tenants", { method: "POST", body: JSON.stringify(values) });
    createDialog.close();
    await loadTenants();
    showMessage(`已创建 ${data.tenant.name}，管理员账号 ${data.adminUser.phone}`);
  } catch (error) { showMessage(error.message); }
});

document.getElementById("planForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = formObject(form);
  values.modules = [...form.querySelectorAll('input[name="modules"]:checked')].map((input) => input.value);
  try {
    await api("/api/platform/plans", { method: "POST", body: JSON.stringify(values) });
    await loadPlans();
    resetPlanEditor();
    showMessage("套餐已保存；已存在的单户模块覆盖保持不变");
  } catch (error) { showMessage(error.message); }
});
document.getElementById("planList").addEventListener("click", (event) => {
  const button = event.target.closest('[data-action="edit-plan"]');
  if (!button) return;
  const plan = plans.find((item) => item.planId === button.dataset.planId);
  if (!plan) return;
  const form = document.getElementById("planForm");
  form.elements.planId.value = plan.planId;
  form.elements.name.value = plan.name;
  form.elements.description.value = plan.description;
  document.getElementById("planFormTitle").textContent = `编辑套餐 · ${plan.name}`;
  moduleCheckboxes(document.getElementById("planModules"), plan.modules);
});
document.getElementById("resetPlanForm").addEventListener("click", resetPlanEditor);

document.getElementById("releaseForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = formObject(form);
  values.modules = [...form.querySelectorAll('input[name="modules"]:checked')].map((input) => input.value);
  values.tenantIds = [...form.querySelectorAll('input[name="tenantIds"]:checked')].map((input) => input.value);
  try {
    await api("/api/platform/releases", { method: "POST", body: JSON.stringify(values) });
    form.reset();
    moduleCheckboxes(document.getElementById("releaseModules"), []);
    renderReleaseTenantCheckboxes();
    await loadReleases();
    showMessage("发布记录已登记");
  } catch (error) { showMessage(error.message); }
});

document.getElementById("tenantRows").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const tenant = tenants.find((item) => item.tenantId === button.dataset.tenantId);
  if (!tenant) return;
  try {
    if (button.dataset.action === "details") await openTenantDetails(tenant.tenantId);
    if (button.dataset.action === "status") {
      await api(`/api/platform/tenants/${encodeURIComponent(tenant.tenantId)}/status`, { method: "POST", body: JSON.stringify({ status: button.dataset.status }) });
      await loadTenants();
      showMessage("租户状态已更新");
    }
    if (button.dataset.action === "password") {
      resetPasswordTenant = tenant;
      document.getElementById("resetPasswordTitle").textContent = `重置${tenant.name}管理员密码`;
      resetPasswordForm.reset();
      resetPasswordDialog.showModal();
      resetPasswordForm.elements.password.focus();
    }
  } catch (error) { showMessage(error.message); }
});

document.getElementById("releaseList").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  try {
    if (button.dataset.action === "save-rollout") {
      const tenantIds = [...document.querySelectorAll(`[data-release-id="${CSS.escape(button.dataset.releaseId)}"][data-rollout-tenant]:checked`)].map((input) => input.dataset.rolloutTenant);
      await api(`/api/platform/releases/${encodeURIComponent(button.dataset.releaseId)}/rollouts`, { method: "POST", body: JSON.stringify({ tenantIds }) });
      await loadReleases();
      showMessage("灰度租户名单已更新");
    } else {
      const status = { "stable-release": "stable", "pause-release": "paused", "rollback-release": "rolled_back", "gray-release": "gray" }[button.dataset.action];
      if (status) await updateReleaseStatus(button.dataset.releaseId, status);
    }
  } catch (error) { showMessage(error.message); }
});

resetPasswordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!resetPasswordTenant) return;
  const tenant = resetPasswordTenant;
  try {
    const data = await api(`/api/platform/tenants/${encodeURIComponent(tenant.tenantId)}/admin-password`, { method: "POST", body: JSON.stringify({ password: resetPasswordForm.elements.password.value }) });
    resetPasswordDialog.close();
    showMessage(`${tenant.name}管理员（${data.adminUser.phone}）密码已重置，旧登录会话已退出`);
  } catch (error) { showMessage(error.message); }
});

document.getElementById("refresh").addEventListener("click", () => loadAll().catch((error) => showMessage(error.message)));
["tenantSearch", "tenantStatusFilter", "tenantLicenseFilter", "tenantPaymentFilter"].forEach((id) => document.getElementById(id).addEventListener("input", renderTenants));
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => document.getElementById(button.dataset.close).close()));
document.getElementById("tenantDetailsDialog").addEventListener("click", (event) => {
  if (event.target === tenantDetailsDialog) tenantDetailsDialog.close();
});
document.getElementById("logout").addEventListener("click", async () => {
  try { await api("/api/platform/logout", { method: "POST", body: "{}" }); } catch {}
  localStorage.removeItem(tokenKey);
  setLoggedIn(false);
});

if (localStorage.getItem(tokenKey)) {
  setLoggedIn(true);
  loadAll().catch((error) => {
    localStorage.removeItem(tokenKey);
    setLoggedIn(false);
    showMessage(error.message);
  });
} else {
  setLoggedIn(false);
}
