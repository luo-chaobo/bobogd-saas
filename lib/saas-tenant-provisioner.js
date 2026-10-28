"use strict";

const crypto = require("crypto");

function quoteDatabase(name) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) throw new Error("租户数据库名称无效");
  return `\`${name}\``;
}

function deriveTenantDatabaseIdentity(tenantId) {
  const match = String(tenantId || "").match(/^ten_([a-f0-9]{24})$/);
  if (!match) throw new Error("新租户编号无效，无法分配数据库");
  const suffix = match[1];
  return {
    database: `bobo_tenant_${suffix}`,
    user: `bobo_t_${suffix.slice(0, 20)}`,
  };
}

function deriveTenantDatabasePassword(tenantId, secret) {
  const key = String(secret || "");
  if (Buffer.byteLength(key, "utf8") < 32) throw new Error("SAAS_TENANT_CREDENTIAL_SECRET 至少需要 32 字节");
  return crypto.createHmac("sha256", key).update(`tenant-mysql:${tenantId}`).digest("hex");
}

function createTenantDatabaseConfig({ tenant, host, port, accountHost, secret }) {
  const identity = deriveTenantDatabaseIdentity(tenant.tenantId);
  const password = deriveTenantDatabasePassword(tenant.tenantId, secret);
  const normalizedPort = Number(port || 3306);
  if (!host || !accountHost || !Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
    throw new Error("租户数据库连接配置无效");
  }
  if (!/^[A-Za-z0-9._%-]+$/.test(accountHost)) throw new Error("租户数据库账号来源地址格式无效");
  return {
    slug: tenant.slug,
    tenantId: tenant.tenantId,
    host,
    port: normalizedPort,
    accountHost,
    database: identity.database,
    user: identity.user,
    password,
  };
}

function createTenantDatabaseProvisioner({ mysql, host, port, user, password, accountHost, credentialSecret }) {
  if (!mysql || typeof mysql.createConnection !== "function") throw new Error("租户数据库预配需要 MySQL 驱动");
  if (!host || !user || !password) throw new Error("尚未配置租户数据库预配账号");
  const options = { host, port: Number(port || 3306), user, password, charset: "utf8mb4" };

  async function provision(tenant) {
    const config = createTenantDatabaseConfig({
      tenant,
      host,
      port,
      accountHost,
      secret: credentialSecret,
    });
    const database = quoteDatabase(config.database);
    const account = `'${config.user}'@'${config.accountHost}'`;
    const connection = await mysql.createConnection(options);
    let databaseCreated = false;
    let userCreated = false;
    try {
      await connection.execute(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
      databaseCreated = true;
      await connection.execute(
        `CREATE TABLE ${database}.app_state (name VARCHAR(80) PRIMARY KEY, value_json JSON NOT NULL, updated_at DATETIME NOT NULL)`
      );
      await connection.execute(`CREATE USER ${account} IDENTIFIED BY '${config.password}'`);
      userCreated = true;
      await connection.execute(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${database}.* TO ${account}`
      );
      return config;
    } catch (error) {
      if (userCreated) await connection.execute(`DROP USER IF EXISTS ${account}`).catch(() => {});
      if (databaseCreated) await connection.execute(`DROP DATABASE IF EXISTS ${database}`).catch(() => {});
      throw error;
    } finally {
      await connection.end().catch(() => {});
    }
  }

  async function remove(config) {
    const database = quoteDatabase(config.database);
    const accountHostValue = String(config.accountHost || "");
    if (!/^[A-Za-z0-9._%-]+$/.test(accountHostValue) || !/^bobo_t_[a-f0-9]{20}$/.test(config.user)) {
      throw new Error("拒绝删除格式无效的租户数据库资源");
    }
    const account = `'${config.user}'@'${accountHostValue}'`;
    const connection = await mysql.createConnection(options);
    try {
      await connection.execute(`DROP USER IF EXISTS ${account}`);
      await connection.execute(`DROP DATABASE IF EXISTS ${database}`);
    } finally {
      await connection.end().catch(() => {});
    }
  }

  return { provision, remove };
}

module.exports = {
  createTenantDatabaseConfig,
  createTenantDatabaseProvisioner,
  deriveTenantDatabaseIdentity,
  deriveTenantDatabasePassword,
};
