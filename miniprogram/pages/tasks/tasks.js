const api = require("../../utils/api");
const config = require("../../utils/config");
const roles = require("../../utils/roles");

function absoluteUrl(url) {
  if (!url || /^https?:\/\//i.test(url)) return url || "";
  return `${config.apiBaseUrl.replace(/\/$/, "")}${url}`;
}

function isImage(fileType) {
  return ["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(String(fileType || "").toLowerCase());
}

function isCad(fileType) {
  return ["dwg", "dxf"].includes(String(fileType || "").toLowerCase());
}

function tagClass(status) {
  if (status === "已完成") return "tag-ok";
  if (status === "异常" || status === "返工") return "tag-danger";
  if (status === "进行中" || status === "暂停") return "tag-warn";
  return "";
}

function quantityUnit(value) {
  return value === "套" ? "套" : "件";
}

function planRange(startValue, endValue) {
  const format = (value) => {
    const match = String(value || "").match(/^\d{4}[-/]?(\d{2})[-/]?(\d{2})/);
    return match ? `${match[1]}.${match[2]}` : "";
  };
  const start = format(startValue);
  const end = format(endValue);
  return start && end ? `${start}-${end}` : "未排期";
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value || "");
  } catch (err) {
    return value || "";
  }
}

function extractRouteToken(result) {
  const raw = String(result || "").trim();
  if (!raw) return "";

  const match = raw.match(/[?&#](?:routeToken|token|scene)=([^&#]+)/i);
  if (match) return safeDecode(match[1]).trim();

  const direct = raw.match(/^(?:routeToken|token|scene)=([^&#]+)$/i);
  if (direct) return safeDecode(direct[1]).trim();

  const tokenOnly = safeDecode(raw).trim();
  if (/^rt_[a-zA-Z0-9_-]+$/.test(tokenOnly)) return tokenOnly;

  return "";
}

Page({
  data: {
    tasks: [],
    pendingStatus: {},
    userRoleName: "",
    userName: ""
  },
  async onShow() {
    let user = api.getUser();
    if (!user) {
      wx.redirectTo({ url: "/pages/login/login" });
      return;
    }
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) {
      tabBar.setData({ selected: 0 });
      tabBar.syncUser();
    }
    try {
      user = await api.refreshUser();
    } catch (err) {
      wx.showToast({ title: err.message || "账号信息更新失败", icon: "none" });
      return;
    }
    this.setData({
      userRoleName: roles.roleNames(user),
      userName: user.name || user.phone || ""
    });
    this.load();
  },
  async load() {
    try {
      const data = await api.request("/api/my-tasks");
      const tasks = data.tasks
        .map((r) => {
          const workOrder = r.workOrder || {};
          const drawings = (workOrder.drawings || []).map((drawing, index) => ({
            ...drawing,
            index: index + 1,
            url: absoluteUrl(drawing.url),
            previewUrl: absoluteUrl(drawing.previewUrl),
          }));
          const completedQty = Number(r.completedQty || 0);
          const planQty = Number(r.planQty || 1);
          const progress = Math.round((completedQty / planQty) * 100);
          return {
            ...r,
            quantityUnit: quantityUnit(workOrder.order?.quantityUnit),
            workOrder: { ...workOrder, drawings },
            drawings,
            progress,
            remain: Math.max(0, Number(r.planQty || 0) - completedQty),
            isQuality: r.processName === "质检",
            isOutsource: workOrder.source === "saas-outsourcing",
            canInspect: r.processName !== "质检" || Number(r.inspectionAvailableQty || 0) > 0,
            tagClass: tagClass(r.status),
            planRange: planRange(r.plannedStartDate, r.plannedEndDate || r.targetFinishTime)
          };
        });
      this.setData({ tasks });
    } catch (err) {
      wx.showToast({ title: err.message, icon: "none" });
    }
  },
  logout() {
    wx.showModal({
      title: "退出登录",
      content: "确定退出当前账号吗？",
      success(res) {
        if (!res.confirm) return;
        api.logout();
        getApp().globalData.user = null;
        wx.reLaunch({ url: "/pages/login/login" });
      }
    });
  },
  previewDrawing(event) {
    const routeId = event.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/drawings/drawings?routeId=${encodeURIComponent(routeId)}` });
  },
  openPreviewPage(previewUrl, drawing) {
    wx.navigateTo({
      url: `/pages/file-preview/file-preview?url=${encodeURIComponent(previewUrl)}&downloadUrl=${encodeURIComponent(drawing.url)}&fileType=${encodeURIComponent(drawing.fileType || "")}&name=${encodeURIComponent(drawing.name || "图纸预览")}`
    });
  },
  openPdf(url) {
    wx.showLoading({ title: "正在打开" });
    wx.downloadFile({
      url,
      success: (result) => {
        if (result.statusCode !== 200) {
          wx.showToast({ title: "PDF 下载失败", icon: "none" });
          return;
        }
        wx.openDocument({ filePath: result.tempFilePath, fileType: "pdf", showMenu: true });
      },
      fail: () => wx.showToast({ title: "PDF 下载失败", icon: "none" }),
      complete: () => wx.hideLoading(),
    });
  },
  goReport(e) {
    const route = this.data.tasks.find((item) => item.id === e.currentTarget.dataset.id);
    const canReportExceptionOnly = route && !route.isQuality && !route.isOutsource && ["待开始", "暂停"].includes(route.status);
    if (!route || (route.status !== "进行中" && !canReportExceptionOnly)) {
      wx.showToast({ title: "请先开始生产再报工", icon: "none" });
      return;
    }
    if (route.isQuality && !route.canInspect) {
      wx.showToast({ title: "暂无可送检数量", icon: "none" });
      return;
    }
    wx.navigateTo({ url: `/pages/report/report?routeId=${route.id}` });
  },
  scanReport() {
    wx.scanCode({
      onlyFromCamera: false,
      success: (res) => {
        // 1. 获取扫出来的原始字符串
        let scanResult = res.result || res.path || "";
        console.log("扫码原始结果:", scanResult);

        let routeToken = scanResult; // 默认值

        // 2. 终极智能提取（正则匹配法）
        // 自动在任意网址或参数中，抓取类似 rt_xxxx 或 qt_xxxx 的核心 Token，无视末尾的 / 或 #
        const match = scanResult.match(/[a-zA-Z]+_[a-zA-Z0-9]+/);
        if (match) {
          routeToken = match[0];
        }

        console.log("最终解析出的 Token:", routeToken);

        // 3. 校验并执行
        if (!routeToken) {
          wx.showToast({ title: "二维码无效", icon: "none" });
          return;
        }

        // 把干净的 Token 传给处理函数
        this.handleScannedRoute(routeToken);
      },
      fail(err) {
        const message = String((err && err.errMsg) || "");
        if (!message.includes("cancel")) {
          wx.showToast({ title: "扫码失败，请重新扫描", icon: "none" });
        }
      }
    });
  },
  async handleScannedRoute(routeToken) {
    wx.showLoading({ title: "正在识别工序", mask: true });
    try {
      const data = await api.request(`/api/qr/resolve?routeToken=${encodeURIComponent(routeToken)}`);
      const route = data.route || {};
      const permissionAllowed = data.permissionAllowed !== false;

      if (!permissionAllowed) {
        wx.showModal({
          title: "无法报工",
          content: data.processPermissionError || data.permissionError || "当前账号无权操作此工序",
          showCancel: false
        });
        return;
      }

      if (route.processName !== "质检" && route.workOrder?.source !== "saas-outsourcing" && ["待开始", "暂停"].includes(route.status)) {
        this.openScannedReport(data.routeId || route.id);
        return;
      }

      if (route.status === "待开始") {
        const workOrder = route.workOrder || data.workOrder || {};
        const workNo = workOrder.workNo || data.workOrder?.workNo || "";
        const productName = workOrder.productName || data.workOrder?.productName || "";
        const planQty = route.planQty || workOrder.planQty || "";
        const unit = quantityUnit(workOrder.order?.quantityUnit || data.workOrder?.order?.quantityUnit);
        wx.showModal({
          title: `${route.processName || "该工序"}尚未开始`,
          content: [
            workNo ? `工单：${workNo}` : "",
            productName ? `产品：${productName}` : "",
            route.processName ? `工序：${route.processName}` : "",
            planQty ? `计划：${planQty} ${unit}` : "",
            "是否现在开始生产？"
          ].filter(Boolean).join("\n"),
          confirmText: "开始生产",
          success: (result) => {
            if (result.confirm) this.startScannedRoute(data.routeId || route.id);
          }
        });
        return;
      }

      if (route.status === "暂停") {
        wx.showModal({
          title: "工序已暂停",
          content: "请先在我的任务中点击“继续”，再扫码报工。",
          showCancel: false
        });
        return;
      }

      if (route.status === "已完成") {
        wx.showModal({ title: "工序已完成", content: "该工序无需再次报工。", showCancel: false });
        return;
      }

      if (route.status !== "进行中") {
        wx.showModal({
          title: "暂不能报工",
          content: data.statusError || data.permissionError || `当前状态为${route.status || "未知"}`,
          showCancel: false
        });
        return;
      }

      if (!data.canReport) {
        wx.showModal({ title: "无法报工", content: data.permissionError || "当前工序暂不能报工", showCancel: false });
        return;
      }

      this.openScannedReport(data.routeId || route.id);
    } catch (err) {
      wx.showModal({
        title: "二维码识别失败",
        content: err.message || "请确认二维码来自当前工单系统后重试。",
        showCancel: false
      });
    } finally {
      wx.hideLoading();
    }
  },
  async startScannedRoute(routeId) {
    wx.showLoading({ title: "正在开始生产", mask: true });
    try {
      const result = await api.request("/api/route-status", {
        method: "POST",
        data: { routeId, status: "进行中" }
      });
      this.updateTaskStatus(result.route);
      wx.showToast({ title: "已开始生产", icon: "success" });
    } catch (err) {
      wx.showModal({ title: "无法开始工序", content: err.message || "请稍后重试", showCancel: false });
    } finally {
      wx.hideLoading();
    }
  },
  openScannedReport(routeId) {
    if (!routeId) {
      wx.showToast({ title: "二维码缺少工序信息", icon: "none" });
      return;
    }
    wx.navigateTo({
      url: `/pages/report/report?routeId=${encodeURIComponent(routeId)}`,
      fail(err) {
        wx.showModal({
          title: "无法打开报工页面",
          content: (err && err.errMsg) || "请清除小程序缓存后重试。",
          showCancel: false
        });
      }
    });
  },
  async setStatus(e) {
    const routeId = e.currentTarget.dataset.id;
    const status = e.currentTarget.dataset.status;
    if (this.data.pendingStatus[routeId]) return;
    this.setData({ [`pendingStatus.${routeId}`]: true });
    try {
      const result = await api.request("/api/route-status", {
        method: "POST",
        data: { routeId, status }
      });
      this.updateTaskStatus(result.route);
      wx.showToast({ title: status === "暂停" ? "已暂停" : "已开始" });
    } catch (err) {
      wx.showToast({ title: err.message, icon: "none" });
    } finally {
      this.setData({ [`pendingStatus.${routeId}`]: false });
    }
  },
  updateTaskStatus(route) {
    if (!route) return;
    const index = this.data.tasks.findIndex((task) => task.id === route.id);
    if (index < 0) return;
    this.setData({
      [`tasks[${index}].status`]: route.status,
      [`tasks[${index}].startedAt`]: route.startedAt || "",
      [`tasks[${index}].pausedAt`]: route.pausedAt || "",
      [`tasks[${index}].tagClass`]: tagClass(route.status)
    });
  }
});
