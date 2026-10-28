const assert = require("assert");
const fs = require("fs");
const test = require("node:test");
const vm = require("vm");

function loadApp() {
  const calls = [];
  const messages = [];
  const element = () => ({
    innerHTML: "",
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    appendChild() {},
    remove() {},
  });
  const context = {
    console,
    Blob: class {},
    URL: { createObjectURL() { return "blob:test"; } },
    FileReader: class {
      readAsDataURL() {
        this.result = "data:image/png;base64,aGVsbG8=";
        this.onload();
      }
    },
    confirm() { return false; },
    fetch: async (pathname, options = {}) => {
      calls.push({ pathname, options });
      return { ok: true, json: async () => pathname === "/api/bootstrap" ? context.bootstrap : { ok: true } };
    },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    document: {
      body: { appendChild(node) { messages.push(node.textContent); } },
      createElement: element,
      getElementById: element,
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    window: { open() {}, location: {}, prompt() { return ""; } },
    setTimeout() {},
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync("public/app.js", "utf8"), context, { filename: "public/app.js" });
  context.calls = calls;
  context.messages = messages;
  return context;
}

function deliveryData() {
  return {
    orders: [
      { id: "waiting-nb", orderNo: "P-1", productName: "宁波件", region: "浙江省宁波市北仑区", deliveryAddress: "长江路 1 号" },
      { id: "waiting-hz", orderNo: "P-2", productName: "杭州件", region: "浙江省杭州市", deliveryAddress: "文一路 2 号" },
      { id: "waiting-no-address", orderNo: "P-0", productName: "缺地址件", region: "", deliveryAddress: "" },
      { id: "active", orderNo: "P-3", productName: "配送件", region: "浙江省宁波市", deliveryAddress: "中山路 3 号" },
      { id: "done", orderNo: "P-4", productName: "已送达件", region: "浙江省宁波市", deliveryAddress: "环城路 4 号" },
    ],
    deliveries: [
      { id: "d-1", orderId: "waiting-nb", status: "waiting", driverId: "", addressSnapshot: { region: "浙江省宁波市北仑区", deliveryAddress: "长江路 1 号" } },
      { id: "d-2", orderId: "waiting-hz", status: "waiting", driverId: "", addressSnapshot: { region: "浙江省杭州市", deliveryAddress: "文一路 2 号" } },
      { id: "d-0", orderId: "waiting-no-address", status: "waiting", driverId: "", addressSnapshot: { region: "", deliveryAddress: "" } },
      { id: "d-3", orderId: "active", status: "delivering", driverId: "driver-1", addressSnapshot: { region: "浙江省宁波市", deliveryAddress: "中山路 3 号" } },
      { id: "d-4", orderId: "done", status: "delivered", driverId: "driver-1", proofAttachmentIds: ["proof-1"], deliveredAt: "2026-09-22T08:00:00.000Z" },
    ],
    users: [{ id: "driver-1", name: "司机1" }],
    attachments: [{ id: "proof-1", url: "/uploads/proof.png" }],
    permissions: {},
  };
}

test("纯司机网页可筛选并勾选待配送订单，同时处理自己的配送中订单", () => {
  const app = loadApp();
  const data = deliveryData();
  vm.runInContext('state.user = { id: "driver-1", role: "driver", roles: ["driver"] }; state.deliveryRegion = "北仑";', app);

  const html = app.deliveriesPage(data);

  assert.match(html, /id="deliveryRegion"/);
  assert.match(html, /data-delivery-select="waiting-nb"/);
  assert.doesNotMatch(html, /data-delivery-select="waiting-hz"/);
  assert.doesNotMatch(html, /data-delivery-select="waiting-no-address"/);
  assert.match(html, /data-start-delivery-trip/);
  assert.match(html, /id="deliveryPhotos_active"[^>]*multiple/);
  assert.match(html, /id="deliveryNote_active"/);
  assert.match(html, /data-complete-delivery="active"/);
  assert.match(html, /data-release-delivery="active"/);
  assert.match(html, /已送达记录/);
  assert.match(html, /照片1/);
});

test("管理员配送管理页面保持原来的总览表格", () => {
  const app = loadApp();
  vm.runInContext('state.user = { id: "manager", role: "manager", roles: ["manager"] };', app);

  const html = app.deliveriesPage(deliveryData());

  assert.match(html, /<th>司机<\/th>/);
  assert.match(html, /<th>送达凭证<\/th>/);
  assert.doesNotMatch(html, /data-delivery-select/);
});

test("缺少地区或详细地址的订单不能进入司机可领取列表", () => {
  const app = loadApp();
  vm.runInContext('state.user = { id: "driver-1", role: "driver", roles: ["driver"] };', app);

  const html = app.deliveriesPage(deliveryData());

  assert.doesNotMatch(html, /data-delivery-select="waiting-no-address"/);
  assert.match(html, /data-delivery-select="waiting-nb"/);
});

test("网页司机开始配送时提交所选订单并刷新数据", async () => {
  const app = loadApp();
  const data = deliveryData();
  app.bootstrap = data;
  vm.runInContext('state.user = { id: "driver-1", role: "driver", roles: ["driver"] }; state.data = bootstrap;', app);

  await app.startDriverDeliveryTrip(["waiting-nb", "waiting-hz"]);

  assert.strictEqual(app.calls[0].pathname, "/api/delivery-trips/start");
  assert.deepStrictEqual(JSON.parse(app.calls[0].options.body), { orderIds: ["waiting-nb", "waiting-hz"] });
  assert.strictEqual(app.calls[1].pathname, "/api/bootstrap");
  assert.ok(app.messages.includes("已开始配送 2 个订单"));
});

test("网页司机确认送达时必须上传照片并提交备注", async () => {
  const app = loadApp();
  const data = deliveryData();
  app.bootstrap = data;
  vm.runInContext('state.user = { id: "driver-1", role: "driver", roles: ["driver"] }; state.data = bootstrap;', app);

  await app.completeDriverDelivery("active", [], "");
  assert.strictEqual(app.calls.length, 0);
  assert.ok(app.messages.includes("请上传 1 至 3 张送达照片"));

  await app.completeDriverDelivery("active", [{ name: "proof.png" }], "客户已签收");
  assert.strictEqual(app.calls[0].pathname, "/api/deliveries/complete");
  assert.deepStrictEqual(JSON.parse(app.calls[0].options.body), {
    orderId: "active",
    photos: [{ name: "proof.png", dataUrl: "data:image/png;base64,aGVsbG8=" }],
    note: "客户已签收",
  });
  assert.strictEqual(app.calls[1].pathname, "/api/bootstrap");
  assert.ok(app.messages.includes("送达信息已提交"));
});
