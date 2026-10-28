"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  calculateOutsourceRebate,
  requiresOutsourceCompletionPhoto,
  validateFullOutsourceSelection,
} = require("../lib/saas-outsourcing-commercial");

test("new outsource task must include the full route chain and planned quantity", () => {
  const routes = [
    { id: "r1", routeType: "production" },
    { id: "rw", routeType: "rework" },
    { id: "r2", routeType: "production" },
  ];

  assert.equal(validateFullOutsourceSelection(routes, ["r1", "r2"], 38, 38), true);
  assert.throws(() => validateFullOutsourceSelection(routes, ["r1"], 38, 38), /全部工序/);
  assert.throws(() => validateFullOutsourceSelection(routes, ["r1", "r2"], 20, 38), /全部计划数量/);
  assert.throws(() => validateFullOutsourceSelection([{ id: "r1" }], ["r1", "r1"], 38, 38), /重复选择/);
});

test("only an outsource report that completes its process requires a photo", () => {
  assert.equal(requiresOutsourceCompletionPhoto(true, 7, 10, 2), false);
  assert.equal(requiresOutsourceCompletionPhoto(true, 7, 10, 3), true);
  assert.equal(requiresOutsourceCompletionPhoto(false, 7, 10, 3), false);
});

test("rebate uses accepted output and actual paid fees with cumulative tiers", () => {
  assert.deepEqual(calculateOutsourceRebate({ outputFen: 99999, firstTargetFen: 100000, fullTargetFen: 200000, annualAmountFen: 120000, paymentStatus: "paid" }), {
    tier: 0, refundFen: 0,
  });
  assert.deepEqual(calculateOutsourceRebate({ outputFen: 100000, firstTargetFen: 100000, fullTargetFen: 200000, annualAmountFen: 120000, paymentStatus: "paid" }), {
    tier: 1, refundFen: 60000,
  });
  assert.deepEqual(calculateOutsourceRebate({ outputFen: 200000, firstTargetFen: 100000, fullTargetFen: 200000, annualAmountFen: 120000, paymentStatus: "paid" }), {
    tier: 2, refundFen: 120000,
  });
  assert.deepEqual(calculateOutsourceRebate({ outputFen: 200000, firstTargetFen: 100000, fullTargetFen: 200000, annualAmountFen: 120000, paymentStatus: "waived" }), {
    tier: 2, refundFen: 0,
  });
  assert.deepEqual(calculateOutsourceRebate({ outputFen: 200000, firstTargetFen: 100000, fullTargetFen: 200000, annualAmountFen: 120000, paymentStatus: "unpaid" }), {
    tier: 2, refundFen: 0,
  });
  assert.deepEqual(calculateOutsourceRebate({ outputFen: 500000, firstTargetFen: 500000, fullTargetFen: 30000000, annualAmountFen: 800000, paymentStatus: "unpaid" }), {
    tier: 1, refundFen: 0,
  });
});

test("rebate progress is rounded to two decimal places", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const adminJs = fs.readFileSync(path.join(__dirname, "..", "public", "platform-admin.js"), "utf8");
  const functionSource = adminJs.match(/function rebateProgressPercent\(output, target\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(functionSource, "platform admin must define rebateProgressPercent");
  const rebateProgressPercent = vm.runInNewContext(`${functionSource}; rebateProgressPercent`);

  assert.equal(rebateProgressPercent(5000, 300000), 1.67);
  assert.equal(rebateProgressPercent(5000, 5000), 100);
  assert.equal(rebateProgressPercent(5000, 0), 0);
});

test("admin and task interfaces expose cycle thresholds, progress, payout records, and task proof access", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const publicDir = path.join(__dirname, "..", "public");
  const adminHtml = fs.readFileSync(path.join(publicDir, "platform-admin.html"), "utf8");
  const adminJs = fs.readFileSync(path.join(publicDir, "platform-admin.js"), "utf8");
  const outsourcingJs = fs.readFileSync(path.join(publicDir, "outsourcing.js"), "utf8");
  const backend = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const store = fs.readFileSync(path.join(__dirname, "..", "lib", "saas-store.js"), "utf8");
  const appJs = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
  const miniOutsourcing = fs.readFileSync(path.join(__dirname, "..", "..", "miniprogram-local-test", "pages", "outsourcing", "outsourcing.js"), "utf8");
  const miniReport = fs.readFileSync(path.join(__dirname, "..", "..", "miniprogram-local-test", "pages", "report", "report.js"), "utf8");
  assert.match(adminJs, /第一档已达标/);
  assert.match(adminJs, /第二档已达标/);
  assert.match(adminJs, /period\.rebateTier === 2/);
  assert.match(adminJs, /period\.rebateTier === 1/);

  assert.match(adminHtml, /外协产值返还/);
  assert.ok(adminJs.includes("/api/platform/outsourcing-rebates"));
  assert.match(adminJs, /progress-track/);
  assert.match(adminJs, /settlement/);
  assert.match(outsourcingJs, /外派单/);
  assert.match(outsourcingJs, /productionValueFen/);
  assert.match(appJs, /outsourcedOrderIds/);
  assert.ok(store.includes("t.status = 'accepted_by_owner'"));
  assert.ok(store.includes("owner_accepted_at >= e.starts_at"));
  assert.ok(backend.includes("/reports/"));
  assert.ok(miniOutsourcing.includes("previewReportImage"));
  assert.ok(miniOutsourcing.includes("productionValueText"));
  assert.ok(miniReport.includes("外派工序完工报工必须上传至少一张现场照片"));
  assert.ok(miniReport.includes("routeId: this.data.routeId, workOrderId"));
});
