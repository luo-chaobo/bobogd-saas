App({
  globalData: {
    user: null,
    featureModules: [],
    featureCatalog: []
  },
  onLaunch() {
    const user = wx.getStorageSync("work_user");
    if (user) this.globalData.user = user;
    const featureModules = wx.getStorageSync("work_feature_modules");
    const featureCatalog = wx.getStorageSync("work_feature_catalog");
    this.globalData.featureModules = Array.isArray(featureModules) ? featureModules : [];
    this.globalData.featureCatalog = Array.isArray(featureCatalog) ? featureCatalog : [];
  }
});