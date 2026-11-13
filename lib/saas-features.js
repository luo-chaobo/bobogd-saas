"use strict";

const FEATURE_MODULES = [
  { key: "dashboard", name: "生产总览", view: "dashboard", apiPrefixes: ["/api/dashboard", "/api/tv-dashboard", "/api/tv-orders", "/api/tv-drawings", "/api/tv-viewer-token", "/api/dispatch-board-token"] },
  { key: "customers", name: "客户资料", view: "customers", apiPrefixes: ["/api/customers"] },
  { key: "orders", name: "订单工单", view: "orders", apiPrefixes: ["/api/orders", "/api/work-orders", "/api/platform-orders", "/api/external/work-orders", "/api/deliveries", "/api/delivery-trips", "/api/drawings", "/api/attachments", "/api/upload"] },
  { key: "dispatch", name: "派工路线", view: "dispatch", apiPrefixes: ["/api/assign", "/api/routes", "/api/route-status", "/api/report", "/api/route-exceptions", "/api/my-tasks", "/api/mobile/completions", "/api/qr/", "/api/dispatch-board"] },
  { key: "quality", name: "质检详情", view: "exceptions", apiPrefixes: ["/api/exceptions", "/api/quality"] },
  { key: "customerFeedback", name: "客户反馈", view: "customerFeedback", apiPrefixes: ["/api/customer-feedbacks"] },
  { key: "history", name: "历史查询", view: "history", apiPrefixes: ["/api/history/"] },
  { key: "reports", name: "基础报表", view: "reports", apiPrefixes: ["/api/reports/"] },
  { key: "settings", name: "基础设置", view: "settings", apiPrefixes: ["/api/settings", "/api/users", "/api/processes"] },
  { key: "outsourcing", name: "外协监管", view: "outsourcing", apiPrefixes: ["/api/outsourcing"] },
  { key: "auditLogs", name: "操作日志", view: "auditLogs", apiPrefixes: ["/api/audit-logs"] },
];

const FEATURE_KEYS = new Set(FEATURE_MODULES.map((item) => item.key));
const UNGATED_API_PATHS = new Set([
  "/api/bootstrap", "/api/login", "/api/logout", "/api/me", "/api/external/health",
]);

function normalizeFeatureModules(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(String).filter((item) => FEATURE_KEYS.has(item)))];
}

function publicFeatureCatalog(slug = "") {
  const partnerTenant = Boolean(slug) && String(slug).toLowerCase() !== "future-machinery";
  return FEATURE_MODULES.map(({ key, name, view, href, apiPrefixes }) => ({
    key,
    name: key === "outsourcing" && partnerTenant ? "委派任务" : name,
    view,
    href,
    apiPrefixes,
  }));
}

function effectiveFeatureModules({ slug, planModules = [], overrides = {} }) {
  if (String(slug || "").toLowerCase() === "future-machinery") return FEATURE_MODULES.map((item) => item.key);
  const enabled = new Set(normalizeFeatureModules(planModules));
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!FEATURE_KEYS.has(key)) continue;
    if (value === true) enabled.add(key);
    if (value === false) enabled.delete(key);
  }
  return FEATURE_MODULES.map((item) => item.key).filter((key) => enabled.has(key));
}

function matchesPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

function featureForApiPath(pathname) {
  return FEATURE_MODULES.find((module) => module.apiPrefixes.some((prefix) => matchesPrefix(pathname, prefix)))?.key || null;
}

function isKnownUngatedApiPath(pathname) {
  return UNGATED_API_PATHS.has(pathname);
}

module.exports = { FEATURE_MODULES, effectiveFeatureModules, featureForApiPath, isKnownUngatedApiPath, normalizeFeatureModules, publicFeatureCatalog };
