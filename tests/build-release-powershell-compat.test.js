const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("release builder parses in Windows PowerShell 5", () => {
  const script = path.join(root, "scripts", "build-release.ps1");
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-Tag",
    "bobo-v0.0.0-compat-test"
  ], { cwd: root, encoding: "utf8" });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;

  assert.match(output, /Git worktree must be clean|Cannot find Git tag|not a git repository/);
  assert.doesNotMatch(output, /ParserError|Unexpected token|terminator/);
});

test("release builder normalizes Windows ZIP entry separators", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "build-release.ps1"), "utf8");

  assert.ok(source.includes("Copy-Item -LiteralPath $sourceArchive -Destination $pendingArchive"));
  assert.ok(!source.includes("[IO.Compression.ZipFile]::CreateFromDirectory("));
  assert.ok(source.includes("$pnpmLockPath = Join-Path $stageDirectory 'pnpm-lock.yaml'"));
});
