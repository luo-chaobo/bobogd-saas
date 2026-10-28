const config = require("./config");
const { canAccessApiPath, requiredFeatureForPath } = require("./feature-contract");

function getUser() {
  return wx.getStorageSync("work_user");
}

function getSessionToken() {
  return wx.getStorageSync("work_session") || "";
}

function getCompanySlug() {
  return wx.getStorageSync("work_company_slug") || "future-machinery";
}

function setUser(user) {
  if (!user) return;
  wx.setStorageSync("work_user", user);
  const app = getApp();
  if (app && app.globalData) app.globalData.user = user;
}

function setAccountContext(account) {
  if (!account || !Array.isArray(account.featureModules)) return;
  wx.setStorageSync("work_feature_modules", account.featureModules);
  wx.setStorageSync("work_feature_catalog", Array.isArray(account.featureCatalog) ? account.featureCatalog : []);
  const app = getApp();
  if (app && app.globalData) {
    app.globalData.featureModules = account.featureModules;
    app.globalData.featureCatalog = Array.isArray(account.featureCatalog) ? account.featureCatalog : [];
  }
}

function getFeatureModules() {
  const modules = wx.getStorageSync("work_feature_modules");
  return Array.isArray(modules) ? modules : [];
}

function getFeatureCatalog() {
  const catalog = wx.getStorageSync("work_feature_catalog");
  return Array.isArray(catalog) ? catalog : [];
}

function assertFeatureEnabled(path) {
  const catalog = getFeatureCatalog();
  const feature = requiredFeatureForPath(catalog, path);
  if (feature && !canAccessApiPath(catalog, getFeatureModules(), path)) {
    throw new Error(`当前套餐未开放${feature.name || "此功能"}`);
  }
}

function logout() {
  request("/api/logout", { method: "POST" }).catch(() => {});
  wx.removeStorageSync("work_user");
  wx.removeStorageSync("work_session");
  wx.removeStorageSync("work_tenant_id");
  wx.removeStorageSync("work_feature_modules");
  wx.removeStorageSync("work_feature_catalog");
  wx.removeStorageSync("pending_report_route_id");
  wx.removeStorageSync("pending_report_route_token");
  const app = getApp();
  if (app && app.globalData) {
    app.globalData.user = null;
    app.globalData.featureModules = [];
    app.globalData.featureCatalog = [];
  }
}

function request(path, options = {}) {
  const user = getUser();
  try {
    assertFeatureEnabled(path);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${config.apiBaseUrl}${path}`,
      method: options.method || "GET",
      data: options.data || {},
      header: {
        "content-type": "application/json",
        "x-user-id": user ? user.id : "",
        "x-company-slug": options.companySlug || getCompanySlug(),
        ...(getSessionToken() && path !== "/api/login" ? { Authorization: `Bearer ${getSessionToken()}` } : {}),
        ...(options.header || {})
      },
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data);
        else reject(new Error((res.data && res.data.error) || "请求失败"));
      },
      fail(err) {
        reject(new Error(err.errMsg || "网络异常"));
      }
    });
  });
}

function login(phone, password, companySlug) {
  return request("/api/login", { method: "POST", data: { phone, password }, companySlug });
}

async function refreshUser() {
  const data = await request("/api/me");
  setUser(data.user);
  setAccountContext(data);
  return data.user;
}

module.exports = {
  request,
  login,
  getUser,
  getSessionToken,
  getCompanySlug,
  getFeatureModules,
  getFeatureCatalog,
  setAccountContext,
  setUser,
  refreshUser,
  logout
};