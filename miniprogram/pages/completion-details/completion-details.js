const api = require("../../utils/api");

const PERIODS = [
  { value: "today", label: "当天" },
  { value: "3d", label: "三天" },
  { value: "7d", label: "一星期" },
  { value: "30d", label: "一个月" }
];

const STATUS_CLASS = {
  已完成: "tag-ok",
  已发货: "tag-shipped",
  已开票: "tag-invoiced"
};

function confirmFulfillment(label, enabled) {
  return new Promise((resolve) => {
    wx.showModal({
      title: "确认操作",
      content: enabled ? `确认将该订单标记为${label}吗？` : `确认取消该订单的${label}状态吗？`,
      confirmText: "确认",
      cancelText: "取消",
      success: (result) => resolve(result.confirm === true),
      fail: () => resolve(false)
    });
  });
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (number) => String(number).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

Page({
  data: {
    period: "today",
    periods: PERIODS,
    from: "",
    to: "",
    count: 0,
    items: [],
    loading: false,
    canManageOrderFulfillment: false
  },
  onLoad(options) {
    const period = PERIODS.some((item) => item.value === options.period) ? options.period : "today";
    this.setData({ period });
  },
  onShow() {
    const user = api.getUser();
    if (!user) {
      wx.redirectTo({ url: "/pages/login/login" });
      return;
    }
    if (!user.viewBoardCustomer) {
      wx.switchTab({ url: "/pages/board/board" });
      return;
    }
    this.load();
  },
  async load() {
    this.setData({ loading: true });
    try {
      const data = await api.request(`/api/mobile/completions?period=${this.data.period}&includeItems=1`);
      this.setData({
        from: data.from,
        to: data.to,
        count: data.count,
        canManageOrderFulfillment: Boolean(data.canManageOrderFulfillment),
        items: data.items.map((item) => ({
          ...item,
          statusClass: STATUS_CLASS[item.status] || "tag-ok",
          completedAtText: formatDateTime(item.completedAt),
          shipped: Boolean(item.shippedAt),
          invoiced: Boolean(item.invoicedAt),
          submitting: false
        }))
      });
    } catch (err) {
      wx.showToast({ title: err.message, icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },
  selectPeriod(e) {
    const period = e.currentTarget.dataset.period;
    if (!PERIODS.some((item) => item.value === period) || period === this.data.period) return;
    this.setData({ period });
    this.load();
  },
  async updateFulfillment(e) {
    const orderId = e.currentTarget.dataset.orderId;
    const type = e.currentTarget.dataset.type;
    const index = this.data.items.findIndex((item) => item.orderId === orderId);
    const item = this.data.items[index];
    if (!item || item.submitting || !item.canUpdateFulfillment || !this.data.canManageOrderFulfillment) return;
    const enabled = e.detail.value === true;
    const field = type === "shipped" ? "shipped" : "invoiced";
    const label = type === "shipped" ? "已发货" : "已开票";
    const originalShipped = item.shipped;
    const originalInvoiced = item.invoiced;
    const originalValue = item[field];
    this.setData({ [`items[${index}].${field}`]: enabled });
    const confirmed = await confirmFulfillment(label, enabled);
    if (!confirmed) {
      this.setData({ [`items[${index}].${field}`]: originalValue });
      return;
    }
    const shipped = type === "shipped" ? enabled : item.shipped;
    const invoiced = type === "invoiced" ? enabled : item.invoiced;
    this.setData({ [`items[${index}].submitting`]: true });
    try {
      const result = await api.request("/api/orders/fulfillment", { method: "POST", data: { orderId, shipped, invoiced } });
      wx.showToast({ title: result.platformSync === "pending" ? "已保存，平台同步中" : "状态已更新", icon: result.platformSync === "pending" ? "none" : "success" });
      await this.load();
    } catch (err) {
      this.setData({ [`items[${index}].submitting`]: false, [`items[${index}].shipped`]: originalShipped, [`items[${index}].invoiced`]: originalInvoiced });
      wx.showToast({ title: err.message, icon: "none" });
    }
  }
});
