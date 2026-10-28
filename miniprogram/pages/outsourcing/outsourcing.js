const api = require("../../utils/api");
const config = require("../../utils/config");

const STATUS_NAMES = {
  sent: "待接受",
  accepted: "已接受",
  in_progress: "生产中",
  blocked: "有阻塞",
  submitted: "待验收",
  accepted_by_owner: "已验收",
  revision_requested: "返修中",
  cancelled: "已取消"
};

const PARTNER_ACTIONS = {
  sent: [["接受任务", "accepted", "tasks"], ["拒绝任务", "cancelled", "tasks"]],
  accepted: [["报告阻塞", "blocked", "exceptions"], ["提交验收", "submitted", "delivery"]],
  in_progress: [["报告阻塞", "blocked", "exceptions"], ["提交验收", "submitted", "delivery"]],
  blocked: [["恢复生产", "in_progress", "progress"], ["提交验收", "submitted", "delivery"]],
  revision_requested: [["继续生产", "in_progress", "progress"], ["提交验收", "submitted", "delivery"]]
};

const OWNER_ACTIONS = {
  sent: [["取消委派", "cancelled", "tasks"]],
  submitted: [["验收完成", "accepted_by_owner", "quality"], ["要求返修", "revision_requested", "quality"]]
};

function taskActions(task) {
  const choices = task.side === "partner" ? PARTNER_ACTIONS[task.status] || [] : OWNER_ACTIONS[task.status] || [];
  const routes = Array.isArray(task.production?.routes) ? task.production.routes : [];
  const allProcessesComplete = routes.length > 0 && routes.every((route) => Number(route.planQty) > 0
    && Number(route.completedQty || 0) >= Number(route.planQty) && route.status === "已完成");
  return choices.filter(([, , permission]) => task.side === "owner"
    || (task.relationActive && (task.permissions || []).includes(permission)))
    .map(([label, status]) => ({
      label,
      status,
      danger: status === "cancelled",
      disabled: status === "submitted" && !allProcessesComplete
    }));
}

