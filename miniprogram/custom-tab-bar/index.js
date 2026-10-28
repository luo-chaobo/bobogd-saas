Component({
  data: {
    selected: 0,
    visibleItems: [],
    items: [
      { pagePath: "/pages/tasks/tasks", text: "任务", featureKey: "dispatch" },
      { pagePath: "/pages/board/board", text: "看板", featureKey: "dashboard" },
      { pagePath: "/pages/exceptions/exceptions", text: "异常", featureKey: "quality", primaryOnly: true },
      { pagePath: "/pages/deliveries/deliveries", text: "配送", featureKey: "orders", primaryOnly: true },
      { pagePath: "/pages/outsourcing/outsourcing", text: "委派", featureKey: "outsourcing" }
    ]
  },
  lifetimes: {
    attached() {
      this.syncUser();
    }
  },
  methods: {
    syncUser() {
      const user = wx.getStorageSync("work_user") || {};
      const companySlug = wx.getStorageSync("work_company_slug") || "future-machinery";
      const primaryTenant = companySlug === "future-machinery";
      const featureModules = wx.getStorageSync("work_feature_modules") || [];
      const visibleItems = this.data.items.filter((item) => featureModules.includes(item.featureKey)
        && (!item.primaryOnly || primaryTenant));
      this.setData({
        visibleItems
      });
    },
    switchTab(event) {
      const { path, index } = event.currentTarget.dataset;
      this.setData({ selected: Number(index) });
      wx.switchTab({ url: path });
    }
  }
});
