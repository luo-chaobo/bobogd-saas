const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { normalizeUnitPrice, calculateOrderTotal } = require("../lib/order-financials");

const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");

test("SaaS order managers can enter prices and the server calculates totals", () => {
  assert.ok(/viewOrderFinancials:\s*canSupervise\(user\)/.test(server));
  assert.ok(/normalizeUnitPrice\(body\.unitPrice\)/.test(server));
  assert.ok(/calculateOrderTotal\(priceResult\.value, quantity\)/.test(server));
  assert.ok(/unitPrice:\s*priceResult\.value,\s*totalAmount/.test(server));
  assert.ok(/data\.permissions\?\.viewOrderFinancials[\s\S]*单价（元）[\s\S]*总金额（元）/.test(app));
  assert.ok(/res\.viewOrderFinancials \? data : redactOrderFinancials\(data\)/.test(server));
});

test("order financial values are validated and calculated in cents", () => {
  const price = normalizeUnitPrice("12.35");
  assert.deepEqual(price, { value: 12.35, error: "" });
  assert.equal(calculateOrderTotal(price.value, 3), 37.05);
  assert.notEqual(normalizeUnitPrice("12.345").error, "");
});
