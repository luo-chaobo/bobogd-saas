const assert = require("assert");
const fs = require("fs");
const test = require("node:test");
const vm = require("vm");

function loadApp() {
  const element = () => ({
    innerHTML: "",
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    appendChild() {},
  });
  const context = {
    console,
    Blob: class {},
    URL: { createObjectURL() { return "blob:test"; } },
    FileReader: class {},
    confirm() { return false; },
    fetch() { return Promise.reject(new Error("not used")); },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    document: {
      body: { appendChild() {} },
      createElement: element,
      getElementById: element,
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    window: { open() {}, location: {} },
    setTimeout() {},
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync("public/app.js", "utf8"), context, { filename: "public/app.js" });
  return context;
}

test("订单工单保持一级菜单样式并与平台单子菜单同步待创建角标", () => {
  const app = loadApp();
  vm.runInContext('state.view = "ordersPlatform"', app);
  const html = app.ordersNavigation({
    workOrders: [
      { creationStatus: "pending", order: { orderOrigin: "platform", sourceChannel: "website" } },
      { creationStatus: "confirmed", order: { orderOrigin: "platform", sourceChannel: "order_platform" } },
    ],
  });

  assert.match(html, /<div class="nav-parent"><span>订单工单<\/span>\s*<b class="nav-count">1<\/b><\/div>/);
  assert.match(html, /class="nav-submenu"/);
  assert.match(html, /data-view="ordersAll"[^>]*>全部订单<\/button>/);
  assert.match(html, /data-view="ordersFactory"[^>]*>工厂单<\/button>/);
  assert.match(html, /data-view="ordersPlatform"[^>]*>平台单\s*<b class="nav-count">1<\/b>/);
  assert.strictEqual((html.match(/class="nav-count"/g) || []).length, 2);
});

test("平台单确认界面保留工厂单字段并预填客户配送地址", () => {
  const app = loadApp();
  vm.runInContext('state.confirmingPlatformOrderId = "order-1"', app);
  const html = app.platformConfirmModal({
    processes: [{ id: "process-1", name: "激光", active: true }],
    orders: [{
      id: "order-1", orderOrigin: "platform", orderNo: "PLATFORM-1", productName: "", externalDescription: "描述",
      externalRegion: "浙江省 宁波市", externalDeliveryAddress: "滨海路 1 号", region: "", deliveryAddress: "",
      quantity: 5, quantityUnit: "套", dueDate: "2026-10-01", priority: "普通", note: "客户备注",
    }],
    workOrders: [{ orderId: "order-1", creationStatus: "pending" }],
  });

  assert.match(html, /id="confirmDrawingNo"/);
  assert.match(html, /id="confirmQuantityUnit"[\s\S]*?value="套" selected/);
  assert.match(html, /id="confirmWeightKg"/);
  assert.match(html, /id="confirmDrawingFiles" type="file"/);
  assert.match(html, /id="confirmRegion" value="浙江省 宁波市"/);
  assert.match(html, /id="confirmDeliveryAddress" value="滨海路 1 号"/);
});

test("大屏来源按钮位于左侧标题组且公司名称保持独立居中", () => {
  const script = fs.readFileSync("public/tv.js", "utf8");
  const styles = fs.readFileSync("public/tv.css", "utf8");

  assert.match(script, /<div class="title">[\s\S]*?\$\{sourceTabs\(\)\}[\s\S]*?<\/div>\s*<div class="company-name">\$\{esc\(data\.companyName \|\| "宁波未来机械"\)\}<\/div>/);
  assert.doesNotMatch(script, /company-name">宁波未来机械\$\{sourceTabs\(\)\}/);
  assert.match(styles, /\.title\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/s);
  assert.match(styles, /\.tv-source-tabs\s*\{[^}]*margin:\s*0;/s);
});
