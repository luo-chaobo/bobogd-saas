"use strict";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,98}[a-z0-9])?$/;

function databaseName(value, companySlug) {
  const name = String(value || "").trim();
  if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) throw new Error(`租户 ${companySlug} 的数据库配置无效`);
  return name;
}

function normalizeTenantConfig(companySlug, value, options) {
  if (!SLUG_PATTERN.test(companySlug) || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SAAS_TENANT_DATABASES_JSON 配置无效");
  }
  const database = databaseName(value.database, companySlug);
  const blocked = new Set([
    "bobogd",
    "future_orders",
    options.catalogDatabase,
    ...options.forbiddenDatabases,
  ].filter(Boolean).map((item) => String(item).toLowerCase()));
  if (blocked.has(database.toLowerCase())) throw new Error(`租户 ${companySlug} 的数据库必须与生产库和平台目录分离`);

  const host = String(value.host || "").trim();
  const user = String(value.user || "").trim();
  const password = String(value.password || "");
  const port = Number(value.port || 3306);
  if (!host || !user || !password || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`租户 ${companySlug} 的数据库连接配置不完整`);
  }
  return { host, port, database, user, password };
}

function parseTenantDatabaseConfigs(rawValue, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawValue || ""));
  } catch {
    throw new Error("SAAS_TENANT_DATABASES_JSON 必须是有效 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Object.keys(parsed).length) {
    throw new Error("SAAS_TENANT_DATABASES_JSON 必须包含租户数据库映射");
  }

  const normalizedOptions = {
    catalogDatabase: String(options.catalogDatabase || "").trim(),
    forbiddenDatabases: Array.isArray(options.forbiddenDatabases) ? options.forbiddenDatabases : [],
  };
  const configs = {};
  const seenDatabases = new Set();
  for (const [companySlug, value] of Object.entries(parsed)) {
    const config = normalizeTenantConfig(companySlug, value, normalizedOptions);
    const databaseKey = config.database.toLowerCase();
    if (seenDatabases.has(databaseKey)) throw new Error("不同租户不能共用业务数据库");
    seenDatabases.add(databaseKey);
    configs[companySlug] = config;
  }
  return configs;
}

function createTenantPoolRouter({ mysql, configs, catalogDatabase, forbiddenDatabases = [] }) {
  if (!mysql || typeof mysql.createPool !== "function") throw new Error("租户数据库路由需要 MySQL 驱动");
  if (!configs || typeof configs !== "object" || Array.isArray(configs)) throw new Error("租户数据库映射无效");
  const options = { catalogDatabase: String(catalogDatabase || "").trim(), forbiddenDatabases };
  const normalizedConfigs = {};
  const seenDatabases = new Set();
  for (const [companySlug, value] of Object.entries(configs)) {
    const config = normalizeTenantConfig(companySlug, value, options);
    const databaseKey = config.database.toLowerCase();
    if (seenDatabases.has(databaseKey)) throw new Error("不同租户不能共用业务数据库");
    seenDatabases.add(databaseKey);
    normalizedConfigs[companySlug] = config;
  }

  const pools = new Map();
  function getPool(tenant) {
    const companySlug = String(tenant?.slug || "").trim().toLowerCase();
    if (!companySlug || !SLUG_PATTERN.test(companySlug)) throw new Error("租户上下文无效，已拒绝数据库访问");
    const config = normalizedConfigs[companySlug];
    if (!config) throw new Error("tenant database is not configured");
    if (!pools.has(companySlug)) {
      pools.set(companySlug, mysql.createPool({
        ...config,
        waitForConnections: true,
        connectionLimit: 5,
        charset: "utf8mb4",
      }));
    }
    return pools.get(companySlug);
  }

  function registerTenantConfig(companySlug, value) {
    const normalized = normalizeTenantConfig(companySlug, value, options);
    if (normalizedConfigs[companySlug]) throw new Error(`租户 ${companySlug} 已绑定数据库`);
    const databaseKey = normalized.database.toLowerCase();
    if (Object.values(normalizedConfigs).some((item) => item.database.toLowerCase() === databaseKey)) {
      throw new Error("不同租户不能共用业务数据库");
    }
    normalizedConfigs[companySlug] = normalized;
  }

  async function unregisterTenantConfig(companySlug) {
    const pool = pools.get(companySlug);
    if (pool) {
      await pool.end();
      pools.delete(companySlug);
    }
    delete normalizedConfigs[companySlug];
  }

  function hasTenantConfig(companySlug) {
    return Boolean(normalizedConfigs[companySlug]);
  }

  return { getPool, hasTenantConfig, registerTenantConfig, unregisterTenantConfig };
}

module.exports = { createTenantPoolRouter, parseTenantDatabaseConfigs };
