const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const schema = fs.readFileSync(path.join(root, "db", "saas-schema.sql"), "utf8");
const stateStore = fs.readFileSync(path.join(root, "lib", "saas-state-store.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "scripts", "migrate-json-to-mysql.js"), "utf8");

assert.ok(pkg.dependencies && pkg.dependencies.mysql2, "package.json 必须声明 mysql2 依赖");
assert.ok(server.includes("DB_DRIVER"), "server.js 必须通过 DB_DRIVER 切换数据库驱动");
assert.ok(server.includes("createMysqlPool"), "server.js 必须建立 MySQL 连接池");
assert.ok(server.includes("await readDb()"), "API 必须异步读取数据库");
assert.ok(server.includes("await writeDb(db)"), "API 必须异步写入数据库");
assert.ok(schema.includes("CREATE TABLE IF NOT EXISTS saas_tenants"), "SaaS schema 必须包含租户目录");
assert.ok(schema.includes("saas_entitlements"), "SaaS schema 必须包含套餐授权");
assert.ok(server.includes("CREATE TABLE IF NOT EXISTS app_state"), "租户 MySQL 初始化必须包含独立状态表");
assert.ok(stateStore.includes("SELECT value_json FROM app_state"), "租户读取必须使用独立 app_state");
assert.ok(stateStore.includes("REPLACE INTO app_state"), "租户写入必须使用独立 app_state");
assert.ok(migration.includes("app_state"), "迁移脚本必须把当前 JSON 状态写入 MySQL");

console.log("mysql-switch: ok");
