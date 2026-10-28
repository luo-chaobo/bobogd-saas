"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const tvSource = fs.readFileSync(path.join(__dirname, "..", "public", "tv.js"), "utf8");

test("tenant company name is visible in the web sidebar", () => {
  assert.ok(appSource.includes("class=\"brand-company\"") && appSource.includes("data.companyName"), "sidebar brand should render the authenticated tenant name");
});

test("TV board title uses the current tenant company name", () => {
  assert.ok(/class="company-name">\$\{esc\(data\.companyName/.test(tvSource), "TV title should render companyName from its tenant-scoped API response");
});

test("outsourcing module is navigable for both owner and partner tenants", () => {
  assert.ok(appSource.includes('["outsourcing", "外协监管"]'), "admin navigation should include the outsourcing view");
  assert.ok(appSource.includes('outsourcing: "outsourcing"'), "admin navigation should map the feature key to its view");
});