function formatReportTime(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return value || "时间未知";
  const date = new Date(timestamp + 8 * 60 * 60 * 1000);
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function mapTask(task) {
  const production = task.production || {};
  const permissions = Array.isArray(task.permissions) ? task.permissions : [];
  const side = task.side || "partner";
  return {
    ...task,
    expanded: false,
    isOutsource: true,
    sideLabel: side === "owner" ? "我方委派" : "收到委派",
    companyName: side === "owner" ? task.partnerName : task.ownerName,
    statusName: STATUS_NAMES[task.status] || task.status || "未知状态",
    productName: task.snapshot?.productName || "外协生产任务",
    orderNo: task.snapshot?.orderNo || production.workNo || task.taskId,
    quantityText: `${task.snapshot?.quantity || production.planQty || 0} ${task.snapshot?.quantityUnit || "件"}`,
    productionValueText: Number(task.productionValueFen || 0) > 0 ? `¥${(Number(task.productionValueFen) / 100).toFixed(2)}` : "历史委派未录入",
    dueDateText: String(task.dueDate || production.dueDate || "未设置").slice(0, 10),
    processes: Array.isArray(production.routes) ? production.routes.map((route) => ({
      ...route,
      statusText: route.status || "未排期",
      dateText: route.plannedStartDate ? String(route.plannedStartDate).slice(0, 10) : "未排期",
      progressText: `${Number(route.completedQty || 0)}/${Number(route.planQty || task.snapshot?.quantity || 0)}`
    })) : [],
    canShowProgress: side === "owner" || permissions.includes("progress"),
    canShowExceptions: side === "owner" || permissions.includes("exceptions"),
    exceptions: Array.isArray(production.exceptions) ? production.exceptions : [],
    reports: Array.isArray(production.reports) ? production.reports.filter((report) => report.images?.length).map((report) => ({
      ...report,
      createdAtText: formatReportTime(report.createdAt),
      images: report.images.map((url) => ({ url, localPath: "", loadFailed: false }))
    })) : [],
    actions: taskActions(task)
  };
}

Page({
  data: { tasks: [], loading: false, error: "", enabled: true, isOwner: false, previewImagePath: "" },
  async onShow() {
    if (!api.getUser()) {
      wx.redirectTo({ url: "/pages/login/login" });
      return;
    }
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar) {
      tabBar.setData({ selected: 4 });
      tabBar.syncUser();
    }
    try {
      const user = await api.refreshUser();
      if (!api.getFeatureModules().includes("outsourcing")) {
        this.setData({ tasks: [], enabled: false, error: "当前套餐未开放委派任务" });
        return;
      }
      if (!["owner", "manager", "admin"].some((role) => (user.roles || []).includes(role) || user.role === role)) {
        this.setData({ tasks: [], enabled: false, error: "当前岗位无权查看委派任务" });
        return;
      }
      this.setData({ enabled: true });
      await this.loadTasks();
    } catch (error) {
      this.setData({ error: error.message || "账号信息更新失败" });
    }
  },
  async onPullDownRefresh() {
    await this.loadTasks();
    wx.stopPullDownRefresh();
  },
  async loadTasks() {
    this.setData({ loading: true, error: "" });
    try {
      const data = await api.request("/api/outsourcing");
      this.setData({ tasks: (data.tasks || []).map(mapTask), enabled: true, isOwner: data.isOwner === true });
    } catch (error) {
      this.setData({ tasks: [], error: error.message || "委派任务加载失败" });
    } finally {
      this.setData({ loading: false });
    }
  },
  async updateStatus(event) {
    const task = this.data.tasks.find((item) => item.taskId === event.currentTarget.dataset.id);
    const status = event.currentTarget.dataset.status;
    const action = task?.actions.find((item) => item.status === status);
    if (!task || !action) return;
    const message = status === "accepted" ? "接受后可在“我的任务”中安排生产和报工。确认接受吗？"
      : status === "cancelled" && task.side === "partner" ? "拒绝后此委派任务将标记为已取消，确认拒绝吗？"
        : `${action.label}：${task.productName}（${task.quantityText}）？`;
    wx.showModal({
      title: action.label,
      content: message,
      success: async (result) => {
        if (!result.confirm) return;
        try {
          await api.request(`/api/outsourcing/tasks/${encodeURIComponent(task.taskId)}/status`, {
            method: "POST",
            data: { status }
          });
          wx.showToast({ title: action.label + "成功", icon: "success" });
          await this.loadTasks();
        } catch (error) {
          wx.showToast({ title: error.message || "操作失败", icon: "none" });
        }
      }
    });
  },
  async toggleTask(event) {
    const taskId = event.currentTarget.dataset.id;
    const task = this.data.tasks.find((item) => item.taskId === taskId);
    const expanded = !task?.expanded;
    this.setData({
      tasks: this.data.tasks.map((item) => item.taskId === taskId ? { ...item, expanded } : item)
    });
    if (expanded && task?.reports.some((report) => report.images.some((image) => !image.localPath))) {
      const reports = await Promise.all(task.reports.map(async (report) => ({
        ...report,
        images: await Promise.all(report.images.map(async (image) => {
          if (image.localPath) return image;
          const localPath = await this.downloadReportImage(image.url);
          return { ...image, localPath, loadFailed: !localPath };
        }))
      })));
      this.setData({ tasks: this.data.tasks.map((item) => item.taskId === taskId ? { ...item, reports } : item) });
    }
  },
  downloadReportImage(url) {
    return new Promise((resolve) => {
      wx.downloadFile({
        url: `${config.apiBaseUrl}${url}`,
        header: { Authorization: `Bearer ${api.getSessionToken()}`, "x-company-slug": api.getCompanySlug() },
        success(result) { resolve(result.statusCode === 200 ? result.tempFilePath : ""); },
        fail() { resolve(""); }
      });
    });
  },
  previewReportImage(event) {
    const path = event.currentTarget.dataset.path;
    if (path) this.setData({ previewImagePath: path });
  },
  closePhotoPreview() {
    this.setData({ previewImagePath: "" });
  },
  keepPhotoPreview() {
  },
});
