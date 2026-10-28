const api = require("../../utils/api");

function landingPage(user, featureModules = []) {
  const roles = [...new Set([...(Array.isArray(user?.roles) ? user.roles : []), user?.role].filter(Boolean))];
  if (roles.length === 1 && roles[0] === "driver" && featureModules.includes("orders")) return "/pages/deliveries/deliveries";
  if (featureModules.includes("dispatch")) return "/pages/tasks/tasks";
  if (featureModules.includes("outsourcing")) return "/pages/outsourcing/outsourcing";
  if (featureModules.includes("dashboard")) return "/pages/board/board";
  return "/pages/login/login";
}

Page({
  data: {
    companySlug: "future-machinery",
    phone: "",
    password: ""
  },
  onLoad() {
    const savedLogin = wx.getStorageSync("last_login_credentials") || {};
    this.setData({
      phone: savedLogin.phone || "",
      companySlug: wx.getStorageSync("work_company_slug") || "future-machinery",
      password: ""
    });
  },
  onShow() {
    const user = api.getUser();
    if (user) {
      wx.switchTab({ url: landingPage(user, api.getFeatureModules()) });
    }
  },
  onPhone(e) {
    this.setData({ phone: e.detail.value });
  },
  onCompanySlug(e) {
    this.setData({ companySlug: String(e.detail.value || "").trim().toLowerCase() });
  },
  onPassword(e) {
    this.setData({ password: e.detail.value });
  },
  async submit() {
    try {
      const phone = String(this.data.phone || "").trim();
      const password = String(this.data.password || "").trim();
      if (!phone || !password) {
        wx.showToast({ title: "请填写手机号和密码", icon: "none" });
        return;
      }
      const companySlug = String(this.data.companySlug || "").trim().toLowerCase();
      const data = await api.login(phone, password, companySlug);
      api.setAccountContext(data);
      wx.setStorageSync("work_company_slug", companySlug);
      if (data.sessionToken) wx.setStorageSync("work_session", data.sessionToken);
      if (data.user.tenantId) wx.setStorageSync("work_tenant_id", data.user.tenantId);
      wx.setStorageSync("work_user", data.user);
      wx.setStorageSync("last_login_credentials", { phone });
      getApp().globalData.user = data.user;
      const pendingRouteId = wx.getStorageSync("pending_report_route_id");
      if (pendingRouteId) {
        wx.removeStorageSync("pending_report_route_id");
        wx.redirectTo({ url: `/pages/report/report?routeId=${pendingRouteId}` });
        return;
      }
      const pendingRouteToken = wx.getStorageSync("pending_report_route_token");
      if (pendingRouteToken) {
        wx.removeStorageSync("pending_report_route_token");
        wx.redirectTo({ url: `/pages/report/report?routeToken=${encodeURIComponent(pendingRouteToken)}` });
        return;
      }
      wx.switchTab({ url: landingPage(data.user, data.featureModules || []) });
    } catch (err) {
      wx.showToast({ title: err.message, icon: "none" });
    }
  }
});