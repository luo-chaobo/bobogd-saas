const api = require("../../utils/api");
const config = require("../../utils/config");

function absoluteUrl(url) {
  if (!url || /^https?:\/\//i.test(url)) return url || "";
  return `${config.apiBaseUrl.replace(/\/$/, "")}${url}`;
}

function fileType(drawing) {
  return String(drawing.fileType || drawing.name?.split(".").pop() || "").toLowerCase();
}

function isImage(type) {
  return ["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(type);
}

Page({
  data: { routeId: "", drawings: [], imageUrls: [] },
  onLoad(options) {
    this.setData({ routeId: decodeURIComponent(options.routeId || "") });
    this.load();
  },
  async load() {
    try {
      const data = await api.request(`/api/routes/${encodeURIComponent(this.data.routeId)}/drawings`);
      const drawings = (data.items || []).map((drawing) => {
        const type = fileType(drawing);
        return {
          ...drawing,
          fileType: type,
          url: absoluteUrl(drawing.url),
          previewUrl: absoluteUrl(drawing.previewUrl),
          previewPageUrl: absoluteUrl(drawing.previewPageUrl),
          typeLabel: isImage(type) ? "图片" : type.toUpperCase() || "文件",
          actionLabel: isImage(type) ? "点击预览，可左右滑动" : type === "pdf" ? "点击打开 PDF" : ["dwg", "dxf"].includes(type) ? "进入 CAD 预览" : "暂不支持预览"
        };
      });
      this.setData({ drawings, imageUrls: drawings.filter((item) => isImage(item.fileType)).map((item) => item.url) });
    } catch (error) {
      wx.showToast({ title: error.message || "图纸加载失败", icon: "none" });
    }
  },
  openDrawing(event) {
    const drawing = this.data.drawings[Number(event.currentTarget.dataset.index)];
    if (!drawing) return;
    if (isImage(drawing.fileType)) {
      wx.previewImage({ current: drawing.url, urls: this.data.imageUrls });
      return;
    }
    if (drawing.fileType === "pdf") {
      wx.downloadFile({
        url: drawing.url,
        success: (result) => wx.openDocument({ filePath: result.tempFilePath, fileType: "pdf", showMenu: true }),
        fail: () => wx.showToast({ title: "PDF 下载失败", icon: "none" })
      });
      return;
    }
    if (["dwg", "dxf"].includes(drawing.fileType)) {
      this.openCad(drawing);
      return;
    }
    wx.showModal({ title: "无法预览", content: "该文件格式暂不支持预览。", showCancel: false });
  },
  async openCad(drawing) {
    try {
      const result = await api.request("/api/drawings/preview", { method: "POST", data: { drawingId: drawing.id } });
      const previewUrl = absoluteUrl(result.previewPageUrl || result.previewUrl);
      if (!previewUrl) throw new Error(result.previewError || "CAD 预览生成失败");
      wx.navigateTo({
        url: `/pages/file-preview/file-preview?url=${encodeURIComponent(previewUrl)}&downloadUrl=${encodeURIComponent(drawing.url)}&fileType=${encodeURIComponent(drawing.fileType)}&name=${encodeURIComponent(drawing.name || "CAD 图纸")}`
      });
    } catch (error) {
      wx.showModal({ title: "无法预览", content: error.message || "CAD 预览生成失败", showCancel: false });
    }
  }
});
