const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "public", "outsourcing.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public", "outsourcing-module.css"), "utf8");

test("delegation proof photos open in a centered modal viewer", () => {
  assert.ok(/<dialog[^>]+om-proof-dialog/.test(app));
  assert.ok(/showModal\(\)/.test(app));
  assert.ok(/createObjectURL\(blob\)/.test(app));
  assert.ok(/\.om-proof-dialog/.test(css));
  assert.ok(!/link\.target\s*=\s*"_blank"/.test(app));
});

test("delegation reports show authenticated photo thumbnails and minute precision", () => {
  assert.match(app, /class="om-proof-thumbnail" data-proof-url=/);
  assert.match(app, /function dateTimeText\(/);
  assert.match(app, /dateTimeText\(report\.createdAt\)/);
  assert.match(app, /timeZone:\s*"Asia\/Shanghai"/);
  assert.match(css, /\.om-proof-thumbnail/);
});
