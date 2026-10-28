const api = require("../../utils/api");
const processStyle = require("../../utils/process-style");
const tvToken = require("../../utils/tv-token");

function tagClass(status) {
  if (status === "已完成") return "tag-ok";
  if (status === "异常" || status === "返工") return "tag-danger";
  if (status === "生产中" || status === "进行中") return "tag-warn";
  return "";
}

Page({
  data: {
    summary: { active: 0, finished: 0, overdue: 0, exceptions: 0 },
    workOrders: [],
    canViewTv: false,
    viewBoardCustomer: false,
    completionPeriod: "today",
    completionPeriodIndex: 0,
    completionPeriods: [
      { value: "today", label: "当天" },
      { value: "3d", label: "三天" },
      { value: "7d", label: "一星期" },
      { value: "30d", label: "一个月" }
    ]
  },
  onShow() {
    if (!api.getUser()) {
      wx.redirectTo({ url: "/pages/login/login" });
      return;
    }
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) {
      tabBar.setData({ selected: 1 });
      tabBar.syncUser();
    }
    this.load();
    this.prepareTvViewerToken();
  },
  async prepareTvViewerToken() {
    try {
      await tvToken.prepareTvViewerToken(api.request);
    } catch {}
  },
  async load() {
    try {
      const [data, completion, account] = await Promise.all([
        api.request("/api/dashboard"),
        api.request(`/api/mobile/completions?period=${this.data.completionPeriod}`),
        api.request("/api/me")
      ]);
      const activeWorkOrders = data.workOrders.filter((item) => item.status !== "已完成");
      const workOrders = activeWorkOrders.map((w) => {
        const routes = (w.routes || []).map((route) => {
          const isCurrent = route.processName === w.currentProcess && route.status !== "已完成";
          const isDone = route.status === "已完成";
          return {
            ...route,
            color: processStyle.colorOf(route.processName),
            segmentClass: `${isDone ? "done" : "todo"} ${isCurrent ? "current" : ""}`
          };
        });
        return { ...w, routes, quantityUnit: w.order?.quantityUnit === "套" ? "套" : "件", tagClass: tagClass(w.status) };
      });
      this.setData({
        workOrders,
        canViewTv: Boolean(account.permissions?.viewTv),
        viewBoardCustomer: Boolean(account.permissions?.viewBoardCustomer ?? account.user?.viewBoardCustomer ?? data.permissions?.viewBoardCustomer),
        summary: {
          active: data.active,
          finished: completion.count,
          overdue: data.overdue,
          exceptions: data.openExceptions
        }
      });
    } catch (err) {
      wx.showToast({ title: err.message, icon: "none" });
    }
  },
  openTv() {
    wx.navigateTo({ url: "/pages/tv/tv" });
  },
  async selectCompletionPeriod(e) {
    const index = Number(e.detail.value);
    const period = this.data.completionPeriods[index]?.value;
    if (!period || period === this.data.completionPeriod) return;
    this.setData({ completionPeriod: period, completionPeriodIndex: index });
    try {
      const completion = await api.request(`/api/mobile/completions?period=${period}`);
      this.setData({ "summary.finished": completion.count });
    } catch (err) {
      wx.showToast({ title: err.message, icon: "none" });
    }
  },
  openCompletionDetails() {
    wx.navigateTo({ url: `/pages/completion-details/completion-details?period=${this.data.completionPeriod}` });
  }
});