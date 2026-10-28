const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const page = fs.readFileSync(path.join(root, "public", "outsourcing.js"), "utf8");
const css = fs.readFileSync(path.join(root, "public", "outsourcing-module.css"), "utf8");

test("partner task projection includes only authorized task drawings", () => {
  assert.match(server, /canViewAttachments\s*=\s*side\s*===\s*"partner"\s*&&\s*permissions\.includes\("attachments"\)/);
  assert.match(server, /drawings:\s*canViewAttachments\s*\?\s*\(db\.drawings\s*\|\|\s*\[\]\)[\s\S]*workOrderId\s*===\s*workOrder\.id/);
  assert.match(server, /drawingId:\s*drawing\.id/);
});

test("delegation task cards provide the standard drawing button and centered preview", () => {
  assert.match(page, /om-drawing-dialog/);
  assert.match(page, /data-drawing-task=/);
  assert.match(page, /dataset\.previewDrawing\s*=/);
  assert.match(page, /showModal\(\)/);
  assert.match(page, /api\("\/api\/drawings\/preview"/);
  assert.match(css, /\.om-drawing-dialog/);
  assert.match(css, /img\.om-drawing-preview[^}]*max-width:\s*min\(100%,\s*900px\)[^}]*max-height:\s*75vh/);
  assert.match(css, /iframe\.om-drawing-preview[^}]*width:\s*100%[^}]*height:\s*100%/);
});
