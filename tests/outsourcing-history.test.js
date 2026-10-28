const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { filterWorkOrderSources, finalOutsourceProcessCompletedAt, isOwnerTaskWithinSupervision } = require("../lib/outsourcing-history");

function loadApp() {
  const element = () => ({ innerHTML: "", style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, appendChild() {} });
  const context = {
    console,
    Blob: class {},
    URL: { createObjectURL() { return "blob:test"; } },
    FileReader: class {},
    confirm() { return false; },
    fetch() { return Promise.reject(new Error("not used in UI contract tests")); },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    document: { body: { appendChild() {} }, createElement: element, getElementById: element, querySelector() { return null; }, querySelectorAll() { return []; } },
    window: { open() {}, location: {} },
    setTimeout() {},
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8"), context);
  return context;
}

function loadOutsourcing(fetchImpl = () => Promise.reject(new Error("not used in UI contract tests"))) {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "outsourcing.js"), "utf8");
  const instrumented = source.replace(
    "window.boboOutsourcing = { focusAttention, mount };",
    "window.boboOutsourcing = { focusAttention, mount, test: { state, stats, isCurrentDelegation, taskMatchesFilter, focusStatistic, taskStatusClass, openDialog } };",
  );
  const context = { window: {}, document: { createElement() { return { value: "", textContent: "", disabled: false }; } }, fetch: fetchImpl, sessionStorage: { getItem() { return "test-session"; } }, setTimeout() {}, clearTimeout() {} };
  vm.createContext(context);
  vm.runInContext(instrumented, context);
  return context.window.boboOutsourcing.test;
}

test("opening the delegation dialog refreshes and populates source orders immediately", async () => {
  const response = {
    ok: true,
    async json() { return { orders: [{ id: "order-1", orderNo: "FM-1", productName: "支架", quantity: 3, quantityUnit: "件" }], workOrders: [{ id: "wo-1", orderId: "order-1", status: "未开始", planQty: 3, routes: [{ routeType: "production", status: "待开始", processName: "激光", planQty: 3 }] }] }; },
  };
  const { state, openDialog } = loadOutsourcing(async (url) => { assert.equal(url, "/api/bootstrap"); return response; });
  const elements = new Map();
  const element = (id) => {
    if (elements.has(id)) return elements.get(id);
    const item = {
      options: [], value: "", disabled: false, textContent: "", children: [], shown: false,
      replaceChildren(...children) { this.options = []; this.children = [...children]; this.value = ""; },
      append(child) { this.children.push(child); this.options.push(child); if (!this.value && child.value) this.value = child.value; },
      showModal() { this.shown = true; },
    };
    elements.set(id, item);
    return item;
  };
  state.root = { querySelector: (selector) => element(selector) };
  state.delegations = [{ delegationId: "del-1", partnerTenantId: "partner-1", status: "active", startsAt: "2026-10-01", endsAt: "2026-12-31", permissions: ["tasks"] }];
  state.orders = [];
  await openDialog("task", "partner-1");
  assert.equal(element("#om-order-select").options[0].textContent, "FM-1 · 支架 · 3件");
  assert.equal(element("#om-task-dialog").shown, true);
  assert.equal(element("#om-submit-task").disabled, false);
});

test("owner-confirmed tasks remain visible for one hour and hide at the boundary", () => {
  const task = { side: "owner", status: "accepted_by_owner", ownerAcceptedAt: "2026-10-26T02:00:00.000Z" };
  assert.equal(isOwnerTaskWithinSupervision(task, Date.parse("2026-10-26T02:59:59.999Z")), true);
  assert.equal(isOwnerTaskWithinSupervision(task, Date.parse("2026-10-26T03:00:00.000Z")), false);
  assert.equal(isOwnerTaskWithinSupervision({ ...task, side: "partner" }, Date.parse("2026-10-26T04:00:00.000Z")), true);
  assert.equal(isOwnerTaskWithinSupervision({ ...task, status: "submitted" }, Date.parse("2026-10-26T04:00:00.000Z")), true);
});

test("external completion time is the completed final planned process, excluding rework routes", () => {
  const routes = [
    { sequence: 1, status: "已完成", planQty: 10, completedQty: 10, completedAt: "2026-10-27T01:00:00.000Z" },
    { sequence: 2, status: "已完成", planQty: 10, completedQty: 10, completedAt: "2026-10-27T02:00:00.000Z" },
    { sequence: 3, routeType: "rework", status: "进行中", planQty: 1, completedQty: 0 },
  ];
  assert.equal(finalOutsourceProcessCompletedAt(routes), "2026-10-27T02:00:00.000Z");
  assert.equal(finalOutsourceProcessCompletedAt(routes.map((route, index) => index === 1 ? { ...route, status: "进行中" } : route)), "");
  assert.equal(finalOutsourceProcessCompletedAt(routes.map((route, index) => index === 0 ? { ...route, status: "进行中" } : route)), "");
});

