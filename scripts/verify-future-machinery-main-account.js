"use strict";

const mysql = require("mysql2/promise");
const { verifyPassword } = require("../lib/passwords");

async function main() {
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "bobo_saas_app",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "bobo_saas_local",
    connectionLimit: 1,
    charset: "utf8mb4",
  });
  try {
    const [rows] = await pool.execute("SELECT value_json FROM app_state WHERE name = ?", ["main"]);
    if (rows.length !== 1) throw new Error("future-machinery 主租户数据不存在");
    const db = typeof rows[0].value_json === "string" ? JSON.parse(rows[0].value_json) : rows[0].value_json;
    const users = (db.users || []).filter((user) => user.phone === process.env.MAIN_ACCOUNT_PHONE);
    if (users.length !== 1) throw new Error("手机号在主租户中不存在或重复");
    const user = users[0];
    if (!user.active || !verifyPassword(process.env.MAIN_ACCOUNT_PASSWORD, user.password)) {
      throw new Error("指定密码与当前数据库记录不匹配");
    }
    process.stdout.write(`已核实：future-machinery / ${user.phone} 当前密码与此前指定密码一致，账号已启用。\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
