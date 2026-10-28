"use strict";

const crypto = require("crypto");

function equalText(left, right) {
  const first = Buffer.from(String(left));
  const second = Buffer.from(String(right));
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function signToken(payload, secret) {
  if (!secret) throw new Error("SAAS_SESSION_SECRET 未配置");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyToken(token, secret, expectedAudience, now = Date.now()) {
  if (!secret || typeof token !== "string") return null;
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra) return null;
  const expected = crypto.createHmac("sha256", secret).update(body).digest();
  const supplied = Buffer.from(signature, "base64url");
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.audience !== expectedAudience || Number(payload.expiresAt) <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

function issueUserToken({ tenantId, userId, sessionId, secret, ttlMs = 12 * 60 * 60 * 1000, now = Date.now() }) {
  if (!tenantId || !userId) throw new Error("登录会话缺少公司或用户 ID");
  if (!sessionId) throw new Error("登录会话 ID 不能为空");
  return signToken({ audience: "tenant-user", tenantId, userId, sessionId, expiresAt: now + ttlMs }, secret);
}

function issuePlatformToken({ adminUserId, sessionId, secret, ttlMs = 4 * 60 * 60 * 1000, now = Date.now() }) {
  if (!adminUserId) throw new Error("平台管理员账号不能为空");
  if (!sessionId) throw new Error("平台会话 ID 不能为空");
  return signToken({ audience: "platform-admin", adminUserId, sessionId, expiresAt: now + ttlMs }, secret);
}

function verifyPlatformCredentials(userId, password, config) {
  if (!config.userId || !config.password) return false;
  return equalText(userId, config.userId) && equalText(password, config.password);
}

module.exports = { issuePlatformToken, issueUserToken, signToken, verifyPlatformCredentials, verifyToken };
