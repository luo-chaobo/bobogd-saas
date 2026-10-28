"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("partner task status updates are routed before owner-only management guard", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const handlerStart = source.indexOf("async function handleOutsourcingApi");
  const handlerEnd = source.indexOf("async function ", handlerStart + 1);
  const handler = source.slice(handlerStart, handlerEnd);
  const page = fs.readFileSync(path.join(__dirname, "..", "public", "outsourcing.js"), "utf8");
  const statusRoute = handler.indexOf('url.pathname.match(/^\\/api\\/outsourcing\\/tasks\\/([^/]+)\\/status$/)');
  const ownerGuard = handler.indexOf('if (!isOwner) return send(res, 403, { error: "仅主公司可管理委派关系和创建外协任务" });');

  assert.ok(statusRoute >= 0, "任务状态接口必须存在");
  assert.ok(ownerGuard > statusRoute, "伙伴状态动作必须先处理，主公司专属管理限制不能拦截接受任务");
  assert.match(page, /accepted: "已接受委派任务"/);
  assert.match(page, /owner \? "外协监管" : "委派任务"/);
});

test("standalone outsourcing URL opens the authenticated SaaS app module", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "outsourcing.html"), "utf8");
  assert.match(html, /url=\/index\.html#outsourcing/);
  assert.match(html, /window\.location\.replace\("\/index\.html#outsourcing"\)/);
});
