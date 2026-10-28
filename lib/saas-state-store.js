"use strict";

const fs = require("fs");
const path = require("path");

function createTenantStateStore({ driver, pool, getPool, dataDir }) {
  if (!dataDir) throw new Error("tenant state store requires dataDir");
  if (driver === "mysql" && !getPool && (!pool || typeof pool.execute !== "function")) throw new Error("MySQL tenant state store requires a pool resolver");
  if (!["mysql", "json"].includes(driver)) throw new Error("unsupported tenant state driver");

  function tenantPool(tenant) {
    if (getPool) {
      if (!tenant || typeof tenant !== "object" || !tenant.tenantId || !tenant.slug) throw new Error("tenant context is required");
      const resolvedPool = getPool(tenant);
      if (!resolvedPool || typeof resolvedPool.execute !== "function") throw new Error("tenant database is unavailable");
      return resolvedPool;
    }
    return pool;
  }

  function getStateKey(tenant) {
    if (getPool) return "main";
    const key = String(tenant?.stateKey || "").trim();
    if (!/^[a-zA-Z0-9:_-]{1,100}$/.test(key)) throw new Error("tenant state key is invalid");
    return key;
  }

  function getJsonPath(tenant) {
    const tenantId = String(tenant?.tenantId || "").trim();
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(tenantId)) throw new Error("tenant ID is invalid");
    return path.join(dataDir, "tenants", `${tenantId}.json`);
  }

  async function read(tenant) {
    if (driver === "mysql") {
      const [rows] = await tenantPool(tenant).execute("SELECT value_json FROM app_state WHERE name = ? LIMIT 1", [getStateKey(tenant)]);
      if (!rows.length) return null;
      return typeof rows[0].value_json === "string" ? JSON.parse(rows[0].value_json) : rows[0].value_json;
    }
    const file = getJsonPath(tenant);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  }

  async function write(tenant, state) {
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("tenant state must be an object");
    if (driver === "mysql") {
      await tenantPool(tenant).execute(
        "REPLACE INTO app_state (name, value_json, updated_at) VALUES (?, CAST(? AS JSON), NOW())",
        [getStateKey(tenant), JSON.stringify(state)]
      );
      return;
    }
    const file = getJsonPath(tenant);
    const folder = path.dirname(file);
    fs.mkdirSync(folder, { recursive: true });
    const temporaryFile = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(temporaryFile, file);
  }

  return { read, write };
}

module.exports = { createTenantStateStore };
