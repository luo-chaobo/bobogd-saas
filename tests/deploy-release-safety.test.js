const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("production deploy script preserves shared data and rolls back only code", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "deploy-release.sh"), "utf8");

  assert.match(source, /ROOT="\/srv\/bobo"/);
  assert.match(source, /mysqldump/);
  assert.match(source, /shared\/uploads/);
  assert.match(source, /release-manifest\.json/);
  assert.match(source, /ln -sfn/);
  assert.match(source, /systemctl restart bobo/);
  assert.match(source, /rollback_code/);
  assert.doesNotMatch(source, /DROP DATABASE|DELETE FROM app_state|rm -rf "\$ROOT\/shared/);
});
