"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { requiredOutsourcePermission, hasActiveOutsourcePermission } = require("../lib/saas-outsourcing-access");
const { createSaasStore } = require("../lib/saas-store");

test("partner task actions require the matching delegation permission", () => {
  assert.equal(requiredOutsourcePermission("partner", "accepted"), "tasks");
  assert.equal(requiredOutsourcePermission("partner", "cancelled"), "tasks");
  assert.equal(requiredOutsourcePermission("partner", "in_progress"), "progress");
  assert.equal(requiredOutsourcePermission("partner", "blocked"), "exceptions");
  assert.equal(requiredOutsourcePermission("partner", "submitted"), "delivery");
  assert.equal(requiredOutsourcePermission("owner", "cancelled"), null);
});

test("revoked, expired, and not-yet-active delegations cannot authorize partner actions", () => {
  const base = { status: "active", startsAt: "2026-10-10", endsAt: "2026-10-20", permissions: ["progress"] };
  assert.equal(hasActiveOutsourcePermission(base, "progress", "2026-10-19"), true);
  assert.equal(hasActiveOutsourcePermission({ ...base, status: "revoked" }, "progress", "2026-10-19"), false);
  assert.equal(hasActiveOutsourcePermission(base, "progress", "2026-10-21"), false);
  assert.equal(hasActiveOutsourcePermission(base, "progress", "2026-10-09"), false);
  assert.equal(hasActiveOutsourcePermission(base, "quality", "2026-10-19"), false);
});

test("store rejects a partner status update without the relation grant", async () => {
  const calls = [];
  const pool = { execute: async (sql, params) => {
    calls.push(sql);
    if (sql.includes("SELECT t.task_id")) return [[{
      task_id: "out-1", owner_tenant_id: "owner", partner_tenant_id: "partner", status: "accepted",
      delegation_status: "active", delegation_starts_at: "2020-01-01", delegation_ends_at: "2099-12-31",
      delegation_permissions: '["tasks"]',
    }]];
    return [{ affectedRows: 1 }];
  } };
  const store = createSaasStore(pool);

  await assert.rejects(store.updateOutsourceTaskStatus("out-1", "partner", "submitted", "user-1"), { statusCode: 403 });
  assert.equal(calls.some((sql) => sql.startsWith("UPDATE saas_outsource_tasks")), false);
});

test("store binds the relation grant and tenant into the status update", async () => {
  const calls = [];
  const pool = { execute: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("SELECT t.task_id")) return [[{
      task_id: "out-1", owner_tenant_id: "owner", partner_tenant_id: "partner", status: "accepted",
      delegation_status: "active", delegation_starts_at: "2020-01-01", delegation_ends_at: "2099-12-31",
      delegation_permissions: '["delivery"]',
    }]];
    return [{ affectedRows: 1 }];
  } };
  const store = createSaasStore(pool);

  await store.updateOutsourceTaskStatus("out-1", "partner", "submitted", "user-1");

  const update = calls.find(({ sql }) => sql.includes("UPDATE saas_outsource_tasks t JOIN saas_delegations"));
  assert.ok(update);
  assert.match(update.sql, /JSON_CONTAINS\(d\.permissions_json/);
  assert.equal(update.params[3], "partner");
  assert.equal(update.params.at(-1), "delivery");
});

