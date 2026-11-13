const api = require("../../utils/api");

const processRoleMap = {
  设计: "design_worker",
  激光: "laser_worker",
  切管: "laser_worker",
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

function quantityUnit(value) {
  return value === "套" ? "套" : "件";
}

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
    quantityUnit: "件",
    isQuality: false,
    exceptionSubmitting: false,
    canSubmitException: false,
    imagePath: "",
    imageName: "",
    dispositionOptions: ["无需处理", "返工", "让步接收", "报废"],
    issueRouteNames: [],
    reworkRouteNames: [],
    issueRoutes: [],
    reworkRoutes: [],
    issueRouteName: "",
    reworkRouteName: "",
    form: {
      completedQty: 1,
      submittedQty: 1,
      inspectedQty: 1,
      goodQty: 0,
      badQty: 0,
      reworkQty: 0,
      disposition: "无需处理",
      issueRouteId: "",
      reworkTargetRouteId: "",
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
        
        // 👇👇👇 新增放行逻辑：如果是“待开始”，不要踢回首页，放行给 load() 去弹出一键开工 👇👇👇
        if (data.permissionError === "请先点击开始生产") {
          this.setData({ routeId: data.routeId });
          this.load();
          return;
        }
        // 👆👆👆 新增结束 👆👆👆

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
      const workOrder = data.workOrders.find((w) => w.id === route.workOrderId) || {};
      const unit = quantityUnit(workOrder.order?.quantityUnit);
      const isOutsource = workOrder.source === "saas-outsourcing";
      if (route.status === "待开始" && (route.processName === "质检" || isOutsource)) {
        wx.showModal({
          title: `${route.processName || "该工序"}尚未开始`,
          content: [
            `工单：${workOrder.workNo || ""}`,
            `产品：${workOrder.productName || ""}`,
            `工序：${route.processName || ""}`,
            `计划：${route.planQty || 0} ${unit}`,
            "是否现在开始生产？"
          ].join("\n"),
          confirmText: "开始生产",
          cancelText: "取消",
          success: (modalRes) => {
            if (modalRes.confirm) {
              this.startProduction(route.id);
            } else {
              wx.switchTab({ url: "/pages/tasks/tasks" });
            }
          }
        });
        return; 
      }
      const statusError = reportStatusError(route);
      if (statusError && (isOutsource || route.processName === "质检" || !["待开始", "暂停"].includes(route.status))) {
        showStatusError(statusError);
        return;
      }
      const remain = Math.max(1, Number(route.planQty || 0) - Number(route.completedQty || 0));
      const isQuality = route.processName === "质检";
      const inspectionAvailableQty = Number(route.inspectionAvailableQty || 0);
      if (isQuality && inspectionAvailableQty < 1) {
        wx.showModal({
          title: "暂无可送检数量",
          content: Number(route.pendingReworkQty || 0) > 0 ? `还有 ${route.pendingReworkQty} ${unit}等待返工完成` : "请等待前一道生产工序完成后再质检",
          showCancel: false,
          success: () => wx.navigateBack()
        });
        return;
      }
      const reworkRoutes = data.routes
        .filter((item) => item.workOrderId === route.workOrderId && item.processName !== "质检" && item.routeType !== "rework")
        .sort((a, b) => a.sequence - b.sequence);
      this.setData({
        task: { ...route, workOrder },
        quantityUnit: unit,
        isQuality,
        showRegularSubmit: isQuality || route.status === "进行中",
        canStartProduction: !isQuality && !isOutsource && ["待开始", "暂停"].includes(route.status),
        canSubmitException: Boolean(String(this.data.form.exceptionDescription || "").trim()),
        issueRoutes: reworkRoutes,
        reworkRoutes,
        issueRouteNames: reworkRoutes.map((item) => `${item.sequence}. ${item.processName}`),
        reworkRouteNames: reworkRoutes.map((item) => `${item.sequence}. ${item.processName}`),
        issueRouteName: reworkRoutes.length ? `${reworkRoutes[0].sequence}. ${reworkRoutes[0].processName}` : "",
        reworkRouteName: reworkRoutes.length ? `${reworkRoutes[0].sequence}. ${reworkRoutes[0].processName}` : "",
        form: {
          ...this.data.form,
          completedQty: remain,
          submittedQty: isQuality ? inspectionAvailableQty : remain,
          inspectedQty: isQuality ? inspectionAvailableQty : remain,
          goodQty: isQuality ? inspectionAvailableQty : 0,
          badQty: 0,
          reworkQty: 0,
          disposition: "无需处理",
          issueRouteId: reworkRoutes.length ? reworkRoutes[0].id : "",
          reworkTargetRouteId: reworkRoutes.length ? reworkRoutes[0].id : ""
        }
      });
    } catch (err) {
      wx.showToast({ title: err.message || "报工任务加载失败", icon: "none" });
    }
  },
  onInput(e) {
    const key = e.currentTarget.dataset.key;
    const updates = { [`form.${key}`]: e.detail.value };
    if (key === "exceptionDescription") updates.canSubmitException = Boolean(String(e.detail.value || "").trim());
    if (this.data.isQuality && key === "submittedQty") {
      updates["form.inspectedQty"] = e.detail.value;
      updates["form.goodQty"] = e.detail.value;
      updates["form.badQty"] = 0;
    }
    this.setData(updates);
  },
  onDispositionChange(e) {
    const disposition = this.data.dispositionOptions[Number(e.detail.value)] || "无需处理";
    this.setData({ "form.disposition": disposition });
  },
  onIssueRouteChange(e) {
    const route = this.data.issueRoutes[Number(e.detail.value)];
    this.setData({
      "form.issueRouteId": route ? route.id : "",
      issueRouteName: route ? `${route.sequence}. ${route.processName}` : ""
    });
  },
  onReworkRouteChange(e) {
    const route = this.data.reworkRoutes[Number(e.detail.value)];
    this.setData({
      "form.reworkTargetRouteId": route ? route.id : "",
      reworkRouteName: route ? `${route.sequence}. ${route.processName}` : ""
    });
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
  async startProduction(routeId) {
    wx.showLoading({ title: "正在开始生产", mask: true });
    try {
      await api.request("/api/route-status", {
        method: "POST",
        data: { routeId, status: "进行中" }
      });
      wx.showToast({ title: "已开始生产", icon: "success" });
      wx.switchTab({ url: "/pages/tasks/tasks" });
    } catch (err) {
      wx.showToast({ title: err.message || "操作失败", icon: "none" });
    } finally {
      wx.hideLoading();
    }
  },
  async submitException() {
    const description = String(this.data.form.exceptionDescription || "").trim();
    if (!description || this.data.exceptionSubmitting || this.data.isQuality || this.data.task?.workOrder?.source === "saas-outsourcing") return;
    this.setData({ exceptionSubmitting: true });
    try {
      const images = await this.uploadSelectedImage();
      await api.request("/api/route-exceptions", { method: "POST", data: { routeId: this.data.routeId, description, images } });
      this.setData({ "form.exceptionDescription": "", canSubmitException: false, imagePath: "", imageName: "" });
      wx.showToast({ title: "异常已上报", icon: "success" });
    } catch (err) {
      wx.showToast({ title: err.message || "上报失败", icon: "none" });
    } finally {
      this.setData({ exceptionSubmitting: false });
    }
  },
  startCurrentProduction() {
    this.startProduction(this.data.routeId);
  },
  async submit() {
    if (this.data.exceptionSubmitting) return;
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
        if (submittedQty > Number(this.data.task.inspectionAvailableQty || 0)) throw new Error(`本次最多可送检 ${this.data.task.inspectionAvailableQty} ${this.data.quantityUnit}`);
        if (inspectedQty !== submittedQty) throw new Error("检验数量必须等于送检数量");
        if (goodQty + badQty !== inspectedQty) throw new Error("检验数量必须等于合格数量与不合格数量之和");
        if (badQty > 0 && form.disposition === "无需处理") throw new Error("存在不合格品时请选择处理方式");
        if (badQty > 0 && !form.issueRouteId) throw new Error("请选择问题工序");
        if (badQty > 0 && !String(form.exceptionDescription || "").trim()) throw new Error("存在不合格品时请填写问题说明");
        if (form.disposition === "返工" && !form.reworkTargetRouteId) throw new Error("请选择返工工序");
      } else if (Number(form.completedQty) < 1) {
        throw new Error("完成数量必须大于 0");
      }
      const images = await this.uploadSelectedImage();
      await api.request("/api/report", { method: "POST", data: { routeId: this.data.routeId, ...this.data.form, images } });
      wx.showToast({ 
        title: "报工成功", icon: "success", duration: 1500
         });
              setTimeout(() =>
         {
                const
         pages = getCurrentPages();
                if (pages.length > 1
        ) {
                  wx.navigateBack(); 
                } 
        else
         {
                  wx.switchTab({ 
        url: "/pages/tasks/tasks"
         }); 
                }
              }, 
        1500
        );
    } catch (err) {
      wx.showToast({ title: err.message, icon: "none" });
    }
  }
});
