"use strict";

const crypto = require("crypto");
const mysql = require("mysql2/promise");

async function main() {
  const phone = String(process.env.MAIN_ACCOUNT_PHONE || "").trim();
  const password = String(process.env.MAIN_ACCOUNT_PASSWORD || "");
  if (!/^\+?[0-9]{7,18}$/.test(phone)) throw new Error("主账号手机号格式无效");
  if (!password) throw new Error("主账号密码未设置");

  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "bobo_saas_app",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "bobo_saas_local",
    waitForConnections: true,
    connectionLimit: 1,
    charset: "utf8mb4",
  });
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const [tenants] = await connection.execute(
      "SELECT tenant_id, state_key FROM saas_tenants WHERE slug = ? FOR UPDATE",
      ["future-machinery"]
    );
    if (tenants.length !== 1 || tenants[0].tenant_id !== "future-machinery" || tenants[0].state_key !== "main") {
      throw new Error("future-machinery 主租户不存在或数据键不匹配，未修改账号");
    }

    const [states] = await connection.execute("SELECT value_json FROM app_state WHERE name = ? FOR UPDATE", ["main"]);
    if (states.length !== 1) throw new Error("future-machinery 主租户数据不存在，未修改账号");
    const db = typeof states[0].value_json === "string" ? JSON.parse(states[0].value_json) : states[0].value_json;
    if (!db || !Array.isArray(db.users)) throw new Error("主租户用户数据格式不正确，未修改账号");

    const matches = db.users.filter((user) => user.phone === phone);
    if (matches.length > 1) throw new Error("主租户内该手机号重复，未修改账号");

    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    const passwordHash = `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
    const user = matches[0] || {
      id: `u_${crypto.randomBytes(12).toString("hex")}`,
      name: "老板",
      phone,
    };
    user.role = "owner";
    user.roles = ["owner"];
    user.password = passwordHash;
    user.active = true;
    if (!matches.length) db.users.push(user);

    db.auditLogs ||= [];
    db.auditLogs.push({
      id: `log_${crypto.randomBytes(12).toString("hex")}`,
      actorId: user.id,
      action: "main-account.credentials-reset",
      targetType: "user",
      targetId: user.id,
      detail: { phone, role: "owner" },
      createdAt: new Date().toISOString(),
    });

    const [result] = await connection.execute(
      "UPDATE app_state SET value_json = CAST(? AS JSON), updated_at = NOW() WHERE name = ?",
      [JSON.stringify(db), "main"]
    );
    if (result.affectedRows !== 1) throw new Error("主租户账号更新未生效");
    await connection.execute(
      "UPDATE saas_sessions SET revoked_at = NOW() WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL",
      ["future-machinery", user.id]
    );
    await connection.commit();
    process.stdout.write(`future-machinery 主账号已设置：${phone}（老板权限）\n`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
