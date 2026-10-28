"use strict";

const crypto = require("crypto");

function hashPassword(password) {
  const value = String(password || "");
  if (value.length < 8) throw new Error("密码至少需要 8 位");
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(value, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyPassword(password, stored) {
  const value = String(password || "");
  const text = String(stored || "");
  const [scheme, saltHex, hashHex, extra] = text.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex || extra) return value === text;
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = crypto.scryptSync(value, salt, expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
