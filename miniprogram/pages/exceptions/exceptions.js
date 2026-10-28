const api = require("../../utils/api");
const config = require("../../utils/config");

function fileUrl(url) {
  const text = String(url || "");
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  return `${config.apiBaseUrl.replace(/\/$/, "")}${text.startsWith("/") ? text : `/${text}`}`;
}

Page({
  data: {
    exceptions: [],
    customers: [],
    customerNames: ["全部客户"],
    processNames: ["全部工序"],
    statusOptions: ["全部状态", "待处理", "已解决"],
    selectedCustomerName: "全部客户",
    filters: {
      customerId: "",
      processName: "",
      status: "",
      from: "",
      to: ""
    },
    canResolve: false,
    solutions: {}
  },
  onShow() {
    const user = api.getUser();
    if (!user) {
      wx.redirectTo({ url: "/pages/login/login" });
      return;
    }
    const roles = [...new Set([...(Array.isArray(user.roles) ? user.roles : []), user.role].filter(Boolean))];
    if (!roles.some((role) => ["owner", "manager", "office", "admin", "quality"].includes(role))) {
      wx.switchTab({ url: "/pages/board/board" });
      return;
    }
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) {
      tabBar.setData({ selected: 2 });
      tabBar.syncUser();
    }
    this.load();
  },
  async load() {
    try {
      const user = api.getUser();
      const roles = [...new Set([...(Array.isArray(user?.roles) ? user.roles : []), user?.role].filter(Boolean))];
      const data = await api.request("/api/bootstrap");
      const query = Object.keys(this.data.filters)
        .filter((key) => this.data.filters[key])
        .map((key) => `${key}=${encodeURIComponent(this.data.filters[key])}`)
        .join("&");
      const history = await api.request(`/api/history/exceptions${query ? `?${query}` : ""}`);
      const processNames = ["全部工序"].concat([...new Set(data.routes.map((item) => item.processName).filter(Boolean))]);
      const exceptions = history.items.map((e) => {
        const reporter = data.users.find((u) => u.id === e.reporterId);
        return {
          ...e,
          images: (Array.isArray(e.images) ? e.images : []).map(fileUrl).filter(Boolean),
          reporterName: reporter ? reporter.name : "",
          createdAtText: new Date(e.createdAt).toLocaleString()
        };
      });
      this.setData({
        exceptions,
        customers: data.customers,
        customerNames: ["全部客户"].concat(data.customers.map((item) => item.name)),
        processNames,
        canResolve: ["manager", "quality", "admin", "owner"].some((role) => roles.includes(role))
      });
    } catch (err) {
      wx.showToast({ title: err.message, icon: "none" });
    }
  },
  onSolution(e) {
    this.setData({ [`solutions.${e.currentTarget.dataset.id}`]: e.detail.value });
  },
  onCustomerChange(e) {
    const index = Number(e.detail.value);
    const customer = this.data.customers[index - 1];
    this.setData({
      "filters.customerId": customer ? customer.id : "",
      selectedCustomerName: customer ? customer.name : "全部客户"
    });
    this.load();
  },
  onProcessChange(e) {
    const processName = this.data.processNames[Number(e.detail.value)] || "";
    this.setData({ "filters.processName": processName === "全部工序" ? "" : processName });
    this.load();
  },
  onStatusChange(e) {
    const status = this.data.statusOptions[Number(e.detail.value)] || "";
    this.setData({ "filters.status": status === "全部状态" ? "" : status });
    this.load();
  },
  onDateChange(e) {
    this.setData({ [`filters.${e.currentTarget.dataset.key}`]: e.detail.value });
    this.load();
  },
  previewImage(e) {
    const current = e.currentTarget.dataset.url;
    if (!current) return;
    wx.previewImage({ current, urls: [current] });
  },
  async resolve(e) {
    try {
      const id = e.currentTarget.dataset.id;
      await api.request("/api/exceptions/resolve", {
        method: "POST",
        data: { id, solution: this.data.solutions[id] || "", status: "已解决" }
      });
      wx.showToast({ title: "已处理" });
      this.load();
    } catch (err) {
      wx.showToast({ title: err.message, icon: "none" });
    }
  }
});