test("outsourcing API and history use the final process completion timestamp", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(source, /finalProcessCompletedAt: canShowProgress \? finalProcessCompletedAt : ""/);
  assert.match(source, /completedAt: outsourcingTask\?\.production\?\.finalProcessCompletedAt \|\| workOrderCompletedAt\(db, workOrder\)/);
});

test("outsourcing task status badges have fixed layout and distinct lifecycle colors", () => {
  const { taskStatusClass } = loadOutsourcing();
  assert.equal(taskStatusClass("sent"), "is-pending");
  assert.equal(taskStatusClass("in_progress"), "is-active");
  assert.equal(taskStatusClass("blocked"), "is-blocked");
  assert.equal(taskStatusClass("submitted"), "is-submitted");
  assert.equal(taskStatusClass("revision_requested"), "is-revision");
  assert.equal(taskStatusClass("accepted_by_owner"), "is-complete");
  assert.equal(taskStatusClass("cancelled"), "is-cancelled");

  const source = fs.readFileSync(path.join(__dirname, "..", "public", "outsourcing-module.css"), "utf8");
  assert.match(source, /\.om-task-card > summary\s*\{[^}]*display:\s*grid/);
  for (const statusClass of ["is-pending", "is-active", "is-blocked", "is-submitted", "is-revision", "is-complete", "is-cancelled"]) {
    assert.ok(source.includes(`.om-state.${statusClass}`));
  }
});

test("history source filters distinguish outsourcing, factory, and platform orders only when enabled", () => {
  const items = [
    { id: "factory", isOutsourced: false, orderOrigin: "factory" },
    { id: "platform", isOutsourced: false, orderOrigin: "platform", sourceChannel: "website" },
    { id: "outsourcing", isOutsourced: true, orderOrigin: "factory" },
  ];
  assert.deepEqual(filterWorkOrderSources(items, { source: "outsourcing" }, true).map((item) => item.id), ["outsourcing"]);
  assert.deepEqual(filterWorkOrderSources(items, { source: "factory" }, true).map((item) => item.id), ["factory"]);
  assert.deepEqual(filterWorkOrderSources(items, { source: "platform", sourceChannel: "website" }, true).map((item) => item.id), ["platform"]);
  assert.deepEqual(filterWorkOrderSources(items, { source: "outsourcing" }, false).map((item) => item.id), ["factory", "platform", "outsourcing"]);
});

test("history page limits source controls to Future Machinery and shows the outsourcing option", () => {
  const app = loadApp();
  vm.runInContext('state.historyFilters = { dateType: "createdAt", from: "", to: "", customerId: "", status: "", source: "outsourcing", sourceChannel: "", workNo: "" }; state.historyResults = { workOrders: [], loaded: false }; state.user = { tenantId: "future-machinery" };', app);
  const ownerPage = app.historyPage({ customers: [], permissions: {} });
  assert.match(ownerPage, /来源筛选/);
  assert.match(ownerPage, /外派单/);
  vm.runInContext('state.user = { tenantId: "partner-company" };', app);
  const partnerPage = app.historyPage({ customers: [], permissions: {} });
  assert.doesNotMatch(partnerPage, /来源筛选|平台渠道/);
});

