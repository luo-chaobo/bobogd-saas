const api = require("../../utils/api");

function fileToDataUrl(file) {
  const extension = String(file.tempFilePath || "").split(".").pop().toLowerCase();
  const contentType = extension === "png" ? "image/png" : extension === "gif" ? "image/gif" : "image/jpeg";
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: file.tempFilePath,
      encoding: "base64",
      success: (result) => resolve({ name: file.tempFilePath.split("/").pop() || "送达照片.jpg", dataUrl: `data:${contentType};base64,${result.data}` }),
      fail: reject
    });
  });
}

Page({
  data: {
    region: "",
    available: [],
    active: [],
    selectedIds: [],
    loading: false
  },
  async onShow() {
    const user = api.getUser();
    if (!user) {
      wx.redirectTo({ url: "/pages/login/login" });
      return;
    }
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) {
      tabBar.setData({ selected: 3 });
      tabBar.syncUser();
    }
    await this.load();
  },
  onRegion(event) {
    this.setData({ region: event.detail.value });
  },
  async search() {
    await this.load();
  },
  logout() {
    wx.showModal({
      title: "退出登录",
      content: "确定退出当前司机账号吗？",
      success: (result) => {
        if (!result.confirm) return;
        api.logout();
        getApp().globalData.user = null;
        wx.reLaunch({ url: "/pages/login/login" });
      }
    });
  },
  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const query = this.data.region ? `?region=${encodeURIComponent(this.data.region)}` : "";
      const [availableData, myData] = await Promise.all([
        api.request(`/api/deliveries/available${query}`),
        api.request("/api/deliveries/my")
      ]);
      this.setData({
        available: availableData.orders || [],
        active: (myData.deliveries || []).filter((item) => item.status === "delivering"),
        selectedIds: []
      });
    } catch (err) {
      wx.showToast({ title: err.message || "配送任务加载失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },
  selectOrders(event) {
    this.setData({ selectedIds: event.detail.value || [] });
  },
  callCustomer(event) {
    const phone = String(event.currentTarget.dataset.phone || "").trim();
    if (!/^[+\d][\d\s()-]{4,20}$/.test(phone)) {
      wx.showToast({ title: "暂无有效联系电话", icon: "none" });
      return;
    }
    wx.makePhoneCall({ phoneNumber: phone.replace(/[\s()-]/g, "") });
  },
  copyAddress(event) {
    const address = String(event.currentTarget.dataset.address || "").trim();
    if (!address) {
      wx.showToast({ title: "订单没有配送地址", icon: "none" });
      return;
    }
    wx.setClipboardData({ data: address, success: () => wx.showToast({ title: "地址已复制", icon: "success" }) });
  },
  async startTrip() {
    if (!this.data.selectedIds.length) {
      wx.showToast({ title: "请先勾选订单", icon: "none" });
      return;
    }
    try {
      await api.request("/api/delivery-trips/start", { method: "POST", data: { orderIds: this.data.selectedIds } });
      wx.showToast({ title: "已开始配送", icon: "success" });
      await this.load();
    } catch (err) {
      wx.showToast({ title: err.message, icon: "none" });
      await this.load();
    }
  },
  complete(event) {
    const orderId = event.currentTarget.dataset.id;
    wx.chooseMedia({
      count: 3,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      success: async (result) => {
        try {
          const photos = await Promise.all((result.tempFiles || []).map(fileToDataUrl));
          if (!photos.length) return;
          wx.showModal({
            title: "确认送达",
            content: "可填写送达备注",
            editable: true,
            placeholderText: "例如：客户本人签收",
            success: async (modal) => {
              if (!modal.confirm) return;
              try {
                await api.request("/api/deliveries/complete", { method: "POST", data: { orderId, photos, note: modal.content || "" } });
                wx.showToast({ title: "送达已确认", icon: "success" });
                await this.load();
              } catch (err) {
                wx.showToast({ title: err.message, icon: "none" });
              }
            }
          });
        } catch (err) {
          wx.showToast({ title: "照片读取失败", icon: "none" });
        }
      }
    });
  },
  async release(event) {
    try {
      await api.request("/api/deliveries/release", { method: "POST", data: { orderId: event.currentTarget.dataset.id } });
      wx.showToast({ title: "已退回待配送", icon: "success" });
      await this.load();
    } catch (err) {
      wx.showToast({ title: err.message, icon: "none" });
    }
  }
});
