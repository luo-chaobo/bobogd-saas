const config = require("../../utils/config");

function safeDecode(value) {
  try {
    return decodeURIComponent(value || "");
  } catch {
    return value || "";
  }
}

function safeFileName(value) {
  return String(value || "drawing.dwg").replace(/[\\/:*?"<>|]/g, "_").trim() || "drawing.dwg";
}

function validDrawingUrl(value) {
  const baseUrl = config.apiBaseUrl.replace(/\/$/, "");
  const prefix = `${baseUrl}/uploads/drawings/`;
  const cleanUrl = String(value || "").split("?")[0].toLowerCase();
  return String(value || "").startsWith(prefix) && (cleanUrl.endsWith(".dwg") || cleanUrl.endsWith(".dxf"));
}

Page({
  data: {
    url: "",
    name: "",
    status: "preparing",
    progress: 0,
    tempFilePath: "",
    error: ""
  },
  onLoad(options) {
    const url = safeDecode(options.url);
    const name = safeFileName(safeDecode(options.name));
    if (!validDrawingUrl(url)) {
      this.setData({ status: "error", error: "下载地址无效" });
      return;
    }
    this.setData({ url, name });
    this.downloadFile();
  },
  downloadFile() {
    if (!this.data.url) return;
    this.setData({ status: "downloading", progress: 0, tempFilePath: "", error: "" });
    const task = wx.downloadFile({
      url: this.data.url,
      success: (result) => {
        if (result.statusCode !== 200 || !result.tempFilePath) {
          this.setData({ status: "error", error: `下载失败（HTTP ${result.statusCode || 0}）` });
          return;
        }
        this.setData({ status: "success", progress: 100, tempFilePath: result.tempFilePath });
      },
      fail: (error) => {
        this.setData({ status: "error", error: error.errMsg || "下载失败，请检查网络后重试" });
      }
    });
    if (task && typeof task.onProgressUpdate === "function") {
      task.onProgressUpdate((result) => this.setData({ progress: Number(result.progress || 0) }));
    }
  },
  shareFile() {
    if (!this.data.tempFilePath) return;
    if (typeof wx.shareFileMessage !== "function") {
      wx.showModal({ title: "无法转发", content: "当前微信版本不支持文件转发，请升级微信后重试。", showCancel: false });
      return;
    }
    wx.shareFileMessage({
      filePath: this.data.tempFilePath,
      fileName: this.data.name,
      fail: (error) => wx.showToast({ title: error.errMsg || "转发失败", icon: "none" })
    });
  },
  openLocalFile() {
    if (!this.data.tempFilePath) return;
    wx.openDocument({
      filePath: this.data.tempFilePath,
      showMenu: true,
      fail: () => wx.showModal({
        title: "微信无法直接打开",
        content: "DWG/DXF 不是微信正式支持的文档格式，请使用“转发文件”发送到支持 CAD 的应用中打开。",
        showCancel: false
      })
    });
  }
});
