const api = require("../../utils/api");

const processRoleMap = {
  设计: "design_worker",
  激光: "laser_worker",
  折弯: "bend_worker",
  压铆: "rivet_worker",
  攻丝: "tap_worker",
  焊接: "weld_worker",
  机加: "machining_worker",
  打磨: "polish_worker",
  喷塑: "powder_worker",
  装配: "assembly_worker",
  质检: "quality"
};

function canReportProcess(user, route) {
  if (!user || !route) return "请先登录";
  if (route.assignedTo && route.assignedTo !== user.id) return "该工序已指定给其他员工";
  const userRoles = [...new Set([...(Array.isArray(user.roles) ? user.roles : []), user.role].filter(Boolean))];
  if (userRoles.some((role) => ["owner", "manager", "office", "admin"].includes(role))) return "";
  const requiredRole = route.assignedRole || processRoleMap[route.processName];
  if (requiredRole && userRoles.includes(requiredRole)) return "";
  if (!requiredRole && userRoles.includes("worker")) return "";
  return "当前岗位不能操作此工序";
}

function reportStatusError(route) {
  if (!route) return "工序不存在";
  if (route.status === "待开始") return "请先点击开始生产";
  if (route.status === "暂停") return "工序已暂停，请先点击继续";
  if (route.status === "已完成") return "该工序已完成，无需再报工";
  if (route.status !== "进行中") return `当前状态为${route.status}，暂不能报工`;
  return "";
}

function showStatusError(message) {
  wx.showModal({
    title: "暂不能报工",
    content: message,
    showCancel: false,
    success: () => {
      const pages = getCurrentPages();
      if (pages.length > 1) wx.navigateBack();
      else wx.switchTab({ url: "/pages/tasks/tasks" });
    }
  });
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value || "");
  } catch {
    return value || "";
  }
}

