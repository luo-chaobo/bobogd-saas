"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createTenantStateStore } = require("../lib/saas-state-store");

test("each tenant reads and writes only app_state.main in its own database", async () => {
  const calls = [];
  const pools = Object.fromEntries(["future-machinery", "xrjx"].map((slug) => [slug, {
    execute: async (sql, params) => {
      calls.push({ slug, sql, params });
      return sql.startsWith("SELECT") ? [[{ value_json: JSON.stringify({ company: slug }) }]] : [{ affectedRows: 1 }];
    },
  }]));
  const store = createTenantStateStore({ driver: "mysql", dataDir: "unused", getPool: (tenant) => pools[tenant.slug] });

  const first = await store.read({ tenantId: "future", slug: "future-machinery", stateKey: "must-not-be-used" });
  await store.write({ tenantId: "partner", slug: "xrjx", stateKey: "must-not-be-used" }, { company: "xrjx" });

  assert.deepEqual(first, { company: "future-machinery" });
  assert.deepEqual(calls.map(({ slug }) => slug), ["future-machinery", "xrjx"]);
  assert.equal(calls[0].params[0], "main");
  assert.equal(calls[1].params[0], "main");
});

test("tenant state store rejects a missing tenant context instead of falling back", async () => {
  const store = createTenantStateStore({
    driver: "mysql",
    dataDir: "unused",
    getPool: () => { throw new Error("tenant database is not configured"); },
  });

  await assert.rejects(store.read(null), /tenant context is required/);
  await assert.rejects(store.write(null, { users: [] }), /tenant context is required/);
});