test("external history detail shows delegation data, both due dates, route progress, and photo preview", () => {
  const app = loadApp();
  app.fixture = [{
    id: "work-order", workNo: "OUT-1", orderNo: "FM-1", customerName: "客户", productName: "支架", planQty: 10, isOutsourced: true,
    dueDate: "2026-11-03", productionStatus: "已完成", routes: [],
    outsourcing: {
      taskId: "task-1", status: "accepted_by_owner", partnerName: "外协厂", dueDate: "2026-11-01",
      productionValueFen: 800000, createdAt: "2026-10-25T01:00:00.000Z", partnerAcceptedAt: "2026-10-25T02:00:00.000Z",
      production: { finalProcessCompletedAt: "2026-10-25T03:00:00.000Z", routes: [{ processName: "激光", sequence: 1, status: "已完成", planQty: 10, completedQty: 10 }], reports: [{ processName: "激光", createdAt: "2026-10-25T03:00:00.000Z", images: ["/api/outsourcing/tasks/task-1/reports/report-1/images/0"] }] },
    },
  }];
  vm.runInContext('state.user = { tenantId: "future-machinery" }; state.historyOrderId = "work-order"; state.historyResults.workOrders = fixture;', app);
  const html = app.historyOrderModal({});
  assert.match(html, /委派时间/);
  assert.match(html, /接受时间/);
  assert.match(html, /外协交期/);
  assert.match(html, /未来交期/);
  assert.match(html, /本单产值/);
  assert.match(html, /最后工序完成时间/);
  assert.match(html, /2026\/10\/25 11:00/);
  assert.match(html, /已完成/);
  assert.match(html, /报工照片/);
  const photoGroups = vm.runInContext("Array.from(attachmentGroups.values())", app);
  assert.equal(photoGroups[0].files[0].url, "/api/outsourcing/tasks/task-1/reports/report-1/images/0");
  assert.equal(photoGroups[0].files[0].protectedOutsourceImage, true);
  vm.runInContext('state.user = { tenantId: "partner-company" };', app);
  assert.doesNotMatch(app.historyOrderModal({}), /未来交期/);
});

test("completed outsourcing task label and owner archive timer are present in the task view", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "outsourcing.js"), "utf8");
  assert.ok(source.includes('accepted_by_owner: "订单已完成"'));
  assert.ok(source.includes('"is-complete"'));
  assert.ok(source.includes("ownerAcceptedAt"));
  assert.ok(source.includes("setTimeout("));
  assert.ok(source.includes("最后工序完成时间"));
});

test("owner statistics are keyboard-operable navigation buttons for all four destinations", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "outsourcing.js"), "utf8");
  for (const target of ["partners", "relations", "processing", "attention"]) assert.ok(source.includes(`"${target}"`));
  assert.match(source, /data-stat="\$\{target\}"/);
  assert.match(source, /function focusStatistic\(/);
  assert.match(source, /scrollIntoView\(/);
  assert.match(source, /aria-label=.*点击查看/);
});

test("active relationship overview and task presets use the statistic count predicates", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "outsourcing.js"), "utf8");
  assert.match(source, /function isCurrentDelegation\(/);
  assert.match(source, /function taskMatchesFilter\(/);
  assert.match(source, /function activeRelationsView\(/);
  assert.match(source, /status === "processing"/);
  assert.match(source, /status === "attention"/);
});

test("owner statistics count only current relations and task presets match their counts", () => {
  const { state, stats, isCurrentDelegation, taskMatchesFilter } = loadOutsourcing();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  assert.equal(isCurrentDelegation({ status: "active", startsAt: "2000-01-01", endsAt: "2099-12-31" }, today), true);
  assert.equal(isCurrentDelegation({ status: "active", startsAt: "2099-01-01", endsAt: "2099-12-31" }, today), false);
  assert.equal(isCurrentDelegation({ status: "active", startsAt: "2000-01-01", endsAt: "2000-12-31" }, today), false);
  state.isOwner = true;
  state.partners = [{}, {}];
  state.delegations = [
    { status: "active", startsAt: "2000-01-01", endsAt: "2099-12-31" },
    { status: "active", startsAt: "2099-01-01", endsAt: "2099-12-31" },
  ];
  state.tasks = [
    { side: "owner", status: "accepted" },
    { side: "owner", status: "submitted" },
    { side: "owner", status: "accepted_by_owner", ownerAcceptedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
  ];
  const html = stats();
  assert.match(html, /外协单位，2，点击查看/);
  assert.match(html, /有效委派关系，1，点击查看/);
  assert.match(html, /处理中任务，2，点击查看/);
  assert.match(html, /待跟进，1，点击查看/);
  assert.equal(taskMatchesFilter(state.tasks[0], "processing"), true);
  assert.equal(taskMatchesFilter(state.tasks[1], "attention"), true);
  assert.equal(taskMatchesFilter(state.tasks[2], "processing"), false);
});

test("statistic navigation opens the matching view and preset filter", () => {
  const { state, focusStatistic } = loadOutsourcing();
  state.isOwner = true;
  state.root = { isConnected: false };
  focusStatistic("relations");
  assert.equal(state.tab, "units");
  assert.equal(state.unitView, "relations");
  focusStatistic("processing");
  assert.equal(state.tab, "tasks");
  assert.equal(state.taskStatus, "processing");
  focusStatistic("attention");
  assert.equal(state.taskStatus, "attention");
});
