const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const tv = fs.readFileSync(path.join(root, "public", "tv.js"), "utf8");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public", "tv.css"), "utf8");

test("outsourced orders are marked on the TV board", () => {
  assert.ok(/order\.isOutsourced/.test(tv));
  assert.ok(/text:\s*"外派单"[\s\S]*cls:\s*"outsource"/.test(tv));
  assert.ok(/outsourcedOrderIds\.has\(/.test(server));
  assert.ok(/source\s*===\s*"saas-outsourcing"/.test(server));
  assert.ok(/\.badge\.outsource/.test(css));
});
