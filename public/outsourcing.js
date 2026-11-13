"use strict";

(() => {
  const state = {
    root: null,
    loaded: false,
    loading: false,
    isOwner: false,
    partners: [],
    delegations: [],
    tasks: [],
    tenantNames: {},
    orders: [],
    tab: "units",
    unitView: "detail",
    selectedPartnerId: "",
    unitTaskLimit: 8,
    unitSearch: "",
    taskSearch: "",
    taskStatus: "all",
    openGroups: new Set(),
    taskGroupsInitialized: false,
    taskGroupLimits: new Map(),
    message: "",
    error: "",
    proofObjectUrl: "",
    proofObjectUrls: new Map(),
    proofLoads: new Map(),
    proofSession: "",
    drawingObjectUrl: "",
    submittingTask: false,
  };

  const permissionNames = { tasks: "任务承接", progress: "进度", exceptions: "异常", attachments: "附件", quality: "质检与返修", delivery: "发货验收" };
  const statusNames = { sent: "待外协确认", accepted: "生产中", in_progress: "生产中", blocked: "有阻塞", submitted: "外协已发货，待未来机械验收", accepted_by_owner: "订单已完成", revision_requested: "返修中", cancelled: "已取消" };
  let pendingAttentionStatus = "";
  let ownerArchiveTimer = null;

  function esc(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  }

  function currentUser() {
    try { return JSON.parse(sessionStorage.getItem("work_user") || "null"); } catch { return null; }
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionStorage.getItem("work_session") || ""}`,
        "x-company-slug": sessionStorage.getItem("work_company_slug") || "future-machinery",
        ...(options.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "请求失败");
    return body;
  }

  function dateText(value) {
    if (!value) return "未设置";
    if (typeof value === "string") return value.slice(0, 10);
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? "未设置" : value.toISOString().slice(0, 10);
    if (typeof value === "object") {
      const year = Number(value.year);
      const month = Number(value.month);
      const day = Number(value.day);
      if (Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)) return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (typeof value.toISOString === "function") return value.toISOString().slice(0, 10);
    }
    return "未设置";
  }

  function dateTimeText(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return dateText(value);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
  }

  function clearProofImages() {
    for (const url of state.proofObjectUrls.values()) URL.revokeObjectURL(url);
    state.proofObjectUrls.clear();
    state.proofLoads.clear();
  }

  async function proofImageUrl(url) {
    const session = sessionStorage.getItem("work_session") || "";
    if (state.proofSession !== session) {
      clearProofImages();
      state.proofSession = session;
    }
    if (state.proofObjectUrls.has(url)) return state.proofObjectUrls.get(url);
    if (state.proofLoads.has(url)) return state.proofLoads.get(url);
    const request = fetch(url, { headers: { Authorization: `Bearer ${session}`, "x-company-slug": sessionStorage.getItem("work_company_slug") || "future-machinery" } })
      .then((response) => { if (!response.ok) throw new Error("无权查看报工照片"); return response.blob(); })
      .then((blob) => {
        if (!blob.type.startsWith("image/")) throw new Error("报工凭证不是有效图片");
        if (sessionStorage.getItem("work_session") !== session) throw new Error("登录状态已变化，请刷新页面");
        const objectUrl = URL.createObjectURL(blob);
        state.proofObjectUrls.set(url, objectUrl);
        return objectUrl;
      })
      .finally(() => state.proofLoads.delete(url));
    state.proofLoads.set(url, request);
    return request;
  }

  function todayText() {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  function taskTitle(task) {
    return task.production?.workNo || task.snapshot?.orderNo || task.taskId;
  }

  function taskPartnerId(task) {
    return task.side === "owner" ? task.partnerTenantId : task.ownerTenantId;
  }

  function taskCompanyName(task) {
    const tenantId = taskPartnerId(task);
    return state.tenantNames[tenantId] || (task.side === "owner" ? task.partnerName : task.ownerName) || "未知单位";
  }

  function buildShell() {
    return `
      <section class="om-workspace" aria-labelledby="om-title">
        <header class="om-header">
          <div><p class="om-eyebrow">BOBO SaaS</p><h1 id="om-title">委派任务</h1><p id="om-subtitle" class="om-subtitle">查看和处理分配给本公司的任务。</p></div>
          <div class="om-header-actions"><button class="om-button om-button-light" type="button" data-om-action="refresh">刷新</button></div>
        </header>
        <div id="om-content" aria-live="polite"></div>
        <p id="om-message" class="om-message" role="status"></p>
        <dialog id="om-delegation-dialog" class="om-dialog">
          <form id="om-delegation-form" class="om-dialog-form">
            <div class="om-dialog-head"><div><h2>建立外协关系</h2><p>设置授权期限和外协单位可访问的功能。</p></div><button class="om-icon-button" type="button" data-close="delegation" aria-label="关闭">×</button></div>
            <div class="om-form-grid">
              <label class="om-field"><span>外协单位</span><select name="partnerTenantId" id="om-partner-select" required></select></label>
              <label class="om-field"><span>开始日期</span><input name="startsAt" type="date" required /></label>
              <label class="om-field"><span>结束日期</span><input name="endsAt" type="date" required /></label>
              <fieldset class="om-permissions"><legend>允许查看或处理</legend>
                ${Object.entries(permissionNames).map(([key, name]) => `<label><input type="checkbox" name="permission" value="${key}" ${["tasks", "progress", "exceptions", "attachments"].includes(key) ? "checked" : ""}><span>${name}</span></label>`).join("")}
                <p class="om-hint om-wide">“任务承接”允许外协确认收到订单；“发货验收”允许外协完成工序后提交发货，供未来机械验收；“质检与返修”允许委托方处理验收和返修。</p>
              </fieldset>
            </div>
            <div class="om-dialog-actions"><button class="om-button om-button-light" type="button" data-close="delegation">取消</button><button class="om-button" type="submit">创建关系</button></div>
          </form>
        </dialog>
        <dialog id="om-task-dialog" class="om-dialog">
          <form id="om-task-form" class="om-dialog-form">
            <div class="om-dialog-head"><div><h2>委派生产任务</h2><p>外协确认承接后生产，完成全部工序并发货后提交验收。</p></div><button class="om-icon-button" type="button" data-close="task" aria-label="关闭">×</button></div>
            <div class="om-form-grid">
              <label class="om-field"><span>委派关系</span><select name="delegationId" id="om-delegation-select" required></select></label>
              <label class="om-field"><span>来源订单</span><select name="orderId" id="om-order-select" required></select></label>
              <label class="om-field"><span>整单计划数量</span><input id="om-quantity" type="text" readonly></label>
              <label class="om-field"><span>本单产值（元）</span><input name="productionValue" id="om-production-value" type="number" min="0.01" step="0.01" required></label>
              <label class="om-field"><span>外协交期</span><input name="dueDate" type="date" required></label>
              <fieldset id="om-route-options" class="om-route-options"><legend>整单完整工序链</legend><p class="om-empty">先选择来源订单</p></fieldset>
              <p id="om-quantity-hint" class="om-hint om-wide">新委派将覆盖整张工单、全部计划数量和完整工序链。</p>
              <p id="om-delivery-permission-hint" class="om-hint om-wide" hidden>当前关系未开启“发货验收”，外协单位将无法提交验收。请先在有效关系中开启该权限。</p>
              <label class="om-field om-wide"><span>验收要求</span><textarea name="acceptanceCriteria" rows="3" maxlength="2000"></textarea></label>
            </div>
            <div class="om-dialog-actions"><button class="om-button om-button-light" type="button" data-close="task">取消</button><button class="om-button" type="submit" id="om-submit-task" disabled>发送外协任务</button></div>
          </form>
        </dialog>
        <dialog id="om-proof-dialog" class="om-proof-dialog" aria-label="报工照片预览">
          <button class="om-proof-dialog-close" type="button" data-close-proof aria-label="关闭照片预览">×</button>
          <img id="om-proof-viewer-image" alt="委派任务报工照片">
        </dialog>
        <dialog id="om-drawing-dialog" class="om-drawing-dialog" aria-label="原订单图纸">
          <header><strong id="om-drawing-title">原订单图纸</strong><button class="om-proof-dialog-close" type="button" data-close-drawing aria-label="关闭图纸预览">×</button></header>
          <nav id="om-drawing-list" aria-label="图纸文件"></nav>
          <div id="om-drawing-viewer"></div>
        </dialog>
      </section>`;
  }

  function taskWithinOwnerSupervision(task, now = Date.now()) {
    if (task.side !== "owner" || task.status !== "accepted_by_owner") return true;
    const acceptedAt = new Date(task.ownerAcceptedAt).getTime();
    return !Number.isFinite(acceptedAt) || now < acceptedAt + 60 * 60 * 1000;
  }

  function ownerTasks() { return state.tasks.filter((task) => task.side === "owner" && taskWithinOwnerSupervision(task)); }

  function isCurrentDelegation(delegation, today = todayText()) {
    return delegation.status === "active" && delegation.startsAt <= today && delegation.endsAt >= today;
  }

  function activeDelegations() {
    return state.delegations.filter((delegation) => isCurrentDelegation(delegation));
  }

  function isAttentionStatus(status) {
    return ["sent", "blocked", "submitted", "revision_requested"].includes(status);
  }

  function taskMatchesFilter(task, status) {
    if (!taskWithinOwnerSupervision(task)) return false;
    if (status === "processing") return !["accepted_by_owner", "cancelled"].includes(task.status);
    if (status === "attention") return isAttentionStatus(task.status);
    return status === "all" || task.status === status;
  }

  function scheduleOwnerArchive() {
    if (ownerArchiveTimer) clearTimeout(ownerArchiveTimer);
    ownerArchiveTimer = null;
    if (!state.isOwner) return;
    const now = Date.now();
    const nextExpiry = state.tasks
      .filter((task) => task.side === "owner" && task.status === "accepted_by_owner")
      .map((task) => new Date(task.ownerAcceptedAt).getTime() + 60 * 60 * 1000)
      .filter((time) => Number.isFinite(time) && time > now)
      .sort((a, b) => a - b)[0];
    if (nextExpiry) ownerArchiveTimer = setTimeout(() => { ownerArchiveTimer = null; render(); }, nextExpiry - now);
  }

  function relationsForPartner(partnerId) {
    return state.delegations.filter((item) => item.partnerTenantId === partnerId);
  }

  function tasksForPartner(partnerId) {
    return ownerTasks().filter((task) => task.partnerTenantId === partnerId);
  }

  function stats() {
    const activeRelations = activeDelegations().length;
    const visibleTasks = ownerTasks();
    const activeTasks = visibleTasks.filter((item) => !["accepted_by_owner", "cancelled"].includes(item.status)).length;
    const attention = visibleTasks.filter((item) => isAttentionStatus(item.status)).length;
    const cards = [["partners", "已开通租户", state.partners.length], ["relations", "有效委派关系", activeRelations], ["processing", "处理中任务", activeTasks], ["attention", "待跟进", attention]];
    return `<section class="om-stats" aria-label="外协概况">
      ${cards.map(([target, label, count]) => `<button type="button" class="om-stat" data-stat="${target}" aria-label="${label}，${count}，点击查看对应内容"><span>${label}</span><strong>${count}</strong><small>查看 →</small></button>`).join("")}
    </section>`;
  }

  function tabs() {
    const labels = state.isOwner ? [["units", "外协单位"], ["tasks", "委派任务"]] : [["tasks", "收到的任务"]];
    return `<nav class="om-tabs" aria-label="外协监管视图">${labels.map(([key, label]) => `<button type="button" class="${state.tab === key ? "active" : ""}" data-tab="${key}">${label}</button>`).join("")}</nav>`;
  }

  function unitList() {
    const query = state.unitSearch.trim().toLocaleLowerCase();
    const today = todayText();
    const partners = state.partners.filter((partner) => !query || `${partner.name} ${partner.tenantId}`.toLocaleLowerCase().includes(query));
    if (!partners.length) return `<div class="om-empty-state">${state.partners.length ? "没有符合条件的单位" : "暂无已开通的外协单位"}</div>`;
    return partners.map((partner) => {
      const relations = relationsForPartner(partner.tenantId);
      const tasks = tasksForPartner(partner.tenantId);
      const active = relations.filter((item) => isCurrentDelegation(item, today)).length;
      return `<button type="button" class="om-unit ${state.selectedPartnerId === partner.tenantId ? "selected" : ""}" data-partner="${esc(partner.tenantId)}">
        <span class="om-unit-copy"><strong>${esc(partner.name)}</strong><small>${active ? `${active} 个有效关系` : relations.length ? "无有效关系" : "尚未建立关系"}</small></span>
        <span class="om-unit-count">${tasks.length}</span>
      </button>`;
    }).join("");
  }

  function relationCard(item) {
    const current = isCurrentDelegation(item);
    const permissions = (item.permissions || []).map((permission) => permissionNames[permission]).filter(Boolean);
    return `<article class="om-relation-card">
      <div class="om-relation-main"><div><strong>${current ? "有效授权" : item.status === "active" ? "未生效或已过期" : "已撤销"}</strong><span class="om-state ${current ? "is-active" : ""}">${esc(item.status)}</span></div>
        <p>${esc(item.startsAt)} 至 ${esc(item.endsAt)}</p><small>可访问：${esc(permissions.join("、") || "无")}</small></div>
      ${item.status === "active" ? `<button type="button" class="om-button om-button-light om-button-small" data-revoke="${esc(item.delegationId)}">撤销</button>` : ""}
    </article>`;
  }

  function selectedUnitView() {
    const partner = state.partners.find((item) => item.tenantId === state.selectedPartnerId);
    if (!partner) return `<section class="om-detail"><div class="om-empty-state">选择左侧外协单位查看关系和任务。</div></section>`;
    const relations = relationsForPartner(partner.tenantId);
    const tasks = tasksForPartner(partner.tenantId);
    const currentRelations = relations.filter((item) => isCurrentDelegation(item));
    const historyRelations = relations.filter((item) => !currentRelations.includes(item));
    const visibleTasks = tasks.slice(0, state.unitTaskLimit);
    return `<section class="om-detail">
      <div class="om-detail-head"><div><p class="om-eyebrow">外协单位</p><h2>${esc(partner.name)}</h2><p>${relations.length} 个关系 · ${tasks.length} 项委派任务</p></div>
        <button type="button" class="om-button" data-open="task" data-task-partner="${esc(partner.tenantId)}" ${relations.some((item) => item.status === "active" && (item.permissions || []).includes("tasks")) ? "" : "disabled"}>委派任务</button></div>
      ${!partner.eligible ? `<div class="om-notice">该单位当前没有有效 SaaS 授权，暂不能建立委派关系。</div>` : ""}
      <section class="om-section"><div class="om-section-head"><h3>委派关系</h3><button type="button" class="om-text-button" data-open="delegation" data-new-partner="${esc(partner.tenantId)}">建立关系</button></div>
        <div class="om-relation-list">${currentRelations.length ? currentRelations.map(relationCard).join("") : `<div class="om-empty-state">当前没有有效关系</div>`}
          ${historyRelations.length ? `<details class="om-history-relations"><summary>历史及未生效关系 · ${historyRelations.length}</summary><div>${historyRelations.map(relationCard).join("")}</div></details>` : ""}</div></section>
      <section class="om-section"><div class="om-section-head"><h3>任务进度</h3><span class="om-muted">${tasks.length} 项</span></div>
        <div class="om-task-list">${tasks.length ? visibleTasks.map((task) => taskCard(task)).join("") : `<div class="om-empty-state">该单位暂无委派任务</div>`}
          ${tasks.length > visibleTasks.length ? `<button type="button" class="om-button om-button-light" data-load-more="unitTasks">加载更多任务（剩余 ${tasks.length - visibleTasks.length} 项）</button>` : ""}</div></section>
    </section>`;
  }

  function unitsView() {
    return `<section class="om-master-detail">
      <aside class="om-unit-panel"><div class="om-panel-title"><div><h2>外协单位</h2><span>${state.partners.length} 家已开通租户</span></div><button type="button" class="om-button om-button-light om-button-small" data-open="delegation">建立关系</button></div>
        <label class="om-search"><span class="om-sr-only">搜索外协单位</span><input id="om-unit-search" type="search" placeholder="搜索单位名称" value="${esc(state.unitSearch)}"></label>
        <div id="om-unit-list" class="om-unit-list">${unitList()}</div></aside>
      ${state.unitView === "relations" ? activeRelationsView() : selectedUnitView()}
    </section>`;
  }

  function activeRelationsView() {
    const relations = activeDelegations();
    return `<section id="om-active-relations" class="om-detail"><div class="om-detail-head"><div><p class="om-eyebrow">委派关系</p><h2>全部有效委派关系</h2><p>${relations.length} 项</p></div></div>
      <div class="om-active-relation-list">${relations.length ? relations.map((item) => `<div class="om-active-relation"><strong>${esc(state.tenantNames[item.partnerTenantId] || item.partnerTenantId)}</strong>${relationCard(item)}</div>`).join("") : `<div class="om-empty-state">当前没有有效委派关系</div>`}</div>
    </section>`;
  }

  function taskStatusClass(status) {
    return {
      sent: "is-pending",
      accepted: "is-active",
      in_progress: "is-active",
      blocked: "is-blocked",
      submitted: "is-submitted",
      accepted_by_owner: "is-complete",
      revision_requested: "is-revision",
      cancelled: "is-cancelled",
    }[status] || "is-neutral";
  }

  function taskCard(task) {
    const title = taskTitle(task);
    const originalOrderNo = task.side === "owner" ? String(task.snapshot?.orderNo || "").trim() : "";
    const status = statusNames[task.status] || task.status;
    const due = dateText(task.dueDate || task.snapshot?.dueDate || task.production?.dueDate);
    const quantity = `${task.snapshot?.quantity ?? "—"}${task.snapshot?.quantityUnit || "件"}`;
    const valueFen = Number(task.productionValueFen || 0);
    const valueText = valueFen > 0 ? `${(valueFen / 100).toFixed(2)} 元` : "历史委派未录入";
    const processes = task.production?.routes || [];
    const timeline = task.production && (task.side === "owner" || (task.permissions || []).includes("progress"))
      ? `<div class="om-timeline" aria-label="生产工序进度">${processes.length ? processes.map((route) => {
        const nodeClass = route.status === "已完成" ? "done" : route.status === "进行中" ? "active" : ["暂停", "异常"].includes(route.status) ? "blocked" : "pending";
        return `<div class="om-process ${nodeClass}"><strong>${esc(route.status || "未排期")}</strong><span>${esc(route.processName)}</span><small>${esc(`${route.completedQty || 0}/${route.planQty || 0}`)}</small><small>${esc(route.plannedStartDate && route.plannedEndDate ? `${route.plannedStartDate.slice(5)} 至 ${route.plannedEndDate.slice(5)}` : "未排期")}</small></div>`;
      }).join("") : `<span class="om-muted">尚未生成工序进度</span>`}</div>` : "";
    const permissionLine = task.side === "partner"
      ? `<p class="om-permission-line">${task.relationActive ? `当前授权：${(task.permissions || []).map((value) => permissionNames[value]).filter(Boolean).join("、") || "仅可查看任务摘要"}` : "委派关系已失效，任务仅供查看"}</p>` : "";
    const exceptions = task.production?.exceptions || [];
    const reports = (task.reports || task.production?.reports || []).filter((report) => report.images?.length);
    const reportPhotos = reports.map((report) => `<div class="om-proof"><strong>${esc(report.processName || "报工照片")} · ${esc(report.reporterName || "")} · ${esc(dateTimeText(report.createdAt))}</strong><div>${report.images.map((url, index) => `<button type="button" class="om-proof-image" data-proof-url="${esc(url)}" aria-label="查看报工照片 ${index + 1}"><img class="om-proof-thumbnail" data-proof-url="${esc(url)}" alt="报工照片 ${index + 1}" loading="lazy"><span class="om-proof-count">${index + 1}</span></button>`).join("")}</div></div>`).join("");
    const drawings = task.side === "partner" && (task.permissions || []).includes("attachments") ? task.production?.drawings || [] : [];
    const drawingButton = drawings.length ? `<button type="button" class="om-drawing-button" data-drawing-task="${esc(task.taskId)}" aria-label="查看原订单图纸，共 ${drawings.length} 个文件"><span>图</span><small>${drawings.length > 99 ? "99+" : drawings.length}</small></button>` : "";
    const futureDue = task.side === "owner" ? dateText(task.ownerDueDate || task.snapshot?.ownerDueDate) : "";
    const delegationTimes = `委派时间：${task.createdAt ? dateTimeText(task.createdAt) : "未记录"} · 接受时间：${task.partnerAcceptedAt ? dateTimeText(task.partnerAcceptedAt) : "未记录"} · 最后工序完成时间：${task.production?.finalProcessCompletedAt ? dateTimeText(task.production.finalProcessCompletedAt) : "未完成"}`;
    const actions = taskActions(task);
    const attentionTask = state.isOwner && ["submitted", "blocked"].includes(task.status);
    const focusedTask = attentionTask && state.taskStatus === task.status;
    const taskClass = attentionTask ? `om-task-card om-attention-${task.status}` : "om-task-card";
    return `<details class="${taskClass}" ${focusedTask ? "open" : ""}>
      <summary><span class="om-task-summary-main"><strong>${esc(title)}</strong><small>${originalOrderNo ? `原订单 ${esc(originalOrderNo)} · ` : ""}${esc(task.snapshot?.productName || "外协生产任务")} · ${esc(quantity)} · 交期 ${esc(due)}${futureDue !== "未设置" && futureDue ? ` · 未来交期 ${esc(futureDue)}` : ""}</small></span><span class="om-state ${taskStatusClass(task.status)}">${esc(status)}</span></summary>
      <div class="om-task-detail"><div class="om-task-meta"><span class="om-outsource-badge">外派单</span><span>本单产值 ${esc(valueText)}</span><span>任务编号 ${esc(task.taskId)}</span><span>委托单位 ${esc(task.side === "owner" ? state.tenantNames[task.ownerTenantId] || "本公司" : task.ownerName || "委托单位")}</span>${drawingButton}</div>
        <p class="om-task-times">${esc(delegationTimes)}</p>${permissionLine}${timeline}
        ${reportPhotos}
        ${exceptions.map((item) => `<p class="om-exception">异常：${esc(item.type)} · ${esc(item.status)} · ${esc(item.description)}</p>`).join("")}
        ${actions ? `<div class="om-task-actions">${actions}</div>` : ""}</div>
    </details>`;
  }

  function taskActions(task) {
    const choices = task.side === "partner" ? {
      sent: [["确认承接", "accepted", "tasks"], ["拒绝任务", "cancelled", "tasks"]],
      accepted: [["提交验收", "submitted", "delivery"], ["报告阻塞", "blocked", "exceptions"]],
      in_progress: [["提交验收", "submitted", "delivery"], ["报告阻塞", "blocked", "exceptions"]],
      blocked: [["解除阻塞", "in_progress", "progress"], ["提交验收", "submitted", "delivery"]],
      revision_requested: [["继续生产", "in_progress", "progress"], ["提交验收", "submitted", "delivery"], ["报告阻塞", "blocked", "exceptions"]],
    }[task.status] || [] : ["sent", "accepted", "in_progress"].includes(task.status) && !(task.production?.completedQty > 0) ? [["取消委派", "cancelled", "tasks"]]
      : task.status === "submitted" ? [["确认验收并完成订单", "accepted_by_owner", "quality"], ["要求返修", "revision_requested", "quality"]] : [];
    const permissions = new Set(task.permissions || []);
    const allowed = choices.filter(([, , permission]) => task.side !== "partner" || (task.relationActive && permissions.has(permission)));
    const routes = task.production?.routes || [];
    const allProcessesComplete = routes.length > 0 && routes.every((route) => Number(route.planQty) > 0
      && Number(route.completedQty || 0) >= Number(route.planQty) && route.status === "已完成");
    return allowed.map(([label, status]) => {
      const disabled = status === "submitted" && !allProcessesComplete;
      return `<button type="button" class="om-button ${status === "cancelled" ? "om-button-light" : ""}" data-task-status="${esc(status)}" data-task-id="${esc(task.taskId)}" ${disabled ? 'disabled title="全部工序完成后才能提交验收"' : ""}>${label}</button>`;
    }).join("");
  }

  function filteredTasks() {
    const query = state.taskSearch.trim().toLocaleLowerCase();
    return state.tasks.filter((task) => {
      if (!taskMatchesFilter(task, state.taskStatus)) return false;
      return !query || `${taskTitle(task)} ${task.snapshot?.productName || ""} ${taskCompanyName(task)} ${task.taskId}`.toLocaleLowerCase().includes(query);
    });
  }

  function tasksView() {
    const filtered = filteredTasks();
    const grouped = new Map();
    for (const task of filtered) {
      const key = taskPartnerId(task) || "unknown";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(task);
    }
    const groups = [...grouped.entries()].sort((a, b) => taskCompanyName(a[1][0]).localeCompare(taskCompanyName(b[1][0]), "zh-CN"));
    const attentionNotice = state.isOwner && state.taskStatus === "submitted"
      ? `<p class="om-attention-notice">以下订单等待未来机械验收：确认验收后完成委派，或要求返修；处理后待验收角标会清除。</p>`
      : state.isOwner && state.taskStatus === "blocked"
        ? `<p class="om-attention-notice blocked">以下委派任务报告了阻塞；外协解除阻塞或完成后，阻塞角标会清除。</p>`
        : "";
    return `<section id="om-task-center" class="om-task-center">${attentionNotice}<div class="om-task-filters">
      <label class="om-search"><span class="om-sr-only">搜索任务</span><input id="om-task-search" type="search" placeholder="搜索单位、工单或产品" value="${esc(state.taskSearch)}"></label>
      <label class="om-filter"><span class="om-sr-only">任务状态</span><select id="om-task-status"><option value="all">全部状态</option>${state.isOwner ? `<option value="processing" ${state.taskStatus === "processing" ? "selected" : ""}>处理中任务</option><option value="attention" ${state.taskStatus === "attention" ? "selected" : ""}>待跟进</option>` : ""}${Object.entries(statusNames).map(([key, label]) => `<option value="${key}" ${state.taskStatus === key ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      ${state.isOwner ? `<button type="button" class="om-button" data-open="task">新建委派任务</button>` : ""}
    </div>
      <div class="om-group-list">${groups.length ? groups.map(([partnerId, items], index) => {
        const defaultOpen = state.taskGroupsInitialized ? state.openGroups.has(partnerId) : index === 0;
        const limit = state.taskGroupLimits.get(partnerId) || 8;
        const visibleItems = items.slice(0, limit);
        return `<details class="om-task-group" data-group="${esc(partnerId)}" ${defaultOpen ? "open" : ""}><summary><span><strong>${esc(taskCompanyName(items[0]))}</strong><small>${items.length} 项任务</small></span><span class="om-group-status">${items.filter((item) => isAttentionStatus(item.status)).length} 项待跟进</span></summary><div class="om-group-body">${visibleItems.map(taskCard).join("")}${items.length > visibleItems.length ? `<button type="button" class="om-button om-button-light" data-load-more="taskGroup" data-group-id="${esc(partnerId)}">加载更多任务（剩余 ${items.length - visibleItems.length} 项）</button>` : ""}</div></details>`;
      }).join("") : `<div class="om-empty-state">${state.tasks.length ? "没有符合条件的任务" : "暂无外协任务"}</div>`}</div>
    </section>`;
  }

  function render() {
    if (!state.root?.isConnected) return;
    const content = state.root.querySelector("#om-content");
    const message = state.root.querySelector("#om-message");
    const owner = state.isOwner;
    const title = state.root.querySelector("#om-title");
    const subtitle = state.root.querySelector("#om-subtitle");
    if (title) title.textContent = owner ? "外协监管" : "委派任务";
    if (subtitle) subtitle.textContent = owner ? "按外协单位管理委派关系、生产任务和交付进度。" : "确认承接后安排生产；全部工序完成并发货后提交验收。";
    const headActions = state.root.querySelector(".om-header-actions");
    if (headActions && owner) headActions.innerHTML = `<button class="om-button om-button-light" type="button" data-om-action="refresh">刷新</button><button class="om-button" type="button" data-open="delegation">建立外协关系</button>`;
    content.innerHTML = `${state.error ? `<div class="om-error" role="alert">${esc(state.error)} <button type="button" class="om-text-button" data-om-action="refresh">重试</button></div>` : ""}${owner ? stats() : ""}${tabs()}${owner && state.tab === "units" ? unitsView() : tasksView()}`;
    for (const image of content.querySelectorAll("img.om-proof-thumbnail[data-proof-url]")) {
      proofImageUrl(image.dataset.proofUrl)
        .then((objectUrl) => { if (image.isConnected) image.src = objectUrl; })
        .catch(() => { if (image.isConnected) image.classList.add("om-proof-thumbnail-error"); });
    }
    message.textContent = state.message;
    message.classList.toggle("has-message", Boolean(state.message));
    scheduleOwnerArchive();
  }

  function renderPartners() {
    const select = state.root.querySelector("#om-partner-select");
    select.replaceChildren();
    for (const partner of state.partners.filter((item) => item.eligible)) {
      const option = document.createElement("option");
      option.value = partner.tenantId;
      option.textContent = partner.name;
      select.append(option);
    }
  }

  function renderOrderOptions() {
    const select = state.root.querySelector("#om-order-select");
    const selectedOrderId = select.value;
    const availableOrders = state.orders.filter((item) => item.workOrder && item.workOrder.status !== "已完成");
    select.replaceChildren();
    if (!availableOrders.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "当前没有可委派订单";
      option.disabled = true;
      select.append(option);
      select.disabled = true;
      return;
    }
    for (const order of availableOrders) {
      const option = document.createElement("option");
      option.value = order.id;
      option.textContent = `${order.orderNo} · ${order.productName} · ${order.quantity}${order.quantityUnit || "件"}`;
      select.append(option);
    }
    if (availableOrders.some((item) => item.id === selectedOrderId)) select.value = selectedOrderId;
    select.disabled = false;
  }

  async function refreshOrderOptions() {
    const bootstrap = await api("/api/bootstrap");
    state.orders = (bootstrap.orders || []).map((order) => ({ ...order, workOrder: (bootstrap.workOrders || []).find((item) => item.orderId === order.id) }));
    renderOrderOptions();
  }

  function renderDelegationOptions(preferredPartner = "") {
    const select = state.root.querySelector("#om-delegation-select");
    select.replaceChildren();
    const today = todayText();
    const available = state.delegations.filter((item) => item.status === "active" && item.startsAt <= today && item.endsAt >= today && (item.permissions || []).includes("tasks") && (item.permissions || []).includes("delivery") && (!preferredPartner || item.partnerTenantId === preferredPartner));
    for (const item of available) {
      const option = document.createElement("option");
      option.value = item.delegationId;
      option.textContent = `${state.tenantNames[item.partnerTenantId] || item.partnerTenantId} · ${item.endsAt}`;
      select.append(option);
    }
    state.root.querySelector("#om-delivery-permission-hint").hidden = available.length > 0;
  }

  function selectedOrder() {
    return state.orders.find((order) => order.id === state.root.querySelector("#om-order-select").value);
  }

  function updateQuantityLimit() {
    const order = selectedOrder();
    const routes = order?.workOrder?.routes?.filter((route) => route.routeType !== "rework") || [];
    const quantity = Number(order?.workOrder?.planQty || order?.quantity || 0);
    state.root.querySelector("#om-quantity").value = quantity ? `${quantity} ${order?.quantityUnit || "件"}` : "";
    const reserved = ownerTasks().some((task) => task.status !== "cancelled" && task.ownerOrderId === order?.id);
    const ready = routes.length > 0 && routes.every((route) => route.status === "待开始" && !route.assignedTo && !Number(route.completedQty || 0));
    state.root.querySelector("#om-submit-task").disabled = !ready || reserved || quantity < 1;
    state.root.querySelector("#om-quantity-hint").textContent = reserved ? "此工单已有未取消的外派单。" : ready ? `将委派全部 ${routes.length} 道工序及 ${quantity} ${order?.quantityUnit || "件"}计划数量。` : "完整工序链必须全部未报工、未派工后才能整单外派。";
  }

  function renderRouteOptions() {
    const host = state.root.querySelector("#om-route-options");
    host.replaceChildren();
    const legend = document.createElement("legend");
    legend.textContent = "整单完整工序链（不可拆分）";
    host.append(legend);
    const order = selectedOrder();
    const routes = order?.workOrder?.routes?.filter((route) => route.routeType !== "rework") || [];
    if (!routes.length) {
      const empty = document.createElement("p");
      empty.className = "om-empty";
      empty.textContent = "当前订单没有可委派的工序";
      host.append(empty);
    }
    for (const route of routes) {
      const label = document.createElement("p");
      label.className = "om-route-choice";
      const available = route.status === "待开始" && !route.assignedTo && !Number(route.completedQty || 0);
      label.textContent = `${route.processName} · ${route.status}${available ? "" : "（当前不可整单外派）"}`;
      host.append(label);
    }
    updateQuantityLimit();
  }

  async function refresh() {
    if (!state.root) return;
    state.loading = true;
    state.error = "";
    render();
    try {
      const [outsourcing, bootstrap] = await Promise.all([api("/api/outsourcing"), api("/api/bootstrap")]);
      if (!state.root?.isConnected) return;
      const user = currentUser();
      const manager = ["owner", "manager", "admin"].some((role) => user?.role === role || user?.roles?.includes(role));
      state.isOwner = outsourcing.isOwner === true && manager;
      state.partners = outsourcing.partners || [];
      state.delegations = outsourcing.delegations || [];
      state.tasks = outsourcing.tasks || [];
      state.tenantNames = outsourcing.tenantNames || {};
      state.orders = (bootstrap.orders || []).map((order) => ({ ...order, workOrder: (bootstrap.workOrders || []).find((item) => item.orderId === order.id) }));
      if (!state.isOwner) state.tab = "tasks";
      if (!state.partners.some((item) => item.tenantId === state.selectedPartnerId)) state.selectedPartnerId = state.partners[0]?.tenantId || "";
      renderPartners();
      renderOrderOptions();
      state.loaded = true;
      if (pendingAttentionStatus && state.isOwner) {
        applyAttention(pendingAttentionStatus);
        pendingAttentionStatus = "";
      }
    } catch (error) {
      state.error = error.message;
    } finally {
      state.loading = false;
      render();
      if (state.root?.isConnected) renderRouteOptions();
    }
  }

  async function openDialog(kind, partnerId = "") {
    if (kind === "delegation") {
      renderPartners();
      const partnerSelect = state.root.querySelector("#om-partner-select");
      if (!partnerSelect.options.length) {
        state.message = "当前没有可建立委派关系的已授权外协单位。";
        render();
        return;
      }
      if (partnerId) partnerSelect.value = partnerId;
      state.root.querySelector("#om-delegation-dialog").showModal();
      return;
    }
    renderDelegationOptions(partnerId);
    const dialog = state.root.querySelector("#om-task-dialog");
    if (!state.root.querySelector("#om-delegation-select").options.length) {
      state.message = partnerId
        ? "所选外协单位没有当前有效且同时开启“任务承接”和“发货验收”的关系。"
        : "请先建立当前有效关系，并同时开启“任务承接”和“发货验收”权限。";
      render();
      return;
    }
    if (partnerId) {
      const relation = state.delegations.find((item) => item.partnerTenantId === partnerId && item.status === "active" && (item.permissions || []).includes("tasks"));
      if (relation) state.root.querySelector("#om-delegation-select").value = relation.delegationId;
    }
    const orderSelect = state.root.querySelector("#om-order-select");
    orderSelect.replaceChildren();
    const loadingOption = document.createElement("option");
    loadingOption.value = "";
    loadingOption.textContent = "正在加载可委派订单…";
    loadingOption.disabled = true;
    orderSelect.append(loadingOption);
    orderSelect.disabled = true;
    renderRouteOptions();
    dialog.showModal();
    try {
      await refreshOrderOptions();
      renderRouteOptions();
    } catch (error) {
      orderSelect.replaceChildren();
      const errorOption = document.createElement("option");
      errorOption.value = "";
      errorOption.textContent = "订单加载失败，请关闭窗口后重试";
      errorOption.disabled = true;
      orderSelect.append(errorOption);
      orderSelect.disabled = true;
      state.message = error.message;
      render();
    }
  }

  function formObject(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  async function submitDelegation(form) {
    const values = formObject(form);
    values.permissions = [...form.querySelectorAll("[name=permission]:checked")].map((input) => input.value);
    delete values.permission;
    try {
      await api("/api/outsourcing/delegations", { method: "POST", body: JSON.stringify(values) });
      form.reset();
      state.root.querySelector("#om-delegation-dialog").close();
      state.message = "委派关系已创建";
      await refresh();
    } catch (error) { state.message = error.message; render(); }
  }

  async function submitTask(form) {
    if (state.submittingTask) return;
    state.submittingTask = true;
    const submitButton = form.querySelector("#om-submit-task");
    submitButton.disabled = true;
    submitButton.textContent = "正在发送…";
    const values = formObject(form);
    const order = selectedOrder();
    values.routeIds = (order?.workOrder?.routes || []).filter((route) => route.routeType !== "rework").map((route) => route.id);
    values.quantity = String(order?.workOrder?.planQty || order?.quantity || "");
    values.productionValueFen = Math.round(Number(values.productionValue) * 100);
    delete values.productionValue;
    try {
      const result = await api("/api/outsourcing/tasks", { method: "POST", body: JSON.stringify(values) });
      form.reset();
      state.root.querySelector("#om-task-dialog").close();
      state.message = `已发送任务 ${result.partnerWorkNo}`;
      await refresh();
    } catch (error) {
      state.message = `${error.message}；正在同步最新委派状态，请检查订单是否已创建。`;
      render();
      await refresh();
    } finally {
      state.submittingTask = false;
      const button = state.root?.querySelector("#om-submit-task");
      if (button) {
        button.textContent = "发送外协任务";
        updateQuantityLimit();
      }
    }
  }

  async function updateTaskStatus(taskId, status) {
    try {
      await api(`/api/outsourcing/tasks/${encodeURIComponent(taskId)}/status`, { method: "POST", body: JSON.stringify({ status }) });
      const messages = { accepted: "已确认承接委派任务", cancelled: "任务已取消", in_progress: "阻塞已解除，可继续报工", blocked: "阻塞情况已提交给委托方", submitted: "外协已提交发货，等待未来机械验收", accepted_by_owner: "已确认验收，订单已完成", revision_requested: "已要求外协单位返修" };
      state.message = messages[status] || "任务状态已更新";
      await refresh();
      window.boboRefreshOutsourcingBadges?.();
    } catch (error) { state.message = error.message; render(); }
  }

  async function revokeDelegation(delegationId) {
    try {
      await api(`/api/outsourcing/delegations/${encodeURIComponent(delegationId)}/revoke`, { method: "POST", body: "{}" });
      state.message = "委派关系已撤销";
      await refresh();
    } catch (error) { state.message = error.message; render(); }
  }

  async function showProofImage(url) {
    try {
      const objectUrl = await proofImageUrl(url);
      const dialog = state.root.querySelector("#om-proof-dialog");
      state.proofObjectUrl = objectUrl;
      dialog.querySelector("img").src = objectUrl;
      dialog.showModal();
    } catch (error) {
      state.message = error.message;
      render();
    }
  }

  async function showTaskDrawings(taskId) {
    const task = state.tasks.find((item) => item.taskId === taskId);
    const drawings = task?.side === "partner" && (task.permissions || []).includes("attachments") ? task.production?.drawings || [] : [];
    if (!drawings.length) return;
    const dialog = state.root.querySelector("#om-drawing-dialog");
    const title = state.root.querySelector("#om-drawing-title");
    const list = state.root.querySelector("#om-drawing-list");
    title.textContent = `${taskTitle(task)} · 原订单图纸`;
    list.replaceChildren(...drawings.map((drawing, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.previewDrawing = String(index);
      button.textContent = drawing.name || `图纸 ${index + 1}`;
      return button;
    }));
    dialog.dataset.taskId = taskId;
    dialog.showModal();
    await showDrawingFile(drawings[0]);
  }

  async function showDrawingFile(drawing) {
    const dialog = state.root.querySelector("#om-drawing-dialog");
    const viewer = state.root.querySelector("#om-drawing-viewer");
    if (state.drawingObjectUrl) URL.revokeObjectURL(state.drawingObjectUrl);
    state.drawingObjectUrl = "";
    viewer.replaceChildren();
    const extension = String(drawing.fileType || "").toLowerCase();
    try {
      let previewUrl = "";
      if (["dwg", "dxf"].includes(extension)) {
        const preview = await api("/api/drawings/preview", { method: "POST", body: JSON.stringify({ drawingId: drawing.drawingId }) });
        if (preview.previewError) throw new Error(preview.previewError);
        previewUrl = preview.previewPageUrl || preview.previewUrl || "";
      } else {
        const response = await fetch(drawing.url, { headers: { Authorization: `Bearer ${sessionStorage.getItem("work_session") || ""}`, "x-company-slug": sessionStorage.getItem("work_company_slug") || "future-machinery" } });
        if (!response.ok) throw new Error("无权查看原订单图纸");
        state.drawingObjectUrl = URL.createObjectURL(await response.blob());
        previewUrl = state.drawingObjectUrl;
      }
      const element = document.createElement(["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(extension) ? "img" : "iframe");
      element.className = "om-drawing-preview";
      element.src = previewUrl;
      if (element.tagName === "IMG") element.alt = drawing.name || "原订单图纸";
      else { element.title = drawing.name || "原订单图纸"; element.setAttribute("loading", "lazy"); }
      viewer.replaceChildren(element);
    } catch (error) {
      const message = document.createElement("p");
      message.className = "om-drawing-error";
      message.textContent = error.message || "图纸预览失败";
      viewer.replaceChildren(message);
    }
  }

  function bind(root) {
    const proofDialog = root.querySelector("#om-proof-dialog");
    proofDialog.addEventListener("close", () => {
      state.proofObjectUrl = "";
      proofDialog.querySelector("img").removeAttribute("src");
    });
    const drawingDialog = root.querySelector("#om-drawing-dialog");
    drawingDialog.addEventListener("close", () => {
      if (state.drawingObjectUrl) URL.revokeObjectURL(state.drawingObjectUrl);
      state.drawingObjectUrl = "";
      root.querySelector("#om-drawing-viewer").replaceChildren();
      root.querySelector("#om-drawing-list").replaceChildren();
    });
    root.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.stat) { focusStatistic(button.dataset.stat); return; }
      if (button.dataset.proofUrl) {
        showProofImage(button.dataset.proofUrl);
        return;
      }
      if (button.dataset.drawingTask) { showTaskDrawings(button.dataset.drawingTask); return; }
      if (button.dataset.previewDrawing !== undefined) {
        const task = state.tasks.find((item) => item.taskId === root.querySelector("#om-drawing-dialog").dataset.taskId);
        const drawing = task?.production?.drawings?.[Number(button.dataset.previewDrawing)];
        if (drawing) showDrawingFile(drawing);
        return;
      }
      if (button.dataset.closeProof !== undefined) { proofDialog.close(); return; }
      if (button.dataset.closeDrawing !== undefined) { drawingDialog.close(); return; }
      if (button.dataset.tab) { state.tab = button.dataset.tab; if (button.dataset.tab === "units") state.unitView = "detail"; render(); return; }
      if (button.dataset.partner) { state.selectedPartnerId = button.dataset.partner; state.unitView = "detail"; state.unitTaskLimit = 8; render(); return; }
      if (button.dataset.open) { openDialog(button.dataset.open, button.dataset.taskPartner || button.dataset.newPartner || ""); return; }
      if (button.dataset.close) { root.querySelector(`#om-${button.dataset.close}-dialog`).close(); return; }
      if (button.dataset.omAction === "refresh") { state.message = ""; refresh(); return; }
      if (button.dataset.revoke) { revokeDelegation(button.dataset.revoke); return; }
      if (button.dataset.loadMore === "unitTasks") { state.unitTaskLimit += 8; render(); return; }
      if (button.dataset.loadMore === "taskGroup") {
        const partnerId = button.dataset.groupId;
        state.taskGroupLimits.set(partnerId, (state.taskGroupLimits.get(partnerId) || 8) + 8);
        render();
        return;
      }
      if (button.dataset.taskId && button.dataset.taskStatus) updateTaskStatus(button.dataset.taskId, button.dataset.taskStatus);
    });
    root.addEventListener("input", (event) => {
      if (event.target.id === "om-unit-search") { state.unitSearch = event.target.value; render(); const input = root.querySelector("#om-unit-search"); input?.focus(); input?.setSelectionRange(input.value.length, input.value.length); }
      if (event.target.id === "om-task-search") { state.taskSearch = event.target.value; render(); const input = root.querySelector("#om-task-search"); input?.focus(); input?.setSelectionRange(input.value.length, input.value.length); }
    });
    root.addEventListener("change", (event) => {
      if (event.target.id === "om-task-status") { state.taskStatus = event.target.value; render(); }
      if (event.target.id === "om-order-select") renderRouteOptions();
    });
    root.addEventListener("toggle", (event) => {
      const group = event.target.closest("details.om-task-group");
      if (!group) return;
      state.taskGroupsInitialized = true;
      const key = group.dataset.group;
      if (group.open) state.openGroups.add(key); else state.openGroups.delete(key);
    }, true);
    root.addEventListener("submit", (event) => {
      if (event.target.id === "om-delegation-form") { event.preventDefault(); submitDelegation(event.target); }
      if (event.target.id === "om-task-form") { event.preventDefault(); submitTask(event.target); }
    });
  }

  function mount(root) {
    if (!root) return;
    if (state.root !== root) {
      state.root = root;
      root.innerHTML = buildShell();
      bind(root);
    }
    if (state.loaded) render();
    else if (!state.loading) refresh();
  }

  function applyAttention(status) {
    state.tab = "tasks";
    state.taskStatus = status;
    state.taskSearch = "";
    state.openGroups = new Set(state.tasks.filter((task) => task.status === status).map(taskPartnerId));
    state.taskGroupsInitialized = true;
    render();
  }

  function focusStatistic(statistic) {
    if (!state.isOwner) return;
    let target = "#om-unit-list";
    state.taskSearch = "";
    if (statistic === "partners") {
      state.tab = "units";
      state.unitView = "detail";
      state.unitSearch = "";
    } else if (statistic === "relations") {
      state.tab = "units";
      state.unitView = "relations";
      state.unitSearch = "";
      target = "#om-active-relations";
    } else if (statistic === "processing" || statistic === "attention") {
      state.tab = "tasks";
      state.taskStatus = statistic;
      state.openGroups = new Set(state.tasks.filter((task) => taskMatchesFilter(task, statistic)).map(taskPartnerId));
      state.taskGroupsInitialized = true;
      target = "#om-task-center";
    } else return;
    render();
    setTimeout(() => state.root?.querySelector(target)?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
  }

  function focusAttention(status) {
    if (!["submitted", "blocked"].includes(status)) return;
    if (!state.loaded) {
      pendingAttentionStatus = status;
      return;
    }
    if (state.isOwner) applyAttention(status);
  }

  window.boboOutsourcing = { focusAttention, mount };
})();