test("accepting a task records its first acceptance time and task reads expose both timestamps", async () => {
  const calls = [];
  const acceptedAt = new Date("2026-10-26T02:15:00.000Z");
  const createdAt = new Date("2026-10-26T01:10:00.000Z");
  const pool = { execute: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith("SELECT t.task_id") && sql.includes("JOIN saas_delegations d")) return [[{
      task_id: "out-1", owner_tenant_id: "owner", partner_tenant_id: "partner", status: "sent",
      delegation_status: "active", delegation_starts_at: "2020-01-01", delegation_ends_at: "2099-12-31",
      delegation_permissions: '["tasks"]',
    }]];
    if (sql.startsWith("UPDATE saas_outsource_tasks t JOIN")) return [{ affectedRows: 1 }];
    if (sql.includes("INSERT INTO saas_audit_logs")) return [{ affectedRows: 1 }];
    if (sql.includes("FROM saas_outsource_tasks t WHERE")) return [[{
      task_id: "out-1", delegation_id: "del-1", owner_tenant_id: "owner", partner_tenant_id: "partner",
      owner_order_id: "order-1", partner_work_order_id: "work-1", source_revision: 1, status: "accepted",
      due_date: "2026-10-30", production_value_fen: 789000, partner_accepted_at: acceptedAt,
      snapshot_json: "{}", created_by: "owner-user", created_at: createdAt, updated_at: acceptedAt,
    }]];
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const store = createSaasStore(pool);

  await store.updateOutsourceTaskStatus("out-1", "partner", "accepted", "partner-user");
  const update = calls.find(({ sql }) => sql.startsWith("UPDATE saas_outsource_tasks t JOIN"));
  assert.match(update.sql, /partner_accepted_at = IF\(\? = 'accepted' AND t\.partner_accepted_at IS NULL, NOW\(\), t\.partner_accepted_at\)/);

  const [task] = await store.listOutsourceTasks("partner", "partner");
  assert.equal(task.createdAt, createdAt);
  assert.equal(task.partnerAcceptedAt, acceptedAt);
});

test("task reads recover acceptance time for tasks accepted before the timestamp column existed", async () => {
  const acceptedAt = new Date("2026-10-25T11:32:00.000Z");
  let selectSql = "";
  const pool = { execute: async (sql) => {
    selectSql = sql;
    return [[{
      task_id: "out-legacy", delegation_id: "del-1", owner_tenant_id: "owner", partner_tenant_id: "partner",
      owner_order_id: "order-1", partner_work_order_id: "work-1", source_revision: 1, status: "in_progress",
      due_date: "2026-10-30", production_value_fen: 789000, partner_accepted_at: acceptedAt,
      snapshot_json: "{}", created_by: "owner-user",
      created_at: new Date("2026-10-25T10:00:00.000Z"), updated_at: acceptedAt,
    }]];
  } };
  const store = createSaasStore(pool);

  const [task] = await store.listOutsourceTasks("owner", "owner");

  assert.match(selectSql, /AS partner_accepted_at/);
  assert.equal(task.partnerAcceptedAt, acceptedAt);
});

test("task creation timestamps automatically and reads can recover legacy audit time", async () => {
  const createdAt = "2026-10-27T03:12:00.000Z";
  const calls = [];
  const pool = { execute: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("INSERT INTO saas_outsource_tasks")) return [{ affectedRows: 1 }];
    if (sql.includes("INSERT INTO saas_audit_logs")) return [{ affectedRows: 1 }];
    if (sql.includes("FROM saas_outsource_tasks t WHERE")) return [[{
      task_id: "out-created", delegation_id: "del-1", owner_tenant_id: "owner", partner_tenant_id: "partner",
      owner_order_id: "order-1", partner_work_order_id: "work-1", source_revision: 1, status: "sent",
      due_date: "2026-10-30", production_value_fen: 789000, partner_accepted_at: null,
      created_at: createdAt, created_audit_at: createdAt, snapshot_json: "{}", created_by: "owner-user", updated_at: createdAt,
    }]];
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const store = createSaasStore(pool);
  await store.createOutsourceTask({
    taskId: "out-created", delegationId: "del-1", ownerTenantId: "owner", partnerTenantId: "partner",
    ownerOrderId: "order-1", partnerWorkOrderId: "work-1", sourceRevision: 1, status: "sent",
    dueDate: "2026-10-30", productionValueFen: 789000, snapshot: {}, createdBy: "owner-user", createdAt,
  });
  const insert = calls.find(({ sql }) => sql.includes("INSERT INTO saas_outsource_tasks"));
  assert.match(insert.sql, /created_by, created_at, updated_at\)[\s\S]*VALUES[\s\S]*NOW\(\), NOW\(\)/);

  const [task] = await store.listOutsourceTasks("owner", "owner");
  const read = calls.find(({ sql }) => sql.includes("FROM saas_outsource_tasks t WHERE"));
  assert.match(read.sql, /COALESCE\(t\.created_at, \([\s\S]*outsource-task\.create/);
  assert.equal(task.createdAt, createdAt);
});
