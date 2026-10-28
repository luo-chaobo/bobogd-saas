"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { FEATURE_MODULES } = require("../lib/saas-features");
const { canAccessApiPath, requiredFeatureForPath } = require("../miniprogram/utils/feature-contract");

const root = path.join(__dirname, "..", "miniprogram");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("mini program stores backend feature entitlements with the authenticated tenant session", () => {
  const api = read("utils/api.js");
  const login = read("pages/login/login.js");
  const backend = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

  assert.match(api, /featureModules/);
  assert.match(api, /featureCatalog/);
  assert.match(api, /work_feature_modules/);
  assert.match(login, /featureModules/);
  assert.match(api, /featureCatalog/);
  assert.match(api, /assertFeatureEnabled/);
  assert.match(backend, /publicFeatureCatalog\(requestContext\.getStore\(\)\?\.slug\)/);
  assert.match(backend, /publicFeatureCatalog\(context\?\.slug\)/);
});

test("mini program navigation uses backend module keys and exposes tenant outsourcing work", () => {
  const tabBar = read("custom-tab-bar/index.js");
  const tabTemplate = read("custom-tab-bar/index.wxml");
  const appConfig = JSON.parse(read("app.json"));

  assert.match(tabBar, /work_feature_modules/);
  assert.match(tabBar, /outsourcing/);
  assert.match(tabBar, /item\.featureKey/);
  assert.match(tabBar, /text: "委派"/);
  assert.match(tabTemplate, /visibleItems/);
  assert.ok(appConfig.pages.includes("pages/outsourcing/outsourcing"));
  assert.ok(appConfig.tabBar.list.some((item) => item.pagePath === "pages/outsourcing/outsourcing"));
});

test("primary tenant sees all tabs while partner tenants hide exception and delivery tabs", () => {
  const featureModules = ["dispatch", "dashboard", "quality", "orders", "outsourcing"];
  const primaryTabs = visibleTabs("future-machinery", featureModules);
  const partnerTabs = visibleTabs("partner-test", featureModules);

  assert.deepEqual(primaryTabs, ["任务", "看板", "异常", "配送", "委派"]);
  assert.deepEqual(partnerTabs, ["任务", "看板", "委派"]);
});

function visibleTabs(companySlug, featureModules) {
  const storage = new Map([
    ["work_user", { role: "manager" }],
    ["work_company_slug", companySlug],
    ["work_feature_modules", featureModules]
  ]);
  let definition;
  vm.runInNewContext(read("custom-tab-bar/index.js"), {
    Component: (component) => { definition = component; },
    wx: { getStorageSync: (key) => storage.get(key) }
  });
  const context = {
    data: definition.data,
    setData(update) { this.data = { ...this.data, ...update }; }
  };
  definition.methods.syncUser.call(context);
  return Array.from(context.data.visibleItems, ({ text }) => text);
}

test("outsourcing mini program page uses server task APIs and relation-scoped actions", () => {
  const page = read("pages/outsourcing/outsourcing.js");
  const template = read("pages/outsourcing/outsourcing.wxml");

  assert.match(page, /api\.request\("\/api\/outsourcing"\)/);
  assert.match(page, /\/api\/outsourcing\/tasks\/\$\{[^}]+\}\/status/);
  assert.match(page, /relationActive/);
  assert.match(page, /data\.isOwner === true/);
  assert.match(page, /permissions/);
  assert.match(template, /item\.companyName/);
  assert.match(template, /item\.processes/);
});

test("SaaS mini program outsourcing cards use single currency mark, no start action, and collapse details", () => {
  const page = read("pages/outsourcing/outsourcing.js");
  const template = read("pages/outsourcing/outsourcing.wxml");
  const partnerActions = page.match(/const PARTNER_ACTIONS = \{([\s\S]*?)\n\};/)?.[1] || "";

  assert.match(template, /外派单 · 产值 \{\{item\.productionValueText\}\}/);
  assert.doesNotMatch(template, /产值 ¥\{\{item\.productionValueText\}\}/);
  assert.doesNotMatch(partnerActions, /开始生产/);
  assert.match(template, /wx:if="\{\{item\.expanded\}\}"/);
  assert.match(template, /bindtap="toggleTask"/);
  assert.match(template, /task-heading-status/);
  assert.doesNotMatch(template, /前往我的任务|production-link/);
  assert.doesNotMatch(page, /openProductionTasks/);
  assert.match(template, /disabled="\{\{action\.disabled\}\}"/);
  assert.match(read("pages/outsourcing/outsourcing.wxss"), /\.task-actions \.btn \{[^}]*flex: 1;/);
  assert.match(page, /expanded: false/);
  assert.match(page, /productionValueText: Number\(task\.productionValueFen/);
  assert.match(page, /allProcessesComplete/);
});

test("mobile API feature checks follow the server catalog and fail closed for excluded modules", () => {
  const catalog = FEATURE_MODULES.map(({ key, name, apiPrefixes }) => ({ key, name, apiPrefixes }));
  for (const module of FEATURE_MODULES) {
    for (const prefix of module.apiPrefixes) {
      const path = `${prefix}${prefix.endsWith("/") ? "example" : "/example"}?page=1`;
      assert.equal(requiredFeatureForPath(catalog, path)?.key, module.key);
      assert.equal(canAccessApiPath(catalog, [module.key], path), true);
      assert.equal(canAccessApiPath(catalog, [], path), false);
    }
  }
  assert.equal(canAccessApiPath(catalog, [], "/api/bootstrap"), true);
});
