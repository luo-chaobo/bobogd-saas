"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { FEATURE_MODULES } = require("../lib/saas-features");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("platform plans and tenant navigation use the shared feature catalog", () => {
  const server = read("server.js");
  const app = read("public/app.js");
  const platform = read("public/platform-admin.js");
  const html = read("public/platform-admin.html");

  assert.match(server, /url\.pathname === "\/api\/platform\/feature-modules"/);
  assert.match(server, /url\.pathname === "\/api\/platform\/plans"/);
  assert.match(server, /data\.featureCatalog = publicFeatureCatalog\(context\?\.slug\)/);
  assert.match(server, /!requiredFeature && !isKnownUngatedApiPath\(url\.pathname\)/);
  assert.match(platform, /api\("\/api\/platform\/feature-modules"\)/);
  assert.match(platform, /HTTP \$\{response\.status\}/);
  assert.match(app, /data\.featureCatalog \|\| \[\]/);
  assert.doesNotMatch(app, /const viewModules =/);
  assert.match(html, /platform-admin\.js\?v=20261027-rebate-unpaid-forecast-v1/);
  assert.equal(FEATURE_MODULES.length, 11);
});

test("rebate API is registered and dispatch-board token context carries entitlement state", () => {
  const server = read("server.js");
  assert.match(server, /req\.method === "GET" && url\.pathname === "\/api\/platform\/outsourcing-rebates"/);

  const userPayloadIndex = server.indexOf('const payload = verifyToken(token, SAAS_SESSION_SECRET, "tenant-user")');
  const viewerStart = server.indexOf('const viewerToken =', userPayloadIndex);
  const uploadsStart = server.indexOf('if (url.pathname.startsWith("/uploads/"))', viewerStart);
  const viewerContext = server.slice(viewerStart, uploadsStart);
  assert.match(viewerContext, /findActiveEntitlement\(tenant\.tenantId\)/);
  assert.match(viewerContext, /licenseActive: Boolean\(entitlement\)/);
});

test("TV viewers can lazily read safe drawings for a tenant-visible work order", () => {
  const server = read("server.js");
  assert.match(server, /\^\\\/api\\\/tv-orders\\\/\[\^\/\]\+\\\/drawings\$/);
  assert.match(server, /url\.pathname\.match\(\/\^\\\/api\\\/tv-orders\\\/\(\[\^\/\]\+\)\\\/drawings\$\/\)/);
  assert.match(server, /validTvDrawingViewer\(db, url\.searchParams\.get\("viewerToken"\)\)/);
  assert.match(server, /visibleProductionWorkOrders\(enrich\(db\)\.workOrders\)\.find/);
  assert.match(server, /workOrder\.drawings \|\| \[\]\)\.map\(tvDrawingMeta\)/);
});

test("outsourced tenants cannot bypass task delivery through order maintenance APIs", () => {
  const server = read("server.js");
  assert.match(server, /function isOutsourcedOrder\(db, orderId\)/);
  assert.match(server, /isOutsourcedOrder\(db, order\.id\).*外协任务订单信息由委派方维护/);
  assert.match(server, /sourceWorkOrder\.source === "saas-outsourcing".*外协任务不能从本地订单创建返单/);
  assert.match(server, /workOrders\.some\(\(item\) => item\.source === "saas-outsourcing"\).*外协任务交付请在外协监管中处理/);
});

test("every registered API route group is assigned to a feature or explicit ungated path", () => {
  const features = require("../lib/saas-features");
  const server = read("server.js");
  const routeGroups = [
    ["/api/dashboard", "dashboard"], ["/api/tv-dashboard", "dashboard"],
    ["/api/tv-orders/work-1/drawings", "dashboard"],
    ["/api/customers", "customers"], ["/api/orders", "orders"],
    ["/api/work-orders/delete", "orders"], ["/api/drawings/preview", "orders"],
    ["/api/attachments", "orders"], ["/api/deliveries/complete", "orders"],
    ["/api/dispatch-board/route-toggle", "dispatch"], ["/api/report", "dispatch"],
    ["/api/qr/resolve", "dispatch"], ["/api/exceptions/resolve", "quality"],
    ["/api/customer-feedbacks/resolve", "customerFeedback"], ["/api/history/work-orders", "history"],
    ["/api/reports/management-export", "reports"], ["/api/settings/tv", "settings"],
    ["/api/outsourcing/tasks/out-1/status", "outsourcing"], ["/api/audit-logs", "auditLogs"],
  ];

  for (const [pathname, expected] of routeGroups) assert.equal(features.featureForApiPath(pathname), expected, pathname);
  for (const pathname of ["/api/bootstrap", "/api/login", "/api/logout", "/api/me", "/api/external/health"]) {
    assert.equal(features.isKnownUngatedApiPath(pathname), true, pathname);
  }
  assert.equal(features.featureForApiPath("/api/not-registered"), null);
  assert.equal(features.isKnownUngatedApiPath("/api/not-registered"), false);
  const literalPaths = [...new Set([...server.matchAll(/["'](\/api\/[A-Za-z0-9_./:-]+)["']/g)].map((match) => match[1]))]
    .filter((pathname) => !pathname.startsWith("/api/platform/"));
  for (const pathname of literalPaths) {
    assert.ok(features.featureForApiPath(pathname) || features.isKnownUngatedApiPath(pathname), `unclassified server API path: ${pathname}`);
  }
});
