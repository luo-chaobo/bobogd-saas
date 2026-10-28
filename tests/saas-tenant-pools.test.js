"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createTenantPoolRouter, parseTenantDatabaseConfigs } = require("../lib/saas-tenant-pools");

const validConfig = {
  host: "127.0.0.1",
  port: 3306,
  database: "tenant_future_machinery",
  user: "future_machinery_app",
  password: "local-only-test-secret",
};

test("tenant database configuration is mandatory and parsed by company slug", () => {
  assert.throws(() => parseTenantDatabaseConfigs(""), /SAAS_TENANT_DATABASES_JSON/);
  const configs = parseTenantDatabaseConfigs(JSON.stringify({ "future-machinery": validConfig }));
  assert.equal(configs["future-machinery"].database, "tenant_future_machinery");
});

test("tenant database configuration rejects shared catalog and protected legacy databases", () => {
  assert.throws(
    () => parseTenantDatabaseConfigs(JSON.stringify({ "future-machinery": { ...validConfig, database: "saas_catalog" } }), { catalogDatabase: "saas_catalog" }),
    /数据库必须与生产库和平台目录分离/,
  );
  assert.throws(
    () => parseTenantDatabaseConfigs(JSON.stringify({ "future-machinery": { ...validConfig, database: "bobogd" } })),
    /数据库必须与生产库和平台目录分离/,
  );
  assert.throws(
    () => parseTenantDatabaseConfigs(JSON.stringify({
      "future-machinery": validConfig,
      xrjx: { ...validConfig, user: "xrjx_app" },
    })),
    /不同租户不能共用业务数据库/,
  );
  assert.throws(
    () => parseTenantDatabaseConfigs(JSON.stringify({ "Bad Slug": validConfig })),
    /SAAS_TENANT_DATABASES_JSON 配置无效/,
  );
});

test("tenant database router fails closed and never falls back to another tenant", () => {
  const pools = [];
  const router = createTenantPoolRouter({
    mysql: { createPool: (config) => { const pool = { config }; pools.push(pool); return pool; } },
    configs: { "future-machinery": validConfig },
    catalogDatabase: "saas_catalog",
  });

  const pool = router.getPool({ slug: "future-machinery" });
  assert.equal(pool.config.database, "tenant_future_machinery");
  assert.throws(() => router.getPool({ slug: "unknown-company" }), /tenant database is not configured/);
  assert.equal(pools.length, 1);
});

test("each tenant gets a distinct database pool", () => {
  const configs = {
    "future-machinery": validConfig,
    xrjx: { ...validConfig, database: "tenant_xrjx", user: "xrjx_app" },
  };
  const router = createTenantPoolRouter({ mysql: { createPool: (config) => ({ config }) }, configs, catalogDatabase: "saas_catalog" });

  assert.notEqual(router.getPool({ slug: "future-machinery" }), router.getPool({ slug: "xrjx" }));
  assert.equal(router.getPool({ slug: "xrjx" }).config.database, "tenant_xrjx");
});
