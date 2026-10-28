const STORAGE_KEY = "tvViewerToken";
const EXPIRY_MARGIN_MS = 60 * 1000;

function getCachedTvViewerToken(now = Date.now()) {
  const cached = wx.getStorageSync(STORAGE_KEY);
  if (!cached?.token || Number(cached.expiresAt || 0) <= now + EXPIRY_MARGIN_MS) return "";
  return cached.token;
}

function saveTvViewerToken(data, now = Date.now()) {
  const token = String(data?.token || "");
  const expiresInSeconds = Number(data?.expiresInSeconds || 0);
  if (!token || expiresInSeconds <= 0) return "";
  wx.setStorageSync(STORAGE_KEY, { token, expiresAt: now + expiresInSeconds * 1000 });
  return token;
}

async function prepareTvViewerToken(request) {
  const cached = getCachedTvViewerToken();
  if (cached) return cached;
  return saveTvViewerToken(await request("/api/tv-viewer-token"));
}

module.exports = { getCachedTvViewerToken, prepareTvViewerToken };