function extractRouteToken(options = {}) {
  const scene = safeDecode(options.scene).trim();
  const q = safeDecode(options.q).trim();
  const direct = safeDecode(options.routeToken || options.token).trim();
  if (direct) return direct;

  const match = q.match(/[?&#](?:routeToken|token|scene)=([^&#]+)/i);
  if (match) return safeDecode(match[1]).trim();

  const sceneMatch = scene.match(/^(?:routeToken|token|scene)=([^&#]+)$/i);
  if (sceneMatch) return safeDecode(sceneMatch[1]).trim();
  if (/^rt_[a-zA-Z0-9_-]+$/.test(scene)) return scene;
  return "";
}

Page({
  data: {
    routeId: "",
    task: null,
    isQuality: false,
    imagePath: "",
    imageName: "",
    dispositionOptions: ["无需处理", "返工", "让步接收", "报废"],
    form: {
      completedQty: 1,
      submittedQty: 1,
      inspectedQty: 1,
      goodQty: 0,
      badQty: 0,
      reworkQty: 0,
      disposition: "无需处理",
      note: "",
      exceptionType: "",
      exceptionDescription: ""
    }
  },
  onLoad(options) {
    const routeToken = extractRouteToken(options);
    if (!api.getUser() && routeToken) {
      wx.setStorageSync("pending_report_route_token", routeToken);
      wx.redirectTo({ url: "/pages/login/login" });
      return;
    }
    if (options.routeId) {
      this.setData({ routeId: options.routeId });
      this.load();
      return;
    }
    if (routeToken) {
      this.resolveQr(routeToken);
      return;
    }
    wx.showToast({ title: "缺少工序参数", icon: "none" });
  },
  async resolveQr(routeToken) {
    try {
      const data = await api.request(`/api/qr/resolve?routeToken=${encodeURIComponent(routeToken)}`);
      if (data.canReport === false) {
        showStatusError(data.permissionError || "当前工种不能报此工序");
        return;
      }
      this.setData({ routeId: data.routeId });
      this.load();
    } catch (err) {
      wx.showToast({ title: err.message, icon: "none" });
    }
  },
  async load() {
    if (!api.getUser()) {
      wx.setStorageSync("pending_report_route_id", this.data.routeId);
      wx.redirectTo({ url: "/pages/login/login" });
      return;
    }
    try {
      // 岗位可能已由主管在后台调整，进入报工页时必须使用服务器最新账号信息。
      const user = await api.refreshUser();
      const data = await api.request("/api/bootstrap");
      const route = data.routes.find((r) => r.id === this.data.routeId);
      if (!route) {
        wx.showToast({ title: "工序不存在", icon: "none" });
        return;
      }
      const permissionError = canReportProcess(user, route);
      if (permissionError) {
        wx.showToast({ title: permissionError, icon: "none", duration: 2500 });
        return;
      }
      const statusError = reportStatusError(route);
      if (statusError) {
        showStatusError(statusError);
        return;
      }
      const workOrder = data.workOrders.find((w) => w.id === route.workOrderId) || {};
      const remain = Math.max(1, Number(route.planQty || 0) - Number(route.completedQty || 0));
      const isQuality = route.processName === "质检";
      this.setData({
        task: { ...route, workOrder },
        isQuality,
        form: {
          ...this.data.form,
          completedQty: remain,
          submittedQty: remain,
          inspectedQty: remain,
          goodQty: isQuality ? remain : 0,
          badQty: 0,
          reworkQty: 0,
          disposition: "无需处理"
        }
      });
    } catch (err) {
      wx.showToast({ title: err.message || "报工任务加载失败", icon: "none" });
    }
  },
  onInput(e) {
    this.setData({ [`form.${e.currentTarget.dataset.key}`]: e.detail.value });
  },
  onDispositionChange(e) {
    const disposition = this.data.dispositionOptions[Number(e.detail.value)] || "无需处理";
    this.setData({ "form.disposition": disposition });
  },
  async chooseImage() {
    try {
      const res = await wx.chooseMedia({ count: 1, mediaType: ["image"], sourceType: ["album", "camera"] });
      const file = res.tempFiles[0];
      this.setData({ imagePath: file.tempFilePath, imageName: file.tempFilePath.split("/").pop() });
    } catch (err) {
      wx.showToast({ title: "未选择图片", icon: "none" });
    }
  },
  uploadSelectedImage() {
    if (!this.data.imagePath) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const fs = wx.getFileSystemManager();
      fs.readFile({
        filePath: this.data.imagePath,
        encoding: "base64",
        success: async (res) => {
          try {
            const uploaded = await api.request("/api/upload", {
              method: "POST",
              data: { dataUrl: `data:image/jpeg;base64,${res.data}`, name: this.data.imageName || "现场图片.jpg" }
            });
            resolve([uploaded.url]);
          } catch (err) {
            reject(err);
          }
        },
        fail: () => reject(new Error("图片读取失败"))
      });
    });
  },
  async submit() {
    try {
      if (!this.data.task || this.data.task.status !== "进行中") {
        wx.showToast({ title: "只有进行中的工序才能报工", icon: "none" });
        return;
      }
      const form = this.data.form;
      if (this.data.isQuality) {
        const submittedQty = Number(form.submittedQty);
        const inspectedQty = Number(form.inspectedQty);
        const goodQty = Number(form.goodQty);
        const badQty = Number(form.badQty);
        if (submittedQty < 1 || inspectedQty < 1) throw new Error("送检数量和检验数量必须大于 0");
        if (inspectedQty > submittedQty) throw new Error("检验数量不能超过送检数量");
        if (goodQty + badQty !== inspectedQty) throw new Error("检验数量必须等于合格数量与不合格数量之和");
        if (badQty > 0 && form.disposition === "无需处理") throw new Error("存在不合格品时请选择处理方式");
      } else if (Number(form.completedQty) < 1) {
        throw new Error("完成数量必须大于 0");
      }
      const images = await this.uploadSelectedImage();
      await api.request("/api/report", { method: "POST", data: { routeId: this.data.routeId, ...this.data.form, images } });
      wx.showToast({ title: "报工成功" });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (err) {
      wx.showToast({ title: err.message, icon: "none" });
    }
  }
});
