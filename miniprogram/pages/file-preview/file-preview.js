function isImage(fileType, url) {
  const type = String(fileType || "").toLowerCase();
  const ext = String(url || "").split("?")[0].split(".").pop().toLowerCase();
  return ["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(type || ext);
}

Page({
  data: { url: "", downloadUrl: "", name: "图纸预览", fileType: "", isImage: false, previewError: "" },
  onLoad(options) {
    const url = decodeURIComponent(options.url || "");
    const downloadUrl = decodeURIComponent(options.downloadUrl || options.url || "");
    const fileType = decodeURIComponent(options.fileType || "");
    if (!url) {
      wx.showToast({ title: "预览地址无效", icon: "none" });
      return;
    }
    this.setData({
      url,
      downloadUrl,
      fileType,
      isImage: isImage(fileType, url),
      name: decodeURIComponent(options.name || "图纸预览"),
      previewError: ""
    });
  },
  onPreviewError(error) {
    const detail = error && error.detail ? error.detail.errMsg : "";
    const message = [
      detail || "图片加载失败",
      "请确认该域名已加入小程序 downloadFile 合法域名，并且图片地址可通过 HTTPS 访问。",
    ].join("；");
    this.setData({ previewError: message });
  },
  confirmDownload() {
    if (!this.data.downloadUrl) return;
    wx.showModal({
      title: "确认下载",
      content: "确定下载当前图纸吗？",
      success: (result) => {
        if (result.confirm) this.downloadFile();
      }
    });
  },
  downloadFile() {
    wx.showLoading({ title: "正在下载" });
    wx.downloadFile({
      url: this.data.downloadUrl,
      success: (result) => {
        if (result.statusCode !== 200) {
          wx.showToast({ title: "下载失败", icon: "none" });
          return;
        }
        wx.saveFile({
          tempFilePath: result.tempFilePath,
          success: () => wx.showToast({ title: "图纸已下载" }),
          fail: () => wx.showToast({ title: "保存失败", icon: "none" }),
        });
      },
      fail: () => wx.showToast({ title: "下载失败", icon: "none" }),
      complete: () => wx.hideLoading(),
    });
  }
});
