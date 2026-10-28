const api = require("../../utils/api");
const config = require("../../utils/config");
const tvToken = require("../../utils/tv-token");

function withMobileFlag(url, viewerToken = "") {
  if (!url) return url;
  const parts = [];
  if (!url.includes("mobile=1")) parts.push("mobile=1");
  if (!url.includes("compact=1")) parts.push("compact=1");
  if (viewerToken) parts.push(`viewerToken=${encodeURIComponent(viewerToken)}`);
  if (!parts.length) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${parts.join("&")}`;
}

Page({
  data: {
    canView: false,
    loading: true,
    error: "",
    tvUrl: withMobileFlag(config.tvUrl)
  },
  async onLoad() {
    const user = api.getUser();
    if (!user) {
      wx.redirectTo({ url: "/pages/login/login" });
      return;
    }
    try {
      const cached = tvToken.getCachedTvViewerToken();
      const token = cached || await tvToken.prepareTvViewerToken(api.request);
      this.setData({ canView: true, loading: false, tvUrl: withMobileFlag(config.tvUrl, token) });
    } catch (err) {
      this.setData({ loading: false, error: err.message || "生产看板加载失败" });
    }
  }
});