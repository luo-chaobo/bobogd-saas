"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("HTTP server declares the serialized order and dispatch write queues before use", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /const \{[^}]*\bcreateSerialQueue\b[^}]*\} = require\("\.\/lib\/order-financials"\);/);
  assert.match(server, /const serializeOrderNumberWrite = createSerialQueue\(\)/);
  assert.match(server, /const ORDER_NUMBER_WRITE_PATHS = new Set\(\[[\s\S]*?"\/api\/external\/work-orders",?\s*\]\)/);
  assert.match(server, /const serializeDispatchBoardWrite = createSerialQueue\(\)/);
  assert.match(server, /const DISPATCH_BOARD_WRITE_PATHS = new Set\(\[\s*"\/api\/dispatch-board\/route-toggle",\s*"\/api\/dispatch-board\/route-schedule",\s*"\/api\/dispatch-board\/order-due-date"/);
});
