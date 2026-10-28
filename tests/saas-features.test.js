"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { FEATURE_MODULES, effectiveFeatureModules, featureForApiPath, isKnownUngatedApiPath, publicFeatureCatalog } = require("../lib/saas-features");
const { createSaasStore } = require("../lib/saas-store");

test("future-machinery always receives every module despite plan and overrides", () => {
  const modules = effectiveFeatureModules({
    slug: "future-machinery",
    planModules: [],
    overrides: { orders: false, reports: false },
  });

  assert.deepEqual(modules, FEATURE_MODULES.map((item) => item.key));
});

test("tenant overrides take precedence over its plan modules", () => {
  const modules = effectiveFeatureModules({
    slug: "partner",
    planModules: ["dashboard", "orders", "reports"],
    overrides: { reports: false, outsourcing: true },
  });

  assert.deepEqual(modules, ["dashboard", "orders", "outsourcing"]);
});

test("business API routes resolve to a module while platform and login routes remain ungated", () => {
  assert.equal(featureForApiPath("/api/orders/update"), "orders");
  assert.equal(featureForApiPath("/api/reports/management-export"), "reports");
  assert.equal(featureForApiPath("/api/platform-orders/confirm"), "orders");
  assert.equal(featureForApiPath("/api/platform/tenants"), null);
  assert.equal(featureForApiPath("/api/login"), null);
  assert.equal(isKnownUngatedApiPath("/api/bootstrap"), true);
  assert.equal(isKnownUngatedApiPath("/api/unknown-business-route"), false);
  assert.equal(featureForApiPath("/api/dispatch-board/route-toggle"), "dispatch");
});

test("feature catalog includes stable navigation metadata and unique keys", () => {
  const expected = [
    ["dashboard", "生产总览", "dashboard"], ["customers", "客户资料", "customers"],
    ["orders", "订单工单", "orders"], ["dispatch", "派工路线", "dispatch"],
    ["quality", "质检详情", "exceptions"], ["customerFeedback", "客户反馈", "customerFeedback"],
    ["history", "历史查询", "history"], ["reports", "基础报表", "reports"],
    ["settings", "基础设置", "settings"], ["outsourcing", "外协监管", "outsourcing"],
    ["auditLogs", "操作日志", "auditLogs"],
  ];
  assert.deepEqual(FEATURE_MODULES.map(({ key, name, view }) => [key, name, view]), expected);
  assert.equal(new Set(FEATURE_MODULES.map((item) => item.key)).size, FEATURE_MODULES.length);
  assert.equal(FEATURE_MODULES.find((item) => item.key === "outsourcing").href, undefined);
});

test("outsourcing navigation label is tenant-specific without changing the package key", () => {
  const ownerEntry = publicFeatureCatalog("future-machinery").find((item) => item.key === "outsourcing");
  const partnerEntry = publicFeatureCatalog("subcontractor").find((item) => item.key === "outsourcing");

  assert.equal(ownerEntry.name, "外协监管");
  assert.equal(partnerEntry.name, "委派任务");
  assert.deepEqual(partnerEntry.apiPrefixes, ownerEntry.apiPrefixes);
});

test("gray releases expose their modules only to included tenants", async () => {
  const pool = {
    execute: async (sql, params) => {
      if (sql.includes("SELECT p.modules_json")) return [[{ modules_json: '["dashboard","orders","reports"]', overrides_json: "{}" }]];
      if (sql.includes("FROM saas_feature_releases")) return [[{
        modules_json: '["reports"]', status: "gray", rollout_status: params[0] === "tenant-included" ? "included" : null,
      }]];
      return [[]];
    },
  };
  const store = createSaasStore(pool);

  assert.deepEqual(await store.getTenantFeatureModules({ tenantId: "tenant-included", slug: "included" }), ["dashboard", "orders", "reports"]);
  assert.deepEqual(await store.getTenantFeatureModules({ tenantId: "tenant-excluded", slug: "excluded" }), ["dashboard", "orders"]);
});

test("schema initialization adds legacy full-feature assignments without deleting existing data", async () => {
  const calls = [];
  const store = createSaasStore({ execute: async (sql, params) => { calls.push({ sql, params }); return [[]]; } });

  await store.ensureSchema();

  assert.ok(calls.some(({ sql }) => sql.includes("CREATE TABLE IF NOT EXISTS saas_feature_plans")));
  assert.ok(calls.some(({ sql }) => sql.includes("INSERT IGNORE INTO saas_tenant_feature_assignments") && sql.includes("SELECT tenant_id")));
  assert.ok(calls.some(({ sql }) => sql.includes("saas_feature_release_rollouts")));
});

test("feature plan writes preserve the selected stable module keys", async () => {
  const statements = [];
  const store = createSaasStore({ execute: async (sql, params) => {
    statements.push({ sql, params });
    return sql.includes("SELECT plan_id") ? [[]] : [{ affectedRows: 1 }];
  } });

  await store.saveFeaturePlan({ planId: "vip", name: "VIP", modules: ["dashboard", "orders", "outsourcing"], actorUserId: "admin" });

  const upsert = statements.find(({ sql }) => sql.includes("INSERT INTO saas_feature_plans"));
  assert.deepEqual(JSON.parse(upsert.params[3]), ["dashboard", "orders", "outsourcing"]);
});
