const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const { spawn } = require("child_process");
const { weappImageType } = require("./lib/weapp-image");
const { normalizeUnitPrice, calculateOrderTotal, createSerialQueue } = require("./lib/order-financials");
const { filterWorkOrderSources, finalOutsourceProcessCompletedAt, isOwnerTaskWithinSupervision } = require("./lib/outsourcing-history");

const RELEASE_MANIFEST_FILE = path.join(__dirname, "release-manifest.json");
const RELEASE_MANIFEST = fs.existsSync(RELEASE_MANIFEST_FILE)
  ? JSON.parse(fs.readFileSync(RELEASE_MANIFEST_FILE, "utf8"))
  : {};
const PACKAGE_FILE = path.join(__dirname, "package.json");
const PACKAGE_VERSION = fs.existsSync(PACKAGE_FILE)
  ? JSON.parse(fs.readFileSync(PACKAGE_FILE, "utf8")).version
  : "0.5.0-saas.12";
const LOCAL_CONFIG_FILE = path.join(__dirname, "config.local.json");
if (fs.existsSync(LOCAL_CONFIG_FILE)) {
  const localConfig = JSON.parse(fs.readFileSync(LOCAL_CONFIG_FILE, "utf8"));
  const localEnvironment = localConfig.serverEnvironment;
  if (localEnvironment && typeof localEnvironment === "object" && !Array.isArray(localEnvironment)) {
    for (const [name, value] of Object.entries(localEnvironment)) {
      if (value === null || value === undefined || String(process.env[name] || "").trim()) continue;
      process.env[name] = String(value).trim();
    }
  }
}

const PORT = process.env.PORT || 3000;
const RELEASE_VERSION = String(RELEASE_MANIFEST.tag || process.env.BOBO_RELEASE_TAG || `bobo-v${PACKAGE_VERSION}`);
const RELEASE_COMMIT = String(RELEASE_MANIFEST.commit || process.env.BOBO_GIT_COMMIT || "working-tree");
const PLATFORM_SOURCE_CHANNELS = new Set(["website", "order_platform", "miniprogram"]);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const UPLOAD_DIR = path.join(PUBLIC, "uploads");
const DRAWING_DIR = path.join(UPLOAD_DIR, "drawings");
const THUMBNAIL_DIR = path.join(UPLOAD_DIR, "thumbnails");
const CAD_PREVIEW_DIR = path.join(UPLOAD_DIR, "previews");
const CAD_PREVIEW_COMMAND = String(process.env.CAD_PREVIEW_COMMAND || "dwg2SVG").trim();
const WEAPP_CODE_CACHE_DIR = path.resolve(
  process.env.WEAPP_CODE_CACHE_DIR || path.join(DATA_DIR, "weapp-code-cache")
);
const QR_BASE_URL = process.env.QR_BASE_URL || `http://localhost:${PORT}`;
const WX_APPID = String(process.env.WX_APPID || "").trim();
const WX_APP_SECRET = String(process.env.WX_APP_SECRET || "").trim();
const WX_CODE_ENV_VERSION = ["develop", "trial", "release"].includes(process.env.WX_CODE_ENV_VERSION)
  ? process.env.WX_CODE_ENV_VERSION
  : "trial";
const WECHAT_API_BASE_URL = String(process.env.WECHAT_API_BASE_URL || "https://api.weixin.qq.com").replace(/\/$/, "");
const DB_DRIVER = String(process.env.DB_DRIVER || "json").trim().toLowerCase();
const SAAS_ENABLED = String(process.env.SAAS_ENABLED || "").trim().toLowerCase() === "true";
const SAAS_SESSION_SECRET = String(process.env.SAAS_SESSION_SECRET || "").trim();
const FUTURE_WEBHOOK_URL = String(process.env.FUTURE_WEBHOOK_URL || "").trim();
const BOBO_INTEGRATION_SECRET = String(process.env.BOBO_INTEGRATION_SECRET || "").trim();
const saasFeatureApi = SAAS_ENABLED ? {
  ...require("./lib/saas-features"),
  ...require("./lib/saas-outsourcing-access"),
} : {
  FEATURE_MODULES: [],
  publicFeatureCatalog: () => [
    { key: "dashboard", name: "生产总览", view: "dashboard" },
    { key: "customers", name: "客户资料", view: "customers" },
    { key: "orders", name: "订单工单", view: "orders" },
    { key: "dispatch", name: "派工路线", view: "dispatch" },
    { key: "quality", name: "质检详情", view: "exceptions" },
    { key: "customerFeedback", name: "客户反馈", view: "customerFeedback" },
    { key: "history", name: "历史查询", view: "history" },
    { key: "reports", name: "基础报表", view: "reports" },
    { key: "settings", name: "基础设置", view: "settings" },
    { key: "outsourcing", name: "外协监管", view: "outsourcing" },
    { key: "auditLogs", name: "操作日志", view: "auditLogs" },
  ],
  featureForApiPath: () => null,
  isKnownUngatedApiPath: () => false,
  hasActiveOutsourcePermission: () => false,
  requiredOutsourcePermission: () => "",
};
const { FEATURE_MODULES, featureForApiPath, isKnownUngatedApiPath,
  hasActiveOutsourcePermission, requiredOutsourcePermission, publicFeatureCatalog } = saasFeatureApi;
const SAAS_TENANT_INTEGRATIONS = parseTenantIntegrations(process.env.SAAS_TENANT_INTEGRATIONS_JSON);
const saasModules = SAAS_ENABLED ? {
  ...require("./lib/saas-store"),
  ...require("./lib/saas-tenant-pools"),
  ...require("./lib/saas-tenant-provisioner"),
  ...require("./lib/saas-state-store"),
  ...require("./lib/saas-auth"),
  ...require("./lib/saas-domain"),
  ...require("./lib/saas-outsourcing-commercial"),
  ...require("./lib/passwords"),
} : {};

const {
  createSaasStore,
  createTenantPoolRouter,
  parseTenantDatabaseConfigs,
  createTenantDatabaseConfig,
  createTenantDatabaseProvisioner,
  createTenantStateStore,
  issuePlatformToken,
  issueUserToken,
  signToken,
  verifyPlatformCredentials,
  verifyToken,
  createDelegation,
  createEntitlement,
  createOutsourceTask,
  createTenant,
  calculateOutsourceRebate,
  requiresOutsourceCompletionPhoto,
  validateFullOutsourceSelection,
  todayInShanghai,
  hashPassword: hashSaasPassword,
  verifyPassword: verifySaasPassword,
} = saasModules;
const MYSQL_STATE_KEY = "main";
const requestContext = new AsyncLocalStorage();
const ULTIMATE_WORK_ORDER_ADMIN_PHONE = "15257457485";
const RESTRICTED_VIEW_PHONES = new Set([
  "13456125046",
  "13757433269",
  "13777234068",
  "15257457485",
  "15728038503",
]);
const AUDIT_RETENTION_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const TV_VIEW_TOKEN_SECRET = String(process.env.TV_VIEW_TOKEN_SECRET || WX_APP_SECRET).trim()
  || crypto.randomBytes(32).toString("hex");
const TV_VIEW_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
let wechatAccessTokenCache = { value: "", expiresAt: 0 };
let wechatAccessTokenPromise = null;
const weappCodePromises = new Map();
let mysqlPool = null;
let saasCatalogPool = null;
let tenantPoolRouter = null;
let tenantStateStore = null;
let saasStore = null;
const tenantDeliveryQueues = new Map();
const serializeOrderNumberWrite = createSerialQueue();
const ORDER_NUMBER_WRITE_PATHS = new Set([
  "/api/orders",
  "/api/orders/update",
  "/api/orders/repeat",
  "/api/external/work-orders",
]);
const serializeDispatchBoardWrite = createSerialQueue();
const DISPATCH_BOARD_WRITE_PATHS = new Set([
  "/api/dispatch-board/route-toggle",
  "/api/dispatch-board/route-schedule",
  "/api/dispatch-board/order-due-date",
  "/api/dispatch-board/report",
  "/api/dispatch-board/report-upload",
  "/api/dispatch-board/report-context",
  "/api/routes/publish-schedule",
  "/api/report",
  "/api/route-status",
  "/api/assign",
  "/api/routes",
  "/api/routes/delete",
]);

function serializeTenantDelivery(tenantId, task) {
  const previous = tenantDeliveryQueues.get(tenantId) || Promise.resolve();
  const current = previous.then(task, task);
  const queued = current.catch(() => {});
  tenantDeliveryQueues.set(tenantId, queued);
  return current.finally(() => {
    if (tenantDeliveryQueues.get(tenantId) === queued) tenantDeliveryQueues.delete(tenantId);
  });
}

function parseTenantIntegrations(rawValue) {
  if (!rawValue) return {};
  let input;
  try {
    input = JSON.parse(rawValue);
  } catch {
    throw new Error("SAAS_TENANT_INTEGRATIONS_JSON 必须是有效 JSON");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("SAAS_TENANT_INTEGRATIONS_JSON 必须是租户映射");
  const result = {};
  const inboundSecrets = new Set();
  for (const [slug, value] of Object.entries(input)) {
    if (!/^[a-z0-9](?:[a-z0-9-]{1,98}[a-z0-9])?$/.test(slug) || !value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("SAAS_TENANT_INTEGRATIONS_JSON 租户配置无效");
    }
    const inboundSecret = String(value.inboundSecret || "").trim();
    const webhookSecret = String(value.webhookSecret || "").trim();
    const webhookUrl = String(value.webhookUrl || "").trim();
    if (inboundSecret && inboundSecret.length < 32) throw new Error(`租户 ${slug} 的 inboundSecret 至少需要 32 个字符`);
    if (inboundSecret && inboundSecrets.has(inboundSecret)) throw new Error("不同租户不能共用外部订单集成密钥");
    if (inboundSecret) inboundSecrets.add(inboundSecret);
    if (webhookUrl) {
      let parsedUrl;
      try { parsedUrl = new URL(webhookUrl); } catch { throw new Error(`租户 ${slug} 的 webhookUrl 无效`); }
      if (parsedUrl.protocol !== "https:" || !webhookSecret || webhookSecret.length < 32) {
        throw new Error(`租户 ${slug} 的平台回调必须配置 HTTPS 地址和至少 32 位 webhookSecret`);
      }
    }
    result[slug] = { inboundSecret, webhookUrl, webhookSecret };
  }
  return result;
}

const defaultSettings = {
  tvCarouselEnabled: true,
  tvCarouselSeconds: 120,
  tvDisplayRatio: "auto",
};

function hashPassword(password) {
  if (!SAAS_ENABLED) throw new Error("Password hashing is available only in SaaS mode");
  return hashSaasPassword(password);
}

function verifyPassword(candidate, stored) {
  if (!SAAS_ENABLED) {
    try {
      return require("./lib/passwords").verifyPassword(candidate, stored);
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND" || !String(error.message).includes("./lib/passwords")) throw error;
      return String(candidate ?? "") === String(stored ?? "");
    }
  }
  return verifySaasPassword(candidate, stored);
}

const roles = {
  owner: "老板",
  manager: "生产主管",
  office: "办公室/跟单",
  worker: "车间工人",
  design_worker: "设计师",
  laser_worker: "激光师傅",
  bend_worker: "折弯师傅",
  rivet_worker: "压铆师傅",
  tap_worker: "攻丝师傅",
  polish_worker: "打磨师傅",
  weld_worker: "焊接师傅",
  machining_worker: "机加师傅",
  powder_worker: "喷塑师傅",
  assembly_worker: "装配师傅",
  quality: "质检",
  driver: "司机",
  admin: "管理员",
};

const defaultProcesses = ["设计", "激光", "切管", "折弯", "压铆", "攻丝", "焊接", "机加", "打磨", "喷塑", "装配", "质检"];
const processAliases = {
  图纸设计: "设计",
  打孔攻丝: "攻丝",
  组装: "装配",
};
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
  质检: "quality",
};
const rolePriority = {
  admin: 100,
  owner: 90,
  manager: 80,
  office: 70,
  quality: 30,
  driver: 25,
  design_worker: 20,
  laser_worker: 20,
  bend_worker: 20,
  rivet_worker: 20,
  tap_worker: 20,
  weld_worker: 20,
  machining_worker: 20,
  polish_worker: 20,
  powder_worker: 20,
  assembly_worker: 20,
  worker: 10,
};

function normalizeProcessName(name) {
  const text = String(name || "").trim();
  return processAliases[text] || text;
}

function normalizeRoles(values) {
  const source = Array.isArray(values) ? values : [values];
  return [...new Set(source.filter((role) => Object.prototype.hasOwnProperty.call(roles, role)))];
}

function tenantUploadDirectory(kind = "") {
  if (!SAAS_ENABLED) return kind ? path.join(UPLOAD_DIR, kind) : UPLOAD_DIR;
  const tenantId = requestContext.getStore()?.tenantId;
  if (!tenantId || !/^[a-zA-Z0-9_-]{1,80}$/.test(tenantId)) throw new Error("租户文件上下文无效");
  const root = path.join(UPLOAD_DIR, "tenants", tenantId);
  return kind ? path.join(root, kind) : root;
}

function tenantUploadPrefix(kind = "") {
  if (!SAAS_ENABLED) return kind ? `/uploads/${kind}` : "/uploads";
  const tenantId = requestContext.getStore()?.tenantId;
  if (!tenantId || !/^[a-zA-Z0-9_-]{1,80}$/.test(tenantId)) throw new Error("租户文件上下文无效");
  return kind ? `/uploads/tenants/${tenantId}/${kind}` : `/uploads/tenants/${tenantId}`;
}

function getUserRoles(user) {
  if (!user) return [];
  return normalizeRoles([...(Array.isArray(user.roles) ? user.roles : []), user.role]);
}

function getPrimaryRole(user) {
  return getUserRoles(user).sort((a, b) => (rolePriority[b] || 0) - (rolePriority[a] || 0))[0] || "worker";
}

function primaryRoleFromRoles(userRoles) {
  return normalizeRoles(userRoles).sort((a, b) => (rolePriority[b] || 0) - (rolePriority[a] || 0))[0] || "worker";
}

function getProcessRole(processName) {
  return processRoleMap[normalizeProcessName(processName)] || "";
}

function processOrderIndex(processName) {
  const index = defaultProcesses.indexOf(normalizeProcessName(processName));
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function userHasRole(user, role) {
  return getUserRoles(user).includes(role);
}

function normalizeTargetFinishTime(value) {
  const text = String(value || "").trim().replaceAll("/", "-").replace(" ", "T");
  if (!text) return "";
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{1,2})(?::\d{2})?$/);
  if (!match) return "";
  const date = normalizeDate(`${match[1]}-${match[2]}-${match[3]}`);
  const hour = Number(match[4]);
  if (!date || hour < 0 || hour > 23) return "";
  return `${date}T${String(hour).padStart(2, "0")}:00`;
}

function normalizePlanDate(value) {
  const text = String(value || "").trim().replaceAll("/", "-");
  if (!text) return "";
  return normalizeDate(text.slice(0, 10));
}

function normalizeRouteSchedule(startValue, endValue) {
  const plannedStartDate = normalizePlanDate(startValue);
  const plannedEndDate = normalizePlanDate(endValue);
  if ((startValue && !plannedStartDate) || (endValue && !plannedEndDate)) return { error: "计划日期格式不正确" };
  if (plannedStartDate && plannedEndDate && plannedStartDate > plannedEndDate) return { error: "计划开始日不能晚于结束日" };
  return { plannedStartDate, plannedEndDate };
}

function reportSchedule(route, createdAt) {
  const reportDate = String(createdAt || "").slice(0, 10);
  const plannedStartDate = route.plannedStartDate || "";
  const plannedEndDate = route.plannedEndDate || "";
  if (!plannedStartDate || !plannedEndDate) {
    return { reportDate, plannedStartDate, plannedEndDate, scheduleStatus: "unplanned", scheduleReason: "未设置完整计划区间" };
  }
  if (reportDate < plannedStartDate) {
    return { reportDate, plannedStartDate, plannedEndDate, scheduleStatus: "early", scheduleReason: "早于计划开始日" };
  }
  if (reportDate > plannedEndDate) {
    return { reportDate, plannedStartDate, plannedEndDate, scheduleStatus: "outside_plan", scheduleReason: "晚于计划结束日" };
  }
  return { reportDate, plannedStartDate, plannedEndDate, scheduleStatus: "on_time", scheduleReason: "" };
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function qrToken(prefix = "qt") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function weappCodeCachePath(route) {
  const fingerprint = crypto
    .createHash("sha256")
    .update(`${route.id}:${route.qrToken}:${WX_CODE_ENV_VERSION}`)
    .digest("hex")
    .slice(0, 20);
  return path.join(WEAPP_CODE_CACHE_DIR, `${fingerprint}.png`);
}

async function readJsonResponse(response, action) {
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${action}返回了无法识别的数据`);
  }
  if (!response.ok || data.errcode) {
    throw new Error(`${action}失败：${data.errmsg || data.errcode || response.status}`);
  }
  return data;
}

async function getWechatAccessToken(forceRefresh = false) {
  if (!WX_APPID || !WX_APP_SECRET) {
    throw new Error("服务器尚未配置 WX_APPID 和 WX_APP_SECRET");
  }
  if (!forceRefresh && wechatAccessTokenCache.value && wechatAccessTokenCache.expiresAt > Date.now()) {
    return wechatAccessTokenCache.value;
  }
  if (!forceRefresh && wechatAccessTokenPromise) return wechatAccessTokenPromise;

  const requestPromise = (async () => {
    const response = await fetch(`${WECHAT_API_BASE_URL}/cgi-bin/stable_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credential",
        appid: WX_APPID,
        secret: WX_APP_SECRET,
        force_refresh: forceRefresh,
      }),
    });
    const data = await readJsonResponse(response, "获取微信访问令牌");
    if (!data.access_token) throw new Error("微信接口未返回访问令牌");
    const expiresIn = Math.max(300, Number(data.expires_in || 7200));
    wechatAccessTokenCache = {
      value: data.access_token,
      expiresAt: Date.now() + Math.max(60, expiresIn - 300) * 1000,
    };
    return data.access_token;
  })();

  wechatAccessTokenPromise = requestPromise;
  try {
    return await requestPromise;
  } finally {
    if (wechatAccessTokenPromise === requestPromise) wechatAccessTokenPromise = null;
  }
}

async function requestWeappCode(route, retry = true) {
  if (!route.qrToken || Buffer.byteLength(route.qrToken, "utf8") > 32) {
    throw new Error("工序二维码参数无效或超过微信 scene 的 32 字节限制");
  }
  const accessToken = await getWechatAccessToken(false);
  const response = await fetch(`${WECHAT_API_BASE_URL}/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(accessToken)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scene: route.qrToken,
      page: "pages/report/report",
      check_path: false,
      env_version: WX_CODE_ENV_VERSION,
      width: 430,
      auto_color: false,
      line_color: { r: 21, g: 111, b: 98 },
      is_hyaline: false,
    }),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = weappImageType(bytes);
  if (response.ok && contentType) return { bytes, contentType };

  let errorData = {};
  try {
    errorData = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`生成微信小程序码失败：HTTP ${response.status}`);
  }
  if (retry && [40001, 40014, 42001].includes(Number(errorData.errcode))) {
    wechatAccessTokenCache = { value: "", expiresAt: 0 };
    await getWechatAccessToken(true);
    return requestWeappCode(route, false);
  }
  throw new Error(`生成微信小程序码失败：${errorData.errmsg || errorData.errcode || response.status}`);
}

async function getWeappCode(route) {
  fs.mkdirSync(WEAPP_CODE_CACHE_DIR, { recursive: true });
  const cacheFile = weappCodeCachePath(route);
  if (fs.existsSync(cacheFile)) {
    const bytes = fs.readFileSync(cacheFile);
    return { bytes, contentType: weappImageType(bytes) || "image/png" };
  }
  if (weappCodePromises.has(cacheFile)) return weappCodePromises.get(cacheFile);

  const requestPromise = (async () => {
    const image = await requestWeappCode(route);
    fs.writeFileSync(cacheFile, image.bytes);
    return image;
  })();
  weappCodePromises.set(cacheFile, requestPromise);
  try {
    return await requestPromise;
  } finally {
    if (weappCodePromises.get(cacheFile) === requestPromise) weappCodePromises.delete(cacheFile);
  }
}

function today(offset = 0) {
  return shanghaiDateKey(new Date(Date.now() + offset * 24 * 60 * 60 * 1000));
}

function normalizeDate(value) {
  const text = String(value || "").trim().replaceAll("/", "-");
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return "";
  const year = match[1];
  const month = match[2].padStart(2, "0");
  const day = match[3].padStart(2, "0");
  const date = new Date(`${year}-${month}-${day}T00:00:00`);
  if (Number.isNaN(date.getTime()) || date.getFullYear() !== Number(year) || date.getMonth() + 1 !== Number(month) || date.getDate() !== Number(day)) return "";
  return `${year}-${month}-${day}`;
}

function normalizeWeightKg(value) {
  if (value === undefined || value === null || String(value).trim() === "") return { value: null };
  const weightKg = Number(value);
  if (!Number.isInteger(weightKg) || weightKg < 0) return { error: "重量必须是大于或等于 0 的整数 KG" };
  return { value: weightKg };
}

function normalizeQuantityUnit(value) {
  const unit = String(value || "").trim();
  return unit === "套" ? "套" : "件";
}

function isValidQuantityUnit(value) {
  return value === undefined || value === null || String(value).trim() === "" || ["件", "套"].includes(String(value).trim());
}

function createMysqlPool() {
  if (SAAS_ENABLED) throw new Error("SaaS mode cannot use the legacy shared MySQL database");
  if (mysqlPool) return mysqlPool;
  const mysql = getMysqlDriver();
  const database = String(process.env.MYSQL_DATABASE || "").trim();
  const user = String(process.env.MYSQL_USER || "").trim();
  if (!database || !user) throw new Error("MySQL 模式必须配置 MYSQL_DATABASE 和 MYSQL_USER");
  mysqlPool = mysql.createPool({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user,
    password: process.env.MYSQL_PASSWORD || "",
    database,
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 5),
    charset: "utf8mb4",
  });
  return mysqlPool;
}

function getMysqlDriver() {
  try {
    return require("mysql2/promise");
  } catch {
    throw new Error("当前 DB_DRIVER=mysql，但未安装 mysql2。请先执行 npm install。");
  }
}

function createSaasCatalogPool() {
  if (saasCatalogPool) return saasCatalogPool;
  if (!SAAS_ENABLED) throw new Error("SaaS catalog is only available in SaaS mode");
  const database = String(process.env.SAAS_CATALOG_MYSQL_DATABASE || "").trim();
  const user = String(process.env.SAAS_CATALOG_MYSQL_USER || "").trim();
  const password = String(process.env.SAAS_CATALOG_MYSQL_PASSWORD || "");
  const legacyDatabase = String(process.env.MYSQL_DATABASE || "").trim().toLowerCase();
  if (!database || !user || !password) throw new Error("SaaS 模式必须单独配置平台目录数据库连接");
  if (["bobogd", "future_orders", legacyDatabase].filter(Boolean).includes(database.toLowerCase())) {
    throw new Error("平台目录数据库必须与既有业务数据库分离");
  }
  saasCatalogPool = getMysqlDriver().createPool({
    host: process.env.SAAS_CATALOG_MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.SAAS_CATALOG_MYSQL_PORT || 3306),
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: Number(process.env.SAAS_CATALOG_MYSQL_CONNECTION_LIMIT || 5),
    charset: "utf8mb4",
  });
  return saasCatalogPool;
}

function ensureTenantPoolRouter() {
  if (!tenantPoolRouter) {
    const catalogDatabase = String(process.env.SAAS_CATALOG_MYSQL_DATABASE || "").trim();
    const configs = parseTenantDatabaseConfigs(process.env.SAAS_TENANT_DATABASES_JSON, {
      catalogDatabase,
      forbiddenDatabases: [process.env.MYSQL_DATABASE || ""],
    });
    tenantPoolRouter = createTenantPoolRouter({
      mysql: getMysqlDriver(),
      configs,
      catalogDatabase,
      forbiddenDatabases: [process.env.MYSQL_DATABASE || ""],
    });
  }
  return tenantPoolRouter;
}

function getTenantPool(tenant) {
  const router = ensureTenantPoolRouter();
  const slug = String(tenant?.slug || "").trim().toLowerCase();
  if (!router.hasTenantConfig(slug)) {
    registerTenantDatabaseConfig(slug, createTenantDatabaseConfig({
      tenant,
      host: process.env.SAAS_TENANT_DATABASE_HOST || process.env.SAAS_CATALOG_MYSQL_HOST || "127.0.0.1",
      port: process.env.SAAS_TENANT_DATABASE_PORT || process.env.SAAS_CATALOG_MYSQL_PORT || 3306,
      accountHost: process.env.SAAS_TENANT_DATABASE_ACCOUNT_HOST || "127.0.0.1",
      secret: getTenantDatabaseCredentialSecret(),
    }));
  }
  return tenantPoolRouter.getPool(tenant);
}

function getTenantDatabaseCredentialSecret() {
  const secret = String(process.env.SAAS_TENANT_CREDENTIAL_SECRET || "");
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("创建租户需要配置至少 32 字节的 SAAS_TENANT_CREDENTIAL_SECRET");
  }
  return secret;
}

function getTenantDatabaseProvisioner() {
  return createTenantDatabaseProvisioner({
    mysql: getMysqlDriver(),
    host: process.env.SAAS_TENANT_PROVISIONER_HOST || process.env.SAAS_CATALOG_MYSQL_HOST || "127.0.0.1",
    port: process.env.SAAS_TENANT_PROVISIONER_PORT || process.env.SAAS_CATALOG_MYSQL_PORT || 3306,
    user: process.env.SAAS_TENANT_PROVISIONER_USER,
    password: process.env.SAAS_TENANT_PROVISIONER_PASSWORD,
    accountHost: process.env.SAAS_TENANT_DATABASE_ACCOUNT_HOST || "127.0.0.1",
    credentialSecret: getTenantDatabaseCredentialSecret(),
  });
}

function registerTenantDatabaseConfig(slug, config) {
  ensureTenantPoolRouter().registerTenantConfig(slug, config);
}

async function unregisterTenantDatabaseConfig(slug) {
  if (tenantPoolRouter) await tenantPoolRouter.unregisterTenantConfig(slug);
}

async function loadProvisionedTenantDatabaseConfigs(store) {
  const provisions = await store.listTenantDatabaseProvisions();
  if (!provisions.length) return;
  const secret = getTenantDatabaseCredentialSecret();
  const host = process.env.SAAS_TENANT_DATABASE_HOST || process.env.SAAS_CATALOG_MYSQL_HOST || "127.0.0.1";
  const port = process.env.SAAS_TENANT_DATABASE_PORT || process.env.SAAS_CATALOG_MYSQL_PORT || 3306;
  for (const provision of provisions) {
    const tenant = { tenantId: provision.tenantId, slug: provision.slug };
    const config = createTenantDatabaseConfig({
      tenant,
      host,
      port,
      accountHost: provision.accountHost,
      secret,
    });
    if (config.database !== provision.database || config.user !== provision.user) {
      throw new Error(`租户 ${provision.slug} 的数据库登记与租户编号不匹配，已拒绝启动`);
    }
    registerTenantDatabaseConfig(provision.slug, config);
  }
}

async function withTenantAdvisoryLock(tenant, purpose, task) {
  if (!SAAS_ENABLED) return task();
  const connection = await getTenantPool(tenant).getConnection();
  const tenantHash = crypto.createHash("sha256").update(tenant.tenantId).digest("hex").slice(0, 40);
  const lockName = `bobo_${purpose}_${tenantHash}`;
  let acquired = false;
  try {
    const [rows] = await connection.execute("SELECT GET_LOCK(?, 15) AS acquired", [lockName]);
    acquired = Number(rows[0]?.acquired) === 1;
    if (!acquired) throw new Error("租户数据正由另一个请求处理，请稍后重试");
    return await task();
  } finally {
    try {
      if (acquired) await connection.execute("SELECT RELEASE_LOCK(?)", [lockName]);
    } finally {
      connection.release();
    }
  }
}

async function withTenantDatabaseLock(tenant, task) {
  if (!SAAS_ENABLED) return task();
  return serializeTenantDelivery(tenant.tenantId, () => withTenantAdvisoryLock(tenant, "state", task));
}

function getTenantStateStore() {
  if (!tenantStateStore) {
    tenantStateStore = createTenantStateStore({ driver: "mysql", dataDir: DATA_DIR, getPool: getTenantPool });
  }
  return tenantStateStore;
}

function getSaasStore() {
  if (!saasStore) saasStore = createSaasStore(createSaasCatalogPool());
  return saasStore;
}

async function ensureSaasCatalog() {
  if (!SAAS_ENABLED) return;
  if (DB_DRIVER !== "mysql") throw new Error("SAAS_ENABLED=true requires DB_DRIVER=mysql");
  if (!SAAS_SESSION_SECRET || SAAS_SESSION_SECRET.length < 32) throw new Error("SAAS_SESSION_SECRET must contain at least 32 characters");
  const store = getSaasStore();
  await store.ensureSchema();
  const catalogPool = createSaasCatalogPool();
  const [rows] = await catalogPool.execute("SELECT tenant_id FROM saas_tenants WHERE slug = ? LIMIT 1", ["future-machinery"]);
  if (!rows.length) {
    await catalogPool.execute(
      `INSERT INTO saas_tenants (tenant_id, slug, name, tenant_type, status, state_key, created_at, updated_at)
       VALUES ('future-machinery', 'future-machinery', '宁波未来机械', 'company', 'active', 'main', NOW(), NOW())`
    );
  }
  const [entitlements] = await catalogPool.execute("SELECT entitlement_id FROM saas_entitlements WHERE tenant_id = ? LIMIT 1", ["future-machinery"]);
  if (!entitlements.length) {
    await catalogPool.execute(
      `INSERT INTO saas_entitlements
        (entitlement_id, tenant_id, annual_amount_fen, currency, starts_at, ends_at, status, payment_status, note, created_by, created_at)
       VALUES ('ent_future_machinery_internal_v1', 'future-machinery', 0, 'CNY', CURRENT_DATE, '2099-12-31', 'active', 'waived', '平台自用租户', 'system', NOW())`
    );
  }
  await loadProvisionedTenantDatabaseConfigs(store);
  const tenant = await store.findTenantBySlug("future-machinery");
  let state = await getTenantStateStore().read(tenant);
  if (!state) {
    await assertEmptyTenantDatabase(tenant);
    state = createEmptyTenantState(null);
  }
  const currentAdminId = await store.findTenantAdminUserId(tenant.tenantId);
  const currentAdmin = state.users?.find((user) => user.id === currentAdminId && user.active
    && (user.role === "owner" || user.roles?.includes("owner")));
  if (currentAdmin) return;

  const phone = String(process.env.SAAS_FUTURE_MACHINERY_ADMIN_PHONE || "").trim();
  const name = String(process.env.SAAS_FUTURE_MACHINERY_ADMIN_NAME || "").trim();
  const password = String(process.env.SAAS_FUTURE_MACHINERY_ADMIN_PASSWORD || "");
  if (!name || !/^\+?[0-9]{7,18}$/.test(phone) || password.length < 8) {
    throw new Error("未来机械缺少有效管理员，需配置管理员姓名、手机号和至少 8 位密码后再启动");
  }
  state.users ||= [];
  let adminUser = state.users.find((user) => user.active && user.phone === phone)
    || state.users.find((user) => user.active && (user.role === "owner" || user.roles?.includes("owner")));
  if (!adminUser) {
    adminUser = { id: `u_${crypto.randomBytes(12).toString("hex")}`, active: true };
    state.users.push(adminUser);
  }
  adminUser.name = name;
  adminUser.phone = phone;
  adminUser.role = "owner";
  adminUser.roles = ["owner"];
  adminUser.password = hashPassword(password);
  await getTenantStateStore().write(tenant, state);
  await store.revokeUserSessions(tenant.tenantId, adminUser.id);
  await store.ensureTenantAdminMembership(tenant.tenantId, adminUser.id);
  await store.recordAudit({ actorUserId: "system", targetTenantId: tenant.tenantId,
    action: "tenant.admin_recovered", entityId: adminUser.id, details: { phone } });
}

async function resolveRequestTenant(req, res, url) {
  if (!SAAS_ENABLED) return { tenantId: "legacy", stateKey: MYSQL_STATE_KEY };
  const store = getSaasStore();
  const isLogin = req.method === "POST" && url.pathname === "/api/login";
  const token = isLogin ? "" : requestToken(req);
  const isPlatformRoute = url.pathname.startsWith("/api/platform/");
  if (isPlatformRoute) {
    if (req.method === "POST" && url.pathname === "/api/platform/login") return { tenantId: "platform", stateKey: MYSQL_STATE_KEY, platform: true };
    const payload = verifyToken(token, SAAS_SESSION_SECRET, "platform-admin");
    const session = payload && await store.findPlatformSession(payload.sessionId);
    if (!payload || !session || session.adminUserId !== payload.adminUserId) {
      send(res, 401, { error: "请先登录平台后台" });
      return null;
    }
    req.saasPlatformAdminId = payload.adminUserId;
    req.saasPlatformSessionId = payload.sessionId;
    return { tenantId: "platform", stateKey: MYSQL_STATE_KEY, platform: true };
  }
  const isTvViewerRoute = (req.method === "GET" && (
    url.pathname === "/api/tv-dashboard"
    || /^\/api\/tv-orders\/[^/]+\/drawings$/.test(url.pathname)
    || /^\/api\/tv-drawings\/[^/]+\/(file|preview-file)$/.test(url.pathname)
  )) || (req.method === "POST" && url.pathname === "/api/tv-drawings/preview");
  if (isTvViewerRoute) {
    const viewerToken = String(url.searchParams.get("viewerToken") || token || "");
    const tvPayload = verifyToken(viewerToken, TV_VIEW_TOKEN_SECRET, "mobile-tv")
      || verifyToken(viewerToken, TV_VIEW_TOKEN_SECRET, "dispatch-board");
    if (tvPayload?.tenantId) {
      const tenant = await store.findTenantById(tvPayload.tenantId);
      if (tenant && tenant.status === "active") {
        const entitlement = await store.findActiveEntitlement(tenant.tenantId);
        const featureModules = await store.getTenantFeatureModules(tenant);
        return { ...tenant, featureModules, licenseActive: Boolean(entitlement) };
      }
    }
  }
  const payload = verifyToken(token, SAAS_SESSION_SECRET, "tenant-user");
  if (payload) {
    const session = await store.findSession(payload.sessionId);
    const tenant = await store.findTenantById(payload.tenantId);
    if (!session || session.tenantId !== payload.tenantId || session.userId !== payload.userId || !tenant || tenant.status !== "active") {
      send(res, 401, { error: "登录会话已失效" });
      return null;
    }
    req.saasUserId = payload.userId;
    req.saasSessionId = payload.sessionId;
    req.saasTenantId = payload.tenantId;
    const entitlement = await store.findActiveEntitlement(tenant.tenantId);
    const featureModules = await store.getTenantFeatureModules(tenant);
    return { ...tenant, featureModules, licenseActive: Boolean(entitlement) };
  }
  const viewerToken = String(url.searchParams.get("viewerToken") || token || "");
  const tvPayload = verifyToken(viewerToken, TV_VIEW_TOKEN_SECRET, "mobile-tv")
    || verifyToken(viewerToken, TV_VIEW_TOKEN_SECRET, "dispatch-board");
  if (tvPayload?.tenantId) {
    const tenant = await store.findTenantById(tvPayload.tenantId);
    if (tenant && tenant.status === "active") {
      const entitlement = await store.findActiveEntitlement(tenant.tenantId);
      const featureModules = await store.getTenantFeatureModules(tenant);
      return { ...tenant, featureModules, licenseActive: Boolean(entitlement) };
    }
  }
  if (url.pathname.startsWith("/uploads/")) {
    const filePayload = verifyToken(String(url.searchParams.get("fileToken") || ""), SAAS_SESSION_SECRET, "tenant-file");
    const tenant = filePayload && await store.findTenantById(filePayload.tenantId);
    if (tenant && tenant.status === "active" && filePayload.path === url.pathname) {
      req.saasFileTenantId = filePayload.tenantId;
      return tenant;
    }
  }
  const slug = String(req.headers["x-company-slug"] || url.searchParams.get("company") || (isLogin ? "future-machinery" : "future-machinery")).trim().toLowerCase();
  const tenant = await store.findTenantBySlug(slug);
  if (!tenant || tenant.status !== "active") {
    send(res, 403, { error: "公司不存在或已停用" });
    return null;
  }
  if (!isLogin && url.pathname !== "/api/qr/resolve") {
    send(res, 401, { error: "请先登录" });
    return null;
  }
  const entitlement = await store.findActiveEntitlement(tenant.tenantId);
  const featureModules = await store.getTenantFeatureModules(tenant);
  return { ...tenant, featureModules, licenseActive: Boolean(entitlement) };
}

function requestToken(req) {
  const authorization = String(req.headers.authorization || "");
  if (authorization.startsWith("Bearer ")) return authorization.slice(7);
  const cookies = String(req.headers.cookie || "").split(";");
  const sessionCookie = cookies.map((part) => part.trim()).find((part) => part.startsWith("bobo_session="));
  return sessionCookie ? decodeURIComponent(sessionCookie.slice("bobo_session=".length)) : "";
}

function createEmptyTenantState(adminUser) {
  return {
    users: adminUser ? [adminUser] : [],
    deletedUsers: [],
    processes: defaultProcesses.map((name, index) => ({ id: `p_${index + 1}`, name, sort: index + 1, active: true })),
    customers: [],
    orders: [],
    workOrders: [],
    routes: [],
    reports: [],
    exceptions: [],
    customerFeedbacks: [],
    attachments: [],
    drawings: [],
    deliveries: [],
    deliveryTrips: [],
    integrationNonces: [],
    platformWebhookEvents: [],
    auditLogs: [],
    settings: { ...defaultSettings },
  };
}

async function assertEmptyTenantDatabase(tenant) {
  const pool = getTenantPool(tenant);
  const [tables] = await pool.execute(
    "SELECT TABLE_NAME AS name FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'",
  );
  if (tables.length !== 1 || tables[0].name !== "app_state") {
    throw new Error("新公司必须绑定已单独预配且只含 app_state 表的租户数据库");
  }
  const [rows] = await pool.execute("SELECT COUNT(*) AS row_count FROM app_state");
  if (Number(rows[0]?.row_count) !== 0) throw new Error("租户数据库已有业务数据，拒绝覆盖");
}

async function handlePlatformApi(req, res, url) {
  if (!SAAS_ENABLED || !url.pathname.startsWith("/api/platform/")) return false;
  if (req.method === "POST" && url.pathname === "/api/platform/login") {
    const body = await parseBody(req);
    const adminUserId = String(body.userId || "").trim();
    if (!verifyPlatformCredentials(adminUserId, body.password, {
      userId: process.env.SAAS_PLATFORM_ADMIN_USER,
      password: process.env.SAAS_PLATFORM_ADMIN_PASSWORD,
    })) return send(res, 401, { error: "平台账号或密码不正确" });
    const sessionId = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000);
    await getSaasStore().createPlatformSession({ sessionId, adminUserId, expiresAt });
    const sessionToken = issuePlatformToken({ adminUserId, sessionId, secret: SAAS_SESSION_SECRET });
    return send(res, 200, { sessionToken, expiresAt: expiresAt.toISOString() });
  }
  if (!req.saasPlatformAdminId) return send(res, 403, { error: "无权管理平台租户" });
  if (req.method === "POST" && url.pathname === "/api/platform/logout") {
    await getSaasStore().revokePlatformSession(req.saasPlatformSessionId);
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/api/platform/tenants") {
    return send(res, 200, { tenants: await getSaasStore().listTenants() });
  }
  if (req.method === "GET" && url.pathname === "/api/platform/feature-modules") {
    return send(res, 200, { modules: publicFeatureCatalog() });
  }
  if (req.method === "GET" && url.pathname === "/api/platform/plans") {
    return send(res, 200, { plans: await getSaasStore().listFeaturePlans() });
  }
  if (req.method === "GET" && url.pathname === "/api/platform/outsourcing-rebates") {
    const store = getSaasStore();
    const periods = await store.listOutsourceRebatePeriods("future-machinery");
    return send(res, 200, { periods: periods.map((period) => {
      const rebate = calculateOutsourceRebate({
        outputFen: period.outputFen,
        firstTargetFen: period.firstTargetFen,
        fullTargetFen: period.fullTargetFen,
        annualAmountFen: period.annualAmountFen,
        paymentStatus: period.paymentStatus,
      });
      return { ...period, rebateTier: rebate.tier, estimatedRefundFen: period.settledRefundFen ?? rebate.refundFen };
    }) });
  }
  const rebateTargetMatch = url.pathname.match(/^\/api\/platform\/outsourcing-rebates\/([^/]+)\/targets$/);
  if (req.method === "POST" && rebateTargetMatch) {
    const body = await parseBody(req);
    const firstTargetFen = Number(body.firstTargetFen);
    const fullTargetFen = Number(body.fullTargetFen);
    if (!Number.isSafeInteger(firstTargetFen) || firstTargetFen <= 0
      || !Number.isSafeInteger(fullTargetFen) || fullTargetFen <= firstTargetFen) {
      return send(res, 400, { error: "两档产值门槛必须为正整数分，且第二档高于第一档" });
    }
    const entitlementId = decodeURIComponent(rebateTargetMatch[1]);
    const periods = await getSaasStore().listOutsourceRebatePeriods("future-machinery");
    const period = periods.find((item) => item.entitlementId === entitlementId && item.partnerSlug !== "future-machinery");
    if (!period) return send(res, 404, { error: "外协租户授权周期不存在" });
    try {
      await getSaasStore().saveOutsourceRebateTargets({
        periodId: period.periodId || `reb_${crypto.randomBytes(12).toString("hex")}`,
        ownerTenantId: "future-machinery",
        partnerTenantId: period.partnerTenantId,
        entitlementId,
        firstTargetFen,
        fullTargetFen,
        actorUserId: req.saasPlatformAdminId,
      });
      return send(res, 200, { ok: true });
    } catch (error) { return send(res, 409, { error: error.message }); }
  }
  const rebateSettlementMatch = url.pathname.match(/^\/api\/platform\/outsourcing-rebates\/([^/]+)\/settlement$/);
  if (req.method === "POST" && rebateSettlementMatch) {
    const body = await parseBody(req);
    const entitlementId = decodeURIComponent(rebateSettlementMatch[1]);
    const periods = await getSaasStore().listOutsourceRebatePeriods("future-machinery");
    const period = periods.find((item) => item.entitlementId === entitlementId && item.partnerSlug !== "future-machinery");
    if (!period) return send(res, 404, { error: "外协租户授权周期不存在" });
    if (period.endsAt > todayInShanghai()) return send(res, 409, { error: "授权周期结束后才能登记年终退款" });
    if (!period.firstTargetFen || !period.fullTargetFen) return send(res, 409, { error: "请先为该授权周期设置两档产值门槛" });
    const rebate = calculateOutsourceRebate({
      outputFen: period.outputFen, firstTargetFen: period.firstTargetFen, fullTargetFen: period.fullTargetFen,
      annualAmountFen: period.annualAmountFen, paymentStatus: period.paymentStatus,
    });
    const refundFen = Number(body.refundFen);
    const settledAt = normalizeDate(body.settledAt);
    const note = String(body.note || "").trim().slice(0, 500);
    if (!Number.isSafeInteger(refundFen) || refundFen !== rebate.refundFen || !settledAt) {
      return send(res, 400, { error: "退款金额必须与达标计算结果一致，并填写有效退款日期" });
    }
    try {
      await getSaasStore().recordOutsourceRebateSettlement({ entitlementId, refundFen, settledAt, note, actorUserId: req.saasPlatformAdminId });
      return send(res, 200, { ok: true });
    } catch (error) { return send(res, 409, { error: error.message }); }
  }
  if (req.method === "POST" && url.pathname === "/api/platform/plans") {
    const body = await parseBody(req);
    const plan = await getSaasStore().saveFeaturePlan({ ...body, actorUserId: req.saasPlatformAdminId });
    return send(res, 200, { plan });
  }
  if (req.method === "GET" && url.pathname === "/api/platform/releases") {
    return send(res, 200, { releases: await getSaasStore().listFeatureReleases(), currentVersion: require("./package.json").version });
  }
  if (req.method === "POST" && url.pathname === "/api/platform/releases") {
    const body = await parseBody(req);
    const release = await getSaasStore().createFeatureRelease({
      ...body,
      releaseId: `rel_${crypto.randomBytes(12).toString("hex")}`,
      actorUserId: req.saasPlatformAdminId,
    });
    return send(res, 201, { release });
  }
  const releaseStatusMatch = url.pathname.match(/^\/api\/platform\/releases\/([^/]+)\/status$/);
  if (req.method === "POST" && releaseStatusMatch) {
    const body = await parseBody(req);
    const ok = await getSaasStore().setFeatureReleaseStatus(decodeURIComponent(releaseStatusMatch[1]), String(body.status || ""), req.saasPlatformAdminId);
    return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: "发布记录不存在" });
  }
  const rolloutMatch = url.pathname.match(/^\/api\/platform\/releases\/([^/]+)\/rollouts$/);
  if (req.method === "POST" && rolloutMatch) {
    const body = await parseBody(req);
    const tenantIds = Array.isArray(body.tenantIds) ? body.tenantIds : [];
    const ok = await getSaasStore().setFeatureReleaseRollouts(decodeURIComponent(rolloutMatch[1]), tenantIds, req.saasPlatformAdminId);
    return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: "发布记录不存在" });
  }
  const tenantDetailsMatch = url.pathname.match(/^\/api\/platform\/tenants\/([^/]+)\/details$/);
  if (req.method === "GET" && tenantDetailsMatch) {
    const tenantId = decodeURIComponent(tenantDetailsMatch[1]);
    const store = getSaasStore();
    const details = await store.getTenantAdminDetails(tenantId);
    if (!details) return send(res, 404, { error: "公司不存在" });
    const tenant = await store.findTenantById(tenantId);
    const adminUserId = await store.findTenantAdminUserId(tenantId);
    const tenantState = tenant ? await withTenantDatabaseLock(tenant, () => requestContext.run(tenant, () => readDb())) : null;
    const admin = tenantState?.users?.find((user) => user.id === adminUserId && user.active) || {};
    details.admin = { name: admin.name || "", phone: admin.phone || "" };
    details.features = await store.getTenantFeatureModules(tenant);
    return send(res, 200, details);
  }
  const tenantFeaturesMatch = url.pathname.match(/^\/api\/platform\/tenants\/([^/]+)\/features$/);
  if (req.method === "POST" && tenantFeaturesMatch) {
    const body = await parseBody(req);
    const ok = await getSaasStore().assignTenantFeatures({
      tenantId: decodeURIComponent(tenantFeaturesMatch[1]),
      planId: String(body.planId || ""),
      overrides: body.overrides || {},
      actorUserId: req.saasPlatformAdminId,
    });
    return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: "公司不存在" });
  }
  if (req.method === "POST" && url.pathname === "/api/platform/tenants") {
    const body = await parseBody(req);
    const tenantId = `ten_${crypto.randomBytes(12).toString("hex")}`;
    const adminUserId = id("u");
    const tenant = createTenant({ tenantId, slug: body.slug, name: body.name });
    const adminUser = {
      id: adminUserId,
      name: String(body.adminName || "").trim(),
      phone: String(body.adminPhone || "").trim(),
      role: "owner",
      roles: ["owner"],
      password: hashPassword(body.adminPassword),
      active: true,
    };
    if (!adminUser.name || !/^\+?[0-9]{7,18}$/.test(adminUser.phone)) throw new Error("公司管理员姓名或手机号无效");
    const annualAmountFen = body.annualAmountFen;
    const startsAt = String(body.startsAt || todayInShanghai());
    const endsAt = String(body.endsAt || "");
    const entitlement = createEntitlement({
      entitlementId: `ent_${crypto.randomBytes(12).toString("hex")}`,
      tenantId,
      annualAmountFen,
      startsAt,
      endsAt,
      paymentStatus: body.paymentStatus,
      createdBy: req.saasPlatformAdminId,
      note: body.entitlementNote || "平台创建公司时授予",
    });
    const store = getSaasStore();
    const planId = String(body.planId || "legacy-full");
    const planExists = (await store.listFeaturePlans()).some((plan) => plan.planId === planId && plan.active);
    if (!planExists) throw new Error("套餐不存在或已停用");
    const provisioner = getTenantDatabaseProvisioner();
    let databaseProvision;
    let routeRegistered = false;
    let catalogTransactionStarted = false;
    try {
      databaseProvision = await provisioner.provision(tenant);
      const tenantConfig = createTenantDatabaseConfig({
        tenant,
        host: process.env.SAAS_TENANT_DATABASE_HOST || process.env.SAAS_CATALOG_MYSQL_HOST || "127.0.0.1",
        port: process.env.SAAS_TENANT_DATABASE_PORT || process.env.SAAS_CATALOG_MYSQL_PORT || 3306,
        accountHost: databaseProvision.accountHost,
        secret: getTenantDatabaseCredentialSecret(),
      });
      registerTenantDatabaseConfig(tenant.slug, tenantConfig);
      routeRegistered = true;
      await assertEmptyTenantDatabase(tenant);
      await withTenantDatabaseLock(tenant, () => requestContext.run(tenant, () => writeDb(createEmptyTenantState(adminUser))));
      catalogTransactionStarted = true;
      await store.createTenantWithEntitlement(tenant, adminUserId, entitlement, databaseProvision, planId);
    } catch (error) {
      let safeToCleanup = !catalogTransactionStarted;
      if (catalogTransactionStarted) {
        try { safeToCleanup = !(await store.findTenantById(tenantId)); }
        catch { safeToCleanup = false; }
      }
      if (safeToCleanup) {
        if (routeRegistered) await unregisterTenantDatabaseConfig(tenant.slug).catch(() => {});
        if (databaseProvision) await provisioner.remove(databaseProvision).catch((cleanupError) => {
          console.error(`租户 ${tenant.slug} 初始化失败，自动清理数据库资源也失败：${cleanupError.message}`);
        });
      }
      throw error;
    }
    return send(res, 201, { tenant, entitlement: { ...entitlement, createdAt: entitlement.createdAt }, adminUser: { id: adminUserId, name: adminUser.name, phone: adminUser.phone } });
  }
  const statusMatch = url.pathname.match(/^\/api\/platform\/tenants\/([^/]+)\/status$/);
  if (req.method === "POST" && statusMatch) {
    const body = await parseBody(req);
    const ok = await getSaasStore().setTenantStatus(decodeURIComponent(statusMatch[1]), String(body.status || ""), req.saasPlatformAdminId);
    return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: "公司不存在" });
  }
  const adminPasswordMatch = url.pathname.match(/^\/api\/platform\/tenants\/([^/]+)\/admin-password$/);
  if (req.method === "POST" && adminPasswordMatch) {
    const body = await parseBody(req);
    const password = String(body.password || "");
    if (password.length < 8) return send(res, 400, { error: "新密码至少需要 8 位" });
    const store = getSaasStore();
    const tenantId = decodeURIComponent(adminPasswordMatch[1]);
    const tenant = await store.findTenantById(tenantId);
    if (!tenant) return send(res, 404, { error: "公司不存在" });
    return withTenantDatabaseLock(tenant, () => requestContext.run(tenant, async () => {
      const db = await readDb();
      const adminUserId = await store.findTenantAdminUserId(tenantId);
      const admin = adminUserId
        ? db.users.find((user) => user.id === adminUserId && user.active)
        : db.users.find((user) => user.active && (user.role === "owner" || (Array.isArray(user.roles) && user.roles.includes("owner"))));
      if (!admin) return send(res, 404, { error: "未找到该公司的有效管理员账号" });
      admin.password = hashPassword(password);
      await writeDb(db);
      await store.revokeUserSessions(tenantId, admin.id);
      await store.recordAudit({
        actorUserId: req.saasPlatformAdminId,
        targetTenantId: tenantId,
        action: "tenant.admin_password_reset",
        entityId: admin.id,
        details: { phone: admin.phone },
      });
      return send(res, 200, { ok: true, adminUser: { name: admin.name, phone: admin.phone } });
    }));
  }
  const entitlementMatch = url.pathname.match(/^\/api\/platform\/tenants\/([^/]+)\/entitlements$/);
  if (req.method === "POST" && entitlementMatch) {
    const body = await parseBody(req);
    const tenantId = decodeURIComponent(entitlementMatch[1]);
    if (!await getSaasStore().findTenantById(tenantId)) return send(res, 404, { error: "公司不存在" });
    const entitlement = createEntitlement({
      entitlementId: `ent_${crypto.randomBytes(12).toString("hex")}`,
      tenantId,
      annualAmountFen: body.annualAmountFen,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      paymentStatus: body.paymentStatus,
      note: body.note,
      createdBy: req.saasPlatformAdminId,
    });
    await getSaasStore().createEntitlement(entitlement);
    return send(res, 201, { entitlement });
  }
  const entitlementPaymentMatch = url.pathname.match(/^\/api\/platform\/tenants\/([^/]+)\/entitlements\/([^/]+)\/payment-status$/);
  if (req.method === "POST" && entitlementPaymentMatch) {
    const body = await parseBody(req);
    const tenantId = decodeURIComponent(entitlementPaymentMatch[1]);
    const entitlementId = decodeURIComponent(entitlementPaymentMatch[2]);
    const paymentStatus = String(body.paymentStatus || "");
    if (!["unpaid", "paid", "waived", "not_required"].includes(paymentStatus)) {
      return send(res, 400, { error: "收款状态无效" });
    }
    const result = await getSaasStore().updateEntitlementPaymentStatus({
      entitlementId, tenantId, paymentStatus, actorUserId: req.saasPlatformAdminId,
    });
    if (!result) return send(res, 404, { error: "授权记录不存在" });
    return send(res, 200, { ok: true, ...result });
  }
  return send(res, 404, { error: "平台接口不存在" });
}

function isOutsourcingOwner(context) {
  return context?.slug === "future-machinery";
}

function canManageOutsourcing(user) {
  return getUserRoles(user).some((role) => ["owner", "manager", "admin"].includes(role));
}

function isOutsourcedOrder(db, orderId) {
  return db.workOrders.some((item) => item.orderId === orderId && item.source === "saas-outsourcing");
}

function normalizeOutsourceReportImages(images, tenantId) {
  if (!Array.isArray(images)) return null;
  const tenantPrefix = `/uploads/tenants/${tenantId}/`;
  const tenantRoot = path.resolve(UPLOAD_DIR, "tenants", tenantId) + path.sep;
  const normalized = [];
  for (const image of images) {
    const value = typeof image === "string" ? image : String(image?.url || "");
    if (!value) return null;
    let pathname;
    try { pathname = new URL(value, "http://local").pathname; } catch { return null; }
    if (!pathname.startsWith(tenantPrefix)) return null;
    const filePath = path.resolve(PUBLIC, `.${pathname}`);
    if (!filePath.startsWith(tenantRoot) || !fs.existsSync(filePath)
      || ![".png", ".jpg", ".jpeg", ".gif"].includes(path.extname(filePath).toLowerCase())) return null;
    normalized.push(pathname);
  }
  return [...new Set(normalized)];
}

function outsourceTaskProjection(db, task, side, permissions = [], ownerName = "", partnerName = "") {
  const workOrder = db.workOrders.find((item) => item.id === task.partnerWorkOrderId);
  if (!workOrder) return { ...task, ownerName, partnerName, production: null, productionValueFen: Number(task.productionValueFen || 0), isOutsource: true };
  const canShowProgress = side === "owner" || permissions.includes("progress");
  const canViewAttachments = side === "partner" && permissions.includes("attachments");
  const order = db.orders.find((item) => item.id === workOrder.orderId) || {};
  const routes = db.routes.filter((item) => item.workOrderId === workOrder.id).sort((a, b) => a.sequence - b.sequence);
  const finalProcessCompletedAt = finalOutsourceProcessCompletedAt(routes);
  const reports = (db.reports || []).filter((item) => item.workOrderId === workOrder.id).map((report) => {
    const route = routes.find((item) => item.id === report.routeId);
    return {
      reportId: report.id,
      processName: route?.processName || "生产报工",
      createdAt: report.createdAt,
      reporterName: db.users.find((item) => item.id === report.reporterId)?.name || "",
      images: (Array.isArray(report.images) ? report.images : []).map((_, index) =>
        `/api/outsourcing/tasks/${encodeURIComponent(task.taskId)}/reports/${encodeURIComponent(report.id)}/images/${index}`),
    };
  }).filter((report) => report.images.length);
  const projection = {
    workNo: workOrder.workNo,
    status: workOrder.status,
    planQty: workOrder.planQty,
    completedQty: routes.reduce((sum, route) => sum + Number(route.completedQty || 0), 0),
    routes: canShowProgress ? routes.map((route) => ({ processName: route.processName, sequence: route.sequence, status: route.status, planQty: route.planQty, completedQty: route.completedQty, plannedStartDate: route.plannedStartDate || "", plannedEndDate: route.plannedEndDate || "", completedAt: route.completedAt || "", lastReportedAt: route.lastReportedAt || "", reporterName: db.users.find((item) => item.id === route.lastReporterId)?.name || "" })) : [],
    finalProcessCompletedAt: canShowProgress ? finalProcessCompletedAt : "",
    dueDate: order.dueDate || task.dueDate,
    reports,
    drawings: canViewAttachments ? (db.drawings || []).filter((drawing) => drawing.workOrderId === workOrder.id && !drawing.removedAt).map((drawing) => ({
      drawingId: drawing.id,
      name: drawing.originalName || drawing.name || path.basename(String(drawing.url || "")),
      fileType: String(drawing.fileType || path.extname(String(drawing.url || "")).slice(1)).toLowerCase(),
      url: drawing.url,
    })) : [],
  };
  if (permissions.includes("exceptions")) {
    projection.exceptions = db.exceptions.filter((item) => item.workOrderId === workOrder.id).map((item) => ({ type: item.type, status: item.status, description: item.description, createdAt: item.createdAt }));
  }
  return { ...task, ownerName, partnerName, productionValueFen: Number(task.productionValueFen || 0), isOutsource: true, production: projection };
}

async function outsourceWorkOrderPermissionError(db, workOrderId, permission) {
  if (!SAAS_ENABLED) return null;
  const context = requestContext.getStore();
  const workOrder = db.workOrders.find((item) => item.id === workOrderId);
  if (workOrder?.source !== "saas-outsourcing") return null;
  if (!context?.tenantId) return "当前公司上下文无效";
  const store = getSaasStore();
  const task = (await store.listOutsourceTasks(context.tenantId, "partner")).find((item) => item.partnerWorkOrderId === workOrder.id);
  if (!task) return "外协任务不存在或不属于当前公司";
  const delegation = await store.findDelegation(task.delegationId);
  if (!delegation || delegation.partnerTenantId !== context.tenantId
    || !hasActiveOutsourcePermission(delegation, permission, todayInShanghai())) {
    return "当前委派关系不允许此操作，或授权已失效";
  }
  return null;
}

async function partnerOutsourcePermissions(db) {
  const context = requestContext.getStore();
  if (!SAAS_ENABLED || !context || context.slug === "future-machinery") return new Map();
  const store = getSaasStore();
  const tasks = await store.listOutsourceTasks(context.tenantId, "partner");
  const accessByWorkOrderId = new Map(db.workOrders
    .filter((workOrder) => workOrder.source === "saas-outsourcing")
    .map((workOrder) => [workOrder.id, new Set()]));
  for (const task of tasks) {
    const delegation = await store.findDelegation(task.delegationId);
    const permissions = delegation?.partnerTenantId === context.tenantId
      && delegation.status === "active"
      && delegation.startsAt <= todayInShanghai()
      && delegation.endsAt >= todayInShanghai()
      ? delegation.permissions : [];
    accessByWorkOrderId.set(task.partnerWorkOrderId, new Set(permissions));
  }
  return accessByWorkOrderId;
}

function canViewOutsourcePermission(accessByWorkOrderId, workOrderId, permission) {
  return !accessByWorkOrderId.has(workOrderId) || accessByWorkOrderId.get(workOrderId).has(permission);
}

async function handleOutsourcingApi(req, res, url, db, user) {
  if (!SAAS_ENABLED || !url.pathname.startsWith("/api/outsourcing")) return false;
  if (!user) return send(res, 401, { error: "请先登录" });
  const context = requestContext.getStore();
  const isOwner = isOutsourcingOwner(context);
  if (!canManageOutsourcing(user)) return send(res, 403, { error: "无权管理外协订单" });
  if (isOwner && !["owner", "manager", "admin"].some((role) => getUserRoles(user).includes(role))) return send(res, 403, { error: "无权管理外协订单" });
  const store = getSaasStore();
  if (req.method === "GET" && url.pathname === "/api/outsourcing/summary") {
    const tasks = await store.listOutsourceTasks(context.tenantId, isOwner ? "owner" : "partner");
    const summary = isOwner
      ? { isOwner: true, pendingAcceptance: tasks.filter((task) => task.status === "submitted").length, blocked: tasks.filter((task) => task.status === "blocked").length }
      : { isOwner: false, incoming: tasks.filter((task) => task.status === "sent").length };
    return send(res, 200, summary);
  }
  const reportImageMatch = url.pathname.match(/^\/api\/outsourcing\/tasks\/([^/]+)\/reports\/([^/]+)\/images\/(\d+)$/);
  if (req.method === "GET" && reportImageMatch) {
    const taskId = decodeURIComponent(reportImageMatch[1]);
    const reportId = decodeURIComponent(reportImageMatch[2]);
    const imageIndex = Number(reportImageMatch[3]);
    const side = context.tenantId === "future-machinery" ? "owner" : "partner";
    const task = (await store.listOutsourceTasks(context.tenantId, side)).find((item) => item.taskId === taskId);
    if (!task || ![task.ownerTenantId, task.partnerTenantId].includes(context.tenantId)) return send(res, 404, { error: "外协任务不存在" });
    const partner = await store.findTenantById(task.partnerTenantId);
    if (!partner || partner.status !== "active") return send(res, 404, { error: "外协任务公司不存在" });
    const partnerDb = context.tenantId === task.partnerTenantId
      ? db
      : await withTenantDatabaseLock(partner, () => requestContext.run(partner, () => readDb()));
    const report = (partnerDb.reports || []).find((item) => item.id === reportId && item.workOrderId === task.partnerWorkOrderId);
    const image = report && Array.isArray(report.images) ? report.images[imageIndex] : null;
    const imageUrl = typeof image === "string" ? image : String(image?.url || "");
    if (!imageUrl) return send(res, 404, { error: "报工照片不存在" });
    const pathname = new URL(imageUrl, "http://local").pathname;
    const tenantRoot = path.resolve(UPLOAD_DIR, "tenants", task.partnerTenantId) + path.sep;
    const filePath = path.resolve(PUBLIC, `.${pathname}`);
    if (!pathname.startsWith(`/uploads/tenants/${task.partnerTenantId}/`) || !filePath.startsWith(tenantRoot)
      || !fs.existsSync(filePath) || ![".png", ".jpg", ".jpeg", ".gif"].includes(path.extname(filePath).toLowerCase())) {
      return send(res, 404, { error: "报工照片不存在" });
    }
    const contentType = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif" })[path.extname(filePath).toLowerCase()];
    return sendLocalFile(res, filePath, contentType);
  }
  if (req.method === "GET" && url.pathname === "/api/outsourcing") {
    const tenants = await store.listTenants();
    const tenantNames = new Map(tenants.map((tenant) => [tenant.tenantId, tenant.name]));
    const delegations = isOwner ? await store.listDelegations(context.tenantId) : [];
    const items = [];
    for (const side of (isOwner ? ["owner", "partner"] : ["partner"])) {
      const tasks = await store.listOutsourceTasks(context.tenantId, side);
      for (const task of tasks) {
        if (side === "owner" && !isOwnerTaskWithinSupervision({ ...task, side })) continue;
        const delegation = isOwner
          ? delegations.find((item) => item.delegationId === task.delegationId)
          : await store.findDelegation(task.delegationId);
        if (!delegation || (side === "owner" && (delegation.ownerTenantId !== context.tenantId || task.ownerTenantId !== context.tenantId))
          || (side === "partner" && (delegation.partnerTenantId !== context.tenantId || task.partnerTenantId !== context.tenantId))) continue;
        let data = db;
        if (side === "owner") {
          const partner = await store.findTenantById(task.partnerTenantId);
          data = partner ? await withTenantDatabaseLock(partner, () => requestContext.run(partner, () => readDb())) : {};
        }
        const relationActive = delegation.status === "active" && delegation.startsAt <= todayInShanghai() && delegation.endsAt >= todayInShanghai();
        const permissions = side === "owner" ? ["progress", "exceptions", "quality", "delivery", "attachments"]
          : relationActive ? delegation.permissions : [];
        const ownerOrder = side === "owner" ? db.orders.find((item) => item.id === task.ownerOrderId) : null;
        items.push({ ...outsourceTaskProjection(data, task, side, permissions, tenantNames.get(task.ownerTenantId) || task.ownerTenantId, tenantNames.get(task.partnerTenantId) || task.partnerTenantId),
          ownerDueDate: ownerOrder?.dueDate || task.snapshot?.ownerDueDate || "", side, permissions, relationActive });
      }
    }
    const partners = isOwner ? await Promise.all(tenants.filter((tenant) => tenant.tenantId !== context.tenantId && tenant.status === "active")
      .map(async (tenant) => ({ ...tenant, eligible: Boolean(await store.findActiveEntitlement(tenant.tenantId)) }))) : [];
    const visibleTenantNames = isOwner ? tenants.map((tenant) => [tenant.tenantId, tenant.name])
      : [...new Set(items.flatMap((task) => [task.ownerTenantId, task.partnerTenantId]))]
        .map((tenantId) => [tenantId, tenantNames.get(tenantId)]).filter(([, name]) => name);
    return send(res, 200, { isOwner, delegations, tasks: items, partners, tenantNames: Object.fromEntries(visibleTenantNames) });
  }
  if (req.method === "POST" && url.pathname === "/api/outsourcing/delegations") {
    const body = await parseBody(req);
    const partner = await store.findTenantById(String(body.partnerTenantId || ""));
    if (!partner || partner.status !== "active" || !await store.findActiveEntitlement(partner.tenantId)) return send(res, 400, { error: "外协公司不存在、已停用或授权未生效" });
    const delegation = createDelegation({
      delegationId: `del_${crypto.randomBytes(12).toString("hex")}`,
      ownerTenantId: context.tenantId,
      partnerTenantId: partner.tenantId,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      permissions: body.permissions,
      createdBy: user.id,
    });
    await store.createDelegation(delegation);
    return send(res, 201, { delegation });
  }
  const revokeMatch = url.pathname.match(/^\/api\/outsourcing\/delegations\/([^/]+)\/revoke$/);
  if (req.method === "POST" && revokeMatch) {
    const ok = await store.revokeDelegation(decodeURIComponent(revokeMatch[1]), context.tenantId, user.id);
    return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: "委派不存在或已撤销" });
  }
  if (req.method === "POST" && url.pathname === "/api/outsourcing/tasks") {
    const body = await parseBody(req);
    const delegation = await store.findDelegation(String(body.delegationId || ""));
    if (!delegation || delegation.ownerTenantId !== context.tenantId || delegation.status !== "active"
      || !delegation.permissions.includes("tasks") || delegation.startsAt > todayInShanghai()
      || delegation.endsAt < todayInShanghai()) return send(res, 403, { error: "当前委派关系不允许创建任务" });
    const order = db.orders.find((item) => item.id === body.orderId);
    const workOrder = order && db.workOrders.find((item) => item.orderId === order.id);
    if (!order || !workOrder) return send(res, 404, { error: "订单或工单不存在" });
    if (workOrder.status === "已完成") return send(res, 400, { error: "已完成工单不能新建外协任务" });
    const outsourceQuantity = Number(body.quantity);
    const planQuantity = Number(workOrder.planQty || order.quantity);
    if (!Number.isSafeInteger(outsourceQuantity) || outsourceQuantity < 1) return send(res, 400, { error: "外协数量必须为有效正整数" });
    const sourceRoutes = db.routes.filter((item) => item.workOrderId === workOrder.id && item.routeType !== "rework").sort((a, b) => a.sequence - b.sequence);
    try { validateFullOutsourceSelection(sourceRoutes, body.routeIds, outsourceQuantity, planQuantity); }
    catch (error) { return send(res, 400, { error: error.message }); }
    const selectedRoutes = sourceRoutes;
    if (selectedRoutes.some((route) => route.status !== "待开始" || Number(route.completedQty || 0) > 0 || route.assignedTo)) return send(res, 409, { error: "整单委派要求全部工序尚未报工和分配" });
    const productionValueFen = Number(body.productionValueFen);
    if (!Number.isSafeInteger(productionValueFen) || productionValueFen <= 0) return send(res, 400, { error: "请输入有效的外协订单产值" });
    const reservations = await store.listTaskReservations(context.tenantId, order.id);
    const reservedByRoute = new Map();
    for (const reservation of reservations) {
      for (const process of reservation.snapshot.processes || []) {
        const route = sourceRoutes.find((item) => process.routeId ? item.id === process.routeId : item.processName === process.name && (!process.sourceSequence || item.sequence === Number(process.sourceSequence)));
        if (route) reservedByRoute.set(route.id, (reservedByRoute.get(route.id) || 0) + Number(reservation.snapshot.quantity || 0));
      }
    }
    const availableQuantity = Math.min(...selectedRoutes.map((route) => Math.max(0, Number(route.planQty || workOrder.planQty) - Number(route.completedQty || 0) - (reservedByRoute.get(route.id) || 0))));
    if (outsourceQuantity > availableQuantity) return send(res, 409, { error: `所选工序最多还能委派 ${availableQuantity} ${normalizeQuantityUnit(order.quantityUnit)}` });
    const taskId = `out_${crypto.randomBytes(12).toString("hex")}`;
    const partner = await store.findTenantById(delegation.partnerTenantId);
    if (!partner) return send(res, 404, { error: "外协公司不存在" });
    const sourceDrawings = db.drawings.filter((item) => !item.removedAt && (item.workOrderId === workOrder.id || item.orderId === order.id));
    const partnerState = await withTenantDatabaseLock(partner, () => requestContext.run(partner, async () => {
      const state = await readDb();
      const copiedFiles = [];
      const partnerOrderId = id("o");
      const partnerWorkOrderId = id("w");
      const partnerCustomer = { id: id("c"), name: `${context.name}委外任务`, contact: "", phone: "", note: "BOBO 外协委派" };
      const partnerOrder = {
        id: partnerOrderId,
        orderNo: `OUT-${taskId.slice(-10)}`,
        customerId: partnerCustomer.id,
        productName: workOrder.productName || order.productName,
        drawingNo: order.drawingNo || "",
        quantity: outsourceQuantity,
        productionValueFen,
        quantityUnit: normalizeQuantityUnit(order.quantityUnit),
        dueDate: String(body.dueDate || delegation.endsAt),
        priority: order.priority || "普通",
        status: "待排产",
        fulfillmentStatus: "生产中",
        note: String(body.acceptanceCriteria || "外协委派工单").slice(0, 1000),
        source: "saas-outsourcing",
        createdAt: new Date().toISOString(),
      };
      const partnerWorkOrder = {
        id: partnerWorkOrderId,
        workNo: partnerOrder.orderNo,
        orderId: partnerOrderId,
        productName: partnerOrder.productName,
        planQty: partnerOrder.quantity,
        status: "待排产",
        currentProcess: "待排产",
        assigneeId: "",
        qrToken: qrToken("wo"),
        source: "saas-outsourcing",
        createdAt: new Date().toISOString(),
      };
      state.customers.push(partnerCustomer);
      state.orders.push(partnerOrder);
      state.workOrders.push(partnerWorkOrder);
      const partnerDrawingIds = [];
      try {
        for (const sourceDrawing of sourceDrawings) {
          const sourcePath = path.resolve(PUBLIC, `.${String(sourceDrawing.url || "")}`);
          const uploadRoot = path.resolve(UPLOAD_DIR) + path.sep;
          if (!sourcePath.startsWith(uploadRoot) || !fs.existsSync(sourcePath)) throw new Error("委派图纸文件缺失或路径无效");
          const extension = path.extname(sourcePath).toLowerCase();
          const fileName = `${id("drawing")}${extension}`;
          const targetDirectory = tenantUploadDirectory("drawings");
          fs.mkdirSync(targetDirectory, { recursive: true });
          const targetPath = path.join(targetDirectory, fileName);
          fs.copyFileSync(sourcePath, targetPath);
          copiedFiles.push(targetPath);
          const drawing = {
            id: id("d"),
            orderId: partnerOrderId,
            workOrderId: partnerWorkOrderId,
            name: String(sourceDrawing.name || sourceDrawing.originalName || fileName),
            originalName: String(sourceDrawing.originalName || sourceDrawing.name || fileName),
            fileName,
            fileType: sourceDrawing.fileType || extension.slice(1),
            contentType: sourceDrawing.contentType || "application/octet-stream",
            url: `${tenantUploadPrefix("drawings")}/${fileName}`,
            previewUrl: "",
            previewError: "",
            createdAt: new Date().toISOString(),
          };
          state.drawings.push(drawing);
          partnerDrawingIds.push(drawing.id);
        }
      } catch (error) {
        copiedFiles.forEach((file) => { if (fs.existsSync(file)) fs.unlinkSync(file); });
        throw error;
      }
      const processes = [];
      for (const [index, sourceRoute] of selectedRoutes.entries()) {
        let process = state.processes.find((item) => item.name === sourceRoute.processName);
        if (!process) {
          process = { id: id("p"), name: sourceRoute.processName, sort: state.processes.length + 1, active: true };
          state.processes.push(process);
        }
        state.routes.push({
          id: id("r"),
          workOrderId: partnerWorkOrderId,
          processId: process.id,
          processName: sourceRoute.processName,
          sequence: index + 1,
          assignedTo: "",
          status: "待开始",
          planQty: partnerOrder.quantity,
          completedQty: 0,
          goodQty: 0,
          badQty: 0,
          reworkQty: 0,
          qrToken: qrToken("route"),
        });
        state.routes.at(-1).plannedStartDate = sourceRoute.plannedStartDate || "";
        state.routes.at(-1).plannedEndDate = sourceRoute.plannedEndDate || "";
        processes.push({ name: sourceRoute.processName, sequence: index + 1, routeId: sourceRoute.id, sourceSequence: sourceRoute.sequence });
      }
      return { state, partnerWorkOrderId, processes, partnerDrawingIds, copiedFiles };
    }));
    let task;
    try {
      task = createOutsourceTask({
        taskId,
        delegationId: delegation.delegationId,
        ownerTenantId: context.tenantId,
        partnerTenantId: partner.tenantId,
        ownerOrderId: order.id,
        partnerWorkOrderId: partnerState.partnerWorkOrderId,
        dueDate: body.dueDate || delegation.endsAt,
        productionValueFen,
        createdBy: user.id,
        snapshot: {
          orderNo: order.orderNo,
          ownerDueDate: order.dueDate || "",
          productName: workOrder.productName || order.productName,
          drawingNumber: order.drawingNo,
          quantity: outsourceQuantity,
          quantityUnit: normalizeQuantityUnit(order.quantityUnit),
          acceptanceCriteria: body.acceptanceCriteria,
          drawingIds: partnerState.partnerDrawingIds,
          processes: partnerState.processes,
        },
      });
      await store.createOutsourceTask(task);
      await withTenantDatabaseLock(partner, () => requestContext.run(partner, async () => {
        const latest = await readDb();
        const partnerOrder = partnerState.state.orders.find((item) => item.id === partnerState.state.workOrders.find((workOrderItem) => workOrderItem.id === partnerState.partnerWorkOrderId)?.orderId);
        const partnerWorkOrder = partnerState.state.workOrders.find((item) => item.id === partnerState.partnerWorkOrderId);
        const partnerCustomer = partnerOrder && partnerState.state.customers.find((item) => item.id === partnerOrder.customerId);
        const partnerRoutes = partnerState.state.routes.filter((item) => item.workOrderId === partnerState.partnerWorkOrderId);
        const partnerDrawings = partnerState.state.drawings.filter((item) => item.workOrderId === partnerState.partnerWorkOrderId);
        if (!partnerOrder || !partnerWorkOrder || !partnerCustomer) throw new Error("外协工单副本数据不完整");
        latest.customers.push(partnerCustomer);
        latest.orders.push(partnerOrder);
        latest.workOrders.push(partnerWorkOrder);
        latest.routes.push(...partnerRoutes);
        latest.drawings.push(...partnerDrawings);
        await writeDb(latest);
      }));
    } catch (error) {
      if (task) {
        try { await store.updateOutsourceTaskStatus(task.taskId, context.tenantId, "cancelled", user.id); } catch {}
      }
      partnerState.copiedFiles.forEach((file) => { if (fs.existsSync(file)) fs.unlinkSync(file); });
      throw error;
    }
    return send(res, 201, { task, partnerWorkNo: partnerState.state.workOrders.find((item) => item.id === task.partnerWorkOrderId)?.workNo || "" });
  }
  const statusMatch = url.pathname.match(/^\/api\/outsourcing\/tasks\/([^/]+)\/status$/);
  if (req.method === "POST" && statusMatch) {
    const body = await parseBody(req);
    try {
      const taskId = decodeURIComponent(statusMatch[1]);
      const actorSide = isOwner ? "owner" : "partner";
      const task = (await store.listOutsourceTasks(context.tenantId, actorSide)).find((item) => item.taskId === taskId);
      if (!task) return send(res, 404, { error: "外协任务不存在或不属于当前公司" });
      if (!isOwner) {
        const delegation = await store.findDelegation(task.delegationId);
        const permission = requiredOutsourcePermission("partner", String(body.status || ""));
        if (!delegation || delegation.partnerTenantId !== context.tenantId || !permission
          || !hasActiveOutsourcePermission(delegation, permission, todayInShanghai())) {
          return send(res, 403, { error: "当前委派关系不允许此操作，或授权已失效" });
        }
        if (body.status === "submitted") {
          const partnerWorkOrder = db.workOrders.find((item) => item.id === task.partnerWorkOrderId && item.source === "saas-outsourcing");
          const routes = partnerWorkOrder ? db.routes.filter((item) => item.workOrderId === partnerWorkOrder.id) : [];
          const allProcessesComplete = routes.length > 0 && routes.every((route) => Number(route.planQty) > 0
            && Number(route.completedQty || 0) >= Number(route.planQty) && route.status === "已完成");
          if (!allProcessesComplete) return send(res, 409, { error: "全部工序完成后才能提交验收" });
        }
      }
      const result = await store.updateOutsourceTaskStatus(taskId, context.tenantId, String(body.status || ""), user.id);
      if (result?.status === "accepted_by_owner" && task && isOwner) {
        const workOrder = db.workOrders.find((item) => item.orderId === task.ownerOrderId);
        for (const process of task.snapshot.processes || []) {
          const route = db.routes.find((item) => item.workOrderId === workOrder?.id && (process.routeId ? item.id === process.routeId : item.processName === process.name && (!process.sourceSequence || item.sequence === Number(process.sourceSequence))));
          if (!route) continue;
          route.completedQty = Math.min(Number(route.planQty || workOrder.planQty), Number(route.completedQty || 0) + Number(task.snapshot.quantity || 0));
          route.goodQty = Number(route.goodQty || 0) + Number(task.snapshot.quantity || 0);
          route.status = route.completedQty >= Number(route.planQty || workOrder.planQty) ? "已完成" : "进行中";
          route.lastReportedAt = new Date().toISOString();
          route.lastReporterId = user.id;
          if (route.status === "已完成") route.completedAt = route.lastReportedAt;
        }
        if (workOrder) syncWorkOrder(db, workOrder.id);
        await writeDb(db);
      }
      return send(res, result ? 200 : 404, result || { error: "外协任务不存在" });
    } catch (error) {
      return send(res, error.statusCode || 400, { error: error.message });
    }
  }
  if (!isOwner) return send(res, 403, { error: "仅主公司可管理委派关系和创建外协任务" });
  return send(res, 404, { error: "外协接口不存在" });
}

async function ensureMysqlStateTable(pool) {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS app_state (
      name VARCHAR(80) PRIMARY KEY,
      value_json JSON NOT NULL,
      updated_at DATETIME NOT NULL
    )
  `);
}

async function ensureDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(DRAWING_DIR, { recursive: true });
  fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
  fs.mkdirSync(CAD_PREVIEW_DIR, { recursive: true });
  if (SAAS_ENABLED) return;
  if (DB_DRIVER === "mysql") {
    const pool = createMysqlPool();
    await ensureMysqlStateTable(pool);
    const [rows] = await pool.execute("SELECT name FROM app_state WHERE name = ?", [MYSQL_STATE_KEY]);
    if (rows.length) return;
    if (fs.existsSync(DB_FILE)) {
      const initialDb = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
      await writeDb(initialDb);
      return;
    }
  } else if (fs.existsSync(DB_FILE)) {
    return;
  }
  const users = [
    { id: "u_owner", name: "老板", phone: "13800000001", role: "owner", password: "123456", active: true },
    { id: "u_manager", name: "生产主管", phone: "13800000002", role: "manager", password: "123456", active: true },
    { id: "u_office", name: "跟单员", phone: "13800000003", role: "office", password: "123456", active: true },
    { id: "u_worker_laser", name: "激光师傅", phone: "13800000004", role: "laser_worker", roles: ["laser_worker"], password: "123456", active: true },
    { id: "u_worker_bend", name: "折弯师傅", phone: "13800000005", role: "bend_worker", roles: ["bend_worker"], password: "123456", active: true },
    { id: "u_quality", name: "质检员", phone: "13800000006", role: "quality", roles: ["quality"], password: "123456", active: true },
    { id: "u_admin", name: "管理员", phone: "13800000007", role: "admin", password: "123456", active: true },
  ];
  const processes = defaultProcesses.map((name, index) => ({ id: `p_${index + 1}`, name, sort: index + 1, active: true }));
  const customers = [
    { id: "c_1", name: "样例客户 A", contact: "张先生", phone: "13900000001", address: "上海", note: "演示客户" },
    { id: "c_2", name: "样例客户 B", contact: "李女士", phone: "13900000002", address: "苏州", note: "急单客户" },
  ];
  const orders = [
    { id: "o_1", orderNo: "SO-20260602-001", customerId: "c_1", productName: "电控箱外壳", drawingNo: "DKX-2406-A", quantity: 120, dueDate: today(5), priority: "普通", status: "生产中", note: "样例订单" },
    { id: "o_2", orderNo: "SO-20260602-002", customerId: "c_2", productName: "设备护罩", drawingNo: "HZ-2406-B", quantity: 40, dueDate: today(1), priority: "急单", status: "生产中", note: "交期紧" },
  ];
  const workOrders = [
    { id: "w_1", workNo: "WO-001", orderId: "o_1", productName: "电控箱外壳", planQty: 120, status: "生产中", currentProcess: "折弯", assigneeId: "u_manager", qrToken: "qr_w_1" },
    { id: "w_2", workNo: "WO-002", orderId: "o_2", productName: "设备护罩", planQty: 40, status: "生产中", currentProcess: "焊接", assigneeId: "u_manager", qrToken: "qr_w_2" },
  ];
  const routes = [
    { id: "r_1", workOrderId: "w_1", processId: "p_2", processName: "激光", sequence: 1, assignedTo: "u_worker_laser", status: "已完成", planQty: 120, completedQty: 120, goodQty: 118, badQty: 2, reworkQty: 0 },
    { id: "r_2", workOrderId: "w_1", processId: "p_3", processName: "折弯", sequence: 2, assignedTo: "u_worker_bend", status: "进行中", planQty: 120, completedQty: 60, goodQty: 60, badQty: 0, reworkQty: 0 },
    { id: "r_3", workOrderId: "w_1", processId: "p_4", processName: "焊接", sequence: 3, assignedTo: "", status: "待开始", planQty: 120, completedQty: 0, goodQty: 0, badQty: 0, reworkQty: 0 },
    { id: "r_4", workOrderId: "w_2", processId: "p_2", processName: "激光", sequence: 1, assignedTo: "u_worker_laser", status: "已完成", planQty: 40, completedQty: 40, goodQty: 40, badQty: 0, reworkQty: 0 },
    { id: "r_5", workOrderId: "w_2", processId: "p_4", processName: "焊接", sequence: 2, assignedTo: "u_worker_bend", status: "异常", planQty: 40, completedQty: 8, goodQty: 6, badQty: 2, reworkQty: 2 },
    { id: "r_6", workOrderId: "w_2", processId: "p_8", processName: "质检", sequence: 3, assignedTo: "u_quality", status: "待开始", planQty: 40, completedQty: 0, goodQty: 0, badQty: 0, reworkQty: 0 },
  ];
  const exceptions = [
    { id: "e_1", workOrderId: "w_2", routeId: "r_5", type: "焊接变形", description: "护罩侧板焊后变形，需要主管确认返修方式。", status: "待处理", reporterId: "u_worker_bend", createdAt: new Date().toISOString(), images: [] },
  ];
  await writeDb({ users, deletedUsers: [], processes, customers, orders, workOrders, routes, reports: [], exceptions, attachments: [], drawings: [], auditLogs: [], settings: { ...defaultSettings } });
}

async function readDb() {
  let db;
  if (DB_DRIVER === "mysql") {
    if (SAAS_ENABLED) {
      const context = requestContext.getStore();
      if (!context || context.platform) throw new Error("请求缺少有效租户上下文，已拒绝业务数据库访问");
      db = await getTenantStateStore().read(context);
      if (!db) throw new Error("租户业务数据库尚未初始化，已拒绝访问");
    } else {
      const pool = createMysqlPool();
      const stateKey = requestContext.getStore()?.stateKey || MYSQL_STATE_KEY;
      const [rows] = await pool.execute("SELECT value_json FROM app_state WHERE name = ?", [stateKey]);
      if (!rows.length) throw new Error("MySQL app_state 未初始化，请先执行迁移或确认 data/db.json 可用于首次导入");
      db = typeof rows[0].value_json === "string" ? JSON.parse(rows[0].value_json) : rows[0].value_json;
    }
  } else {
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  }
  let changed = false;
  if (!Array.isArray(db.deletedUsers)) {
    db.deletedUsers = [];
    changed = true;
  }
  db.reports ||= [];
  db.exceptions ||= [];
  db.customerFeedbacks ||= [];
  db.attachments ||= [];
  db.drawings ||= [];
  db.deliveries ||= [];
  db.deliveryTrips ||= [];
  db.integrationNonces ||= [];
  db.platformWebhookEvents ||= [];
  db.auditLogs ||= [];
  db.processes ||= [];
  db.settings ||= {};
  db.customers.forEach((customer) => {
    if (customer.active === undefined) {
      customer.active = true;
      changed = true;
    }
  });
  db.orders.forEach((order) => {
    const quantityUnit = normalizeQuantityUnit(order.quantityUnit);
    if (order.quantityUnit !== quantityUnit) {
      order.quantityUnit = quantityUnit;
      changed = true;
    }
    const source = normalizedOrderSource(order);
    for (const [key, value] of Object.entries(source)) {
      if (order[key] !== value) {
        order[key] = value;
        changed = true;
      }
    }
  });
  Object.entries(defaultSettings).forEach(([key, value]) => {
    if (db.settings[key] === undefined) {
      db.settings[key] = value;
      changed = true;
    }
  });
  const legacyRoleByName = {
    设计师: "design_worker",
    激光师傅: "laser_worker",
    折弯师傅: "bend_worker",
    压铆师傅: "rivet_worker",
    攻丝师傅: "tap_worker",
    打磨师傅: "polish_worker",
    焊接师傅: "weld_worker",
    机加师傅: "machining_worker",
    喷塑师傅: "powder_worker",
    装配师傅: "assembly_worker",
  };
  db.users.forEach((item) => {
    const nextRole = legacyRoleByName[item.name];
    if (item.role === "worker" && nextRole) {
      item.role = nextRole;
      changed = true;
    }
    const nextRoles = normalizeRoles([...(Array.isArray(item.roles) ? item.roles : []), item.role]);
    const nextPrimaryRole = getPrimaryRole({ ...item, roles: nextRoles });
    if (JSON.stringify(item.roles || []) !== JSON.stringify(nextRoles)) {
      item.roles = nextRoles;
      changed = true;
    }
    if (item.role !== nextPrimaryRole) {
      item.role = nextPrimaryRole;
      changed = true;
    }
  });
  db.deletedUsers.forEach((item) => {
    const nextRoles = normalizeRoles([...(Array.isArray(item.roles) ? item.roles : []), item.role]);
    if (JSON.stringify(item.roles || []) !== JSON.stringify(nextRoles)) {
      item.roles = nextRoles;
      changed = true;
    }
  });
  const processIdMap = new Map();
  const canonicalProcesses = [];
  db.processes.forEach((process) => {
    const name = normalizeProcessName(process.name);
    const existing = canonicalProcesses.find((item) => item.name === name);
    if (existing) {
      processIdMap.set(process.id, existing.id);
      changed = true;
      return;
    }
    if (process.name !== name) changed = true;
    process.name = name;
    if (process.active === undefined) {
      process.active = true;
      changed = true;
    }
    canonicalProcesses.push(process);
    processIdMap.set(process.id, process.id);
  });
  db.processes = canonicalProcesses;
  defaultProcesses.forEach((name) => {
    if (!db.processes.some((process) => process.name === name)) {
      db.processes.push({ id: id("p"), name, sort: db.processes.length + 1, active: true });
      changed = true;
    }
  });
  db.routes.forEach((route) => {
    const processName = normalizeProcessName(route.processName);
    const process = db.processes.find((item) => item.name === processName);
    if (route.processName !== processName) {
      route.processName = processName;
      changed = true;
    }
    const nextProcessId = process?.id || processIdMap.get(route.processId) || route.processId;
    if (route.processId !== nextProcessId) {
      route.processId = nextProcessId;
      changed = true;
    }
    const assignedRole = getProcessRole(processName);
    if (route.assignedRole !== assignedRole) {
      route.assignedRole = assignedRole;
      changed = true;
    }
    if (route.assignedTo && route.status !== "已完成") {
      const assignee = db.users.find((item) => item.id === route.assignedTo && item.active !== false);
      if (!assignee || (assignedRole && !userHasRole(assignee, assignedRole))) {
        route.assignedTo = "";
        changed = true;
      }
    }
    const targetFinishTime = normalizeTargetFinishTime(route.targetFinishTime);
    if ((route.targetFinishTime || "") !== targetFinishTime) {
      route.targetFinishTime = targetFinishTime;
      changed = true;
    }
    const schedule = normalizeRouteSchedule(route.plannedStartDate, route.plannedEndDate || targetFinishTime.slice(0, 10));
    if (!schedule.error) {
      if (route.plannedStartDate !== schedule.plannedStartDate) {
        route.plannedStartDate = schedule.plannedStartDate;
        changed = true;
      }
      if (route.plannedEndDate !== schedule.plannedEndDate) {
        route.plannedEndDate = schedule.plannedEndDate;
        changed = true;
      }
    }
    if (!route.qrToken) {
      route.qrToken = qrToken("rt");
      changed = true;
    }
    if (route.status === "已完成" && !route.completedAt) {
      const report = db.reports.find((item) => item.routeId === route.id);
      route.completedAt = report?.createdAt || new Date().toISOString();
      route.lastReportedAt = route.completedAt;
      route.lastReporterId ||= report?.reporterId || route.assignedTo || "";
      changed = true;
    }
  });
  db.workOrders.forEach((workOrder) => {
    if (!workOrder.creationStatus) {
      const order = db.orders.find((item) => item.id === workOrder.orderId);
      const platform = normalizedOrderSource(order).orderOrigin === "platform";
      const hasRoutes = db.routes.some((route) => route.workOrderId === workOrder.id);
      workOrder.creationStatus = platform && !hasRoutes ? "pending" : "confirmed";
      changed = true;
    }
    const currentProcess = normalizeProcessName(workOrder.currentProcess);
    if (workOrder.currentProcess !== currentProcess) {
      workOrder.currentProcess = currentProcess;
      changed = true;
    }
  });
  db.orders.forEach((order) => {
    if (normalizedOrderSource(order).orderOrigin !== "platform") return;
    if (db.deliveries.some((delivery) => delivery.orderId === order.id)) return;
    const workOrders = db.workOrders.filter((workOrder) => workOrder.orderId === order.id);
    if (!workOrders.length || workOrders.some((workOrder) => workOrder.creationStatus === "pending" || workOrder.status !== "已完成")) return;
    db.deliveries.push({
      id: id("delivery"),
      orderId: order.id,
      tripId: "",
      driverId: order.shippedBy || "",
      status: order.shippedAt ? "legacy_shipped" : "waiting",
      addressSnapshot: { region: String(order.region || ""), deliveryAddress: String(order.deliveryAddress || "") },
      startedAt: order.shippedAt || "",
      deliveredAt: "",
      proofAttachmentIds: [],
      note: "",
      createdAt: order.shippedAt || new Date().toISOString(),
    });
    changed = true;
  });
  db.processes.forEach((process, index) => {
    const standardIndex = defaultProcesses.indexOf(process.name);
    const nextSort = standardIndex >= 0 ? standardIndex + 1 : defaultProcesses.length + index + 1;
    if (process.sort !== nextSort) {
      process.sort = nextSort;
      changed = true;
    }
  });
  const processOrderBeforeSort = db.processes.map((process) => process.id).join(",");
  db.processes.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "zh-Hans-CN"));
  if (processOrderBeforeSort !== db.processes.map((process) => process.id).join(",")) changed = true;
  if (changed) await writeDb(db);
  const reopenableOrderIds = new Set(db.orders.filter(canReopenOrder).map((order) => order.id));
  const activeWorkOrderIds = new Set(db.workOrders
    .filter((workOrder) => ["生产中", "异常"].includes(workOrder.status) && workOrder.creationStatus !== "pending")
    .filter((workOrder) => reopenableOrderIds.has(workOrder.orderId))
    .map((workOrder) => workOrder.id));
  const reopenedWorkOrders = new Set();
  for (const route of db.routes) {
    if (activeWorkOrderIds.has(route.workOrderId) && reopenIncompleteRoute(db, route)) reopenedWorkOrders.add(route.workOrderId);
  }
  for (const workOrderId of reopenedWorkOrders) syncWorkOrder(db, workOrderId);
  return db;
}

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsGenerator(degree) {
  let result = [1];
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    const next = Array(result.length + 1).fill(0);
    result.forEach((coef, index) => {
      next[index] ^= gfMultiply(coef, root);
      next[index + 1] ^= coef;
    });
    result = next;
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data, degree) {
  const generator = rsGenerator(degree);
  const result = Array(degree).fill(0);
  data.forEach((byte) => {
    const factor = byte ^ result.shift();
    result.push(0);
    for (let i = 0; i < degree; i += 1) result[i] ^= gfMultiply(generator[i], factor);
  });
  return result;
}

function appendBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
}

function qrFormatBits(mask) {
  let data = (1 << 3) | mask; // Error correction level L.
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537);
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
}

function qrMask(mask, x, y) {
  if (mask === 0) return (x + y) % 2 === 0;
  if (mask === 1) return y % 2 === 0;
  if (mask === 2) return x % 3 === 0;
  if (mask === 3) return (x + y) % 3 === 0;
  return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
}

function makeQrSvg(text) {
  const version = 4;
  const size = version * 4 + 17;
  const dataCodewords = 80;
  const eccCodewords = 20;
  const modules = Array.from({ length: size }, () => Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => Array(size).fill(false));
  const setFunction = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = dark;
    reserved[y][x] = true;
  };
  const drawFinder = (x, y) => {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) {
        const xx = x + dx;
        const yy = y + dy;
        const dark = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
        setFunction(xx, yy, dark);
      }
    }
  };
  const drawAlignment = (cx, cy) => {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  };
  drawFinder(0, 0);
  drawFinder(size - 7, 0);
  drawFinder(0, size - 7);
  for (let i = 8; i < size - 8; i += 1) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }
  drawAlignment(26, 26);
  setFunction(8, version * 4 + 9, true);
  for (let i = 0; i < 9; i += 1) {
    setFunction(8, i, false);
    setFunction(i, 8, false);
  }
  for (let i = 0; i < 8; i += 1) {
    setFunction(size - 1 - i, 8, false);
    setFunction(8, size - 1 - i, false);
  }

  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > dataCodewords - 3) throw new Error("二维码内容过长");
  const bits = [];
  appendBits(bits, 0x4, 4);
  appendBits(bits, bytes.length, 8);
  bytes.forEach((byte) => appendBits(bits, byte, 8));
  appendBits(bits, 0, Math.min(4, dataCodewords * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((sum, bit) => (sum << 1) | bit, 0));
  for (let pad = 0xec; data.length < dataCodewords; pad ^= 0xec ^ 0x11) data.push(pad);
  const codewords = data.concat(rsRemainder(data, eccCodewords));
  const allBits = [];
  codewords.forEach((byte) => appendBits(allBits, byte, 8));

  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let vert = 0; vert < size; vert += 1) {
      const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        if (!reserved[y][x] && bitIndex < allBits.length) modules[y][x] = Boolean(allBits[bitIndex++]);
      }
    }
  }
  const mask = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!reserved[y][x] && qrMask(mask, x, y)) modules[y][x] = !modules[y][x];
    }
  }
  const format = qrFormatBits(mask);
  const bit = (i) => Boolean((format >>> i) & 1);
  for (let i = 0; i <= 5; i += 1) setFunction(8, i, bit(i));
  setFunction(8, 7, bit(6));
  setFunction(8, 8, bit(7));
  setFunction(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) setFunction(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i += 1) setFunction(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) setFunction(8, size - 15 + i, bit(i));

  const scale = 8;
  const border = 4;
  const dim = (size + border * 2) * scale;
  const rects = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (modules[y][x]) rects.push(`<rect x="${(x + border) * scale}" y="${(y + border) * scale}" width="${scale}" height="${scale}"/>`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects.join("")}</g></svg>`;
}

async function writeDb(db) {
  if (DB_DRIVER === "mysql") {
    if (SAAS_ENABLED) {
      const context = requestContext.getStore();
      if (!context || context.platform) throw new Error("请求缺少有效租户上下文，已拒绝业务数据库写入");
      await getTenantStateStore().write(context, db);
    } else {
      const pool = createMysqlPool();
      const stateKey = requestContext.getStore()?.stateKey || MYSQL_STATE_KEY;
      await pool.execute(
        "REPLACE INTO app_state (name, value_json, updated_at) VALUES (?, CAST(? AS JSON), NOW())",
        [stateKey, JSON.stringify(db)]
      );
    }
    return;
  }
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  const visibleData = res.viewOrderFinancials ? data : redactOrderFinancials(data);
  res.end(JSON.stringify(SAAS_ENABLED ? addFileTokens(visibleData) : visibleData));
}

function redactOrderFinancials(value) {
  if (Array.isArray(value)) return value.map(redactOrderFinancials);
  if (value instanceof Date) return value;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "unitPrice" && key !== "totalAmount")
    .map(([key, item]) => [key, redactOrderFinancials(item)]));
}

function addFileTokens(value) {
  const context = requestContext.getStore();
  if (!context?.tenantId) return value;
  if (typeof value === "string") {
    if (!value.startsWith("/uploads/")) return value;
    const url = new URL(value, "http://local");
    const token = signToken({ audience: "tenant-file", tenantId: context.tenantId, path: url.pathname, expiresAt: Date.now() + 15 * 60 * 1000 }, SAAS_SESSION_SECRET);
    url.searchParams.set("fileToken", token);
    return `${url.pathname}${url.search}${url.hash}`;
  }
  if (Array.isArray(value)) return value.map(addFileTokens);
  if (value instanceof Date) return value;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, addFileTokens(item)]));
}

function sendLocalFile(res, filePath, contentType, downloadName = "") {
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return send(res, 404, { error: "图纸文件不存在" });
  }
  const headers = {
    "Content-Type": contentType || "application/octet-stream",
    "Content-Length": fs.statSync(filePath).size,
    "Cache-Control": "private, no-store",
  };
  if (downloadName) {
    headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

function drawingContentType(drawing, filePath) {
  if (drawing.contentType) return drawing.contentType;
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml; charset=utf-8",
    ".pdf": "application/pdf",
  }[ext] || "application/octet-stream";
}

function validTvDrawingViewer(db, token) {
  const viewer = viewerFromToken(db, token);
  return viewer && ["mobile-tv", "dispatch-board"].includes(viewer.audience) ? viewer : null;
}

function isDateInRange(value, from, to) {
  const dateText = String(value || "").slice(0, 10);
  if (!dateText) return false;
  if (from && dateText < from) return false;
  if (to && dateText > to) return false;
  return true;
}

function historyFilters(url, allowSourceFilters = false) {
  const dateType = String(url.searchParams.get("dateType") || "createdAt");
  return {
    customerId: String(url.searchParams.get("customerId") || "").trim(),
    status: String(url.searchParams.get("status") || "").trim(),
    processName: normalizeProcessName(url.searchParams.get("processName") || ""),
    from: normalizeDate(url.searchParams.get("from") || ""),
    to: normalizeDate(url.searchParams.get("to") || ""),
    keyword: String(url.searchParams.get("keyword") || "").trim().toLowerCase(),
    workOrderId: String(url.searchParams.get("workOrderId") || "").trim(),
    workNo: String(url.searchParams.get("workNo") || "").trim().toLowerCase(),
    dateType: ["createdAt", "dueDate", "completedAt"].includes(dateType) ? dateType : "createdAt",
    source: allowSourceFilters && ["factory", "platform", "outsourcing"].includes(url.searchParams.get("source")) ? url.searchParams.get("source") : "",
    sourceChannel: allowSourceFilters ? String(url.searchParams.get("sourceChannel") || "").trim() : "",
  };
}

function orderFulfillmentStatus(workOrder, order) {
  if (workOrder.status !== "已完成") return workOrder.status;
  if (order.invoicedAt) return "已开票";
  if (order.shippedAt) return "已发货";
  return "已完成";
}

function normalizedOrderSource(order) {
  const platform = order?.orderOrigin === "platform" && PLATFORM_SOURCE_CHANNELS.has(order?.sourceChannel);
  return {
    orderOrigin: platform ? "platform" : "factory",
    sourceChannel: platform ? order.sourceChannel : "factory_manual",
    externalOrderNumber: platform ? String(order.externalOrderNumber || "") : "",
  };
}

function validExternalSignature(req, rawBody, secret) {
  const timestamp = String(req.headers["x-integration-timestamp"] || "");
  const nonce = String(req.headers["x-integration-nonce"] || "");
  const signature = String(req.headers["x-integration-signature"] || "");
  if (!secret || !/^\d{13}$/.test(timestamp) || !nonce || nonce.length > 128 || !/^[a-f0-9]{64}$/.test(signature)) return false;
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${nonce}.${rawBody}`).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function externalOrderMatches(order, input) {
  return order.orderOrigin === "platform"
    && order.sourceChannel === input.sourceChannel
    && String(order.externalOrderNumber || "") === input.externalOrderNumber
    && String(order.externalCustomer ?? "") === input.customer
    && String(order.externalPhone ?? "") === input.phone
    && Number(order.externalQuantity ?? order.quantity) === input.quantity
    && normalizeDate(order.externalExpectedDate ?? order.dueDate) === input.expectedDate
    && String(order.externalDescription ?? order.note ?? "") === input.description
    && String(order.material ?? "") === input.material
    && String(order.dimensions ?? "") === input.dimensions
    && String(order.externalRegion ?? order.region ?? "") === input.region
    && String(order.externalDeliveryAddress ?? order.deliveryAddress ?? "") === input.deliveryAddress;
}

function queuePlatformProgress(db, route, reportId, occurredAt) {
  const workOrder = db.workOrders.find((item) => item.id === route.workOrderId);
  const order = db.orders.find((item) => item.id === workOrder?.orderId);
  const source = normalizedOrderSource(order);
  if (source.orderOrigin !== "platform" || !source.externalOrderNumber) return;
  const eventId = `bobo-report-${reportId}`;
  if (db.platformWebhookEvents.some((item) => item.event?.eventId === eventId)) return;
  const workOrderIds = new Set(db.workOrders.filter((item) => item.orderId === order.id).map((item) => item.id));
  const routes = db.routes.filter((item) => workOrderIds.has(item.workOrderId));
  const allProcessesCompleted = routes.length > 0 && routes.every((item) => item.status === "已完成" && routeQuantityComplete(item));
  order.platformWebhookSequence = Number(order.platformWebhookSequence || 0) + 1;
  db.platformWebhookEvents.push({
    status: "pending", attempts: 0, nextAttemptAt: "", lastError: "",
    event: {
      eventId, sequence: order.platformWebhookSequence, workOrderId: workOrder.id,
      externalOrderNumber: source.externalOrderNumber, type: "process.updated", occurredAt,
      allProcessesCompleted,
      processes: routes.map((item) => ({
        id: item.id, sequence: Number(item.sequence), name: item.processName,
        status: item.status === "已完成" && routeQuantityComplete(item) ? "已完成" : "待开始",
        completedAt: item.status === "已完成" && routeQuantityComplete(item) ? item.completedAt || "" : "",
      })),
      process: { id: route.id, sequence: Number(route.sequence), name: route.processName, status: route.status,
        startedAt: route.startedAt || route.lastReportedAt || "", completedAt: route.completedAt || "" },
    },
  });
}

function queuePlatformShipment(db, order, workOrder, occurredAt) {
  const source = normalizedOrderSource(order);
  if (source.orderOrigin !== "platform" || !source.externalOrderNumber) return null;
  db.platformWebhookEvents ||= [];
  const eventId = `bobo-shipment-${order.id}`;
  const existing = db.platformWebhookEvents.find((item) => item.event?.eventId === eventId);
  if (existing) {
    if (existing.status !== "delivered") { existing.status = "pending"; existing.nextAttemptAt = ""; }
    return existing;
  }
  order.platformWebhookSequence = Number(order.platformWebhookSequence || 0) + 1;
  const queued = { status: "pending", attempts: 0, nextAttemptAt: "", lastError: "", event: {
    eventId, sequence: order.platformWebhookSequence, workOrderId: workOrder.id,
    externalOrderNumber: source.externalOrderNumber, type: "shipment.shipped", occurredAt, allProcessesCompleted: true,
  } };
  db.platformWebhookEvents.push(queued);
  return queued;
}

async function resolveExternalIntegration(req, res) {
  const hasIntegrationSecret = SAAS_ENABLED
    ? Object.values(SAAS_TENANT_INTEGRATIONS).some((config) => config.inboundSecret)
    : Boolean(BOBO_INTEGRATION_SECRET);
  if (!hasIntegrationSecret) {
    send(res, 503, { error: "外部工单集成未启用" });
    return null;
  }
  const rawBody = await readRawBody(req);
  let tenant;
  let integration;
  if (SAAS_ENABLED) {
    for (const [slug, config] of Object.entries(SAAS_TENANT_INTEGRATIONS)) {
      if (config.inboundSecret && validExternalSignature(req, rawBody, config.inboundSecret)) {
        tenant = await getSaasStore().findTenantBySlug(slug);
        integration = config;
        break;
      }
    }
  } else if (validExternalSignature(req, rawBody, BOBO_INTEGRATION_SECRET)) {
    tenant = { tenantId: "legacy", stateKey: MYSQL_STATE_KEY };
    integration = { inboundSecret: BOBO_INTEGRATION_SECRET };
  }
  if (!tenant || (SAAS_ENABLED && tenant.status !== "active")) {
    send(res, 401, { error: "外部集成签名无效或租户不可用" });
    return null;
  }
  if (SAAS_ENABLED) {
    const entitlement = await getSaasStore().findActiveEntitlement(tenant.tenantId);
    if (!entitlement) {
      send(res, 402, { error: "租户授权未生效，拒绝接收新订单" });
      return null;
    }
  }
  req.integrationRawBody = rawBody;
  req.integrationConfig = integration;
  return SAAS_ENABLED ? { ...tenant, licenseActive: true, integration: true } : tenant;
}

function canDrive(user) {
  return Boolean(user && user.active !== false && (userHasRole(user, "driver") || canSupervise(user)));
}

function completedOrderWorkOrders(db, orderId) {
  const workOrders = db.workOrders.filter((workOrder) => workOrder.orderId === orderId);
  return workOrders.length > 0 && workOrders.every((workOrder) => workOrder.creationStatus !== "pending" && workOrder.status === "已完成");
}

function deliveryAvailability(db, order) {
  if (!order || normalizedOrderSource(order).orderOrigin !== "platform") return { ok: false, error: "仅平台订单可以配送" };
  if (!completedOrderWorkOrders(db, order.id)) return { ok: false, error: "订单尚未完成生产" };
  if (!String(order.region || "").trim() || !String(order.deliveryAddress || "").trim()) return { ok: false, error: "订单缺少完整配送地址" };
  const delivery = db.deliveries.find((item) => item.orderId === order.id);
  if (order.shippedAt && !delivery) return { ok: false, error: "订单已发货" };
  if (delivery && delivery.status !== "waiting") return { ok: false, error: "订单已被领取或已完成配送" };
  return { ok: true, delivery };
}

function deliveryOrderView(db, order) {
  const customer = db.customers.find((item) => item.id === order.customerId) || {};
  return {
    ...order,
    customerName: customer.name || order.externalCustomer || "",
    customerPhone: customer.phone || order.externalPhone || "",
    delivery: db.deliveries.find((item) => item.orderId === order.id) || null,
  };
}

function queueDeliveryWebhook(db, order, workOrder, delivery) {
  const source = normalizedOrderSource(order);
  if (source.orderOrigin !== "platform" || !source.externalOrderNumber) return null;
  db.platformWebhookEvents ||= [];
  const eventId = `bobo-delivery-${order.id}`;
  if (db.platformWebhookEvents.some((item) => item.event?.eventId === eventId)) return null;
  order.platformWebhookSequence = Number(order.platformWebhookSequence || 0) + 1;
  const queued = {
    status: "pending", attempts: 0, nextAttemptAt: "", lastError: "",
    event: {
      eventId,
      sequence: order.platformWebhookSequence,
      workOrderId: workOrder.id,
      externalOrderNumber: source.externalOrderNumber,
      type: "delivery.completed",
      occurredAt: delivery.deliveredAt,
      allProcessesCompleted: true,
      delivery: { id: delivery.id, tripId: delivery.tripId, deliveredAt: delivery.deliveredAt },
    },
  };
  db.platformWebhookEvents.push(queued);
  return queued;
}

let processingPlatformWebhooks = false;
async function deliverTenantWebhooks(tenant, integration) {
  if (!integration?.webhookUrl || !integration.webhookSecret) return;
  await withTenantAdvisoryLock(tenant, "webhooks", async () => {
    const db = await withTenantDatabaseLock(tenant, () => requestContext.run(tenant, () => readDb()));
    const now = Date.now();
    const pending = db.platformWebhookEvents.filter((item) => item.status !== "delivered"
      && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now));
    for (const item of pending) {
      const body = JSON.stringify(item.event);
      const timestamp = String(Date.now());
      const nonce = crypto.randomUUID();
      const signature = crypto.createHmac("sha256", integration.webhookSecret)
        .update(`${timestamp}.${nonce}.${body}`).digest("hex");
      try {
        const response = await fetch(integration.webhookUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-integration-timestamp": timestamp,
            "x-integration-nonce": nonce,
            "x-integration-signature": signature,
          },
          body,
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error(`平台回调返回 ${response.status}`);
        item.status = "delivered";
        item.lastError = "";
        item.nextAttemptAt = "";
      } catch (error) {
        item.status = "pending";
        item.attempts = Number(item.attempts || 0) + 1;
        item.lastError = String(error.message || error).slice(0, 500);
        item.nextAttemptAt = new Date(Date.now() + Math.min(60000, 1000 * 2 ** Math.min(item.attempts, 6))).toISOString();
      }
      await withTenantDatabaseLock(tenant, () => requestContext.run(tenant, async () => {
        const latest = await readDb();
        const latestEvent = latest.platformWebhookEvents.find((entry) => entry.event?.eventId === item.event.eventId);
        if (!latestEvent || latestEvent.status === "delivered") return;
        Object.assign(latestEvent, {
          status: item.status,
          attempts: item.attempts,
          lastError: item.lastError,
          nextAttemptAt: item.nextAttemptAt,
        });
        await writeDb(latest);
      }));
    }
  });
}

async function processPlatformWebhooks() {
  if (processingPlatformWebhooks) return;
  processingPlatformWebhooks = true;
  try {
    if (!SAAS_ENABLED) {
      if (!FUTURE_WEBHOOK_URL || !BOBO_INTEGRATION_SECRET) return;
      await deliverTenantWebhooks({ tenantId: "legacy", stateKey: MYSQL_STATE_KEY }, {
        webhookUrl: FUTURE_WEBHOOK_URL,
        webhookSecret: BOBO_INTEGRATION_SECRET,
      });
      return;
    }
    const integrations = Object.entries(SAAS_TENANT_INTEGRATIONS)
      .filter(([, config]) => config.webhookUrl && config.webhookSecret);
    for (const [slug, integration] of integrations) {
      const tenant = await getSaasStore().findTenantBySlug(slug);
      if (tenant?.status === "active") await deliverTenantWebhooks(tenant, integration);
    }
  } finally {
    processingPlatformWebhooks = false;
  }
}

async function backfillPlatformOrder(orderNumber) {
  if (SAAS_ENABLED || DB_DRIVER !== "json" || !orderNumber) throw new Error("回填仅支持指定本地 JSON 数据库中的订单号");
  const db = await readDb();
  const order = db.orders.find((item) => normalizedOrderSource(item).externalOrderNumber === orderNumber);
  if (!order) throw new Error("未找到对应平台订单");
  const workOrderIds = new Set(db.workOrders.filter((item) => item.orderId === order.id).map((item) => item.id));
  const before = db.platformWebhookEvents.length;
  for (const route of db.routes.filter((item) => workOrderIds.has(item.workOrderId)).sort((a, b) => a.sequence - b.sequence)) {
    const report = db.reports.filter((item) => item.routeId === route.id)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (report) queuePlatformProgress(db, route, report.id, report.createdAt);
  }
  if (db.platformWebhookEvents.length !== before) await writeDb(db);
}

function attachmentByUrl(db, url) {
  return db.attachments.find((item) => item.url === url) || null;
}

function workOrderHistoryItems(db, filters, includeCustomerFeedbacks = false, allowSourceFilters = false, outsourcingTasks = []) {
  const taskByOrderId = new Map(outsourcingTasks.filter((task) => task.status !== "cancelled").map((task) => [task.ownerOrderId, task]));
  const items = db.workOrders
    .filter((item) => !filters.workOrderId || item.id === filters.workOrderId)
    .filter((item) => !filters.workNo || String(item.workNo || "").trim().toLowerCase() === filters.workNo)
    .map((workOrder) => {
      const order = db.orders.find((item) => item.id === workOrder.orderId) || {};
      const outsourcingTask = taskByOrderId.get(order.id);
      const customer = db.customers.find((item) => item.id === order.customerId) || {};
      const routes = db.routes.filter((item) => item.workOrderId === workOrder.id).sort((a, b) => a.sequence - b.sequence);
      const drawings = (db.drawings || []).filter((item) => item.workOrderId === workOrder.id || item.orderId === order.id);
      const qualityExceptions = db.exceptions
        .filter((item) => item.workOrderId === workOrder.id && (item.qualityRouteId || item.source === "quality-inspection"))
        .map((item) => ({ ...item, processName: db.routes.find((route) => route.id === item.issueRouteId || route.id === item.routeId)?.processName || item.type || "", reporterName: resolveUser(db, item.reporterId)?.name || "", resolvedByName: resolveUser(db, item.resolvedBy)?.name || "" }));
      const customerFeedbacks = includeCustomerFeedbacks
        ? db.customerFeedbacks.filter((item) => item.workOrderId === workOrder.id).map((item) => ({ ...item, processName: db.routes.find((route) => route.id === item.routeId)?.processName || "", reporterName: resolveUser(db, item.reporterId)?.name || "", resolvedByName: resolveUser(db, item.resolvedBy)?.name || "" }))
        : null;
      const source = normalizedOrderSource(order);
      return {
        id: workOrder.id,
        workNo: workOrder.workNo,
        orderNo: order.orderNo || "",
        orderId: order.id || "",
        customerId: customer.id || "",
        customerName: customer.name || "",
        productName: workOrder.productName || order.productName || "",
        drawingNo: order.drawingNo || "",
        planQty: workOrder.planQty,
        quantityUnit: normalizeQuantityUnit(order.quantityUnit),
        status: orderFulfillmentStatus(workOrder, order),
        productionStatus: workOrder.status,
        weightKg: order.weightKg ?? null,
        priority: order.priority || "普通",
        note: order.note || "",
        shippedAt: order.shippedAt || "",
        invoicedAt: order.invoicedAt || "",
        dueDate: order.dueDate || "",
        ...source,
        isOutsourced: Boolean(outsourcingTask),
        ...(outsourcingTask ? { outsourcing: {
          taskId: outsourcingTask.taskId,
          status: outsourcingTask.status,
          partnerName: outsourcingTask.partnerName || "外协单位",
          createdAt: outsourcingTask.createdAt || "",
          partnerAcceptedAt: outsourcingTask.partnerAcceptedAt || "",
          dueDate: outsourcingTask.dueDate || "",
          productionValueFen: Number(outsourcingTask.productionValueFen || 0),
          production: outsourcingTask.production ? {
            routes: outsourcingTask.production.routes || [],
            reports: outsourcingTask.production.reports || [],
            finalProcessCompletedAt: outsourcingTask.production.finalProcessCompletedAt || "",
          } : null,
        } } : {}),
        createdAt: workOrder.createdAt || order.createdAt || "",
        completedAt: outsourcingTask?.production?.finalProcessCompletedAt || workOrderCompletedAt(db, workOrder),
        routes,
        drawings,
        qualityExceptions,
        ...(includeCustomerFeedbacks ? { customerFeedbacks } : {}),
      };
    })
    .filter((item) => !filters.customerId || item.customerId === filters.customerId)
    .filter((item) => !filters.status || item.status === filters.status)
    .filter((item) => (!filters.from && !filters.to) || isDateInRange(item[filters.dateType], filters.from, filters.to))
    .filter((item) => {
      if (!filters.keyword) return true;
      return [item.workNo, item.orderNo, item.customerName, item.productName, item.drawingNo]
        .some((value) => String(value || "").toLowerCase().includes(filters.keyword));
    })
    .sort((a, b) => String(b[filters.dateType] || b.createdAt || b.dueDate).localeCompare(String(a[filters.dateType] || a.createdAt || a.dueDate)));
  return filterWorkOrderSources(items, filters, allowSourceFilters);
}

function exceptionHistoryItems(db, filters) {
  return db.exceptions
    .map((item) => {
      const route = db.routes.find((routeItem) => routeItem.id === item.routeId) || {};
      const workOrder = db.workOrders.find((workItem) => workItem.id === item.workOrderId) || {};
      const order = db.orders.find((orderItem) => orderItem.id === workOrder.orderId) || {};
      const customer = db.customers.find((customerItem) => customerItem.id === order.customerId) || {};
      return {
        ...item,
        workNo: workOrder.workNo || "",
        orderNo: order.orderNo || "",
        customerId: customer.id || "",
        customerName: customer.name || "",
        productName: workOrder.productName || order.productName || "",
        processName: route.processName || "",
        disposition: item.disposition || "",
        attachments: (item.images || []).map((url) => attachmentByUrl(db, url)).filter(Boolean),
      };
    })
    .filter((item) => !filters.customerId || item.customerId === filters.customerId)
    .filter((item) => !filters.status || item.status === filters.status)
    .filter((item) => !filters.processName || normalizeProcessName(item.processName) === filters.processName)
    .filter((item) => !filters.from || isDateInRange(item.createdAt, filters.from, filters.to))
    .filter((item) => {
      if (!filters.keyword) return true;
      return [item.workNo, item.orderNo, item.customerName, item.productName, item.processName, item.type, item.description]
        .some((value) => String(value || "").toLowerCase().includes(filters.keyword));
    })
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

function saveDataUrlFile(body, options = {}) {
  const allowImagesOnly = options.allowImagesOnly !== false;
  const match = String(body.dataUrl || "").match(/^data:([a-zA-Z0-9.+/-]+);base64,(.+)$/);
  if (!match) return { error: "缺少有效的 dataUrl" };
  const contentType = match[1].toLowerCase();
  if (allowImagesOnly && !contentType.startsWith("image/")) return { error: "只支持图片 dataUrl" };
  const extByType = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "application/pdf": "pdf",
    "application/acad": "dwg",
    "application/x-acad": "dwg",
    "application/dxf": "dxf",
    "application/x-dxf": "dxf",
  };
  const sourceName = String(body.name || "").trim();
  const nameExt = path.extname(sourceName).replace(".", "").toLowerCase();
  const ext = extByType[contentType] || nameExt;
  const allowed = options.allowedExts || ["png", "jpg", "jpeg", "gif"];
  if (!allowed.includes(ext)) return { error: `不支持的文件类型：${ext || contentType}` };
  let targetDir = options.targetDir || UPLOAD_DIR;
  let urlPrefix = options.urlPrefix || "/uploads";
  if (SAAS_ENABLED) {
    const relativeDir = options.targetDir ? path.relative(UPLOAD_DIR, options.targetDir) : "";
    if (relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) return { error: "租户文件目录无效" };
    const kind = relativeDir && relativeDir !== "." ? relativeDir.replaceAll(path.sep, "/") : "";
    targetDir = tenantUploadDirectory(kind);
    urlPrefix = tenantUploadPrefix(kind);
  }
  fs.mkdirSync(targetDir, { recursive: true });
  const fileName = `${id(options.prefix || "file")}.${ext === "jpeg" ? "jpg" : ext}`;
  fs.writeFileSync(path.join(targetDir, fileName), Buffer.from(match[2], "base64"));
  return {
    fileName,
    url: `${urlPrefix}/${fileName}`,
    contentType,
    fileType: ext,
    originalName: sourceName || fileName,
  };
}

function isCadDrawing(fileType) {
  return ["dwg", "dxf"].includes(String(fileType || "").toLowerCase());
}

function cadPreviewPath(fileName) {
  return path.join(tenantUploadDirectory("previews"), `${path.parse(fileName).name}.svg`);
}

function normalizeCadSvg(svg) {
  const style = '<style id="cad-preview-visible-style">line,path,polyline,polygon,circle,ellipse{stroke:#111827!important;stroke-width:0.35px!important;vector-effect:non-scaling-stroke!important}text,tspan{fill:#111827!important;stroke:none!important}</style>';
  const source = String(svg).includes("cad-preview-visible-style")
    ? String(svg)
    : String(svg).replace(/<svg\b([^>]*)>/i, `<svg$1>${style}`);
  return normalizeCadViewBox(source)
    .replace(/stroke-width\s*:\s*0(?:\.0+)?(?:px)?/gi, "stroke-width:0.25px")
    .replace(/stroke-width=(["'])0(?:\.0+)?(?:px)?\1/gi, 'stroke-width="0.25px"')
    .replace(/stroke\s*:\s*(#[0-9a-f]{3,6}|white|rgb\([^)]+\))/gi, (match, color) => `stroke:${normalizeCadColor(color)}`)
    .replace(/stroke=(["'])(#[0-9a-f]{3,6}|white|rgb\([^)]+\))\1/gi, (_match, _quote, color) => `stroke="${normalizeCadColor(color)}"`);
}

function svgAttribute(tag, name) {
  const match = String(tag).match(new RegExp(`${name}=["']([^"']+)["']`, "i"));
  return match ? match[1] : "";
}

function svgNumbers(text) {
  return String(text).match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi)?.map(Number).filter(Number.isFinite) || [];
}

function svgShapeBounds(svg) {
  const shapes = [];
  String(svg).replace(/<(line|polyline|polygon|circle|ellipse|path)\b[^>]*>/gi, (tag, type) => {
    const bounds = createBounds();
    if (type === "line") {
      addBounds(bounds, { x: dxfNumber(svgAttribute(tag, "x1")), y: dxfNumber(svgAttribute(tag, "y1")) });
      addBounds(bounds, { x: dxfNumber(svgAttribute(tag, "x2")), y: dxfNumber(svgAttribute(tag, "y2")) });
    } else if (type === "circle") {
      const cx = dxfNumber(svgAttribute(tag, "cx"));
      const cy = dxfNumber(svgAttribute(tag, "cy"));
      const r = Math.abs(dxfNumber(svgAttribute(tag, "r")));
      addBounds(bounds, { x: cx - r, y: cy - r });
      addBounds(bounds, { x: cx + r, y: cy + r });
    } else if (type === "ellipse") {
      const cx = dxfNumber(svgAttribute(tag, "cx"));
      const cy = dxfNumber(svgAttribute(tag, "cy"));
      const rx = Math.abs(dxfNumber(svgAttribute(tag, "rx")));
      const ry = Math.abs(dxfNumber(svgAttribute(tag, "ry")));
      addBounds(bounds, { x: cx - rx, y: cy - ry });
      addBounds(bounds, { x: cx + rx, y: cy + ry });
    } else if (type === "polyline" || type === "polygon") {
      const values = svgNumbers(svgAttribute(tag, "points"));
      for (let index = 0; index < values.length - 1; index += 2) addBounds(bounds, { x: values[index], y: values[index + 1] });
    } else if (type === "path") {
      const values = svgNumbers(svgAttribute(tag, "d"));
      for (let index = 0; index < values.length - 1; index += 2) addBounds(bounds, { x: values[index], y: values[index + 1] });
    }
    if (Number.isFinite(bounds.minX)) shapes.push(bounds);
    return tag;
  });
  return shapes;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)));
  return sorted[index];
}

function percentileCadBounds(boundsList) {
  const centers = boundsList.map(boundsCenter);
  const sizes = boundsList.map(boundsSize);
  const threshold = Math.max(1, percentile(sizes, 0.6));
  const denseMinX = percentile(centers.map((point) => point.x), 0.05);
  const denseMaxX = percentile(centers.map((point) => point.x), 0.95);
  const denseMinY = percentile(centers.map((point) => point.y), 0.05);
  const denseMaxY = percentile(centers.map((point) => point.y), 0.95);
  const selected = boundsList.filter((bounds) => {
    const center = boundsCenter(bounds);
    const isDense = center.x >= denseMinX && center.x <= denseMaxX && center.y >= denseMinY && center.y <= denseMaxY;
    return isDense || boundsSize(bounds) >= threshold * 4;
  });
  const result = createBounds();
  (selected.length ? selected : boundsList).forEach((bounds) => mergeBounds(result, bounds));
  return Number.isFinite(result.minX) ? result : null;
}

function mainCadBounds(boundsList) {
  if (!boundsList.length) return null;
  if (boundsList.length >= 10) return percentileCadBounds(boundsList);
  const primary = boundsList.reduce((best, item) => (boundsScore(item) > boundsScore(best) ? item : best), boundsList[0]);
  const primaryCenter = boundsCenter(primary);
  const primarySize = Math.max(100, boundsSize(primary));
  const visible = boundsList.filter((item) => {
    const itemSize = boundsSize(item);
    const maxDistance = Math.max(primarySize * 8, 500);
    return itemSize >= primarySize * 0.25 || distance(boundsCenter(item), primaryCenter) <= maxDistance;
  });
  const bounds = createBounds();
  visible.forEach((item) => mergeBounds(bounds, item));
  return Number.isFinite(bounds.minX) ? bounds : null;
}

function normalizeCadViewBox(svg) {
  const bounds = mainCadBounds(svgShapeBounds(svg));
  if (!bounds) return svg;
  const padding = Math.max(10, (boundsWidth(bounds) + boundsHeight(bounds)) / 40);
  const viewBox = `${bounds.minX - padding} ${bounds.minY - padding} ${Math.max(1, boundsWidth(bounds) + padding * 2)} ${Math.max(1, boundsHeight(bounds) + padding * 2)}`;
  return String(svg).includes("viewBox=")
    ? String(svg).replace(/viewBox=(["'])[^"']+\1/i, `viewBox="${viewBox}"`)
    : String(svg).replace(/<svg\b([^>]*)>/i, `<svg$1 viewBox="${viewBox}">`);
}

function cadPreviewUrl(previewUrl) {
  if (!previewUrl) return "";
  const previewFile = path.join(tenantUploadDirectory("previews"), path.basename(String(previewUrl).split("?")[0]));
  const version = fs.existsSync(previewFile) ? Math.round(fs.statSync(previewFile).mtimeMs) : Date.now();
  return `${String(previewUrl).split("?")[0]}?v=${version}`;
}

function cadPreviewPageUrl(previewUrl, downloadUrl, name) {
  const sourceUrl = cadPreviewUrl(previewUrl);
  if (!sourceUrl) return "";
  return `/cad-preview.html?src=${encodeURIComponent(sourceUrl)}&download=${encodeURIComponent(downloadUrl)}&name=${encodeURIComponent(name)}`;
}

function normalizeCadColor(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "white") return "#111827";
  const rgbMatch = text.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  if (rgbMatch) {
    const [r, g, b] = rgbMatch.slice(1).map(Number);
    return r > 220 && g > 220 && b > 220 ? "#111827" : value;
  }
  const hex = text.startsWith("#") ? text.slice(1) : "";
  const fullHex = hex.length === 3 ? hex.split("").map((char) => char + char).join("") : hex;
  if (!/^[0-9a-f]{6}$/.test(fullHex)) return value;
  const r = parseInt(fullHex.slice(0, 2), 16);
  const g = parseInt(fullHex.slice(2, 4), 16);
  const b = parseInt(fullHex.slice(4, 6), 16);
  return r > 220 && g > 220 && b > 220 ? "#111827" : value;
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" }[char]));
}

function readDxfPairs(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const pairs = [];
  for (let index = 0; index < lines.length - 1; index += 2) {
    pairs.push({ code: lines[index].trim(), value: lines[index + 1].trim() });
  }
  return pairs;
}

function dxfNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function dxfPoint(entity, xCode, yCode) {
  return { x: dxfNumber(entity[xCode]), y: dxfNumber(entity[yCode]) };
}

function addBounds(bounds, point) {
  bounds.minX = Math.min(bounds.minX, point.x);
  bounds.minY = Math.min(bounds.minY, point.y);
  bounds.maxX = Math.max(bounds.maxX, point.x);
  bounds.maxY = Math.max(bounds.maxY, point.y);
}

function createBounds() {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function mergeBounds(target, source) {
  addBounds(target, { x: source.minX, y: source.minY });
  addBounds(target, { x: source.maxX, y: source.maxY });
}

function boundsWidth(bounds) {
  return Math.max(0, bounds.maxX - bounds.minX);
}

function boundsHeight(bounds) {
  return Math.max(0, bounds.maxY - bounds.minY);
}

function boundsCenter(bounds) {
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

function boundsSize(bounds) {
  return Math.max(boundsWidth(bounds), boundsHeight(bounds));
}

function boundsScore(bounds) {
  return Math.max(1, boundsWidth(bounds)) * Math.max(1, boundsHeight(bounds));
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function dxfArcPath(cx, cy, radius, startDeg, endDeg) {
  const start = (startDeg * Math.PI) / 180;
  const end = (endDeg * Math.PI) / 180;
  const startPoint = { x: cx + radius * Math.cos(start), y: cy + radius * Math.sin(start) };
  const endPoint = { x: cx + radius * Math.cos(end), y: cy + radius * Math.sin(end) };
  const sweep = ((endDeg - startDeg + 360) % 360) || 360;
  const largeArc = sweep > 180 ? 1 : 0;
  return `M ${startPoint.x} ${-startPoint.y} A ${radius} ${radius} 0 ${largeArc} 0 ${endPoint.x} ${-endPoint.y}`;
}

function dxfEntityFromPairs(pairs, startIndex) {
  const type = pairs[startIndex].value;
  const entity = { type, vertices: [] };
  let index = startIndex + 1;
  for (; index < pairs.length; index += 1) {
    const pair = pairs[index];
    if (pair.code === "0") break;
    if (type === "LWPOLYLINE" && pair.code === "10") {
      const yPair = pairs[index + 1];
      if (yPair && yPair.code === "20") entity.vertices.push({ x: dxfNumber(pair.value), y: dxfNumber(yPair.value) });
    }
    entity[pair.code] = pair.value;
  }
  return { entity, nextIndex: index };
}

function dxfToSvg(text, title = "CAD 预览") {
  const pairs = readDxfPairs(text);
  const shapes = [];
  for (let index = 0; index < pairs.length; index += 1) {
    if (pairs[index].code !== "0") continue;
    const type = pairs[index].value;
    if (type === "LINE") {
      const result = dxfEntityFromPairs(pairs, index);
      const start = dxfPoint(result.entity, "10", "20");
      const end = dxfPoint(result.entity, "11", "21");
      const bounds = createBounds();
      addBounds(bounds, start);
      addBounds(bounds, end);
      shapes.push({ markup: `<line x1="${start.x}" y1="${-start.y}" x2="${end.x}" y2="${-end.y}"/>`, bounds });
      index = result.nextIndex - 1;
    } else if (type === "LWPOLYLINE") {
      const result = dxfEntityFromPairs(pairs, index);
      if (result.entity.vertices.length > 1) {
        const bounds = createBounds();
        result.entity.vertices.forEach((point) => addBounds(bounds, point));
        const points = result.entity.vertices.map((point) => `${point.x},${-point.y}`).join(" ");
        const closed = (Number(result.entity["70"] || 0) & 1) === 1;
        shapes.push({ markup: `<polyline points="${points}"${closed ? " data-closed=\"true\"" : ""}/>`, bounds });
      }
      index = result.nextIndex - 1;
    } else if (type === "CIRCLE" || type === "ARC") {
      const result = dxfEntityFromPairs(pairs, index);
      const center = dxfPoint(result.entity, "10", "20");
      const radius = Math.abs(dxfNumber(result.entity["40"]));
      const bounds = createBounds();
      addBounds(bounds, { x: center.x - radius, y: center.y - radius });
      addBounds(bounds, { x: center.x + radius, y: center.y + radius });
      if (type === "CIRCLE") {
        shapes.push({ markup: `<circle cx="${center.x}" cy="${-center.y}" r="${radius}"/>`, bounds });
      } else {
        shapes.push({ markup: `<path d="${dxfArcPath(center.x, center.y, radius, dxfNumber(result.entity["50"]), dxfNumber(result.entity["51"]))}"/>`, bounds });
      }
      index = result.nextIndex - 1;
    }
  }
  if (!shapes.length) return "";
  const primary = shapes.reduce((best, item) => (boundsScore(item.bounds) > boundsScore(best.bounds) ? item : best), shapes[0]);
  const primaryCenter = boundsCenter(primary.bounds);
  const primarySize = Math.max(100, boundsSize(primary.bounds));
  const visibleShapes = shapes.filter((item) => {
    const itemSize = boundsSize(item.bounds);
    const maxDistance = Math.max(primarySize * 8, 500);
    return itemSize >= primarySize * 0.25 || distance(boundsCenter(item.bounds), primaryCenter) <= maxDistance;
  });
  const bounds = createBounds();
  visibleShapes.forEach((item) => mergeBounds(bounds, item.bounds));
  if (!Number.isFinite(bounds.minX)) return "";
  const padding = Math.max(10, (bounds.maxX - bounds.minX + bounds.maxY - bounds.minY) / 40);
  const minX = bounds.minX - padding;
  const minY = -bounds.maxY - padding;
  const width = Math.max(1, bounds.maxX - bounds.minX + padding * 2);
  const height = Math.max(1, bounds.maxY - bounds.minY + padding * 2);
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${width} ${height}"><title>${escapeXml(title)}</title><rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="#fff"/><g fill="none" stroke="#111827" stroke-width="0.25px" vector-effect="non-scaling-stroke">${visibleShapes.map((item) => item.markup).join("")}</g></svg>`;
}

function cadPreviewCommands(fileType) {
  const configured = CAD_PREVIEW_COMMAND ? [CAD_PREVIEW_COMMAND] : [];
  const defaults = String(fileType || "").toLowerCase() === "dxf" ? ["dxf2svg", "dwg2SVG"] : ["dwg2SVG"];
  return [...new Set([...configured, ...defaults])];
}

function runCadPreviewCommand(command, sourcePath, fileName) {
  return new Promise((resolve) => {
    const chunks = [];
    const errorChunks = [];
    let converter;
    try {
      converter = spawn(command, [sourcePath], { windowsHide: true });
    } catch (error) {
      resolve({ ok: false, error: String(error.message || error) });
      return;
    }
    converter.stdout.on("data", (chunk) => chunks.push(chunk));
    converter.stderr.on("data", (chunk) => errorChunks.push(chunk));
    converter.on("error", (error) => resolve({ ok: false, error: String(error.message || error) }));
    converter.on("close", (code) => {
      const svgText = Buffer.concat(chunks).toString("utf8");
      const stderr = Buffer.concat(errorChunks).toString("utf8").trim();
      if (code === 0 && svgText.includes("<svg")) {
        resolve({ ok: true, svgText });
        return;
      }
      console.error("CAD preview generation failed", {
        command,
        file: fileName,
        code,
        stderr: stderr.slice(0, 500),
      });
      resolve({ ok: false, error: stderr });
    });
  });
}

async function generateCadPreview(drawing) {
  if (!isCadDrawing(drawing.fileType)) return { previewUrl: "", previewError: "" };
  const fileName = drawing.fileName || path.basename(String(drawing.url || ""));
  const sourcePath = path.join(tenantUploadDirectory("drawings"), fileName);
  const targetPath = cadPreviewPath(fileName);
  if (!fs.existsSync(sourcePath)) return { previewUrl: "", previewError: "CAD 预览生成失败" };
  const previewDir = tenantUploadDirectory("previews");
  fs.mkdirSync(previewDir, { recursive: true });
  if (String(drawing.fileType || "").toLowerCase() === "dxf") {
    const previewSvg = dxfToSvg(fs.readFileSync(sourcePath, "utf8"), drawing.originalName || drawing.name || fileName);
    if (previewSvg) {
      fs.writeFileSync(targetPath, previewSvg);
      return { previewUrl: `/uploads/previews/${path.basename(targetPath)}`, previewError: "" };
    }
  }
  for (const command of cadPreviewCommands(drawing.fileType)) {
    const preview = await runCadPreviewCommand(command, sourcePath, fileName);
    if (!preview.ok) continue;
    fs.writeFileSync(targetPath, normalizeCadSvg(preview.svgText));
    return { previewUrl: `/uploads/previews/${path.basename(targetPath)}`, previewError: "" };
  }
  return { previewUrl: "", previewError: "CAD 预览生成失败" };
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > 1024 * 1024) {
        tooLarge = true;
        const error = new Error("请求体过大");
        error.statusCode = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 8 * 1024 * 1024) reject(new Error("请求体过大"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("JSON 格式错误"));
      }
    });
  });
}

function currentUser(req, db) {
  if (SAAS_ENABLED) {
    const context = requestContext.getStore();
    if (!context?.tenantId || !req.saasUserId || req.saasTenantId !== context.tenantId) return null;
    return db.users.find((user) => user.id === req.saasUserId && user.active);
  }
  const userId = req.headers["x-user-id"];
  return db.users.find((u) => u.id === userId && u.active);
}

function signTvViewerToken(user, audience = "mobile-tv") {
  if (!TV_VIEW_TOKEN_SECRET) return "";
  const tenantId = requestContext.getStore()?.tenantId || "legacy";
  const payload = Buffer.from(JSON.stringify({
    userId: user.id,
    tenantId,
    audience,
    expiresAt: Date.now() + TV_VIEW_TOKEN_TTL_MS,
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", TV_VIEW_TOKEN_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function viewerFromToken(db, token) {
  if (!TV_VIEW_TOKEN_SECRET || !token) return null;
  const [payload, signature, extra] = String(token).split(".");
  if (!payload || !signature || extra) return null;
  const expected = crypto.createHmac("sha256", TV_VIEW_TOKEN_SECRET).update(payload).digest();
  let received;
  try {
    received = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.audience || Number(data.expiresAt) <= Date.now()) return null;
    const contextTenantId = requestContext.getStore()?.tenantId;
    if (data.tenantId && contextTenantId && data.tenantId !== contextTenantId) return null;
    const user = db.users.find((item) => item.id === data.userId && item.active);
    return user ? { user, audience: data.audience } : null;
  } catch {
    return null;
  }
}

function tvViewerFromToken(db, token) {
  const viewer = viewerFromToken(db, token);
  return viewer && ["mobile-tv", "dispatch-board"].includes(viewer.audience) ? viewer.user : null;
}

function isValidRole(role) {
  return Object.prototype.hasOwnProperty.call(roles, role);
}

function resolveUser(db, userId) {
  if (!userId) return null;
  const user = db.users.find((u) => u.id === userId);
  if (user) return { ...user, deleted: false };
  const deletedUser = (db.deletedUsers || []).find((u) => u.id === userId);
  return deletedUser ? { ...deletedUser, deleted: true } : null;
}

function qualityRouteMeta(db, route) {
  if (route.processName !== "质检") return {};
  const routes = db.routes.filter((item) => item.workOrderId === route.workOrderId);
  const sourceRoute = routes
    .filter((item) => item.processName !== "质检" && item.routeType !== "rework" && item.sequence < route.sequence)
    .sort((a, b) => b.sequence - a.sequence)[0];
  const reworkRoutes = routes.filter((item) => item.sourceQualityRouteId === route.id);
  const availableFromProduction = Number(sourceRoute?.completedQty || 0);
  const availableFromRework = reworkRoutes
    .filter((item) => item.status === "已完成")
    .reduce((sum, item) => sum + Number(item.completedQty || 0), 0);
  const submittedQty = db.reports
    .filter((item) => item.routeId === route.id && item.reportType === "quality")
    .reduce((sum, item) => sum + Number(item.submittedQty || 0), 0);
  const remainingQty = Math.max(0, Number(route.planQty || 0) - Number(route.completedQty || 0));
  const sourceCompleted = sourceRoute?.status === "已完成";
  return {
    sourceCompleted,
    inspectionAvailableQty: sourceCompleted ? Math.max(0, Math.min(remainingQty, availableFromProduction + availableFromRework - submittedQty)) : 0,
    pendingReworkQty: reworkRoutes
      .filter((item) => item.status !== "已完成")
      .reduce((sum, item) => sum + Math.max(0, Number(item.planQty || 0) - Number(item.completedQty || 0)), 0),
  };
}

function enrichRoute(db, route) {
  return { ...route, ...qualityRouteMeta(db, route) };
}

function workOrderCompletedAt(db, workOrder) {
  if (workOrder.completedAt && !Number.isNaN(new Date(workOrder.completedAt).getTime())) return workOrder.completedAt;
  if (workOrder.status !== "已完成") return "";
  return db.routes
    .filter((route) => route.workOrderId === workOrder.id && route.status === "已完成")
    .map((route) => route.completedAt || route.lastReportedAt || "")
    .filter(Boolean)
    .sort()
    .at(-1) || "";
}

function shanghaiDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function completionPeriodRange(period, now = new Date()) {
  const periodDays = { today: 1, "3d": 3, "7d": 7, "30d": 30 };
  const days = periodDays[period];
  if (!days) return null;
  const to = shanghaiDateKey(now);
  const start = new Date(`${to}T00:00:00+08:00`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { period, from: shanghaiDateKey(start), to };
}

function mobileCompletionData(db, period, includeItems) {
  const range = completionPeriodRange(period);
  if (!range) return null;
  const completed = db.workOrders
    .filter((workOrder) => workOrder.status === "已完成")
    .map((workOrder) => ({ workOrder, completedAt: workOrderCompletedAt(db, workOrder) }))
    .filter((entry) => {
      const key = shanghaiDateKey(entry.completedAt);
      return key && key >= range.from && key <= range.to;
    })
    .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
  const result = { ...range, count: completed.length };
  if (!includeItems) return result;
  result.items = completed.map(({ workOrder, completedAt }) => {
    const order = db.orders.find((item) => item.id === workOrder.orderId) || {};
    const customer = db.customers.find((item) => item.id === order.customerId) || {};
    const allOrderWorkOrdersCompleted = db.workOrders
      .filter((item) => item.orderId === order.id)
      .every((item) => item.status === "已完成");
    return {
      id: workOrder.id,
      workNo: workOrder.workNo,
      orderNo: order.orderNo || "",
      orderId: order.id || "",
      productName: workOrder.productName || order.productName || "",
      customerName: customer.name || "",
      planQty: Number(workOrder.planQty || 0),
      quantityUnit: normalizeQuantityUnit(order.quantityUnit),
      completedAt,
      status: orderFulfillmentStatus(workOrder, order),
      shippedAt: order.shippedAt || "",
      invoicedAt: order.invoicedAt || "",
      canUpdateFulfillment: Boolean(order.id && allOrderWorkOrdersCompleted),
    };
  });
  return result;
}

function enrich(db) {
  const byId = (list, itemId) => list.find((item) => item.id === itemId);
  const routes = db.routes.map((route) => enrichRoute(db, route));
  const workOrders = db.workOrders.map((wo) => {
    const order = byId(db.orders, wo.orderId);
    const customer = order ? byId(db.customers, order.customerId) : null;
    const workOrderRoutes = routes.filter((r) => r.workOrderId === wo.id).sort((a, b) => a.sequence - b.sequence);
    const drawings = db.drawings.filter((item) => !item.removedAt && (item.workOrderId === wo.id || item.orderId === wo.orderId));
    const done = workOrderRoutes.reduce((sum, r) => sum + Number(r.completedQty || 0), 0);
    const total = workOrderRoutes.reduce((sum, r) => sum + Number(r.planQty || 0), 0) || wo.planQty;
    const progress = Math.min(100, Math.round((done / total) * 100));
    const hasException = db.exceptions.some((e) => e.workOrderId === wo.id && e.status !== "已解决");
    const overdue = order && order.dueDate < today(0) && wo.status !== "已完成";
    return { ...wo, completedAt: workOrderCompletedAt(db, wo), order, customer, routes: workOrderRoutes, drawings, progress, hasException, overdue };
  });
  const orders = db.orders.map((order) => ({ ...order, ...normalizedOrderSource(order) }));
  return { ...db, orders, routes, workOrders };
}

function canManage(userOrRole) {
  if (typeof userOrRole === "string") return ["owner", "manager", "office", "admin"].includes(userOrRole);
  return getUserRoles(userOrRole).some((role) => ["owner", "manager", "office", "admin"].includes(role));
}

function canSupervise(userOrRole) {
  if (typeof userOrRole === "string") return ["owner", "manager", "admin"].includes(userOrRole);
  return getUserRoles(userOrRole).some((role) => ["owner", "manager", "admin"].includes(role));
}

function canForceDeleteWorkOrders(user) {
  return Boolean(user && user.active && user.phone === ULTIMATE_WORK_ORDER_ADMIN_PHONE);
}

function canDeleteCustomers(user) {
  return Boolean(user && user.active && user.phone === ULTIMATE_WORK_ORDER_ADMIN_PHONE);
}

function canViewRestrictedBoard(user) {
  const phone = String(user?.phone || "").replace(/\D/g, "").slice(-11);
  return Boolean(user && user.active && RESTRICTED_VIEW_PHONES.has(phone));
}

function userPermissions(user) {
  return {
    forceDeleteWorkOrders: canForceDeleteWorkOrders(user),
    editOrders: canSupervise(user),
    viewOrderFinancials: canSupervise(user),
    viewAuditLogs: canSupervise(user),
    deleteCustomers: canDeleteCustomers(user),
    viewTv: Boolean(user && user.active),
    viewBoardCustomer: canViewRestrictedBoard(user),
    manageCustomerFeedback: canViewRestrictedBoard(user),
    manageOrderFulfillment: canViewRestrictedBoard(user),
  };
}

function cleanAuditValue(value, depth = 0) {
  if (depth > 4) return "[omitted]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => cleanAuditValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const result = {};
  Object.entries(value).forEach(([key, item]) => {
    if (/password|base64|dataurl|filecontent/i.test(key)) return;
    result[key] = cleanAuditValue(item, depth + 1);
  });
  return result;
}

function pruneAuditLogs(db, now = Date.now()) {
  const cutoff = now - AUDIT_RETENTION_MS;
  db.auditLogs = (db.auditLogs || []).filter((item) => {
    const createdAt = new Date(item.createdAt || 0).getTime();
    return Number.isFinite(createdAt) && createdAt >= cutoff;
  });
}

function appendAudit(db, user, action, targetType, targetId, detail = {}) {
  pruneAuditLogs(db);
  db.auditLogs.push({
    id: id("log"),
    actorId: user?.id || "",
    action,
    targetType,
    targetId: targetId || "",
    detail: cleanAuditValue(detail),
    createdAt: new Date().toISOString(),
  });
}

function isShopWorker(userOrRole) {
  if (typeof userOrRole === "string") return rolePriority[userOrRole] > 0 && rolePriority[userOrRole] <= 30;
  return getUserRoles(userOrRole).some((role) => rolePriority[role] > 0 && rolePriority[role] <= 30);
}

function canOperateRoute(user, route) {
  if (!user || !route) return { ok: false, error: "请先登录" };
  if (route.assignedTo && route.assignedTo !== user.id) return { ok: false, error: "该工序已指定给其他员工" };
  if (canManage(user)) return { ok: true };
  const assignedRole = route.assignedRole || getProcessRole(route.processName);
  if (assignedRole && userHasRole(user, assignedRole)) return { ok: true };
  if (!assignedRole && userHasRole(user, "worker")) return { ok: true };
  return { ok: false, error: "当前岗位不能操作此工序" };
}

function canReportProcess(user, route) {
  const permission = canOperateRoute(user, route);
  if (!permission.ok) return permission;
  if (!canManage(user) && !isShopWorker(user)) return { ok: false, error: "无权报工" };
  return { ok: true };
}

function validateAssignee(db, processName, userId) {
  if (!userId) return { ok: true };
  const assignee = db.users.find((item) => item.id === userId && item.active !== false);
  if (!assignee) return { ok: false, error: "指定员工不存在或已停用" };
  const assignedRole = getProcessRole(processName);
  if (assignedRole && !userHasRole(assignee, assignedRole)) {
    return { ok: false, error: `${normalizeProcessName(processName)}工序只能派给${roles[assignedRole]}` };
  }
  return { ok: true, assignee };
}

function canReportRouteStatus(route) {
  if (!route) return { ok: false, error: "工序不存在" };
  if (route.status === "待开始") return { ok: false, error: "请先点击开始生产" };
  if (route.status === "暂停") return { ok: false, error: "工序已暂停，请先点击继续" };
  if (route.status === "已完成") return { ok: false, error: "该工序已完成，无需再报工" };
  if (route.status !== "进行中") return { ok: false, error: `当前状态为${route.status}，暂不能报工` };
  return { ok: true };
}

function routeQuantityComplete(route) {
  const planQty = Number(route?.planQty || 0);
  return planQty > 0 && Number(route?.completedQty || 0) >= planQty;
}

function routeHasOpenIssue(db, route) {
  if (route.routeType === "rework") return false;
  return (db.exceptions || []).some((item) =>
    item.status !== "已解决"
    && [item.routeId, item.issueRouteId, item.qualityRouteId, item.reworkRouteId].includes(route.id)
  );
}

function canonicalRouteStatus(db, route, preferredStatus = route.status) {
  if (routeHasOpenIssue(db, route)) {
    return preferredStatus === "返工" || route.status === "返工" ? "返工" : "异常";
  }
  if (routeQuantityComplete(route)) return "已完成";
  if (["已完成", "异常", "返工"].includes(preferredStatus)) {
    return Number(route.completedQty || 0) > 0 ? "进行中" : "待开始";
  }
  return preferredStatus;
}

function canReopenOrder(order) {
  return Boolean(order && !order.shippedAt && !order.invoicedAt && !["已发货", "已开票"].includes(order.status));
}

function reopenIncompleteRoute(db, route) {
  const planned = Number(route.planQty);
  const completed = Number(route.completedQty || 0);
  if (route.status !== "已完成" || route.routeType === "rework" || !Number.isFinite(planned) || planned <= 0
    || !Number.isFinite(completed) || completed < 0 || completed >= planned) return false;
  route.status = canonicalRouteStatus(db, route);
  route.completedAt = "";
  return true;
}

function validateRouteStatusChange(db, route, nextStatus) {
  const openIssue = routeHasOpenIssue(db, route);
  if (openIssue && !["异常", "返工"].includes(nextStatus)) {
    return { ok: false, error: "工序存在未解决异常或返工，不能修改为普通状态" };
  }
  if (!openIssue && routeQuantityComplete(route) && !["已完成", "异常", "返工"].includes(nextStatus)) {
    return { ok: false, error: "工序完成数量已达到计划数量，状态必须为已完成" };
  }
  if (!routeQuantityComplete(route) && nextStatus === "已完成") {
    return { ok: false, error: "工序完成数量未达到计划数量，不能设置为已完成" };
  }
  if (route.status === "已完成" && ["进行中", "暂停", "待开始"].includes(nextStatus)) {
    return { ok: false, error: "已完成工序不能恢复为进行中、暂停或待开始" };
  }
  return { ok: true };
}

function syncWorkOrder(db, workOrderId) {
  const routes = db.routes.filter((route) => route.workOrderId === workOrderId).sort((a, b) => a.sequence - b.sequence);
  const workOrder = db.workOrders.find((item) => item.id === workOrderId);
  if (!workOrder) return null;
  const active = routes.find((route) => route.status !== "已完成") || routes[routes.length - 1];
  workOrder.currentProcess = active ? active.processName : "";
  const hasOpenIssue = (db.exceptions || []).some((item) => item.workOrderId === workOrderId && item.status !== "已解决");
  if (hasOpenIssue || routes.some((route) => route.status === "异常")) workOrder.status = "异常";
  else if (routes.length && routes.every((route) => route.status === "已完成" && routeQuantityComplete(route))) workOrder.status = "已完成";
  else workOrder.status = "生产中";
  if (workOrder.status === "已完成" && !workOrder.completedAt) workOrder.completedAt = new Date().toISOString();
  if (workOrder.status !== "已完成") workOrder.completedAt = "";
  const order = db.orders.find((item) => item.id === workOrder.orderId);
  if (order) order.status = workOrder.status;
  return workOrder;
}

function formatDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dateKey(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shortDayLabel(key) {
  const parts = String(key || "").split("-");
  if (parts.length >= 3) return `${parts[1]}.${parts[2]}`;
  return key || "";
}

function workOrderMatchesSource(workOrder, source) {
  return source === "all" || !source || normalizedOrderSource(workOrder.order).orderOrigin === source;
}

function visibleProductionWorkOrders(workOrders, source = "all") {
  return workOrders.filter((workOrder) => workOrder.creationStatus !== "pending" && workOrderMatchesSource(workOrder, source));
}

function dashboardProcessNames(db, source = "all") {
  const activeWorkOrderIds = new Set(
    visibleProductionWorkOrders(enrich(db).workOrders, source)
      .filter((workOrder) => workOrder.status !== "已完成").map((workOrder) => workOrder.id)
  );
  const usedNames = new Set(
    db.routes.filter((route) => activeWorkOrderIds.has(route.workOrderId)).map((route) => route.processName)
  );
  const names = new Set(
    db.processes.filter((process) => process.active !== false || usedNames.has(process.name)).map((process) => process.name)
  );
  usedNames.forEach((name) => names.add(name));
  return [...names].sort((a, b) => {
    const orderDiff = processOrderIndex(a) - processOrderIndex(b);
    if (orderDiff) return orderDiff;
    const processA = db.processes.find((process) => process.name === a);
    const processB = db.processes.find((process) => process.name === b);
    return Number(processA?.sort || Number.MAX_SAFE_INTEGER) - Number(processB?.sort || Number.MAX_SAFE_INTEGER)
      || a.localeCompare(b, "zh-Hans-CN");
  });
}

function buildProcessLoad(db, processNames = dashboardProcessNames(db), source = "all") {
  const todayKey = shanghaiDateKey(new Date());
  const activeWorkOrderIds = new Set(
    visibleProductionWorkOrders(enrich(db).workOrders, source)
      .filter((workOrder) => workOrder.status !== "已完成").map((workOrder) => workOrder.id)
  );
  return processNames.map((name) => {
    const process = db.processes.find((p) => p.name === name);
    const routes = db.routes.filter((r) => r.processName === name || (process && r.processId === process.id));
    const completedToday = routes.filter((route) => {
      if (route.status !== "已完成") return false;
      return shanghaiDateKey(route.completedAt || route.lastReportedAt || "") === todayKey;
    }).length;
    const remaining = routes.filter((route) => route.status !== "已完成" && activeWorkOrderIds.has(route.workOrderId)).length;
    return { name, completedToday, remaining, done: completedToday, todo: remaining };
  });
}

function dueInfo(order) {
  const dueDate = order?.dueDate;
  if (!dueDate) return { dueAt: 8640000000000000, dueLevel: "normal", dueLabel: "正常" };
  const dueAt = new Date(`${dueDate}T23:59:59`).getTime();
  const now = Date.now();
  if (Number.isNaN(dueAt)) return { dueAt: 8640000000000000, dueLevel: "normal", dueLabel: "正常" };
  const diff = dueAt - now;
  if (diff < 0) return { dueAt, dueLevel: "overdue", dueLabel: "延期" };
  if (diff <= 48 * 60 * 60 * 1000) return { dueAt, dueLevel: "urgent", dueLabel: "加急" };
  return { dueAt, dueLevel: "normal", dueLabel: "正常" };
}

function routeMeta(db, route) {
  const reports = db.reports.filter((r) => r.routeId === route.id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const latest = reports[0];
  const reporter = latest ? resolveUser(db, latest.reporterId) : resolveUser(db, route.lastReporterId);
  const time = latest?.createdAt || route.completedAt || route.lastReportedAt || "";
  const currentDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return {
    latestReport: latest || null,
    reporterName: reporter?.name || "",
    lastReportTime: time,
    lastReportTimeText: formatDateTime(time),
    targetFinishTimeText: formatDateTime(route.targetFinishTime),
    lastReportScheduleStatus: latest?.scheduleStatus || "",
    plannedStartDate: route.plannedStartDate || "",
    plannedEndDate: route.plannedEndDate || "",
    scheduleOverdue: route.status !== "已完成" && Boolean(route.plannedEndDate) && route.plannedEndDate < currentDate,
  };
}

function tvDrawingMeta(drawing) {
  return {
    id: drawing.id,
    name: drawing.originalName || drawing.name || path.basename(String(drawing.url || "")),
    fileType: String(drawing.fileType || "").toLowerCase(),
    contentType: drawing.contentType || "",
    previewError: drawing.previewError || "",
  };
}

function buildTvDashboard(db, showCustomer = false, includeDrawings = false, source = "all") {
  const data = enrich(db);
  const orders = visibleProductionWorkOrders(data.workOrders, source).map((wo) => {
    const openQualityExceptions = db.exceptions.filter((item) => item.workOrderId === wo.id && item.status !== "已解决" && (item.qualityRouteId || item.source === "quality-inspection"));
    const routes = wo.routes.map((route) => {
      const meta = routeMeta(db, route);
      const progress = Math.min(100, Math.round((Number(route.completedQty || 0) / Number(route.planQty || 1)) * 100));
      const qualityIssueActive = openQualityExceptions.some((item) => item.qualityRouteId === route.id || item.issueRouteId === route.id);
      return { ...route, ...meta, progress, qualityIssueActive };
    });
    const customer = showCustomer ? wo.customer : { id: wo.customer?.id || wo.order?.customerId || "" };
    const { drawings, ...safeWorkOrder } = wo;
    return {
      ...safeWorkOrder,
      ...(includeDrawings ? { drawings: drawings.map(tvDrawingMeta) } : {}),
      customer,
      ...dueInfo(wo.order),
      isRush: wo.order?.priority === "急单",
      routes,
    };
  });
  const todayText = shanghaiDateKey(new Date());
  const finishedWorkOrdersToday = orders.filter((wo) => shanghaiDateKey(wo.completedAt) === todayText).length;
  const active = orders
    .filter((workOrder) => !["已完成"].includes(workOrder.status)
      && !(workOrder.creationStatus === "pending" && workOrder.routes.length === 0))
    .sort((a, b) => a.dueAt - b.dueAt);
  const delayed = active.filter((w) => w.dueLevel === "overdue");
  const urgent = active.filter((w) => w.dueLevel === "urgent");
  const rushOrders = active.filter((w) => w.isRush);
  const onTimeRate = active.length ? Math.round(((active.length - delayed.length) / active.length) * 100) : 100;
  const processLoad = buildProcessLoad(db, dashboardProcessNames(db, source), source);
  const waiting = processLoad.reduce((sum, process) => sum + process.remaining, 0);
  const statusDistribution = {
    active: active.length - delayed.length,
    delayed: delayed.length,
    finishedToday: finishedWorkOrdersToday,
    waiting,
  };
  const recentReports = db.reports
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 12)
    .map((report) => {
      const route = db.routes.find((r) => r.id === report.routeId);
      const wo = data.workOrders.find((w) => w.id === report.workOrderId);
      const user = resolveUser(db, report.reporterId);
      return { ...report, routeName: route?.processName || "", workNo: wo?.workNo || "", productName: wo?.productName || "", reporterName: user?.name || "", timeText: formatDateTime(report.createdAt) };
    });
  const reportTrend = Array.from({ length: 7 }, (_, index) => {
    const d = new Date(`${todayText}T00:00:00+08:00`);
    d.setUTCDate(d.getUTCDate() - (6 - index));
    const key = shanghaiDateKey(d);
    const value = orders.filter((wo) => shanghaiDateKey(wo.completedAt) === key).length;
    return { key, label: shortDayLabel(key), value };
  });
  return {
    generatedAt: new Date().toISOString(),
    generatedAtText: formatDateTime(new Date().toISOString()),
    settings: { ...defaultSettings, ...(db.settings || {}) },
    summary: {
      activeWorkOrders: active.length,
      rushWorkOrders: rushOrders.length,
      delayedWorkOrders: delayed.length,
      urgentWorkOrders: urgent.length,
      waitingRoutes: waiting,
      totalWorkOrders: orders.length,
      onTimeRate,
      finishedToday: finishedWorkOrdersToday,
      finishedWorkOrdersToday,
    },
    processLoad,
    statusDistribution,
    reportTrend,
    activeOrders: active,
    delayedOrders: delayed.slice(0, 6),
    recentReports,
  };
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/external/health") {
      const enabled = SAAS_ENABLED
        ? Object.values(SAAS_TENANT_INTEGRATIONS).some((item) => item.inboundSecret)
        : Boolean(BOBO_INTEGRATION_SECRET);
      return send(res, 200, {
        enabled,
        service: "external-work-orders",
        processMode: "single-process",
        releaseVersion: RELEASE_VERSION,
        gitCommit: RELEASE_COMMIT,
      });
    }
    const externalOrderRequest = req.method === "POST" && url.pathname === "/api/external/work-orders";
    const tenant = externalOrderRequest
      ? await resolveExternalIntegration(req, res)
      : await resolveRequestTenant(req, res, url);
    if (!tenant) return;
    const handleRequest = () => requestContext.run(tenant, () => handleApiWithTenant(req, res, url));
    if (!SAAS_ENABLED && externalOrderRequest) return serializeTenantDelivery(tenant.tenantId, handleRequest);
    return SAAS_ENABLED && !tenant.platform ? withTenantDatabaseLock(tenant, handleRequest) : handleRequest();
  } catch (error) {
    if (res.headersSent || res.writableEnded) {
      console.error("API request failed after response was sent", error);
      return;
    }
    return send(res, error.statusCode || 500, { error: error.message });
  }
}

async function handleApiWithTenant(req, res, url) {
  try {
    if (await handlePlatformApi(req, res, url)) return;
    if (res.writableEnded) return;
    const context = requestContext.getStore();
    if (SAAS_ENABLED && context?.platform) return send(res, 404, { error: "平台接口不存在" });
    const requiredFeature = featureForApiPath(url.pathname);
    if (SAAS_ENABLED && url.pathname.startsWith("/api/") && !context?.integration
      && !requiredFeature && !isKnownUngatedApiPath(url.pathname)) {
      return send(res, 404, { error: "接口不存在" });
    }
    if (SAAS_ENABLED && requiredFeature && !context?.integration
      && !context?.featureModules?.includes(requiredFeature)) {
      return send(res, 403, { error: `当前套餐未开放${FEATURE_MODULES.find((item) => item.key === requiredFeature)?.name || "此功能"}` });
    }
    const db = await readDb();
    if (SAAS_ENABLED && !context?.platform && !context?.licenseActive
      && req.method !== "GET" && url.pathname !== "/api/login" && url.pathname !== "/api/logout") {
      return send(res, 402, { error: "公司授权已到期，当前仅允许查询、导出和数据取回" });
    }
    if (req.method === "POST" && url.pathname === "/api/external/work-orders") {
      const context = requestContext.getStore();
      const secret = context?.integration ? req.integrationConfig?.inboundSecret : BOBO_INTEGRATION_SECRET;
      if (!secret) return send(res, 503, { error: "外部工单集成未启用" });
      const rawBody = req.integrationRawBody || await readRawBody(req);
      if (!context?.integration && !validExternalSignature(req, rawBody, secret)) return send(res, 401, { error: "外部集成签名无效" });
      let input;
      try { input = JSON.parse(rawBody); } catch { return send(res, 400, { error: "请求格式错误" }); }
      if (!input || typeof input !== "object" || Array.isArray(input)) return send(res, 400, { error: "请求格式错误" });
      input = {
        externalOrderNumber: String(input.externalOrderNumber || "").trim(),
        sourceChannel: String(input.sourceChannel || "").trim(),
        customer: String(input.customer || "").trim(),
        phone: String(input.phone || "").trim(),
        quantity: Number(input.quantity),
        expectedDate: normalizeDate(input.expectedDate),
        description: String(input.description || "").trim(),
        material: String(input.material || "").trim(),
        dimensions: String(input.dimensions || "").trim(),
        region: String(input.region || "").trim(),
        deliveryAddress: String(input.deliveryAddress || "").trim(),
      };
      if (!input.externalOrderNumber || input.externalOrderNumber.length > 128 || !input.customer || !input.phone
        || !Number.isInteger(input.quantity) || input.quantity < 1 || !input.expectedDate) {
        return send(res, 422, { error: "外部订单核心参数不合法或不完整" });
      }
      if (!PLATFORM_SOURCE_CHANNELS.has(input.sourceChannel)) return send(res, 422, { error: "平台渠道无效" });
      const nonce = String(req.headers["x-integration-nonce"] || "");
      const result = await (async () => {
        const currentDb = await readDb();
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        currentDb.integrationNonces = (currentDb.integrationNonces || []).filter((item) => Date.parse(item.createdAt) >= cutoff);
        if (currentDb.integrationNonces.some((item) => item.nonce === nonce)) return { status: 401, data: { error: "集成请求已重放" } };
        currentDb.integrationNonces.push({ nonce, createdAt: new Date().toISOString() });
        const existing = currentDb.orders.find((item) => item.externalOrderNumber === input.externalOrderNumber || item.orderNo === input.externalOrderNumber);
        if (existing) {
          if (!externalOrderMatches(existing, input)) {
            await writeDb(currentDb);
            return { status: 409, data: { error: "外部订单号已存在且内容不一致" } };
          }
          const workOrder = currentDb.workOrders.find((item) => item.orderId === existing.id);
          await writeDb(currentDb);
          return { status: 200, data: { order: existing, workOrder, routes: currentDb.routes.filter((item) => item.workOrderId === workOrder?.id) } };
        }
        let customer = currentDb.customers.find((item) => item.phone === input.phone && item.active !== false);
        if (!customer) {
          customer = { id: id("c"), name: input.customer, contact: input.customer, phone: input.phone,
            address: input.deliveryAddress, note: "平台订单自动创建", active: true };
          currentDb.customers.push(customer);
        }
        const createdAt = new Date().toISOString();
        const order = {
          id: id("o"), orderNo: input.externalOrderNumber, customerId: customer.id,
          productName: input.material || input.description || "非标钣金件", drawingNo: "", quantity: input.quantity,
          quantityUnit: "件", dueDate: input.expectedDate, priority: "普通", status: "待正式创建", note: input.description,
          createdAt, orderOrigin: "platform", sourceChannel: input.sourceChannel,
          externalOrderNumber: input.externalOrderNumber, externalCustomer: input.customer, externalPhone: input.phone,
          externalDescription: input.description, externalQuantity: input.quantity, externalExpectedDate: input.expectedDate,
          externalRegion: input.region, externalDeliveryAddress: input.deliveryAddress, material: input.material,
          dimensions: input.dimensions, region: input.region, deliveryAddress: input.deliveryAddress,
        };
        const workOrder = {
          id: id("w"), workNo: input.externalOrderNumber, orderId: order.id, productName: order.productName,
          planQty: input.quantity, status: "待排产", creationStatus: "pending", currentProcess: "",
          assigneeId: "", qrToken: id("qr"), createdAt,
        };
        currentDb.orders.push(order);
        currentDb.workOrders.push(workOrder);
        await writeDb(currentDb);
        return { status: 201, data: { order, workOrder, routes: [] } };
      })();
      return send(res, result.status, result.data);
    }
    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = await parseBody(req);
      const user = db.users.find((item) => item.phone === body.phone && verifyPassword(body.password, item.password) && item.active);
      if (!user) return send(res, 401, { error: "手机号或密码不正确" });
      let sessionToken = "";
      if (SAAS_ENABLED) {
        const context = requestContext.getStore();
        const sessionId = crypto.randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
        await getSaasStore().createSession({ sessionId, tenantId: context.tenantId, userId: user.id, expiresAt });
        sessionToken = issueUserToken({ tenantId: context.tenantId, userId: user.id, sessionId, secret: SAAS_SESSION_SECRET });
        const secureCookie = req.socket.encrypted || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https" ? "; Secure" : "";
        res.setHeader("Set-Cookie", `bobo_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secureCookie}`);
      }
      appendAudit(db, user, "login", "user", user.id, { name: user.name, phone: user.phone });
      await writeDb(db);
      return send(res, 200, {
        sessionToken,
        user: {
          id: user.id,
          tenantId: requestContext.getStore()?.tenantId || "legacy",
          name: user.name,
          role: getPrimaryRole(user),
          roles: getUserRoles(user),
          roleName: roles[getPrimaryRole(user)],
          roleNames: getUserRoles(user).map((role) => roles[role]),
          viewBoardCustomer: canViewRestrictedBoard(user),
        },
        permissions: userPermissions(user),
        featureModules: requestContext.getStore()?.featureModules || FEATURE_MODULES.map((item) => item.key),
        featureCatalog: publicFeatureCatalog(requestContext.getStore()?.slug),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/tv-viewer-token") {
      const viewer = currentUser(req, db);
      if (!viewer) return send(res, 401, { error: "请先登录" });
      const token = signTvViewerToken(viewer);
      if (!token) return send(res, 503, { error: "看板身份令牌未配置" });
      return send(res, 200, { token, expiresInSeconds: TV_VIEW_TOKEN_TTL_MS / 1000 });
    }

    if (req.method === "GET" && url.pathname === "/api/dispatch-board-token") {
      const viewer = currentUser(req, db);
      if (!viewer) return send(res, 401, { error: "请先登录" });
      if (!canViewRestrictedBoard(viewer)) return send(res, 403, { error: "无权使用派工看板" });
      const token = signTvViewerToken(viewer, "dispatch-board");
      if (!token) return send(res, 503, { error: "看板身份令牌未配置" });
      return send(res, 200, { token, expiresInSeconds: TV_VIEW_TOKEN_TTL_MS / 1000 });
    }

    if (req.method === "GET" && url.pathname === "/api/tv-dashboard") {
      const viewer = tvViewerFromToken(db, url.searchParams.get("viewerToken"));
      if (SAAS_ENABLED && !viewer) return send(res, 401, { error: "看板身份已失效，请从公司系统重新打开" });
      const sourceFiltersEnabled = context?.tenantId === "future-machinery";
      const requestedSource = ["factory", "platform"].includes(url.searchParams.get("source")) ? url.searchParams.get("source") : "all";
      const source = sourceFiltersEnabled ? requestedSource : "all";
      const dashboard = buildTvDashboard(db, canViewRestrictedBoard(viewer), Boolean(viewer), source);
      if (SAAS_ENABLED) {
        const tasks = await getSaasStore().listOutsourceTasks(context.tenantId, "owner");
        const outsourcedOrderIds = new Set(tasks.filter((task) => task.status !== "cancelled").map((task) => task.ownerOrderId));
        dashboard.activeOrders = dashboard.activeOrders.map((order) => ({
          ...order,
          isOutsourced: Boolean(order.isOutsourced || order.source === "saas-outsourcing"
            || (context?.tenantId === "future-machinery" && outsourcedOrderIds.has(order.orderId || order.order?.id))),
        }));
      }
      return send(res, 200, {
        ...dashboard,
        sourceFiltersEnabled,
        companyName: requestContext.getStore()?.name || "",
      });
    }

    const tvOrderDrawingsMatch = url.pathname.match(/^\/api\/tv-orders\/([^/]+)\/drawings$/);
    if (req.method === "GET" && tvOrderDrawingsMatch) {
      const viewer = validTvDrawingViewer(db, url.searchParams.get("viewerToken"));
      if (!viewer) return send(res, 401, { error: "看板身份已失效，请重新打开" });
      const workOrderId = decodeURIComponent(tvOrderDrawingsMatch[1]);
      const workOrder = visibleProductionWorkOrders(enrich(db).workOrders).find((item) => item.id === workOrderId);
      if (!workOrder) return send(res, 404, { error: "工单不存在" });
      return send(res, 200, { items: (workOrder.drawings || []).map(tvDrawingMeta) });
    }

    const tvDrawingFileMatch = url.pathname.match(/^\/api\/tv-drawings\/([^/]+)\/(file|preview-file)$/);
    if (req.method === "GET" && tvDrawingFileMatch) {
      const viewer = validTvDrawingViewer(db, url.searchParams.get("viewerToken"));
      if (!viewer) return send(res, 401, { error: "看板身份已失效，请重新打开" });
      const drawing = db.drawings.find((item) => item.id === decodeURIComponent(tvDrawingFileMatch[1]) && !item.removedAt);
      if (!drawing) return send(res, 404, { error: "图纸不存在" });
      const previewFile = tvDrawingFileMatch[2] === "preview-file";
      const sourceUrl = previewFile ? drawing.previewUrl : drawing.url;
      const filePath = sourceUrl ? path.normalize(path.join(PUBLIC, sourceUrl)) : "";
      if (!filePath.startsWith(PUBLIC)) return send(res, 403, { error: "图纸路径无效" });
      const downloadName = url.searchParams.get("download") === "1"
        ? drawing.originalName || drawing.name || path.basename(String(drawing.url || ""))
        : "";
      return sendLocalFile(res, filePath, previewFile ? "image/svg+xml; charset=utf-8" : drawingContentType(drawing, filePath), downloadName);
    }

    if (req.method === "POST" && url.pathname === "/api/tv-drawings/preview") {
      const authorization = String(req.headers.authorization || "");
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      const viewer = validTvDrawingViewer(db, token);
      if (!viewer) return send(res, 401, { error: "看板身份已失效，请重新打开" });
      const body = await parseBody(req);
      const drawing = db.drawings.find((item) => item.id === body.drawingId && !item.removedAt);
      if (!drawing) return send(res, 404, { error: "图纸不存在" });
      if (isCadDrawing(drawing.fileType)) {
        const previewFile = drawing.previewUrl ? path.join(tenantUploadDirectory("previews"), path.basename(drawing.previewUrl)) : "";
        if (!previewFile || !fs.existsSync(previewFile)) {
          const preview = await generateCadPreview(drawing);
          drawing.previewUrl = preview.previewUrl;
          drawing.previewError = preview.previewError;
          await writeDb(db);
        }
      }
      const queryToken = encodeURIComponent(token);
      const hasCadPreview = isCadDrawing(drawing.fileType) && drawing.previewUrl && !drawing.previewError;
      return send(res, 200, {
        previewUrl: hasCadPreview
          ? `/api/tv-drawings/${encodeURIComponent(drawing.id)}/preview-file?viewerToken=${queryToken}`
          : `/api/tv-drawings/${encodeURIComponent(drawing.id)}/file?viewerToken=${queryToken}`,
        previewError: drawing.previewError || "",
      });
    }

    if (req.method === "POST" && url.pathname === "/api/dispatch-board/route-toggle") {
      const authorization = String(req.headers.authorization || "");
      const viewer = viewerFromToken(db, authorization.startsWith("Bearer ") ? authorization.slice(7) : "");
      if (!viewer) return send(res, 401, { error: "派工看板身份已失效，请重新打开" });
      if (viewer.audience !== "dispatch-board" || !canViewRestrictedBoard(viewer.user)) {
        return send(res, 403, { error: "无权操作派工看板" });
      }
      const body = await parseBody(req);
      const route = db.routes.find((item) => item.id === body.routeId);
      if (!route) return send(res, 404, { error: "工序不存在" });
      if (route.status !== body.expectedStatus) return send(res, 409, { error: "工序状态已变化，正在刷新看板" });
      const nextStatus = ["待开始", "暂停"].includes(route.status)
        ? "进行中"
        : route.status === "进行中" ? "暂停" : "";
      if (!nextStatus) return send(res, 400, { error: "当前工序不能在派工看板中切换" });
      const statusValidation = validateRouteStatusChange(db, route, nextStatus);
      if (!statusValidation.ok) return send(res, 409, { error: statusValidation.error });
      const beforeStatus = route.status;
      route.status = nextStatus;
      if (nextStatus === "进行中" && !route.startedAt) route.startedAt = new Date().toISOString();
      if (nextStatus === "暂停") route.pausedAt = new Date().toISOString();
      syncWorkOrder(db, route.workOrderId);
      appendAudit(db, viewer.user, "dispatch-board-route-toggle", "route", route.id, {
        beforeStatus, afterStatus: nextStatus, planQty: Number(route.planQty || 0), completedQty: Number(route.completedQty || 0),
      });
      await writeDb(db);
      return send(res, 200, { ok: true, route });
    }

    if (req.method === "POST" && url.pathname === "/api/dispatch-board/route-schedule") {
      const authorization = String(req.headers.authorization || "");
      const viewer = viewerFromToken(db, authorization.startsWith("Bearer ") ? authorization.slice(7) : "");
      if (!viewer) return send(res, 401, { error: "派工看板身份已失效，请重新打开" });
      if (viewer.audience !== "dispatch-board" || !canViewRestrictedBoard(viewer.user)) {
        return send(res, 403, { error: "无权操作派工看板" });
      }
      const body = await parseBody(req);
      const route = db.routes.find((item) => item.id === body.routeId);
      if (!route) return send(res, 404, { error: "工序不存在" });
      if (route.status === "已完成") return send(res, 400, { error: "已完成工序不能修改排期" });
      const before = {
        plannedStartDate: route.plannedStartDate || "",
        plannedEndDate: route.plannedEndDate || "",
      };
      if (before.plannedStartDate !== String(body.expectedStartDate || "") || before.plannedEndDate !== String(body.expectedEndDate || "")) {
        return send(res, 409, { error: "工序排期已被修改，请刷新后重试" });
      }
      const schedule = normalizeRouteSchedule(body.plannedStartDate, body.plannedEndDate);
      if (schedule.error) return send(res, 400, { error: schedule.error });
      route.plannedStartDate = schedule.plannedStartDate;
      route.plannedEndDate = schedule.plannedEndDate;
      appendAudit(db, viewer.user, "dispatch-board-route-schedule", "route", route.id, {
        before,
        after: { plannedStartDate: route.plannedStartDate, plannedEndDate: route.plannedEndDate },
      });
      await writeDb(db);
      return send(res, 200, { ok: true, route });
    }

    if (req.method === "POST" && url.pathname === "/api/dispatch-board/order-due-date") {
      const authorization = String(req.headers.authorization || "");
      const viewer = viewerFromToken(db, authorization.startsWith("Bearer ") ? authorization.slice(7) : "");
      if (!viewer) return send(res, 401, { error: "派工看板身份已失效，请重新打开" });
      if (viewer.audience !== "dispatch-board" || !canViewRestrictedBoard(viewer.user)) {
        return send(res, 403, { error: "无权操作派工看板" });
      }
      const body = await parseBody(req);
      const order = db.orders.find((item) => item.id === body.orderId);
      if (!order) return send(res, 404, { error: "订单不存在" });
      const beforeDueDate = String(order.dueDate || "");
      if (beforeDueDate !== String(body.expectedDueDate || "")) return send(res, 409, { error: "订单交期已被修改，请刷新后重试" });
      const dueDate = normalizeDate(body.dueDate);
      if (!dueDate) return send(res, 400, { error: "交期格式请填写 YYYY/MM/DD" });
      order.dueDate = dueDate;
      appendAudit(db, viewer.user, "dispatch-board-order-due-date", "order", order.id, {
        beforeDueDate,
        afterDueDate: dueDate,
      });
      await writeDb(db);
      return send(res, 200, { ok: true, order });
    }

    const qrRouteMatch = url.pathname.match(/^\/api\/qr\/route\/([^/]+)\.svg$/);
    if (req.method === "GET" && qrRouteMatch) {
      const route = db.routes.find((r) => r.id === decodeURIComponent(qrRouteMatch[1]));
      if (!route) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("工序不存在");
        return;
      }
      if (!route.qrToken) {
        route.qrToken = qrToken("rt");
        await writeDb(db);
      }
      const scanUrl = `${QR_BASE_URL.replace(/\/$/, "")}/scan.html?routeToken=${encodeURIComponent(route.qrToken)}`;
      const svg = makeQrSvg(scanUrl);
      res.writeHead(200, {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "no-store",
        "X-QR-Content": encodeURIComponent(scanUrl),
      });
      res.end(svg);
      return;
    }

    const weappQrRouteMatch = url.pathname.match(/^\/api\/qr\/route\/([^/]+)\/weapp\.png$/);
    if (req.method === "GET" && weappQrRouteMatch) {
      const route = db.routes.find((r) => r.id === decodeURIComponent(weappQrRouteMatch[1]));
      if (!route) return send(res, 404, { error: "工序不存在" });
      if (!route.qrToken) {
        route.qrToken = qrToken("rt");
        await writeDb(db);
      }
      try {
        const image = await getWeappCode(route);
        res.writeHead(200, {
          "Content-Type": image.contentType,
          "Content-Length": image.bytes.length,
          "Cache-Control": "private, max-age=86400",
        });
        res.end(image.bytes);
      } catch (error) {
        return send(res, 503, {
          error: error.message,
          code: "WEAPP_CODE_UNAVAILABLE",
          envVersion: WX_CODE_ENV_VERSION,
        });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/qr/resolve") {
      const token = url.searchParams.get("routeToken") || url.searchParams.get("token");
      const route = db.routes.find((r) => r.qrToken === token);
      if (!route) return send(res, 404, { error: "二维码无效或工序不存在" });
      const data = enrich(db);
      const workOrder = data.workOrders.find((w) => w.id === route.workOrderId);
      const scanUser = currentUser(req, db);
      const permission = scanUser ? canReportProcess(scanUser, route) : { ok: true };
      const statusPermission = canReportRouteStatus(route);
      const scanPermission = permission.ok ? statusPermission : permission;
      return send(res, 200, {
        routeId: route.id,
        route,
        workOrder,
        canReport: scanPermission.ok,
        permissionAllowed: permission.ok,
        processPermissionError: permission.error || "",
        statusAllowed: statusPermission.ok,
        statusError: statusPermission.error || "",
        permissionError: scanPermission.error || ""
      });
    }

    if (req.method === "POST" && url.pathname === "/api/platform-orders/sync-processes") {
      const user = currentUser(req, db);
      if (!user) return send(res, 401, { error: "请先登录" });
      if (!canSupervise(user)) return send(res, 403, { error: "无权同步平台工序" });
      const body = await parseBody(req);
      const orderNumber = String(body.orderNumber || "").trim();
      const requestId = String(body.requestId || "");
      if (!orderNumber || !/^[a-zA-Z0-9_-]{1,80}$/.test(requestId)) return send(res, 400, { error: "请提供订单号及同步请求标识" });
      const order = db.orders.find((item) => normalizedOrderSource(item).externalOrderNumber === orderNumber);
      const workOrder = db.workOrders.find((item) => item.orderId === order?.id && item.creationStatus !== "pending");
      const route = db.routes.find((item) => item.workOrderId === workOrder?.id);
      if (!order || !route) return send(res, 404, { error: "未找到已建立工序的平台订单" });
      queuePlatformProgress(db, route, `sync-${order.id}-${requestId}`, new Date().toISOString());
      appendAudit(db, user, "platform-process-sync", "order", order.id, { requestId });
      await writeDb(db);
      setTimeout(() => void processPlatformWebhooks(), 50);
      return send(res, 200, { ok: true, platformSync: "queued" });
    }

    if (req.method === "POST" && url.pathname === "/api/platform-orders/confirm") {
      const user = currentUser(req, db);
      if (!user) return send(res, 401, { error: "请先登录" });
      if (!canSupervise(user)) return send(res, 403, { error: "无权确认平台订单" });
      const body = await parseBody(req);
      if (!Array.isArray(body.processIds) || !body.processIds.length) return send(res, 400, { error: "至少选择一道工序" });
      const processIds = [...new Set(body.processIds.map(String))];
      const order = db.orders.find((item) => item.id === body.orderId);
      const workOrder = db.workOrders.find((item) => item.orderId === order?.id);
      if (!order || !workOrder || normalizedOrderSource(order).orderOrigin !== "platform") return send(res, 404, { error: "平台订单不存在" });
      if (workOrder.creationStatus !== "pending") return send(res, 409, { error: "平台订单已正式创建" });
      const selectedProcesses = processIds.map((processId) => db.processes.find((process) => process.id === processId));
      if (selectedProcesses.some((process) => !process || process.active === false)) return send(res, 400, { error: "所选工序不存在或已停用" });
      if (!selectedProcesses.some((process) => normalizeProcessName(process.name) !== "质检")) return send(res, 400, { error: "质检前至少选择一道生产工序" });
      const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
      const productName = has("productName") ? String(body.productName || "").trim() : order.productName;
      const quantity = has("quantity") ? Number(body.quantity) : Number(order.quantity);
      const dueDate = has("dueDate") ? normalizeDate(body.dueDate) : order.dueDate;
      const priority = has("priority") ? String(body.priority || "").trim() : order.priority;
      if (!productName || !Number.isInteger(quantity) || quantity < 1 || !dueDate || !["普通", "急单"].includes(priority)) {
        return send(res, 400, { error: "订单资料不完整或格式不正确" });
      }
      Object.assign(order, {
        productName, quantity, dueDate, priority,
        note: has("note") ? String(body.note || "").trim() : order.note,
        region: has("region") ? String(body.region || "").trim() : order.region,
        deliveryAddress: has("deliveryAddress") ? String(body.deliveryAddress || "").trim() : order.deliveryAddress,
      });
      workOrder.productName = productName;
      workOrder.planQty = quantity;
      selectedProcesses.sort((a, b) => processOrderIndex(a.name) - processOrderIndex(b.name) || processIds.indexOf(a.id) - processIds.indexOf(b.id));
      const confirmedAt = new Date().toISOString();
      const routes = selectedProcesses.map((process, index) => ({
        id: id("r"), workOrderId: workOrder.id, processId: process.id, processName: normalizeProcessName(process.name),
        assignedRole: getProcessRole(process.name), sequence: index + 1, assignedTo: "", qrToken: qrToken("rt"), status: "待开始",
        planQty: Number(workOrder.planQty || order.quantity), completedQty: 0, goodQty: 0, badQty: 0, reworkQty: 0,
      }));
      db.routes.push(...routes);
      workOrder.creationStatus = "confirmed";
      workOrder.confirmedAt = confirmedAt;
      workOrder.confirmedBy = user.id;
      syncWorkOrder(db, workOrder.id);
      queuePlatformProgress(db, routes[0], `plan-${workOrder.id}`, confirmedAt);
      appendAudit(db, user, "platform-order-confirm", "order", order.id, { workOrderId: workOrder.id, processNames: routes.map((route) => route.processName) });
      await writeDb(db);
      setTimeout(() => void processPlatformWebhooks(), 50);
      return send(res, 200, { ok: true, order, workOrder, routes });
    }

    const dispatchReportRequest = ["/api/dispatch-board/report", "/api/dispatch-board/report-context", "/api/dispatch-board/report-upload"].includes(url.pathname);
    let user;
    if (dispatchReportRequest) {
      const authorization = String(req.headers.authorization || "");
      const viewer = viewerFromToken(db, authorization.startsWith("Bearer ") ? authorization.slice(7) : "");
      if (!viewer || viewer.audience !== "dispatch-board") return send(res, 401, { error: "派工看板身份已失效，请重新打开" });
      if (!canManage(viewer.user) || !canViewRestrictedBoard(viewer.user)) return send(res, 403, { error: "无权代报工" });
      user = viewer.user;
    } else user = currentUser(req, db);
    if (!user) return send(res, 401, { error: "请先登录" });
    if (req.method === "GET" && url.pathname === "/api/dispatch-board/report-context") {
      const route = db.routes.find((item) => item.id === url.searchParams.get("routeId"));
      if (!route) return send(res, 404, { error: "工序不存在" });
      if (route.status !== "进行中") return send(res, 409, { error: "只有进行中的工序才能代报工，请刷新" });
      const workOrder = db.workOrders.find((item) => item.id === route.workOrderId);
      const order = db.orders.find((item) => item.id === workOrder?.orderId);
      return send(res, 200, {
        route: enrichRoute(db, route),
        workNo: workOrder?.workNo || "",
        productName: workOrder?.productName || "",
        quantityUnit: normalizeQuantityUnit(order?.quantityUnit),
        managerName: user.name,
        issueRoutes: db.routes.filter((item) => item.workOrderId === route.workOrderId && item.processName !== "质检" && item.routeType !== "rework")
          .sort((a, b) => a.sequence - b.sequence)
          .map((item) => ({ id: item.id, processName: item.processName, sequence: item.sequence })),
      });
    }
    res.viewOrderFinancials = userPermissions(user).viewOrderFinancials;
    if (await handleOutsourcingApi(req, res, url, db, user)) return;
    if (res.writableEnded) return;

    if (req.method === "GET" && url.pathname === "/api/deliveries/available") {
      if (!canDrive(user)) return send(res, 403, { error: "无权查看配送任务" });
      const region = String(url.searchParams.get("region") || "").trim().toLowerCase();
      const orders = db.orders.filter((order) => deliveryAvailability(db, order).ok)
        .filter((order) => !region || `${order.region || ""} ${order.deliveryAddress || ""}`.toLowerCase().includes(region))
        .sort((a, b) => `${a.region || ""}${a.deliveryAddress || ""}${a.orderNo || ""}`.localeCompare(`${b.region || ""}${b.deliveryAddress || ""}${b.orderNo || ""}`, "zh-CN"))
        .map((order) => deliveryOrderView(db, order));
      return send(res, 200, { orders });
    }

    if (req.method === "GET" && url.pathname === "/api/deliveries/my") {
      if (!canDrive(user)) return send(res, 403, { error: "无权查看配送任务" });
      const deliveries = db.deliveries.filter((delivery) => canSupervise(user) || delivery.driverId === user.id)
        .filter((delivery) => ["delivering", "delivered"].includes(delivery.status))
        .map((delivery) => ({
          ...delivery,
          order: deliveryOrderView(db, db.orders.find((order) => order.id === delivery.orderId) || {}),
          proofAttachments: (delivery.proofAttachmentIds || []).map((attachmentId) => db.attachments.find((attachment) => attachment.id === attachmentId)).filter(Boolean),
        })).sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
      return send(res, 200, { deliveries });
    }

    if (req.method === "POST" && url.pathname === "/api/delivery-trips/start") {
      if (!canDrive(user)) return send(res, 403, { error: "无权领取配送任务" });
      const body = await parseBody(req);
      const orderIds = [...new Set((Array.isArray(body.orderIds) ? body.orderIds : []).map(String).filter(Boolean))];
      if (!orderIds.length) return send(res, 400, { error: "请至少选择一个配送订单" });
      const latest = await readDb();
      const orders = orderIds.map((orderId) => latest.orders.find((order) => order.id === orderId));
      if (orders.some((order) => !order)) return send(res, 404, { error: "配送订单不存在" });
      const invalid = orders.map((order) => deliveryAvailability(latest, order)).find((item) => !item.ok);
      if (invalid) return send(res, 409, { error: invalid.error });
      const startedAt = new Date().toISOString();
      const trip = { id: id("trip"), driverId: user.id, status: "delivering", orderIds, startedAt, completedAt: "", createdAt: startedAt };
      const deliveries = orders.map((order) => {
        const existing = latest.deliveries.find((item) => item.orderId === order.id);
        const delivery = existing || { id: id("delivery"), orderId: order.id, proofAttachmentIds: [], note: "", createdAt: startedAt };
        Object.assign(delivery, { tripId: trip.id, driverId: user.id, status: "delivering", addressSnapshot: { region: String(order.region || ""), deliveryAddress: String(order.deliveryAddress || "") }, startedAt, deliveredAt: "" });
        if (!existing) latest.deliveries.push(delivery);
        const workOrder = latest.workOrders.find((item) => item.orderId === order.id);
        order.shippedAt ||= startedAt;
        order.shippedBy ||= user.id;
        order.status = orderFulfillmentStatus(workOrder, order);
        latest.platformWebhookEvents ||= [];
        queuePlatformShipment(latest, order, workOrder, order.shippedAt);
        appendAudit(latest, user, "delivery-start", "delivery", delivery.id, { orderId: order.id, tripId: trip.id });
        return delivery;
      });
      latest.deliveryTrips.push(trip);
      await writeDb(latest);
      return send(res, 201, { trip, delivery: deliveries[0], deliveries });
    }

    if (req.method === "POST" && url.pathname === "/api/deliveries/complete") {
      if (!canDrive(user)) return send(res, 403, { error: "无权确认送达" });
      const body = await parseBody(req);
      const photos = Array.isArray(body.photos) ? body.photos : [];
      if (photos.length < 1 || photos.length > 3) return send(res, 400, { error: "送达照片必须为 1 至 3 张" });
      if (photos.some((photo) => !/^data:image\/(?:png|jpe?g|gif);base64,/.test(String(photo.dataUrl || "")))) return send(res, 400, { error: "送达照片格式无效" });
      const latest = await readDb();
      const delivery = latest.deliveries.find((item) => item.orderId === String(body.orderId || ""));
      if (!delivery) return send(res, 404, { error: "配送记录不存在" });
      if (delivery.status !== "delivering") return send(res, 409, { error: "订单不在配送中" });
      if (!canSupervise(user) && delivery.driverId !== user.id) return send(res, 403, { error: "该订单由其他司机配送" });
      const order = latest.orders.find((item) => item.id === delivery.orderId);
      const workOrder = latest.workOrders.find((item) => item.orderId === order?.id);
      if (!order || !workOrder) return send(res, 404, { error: "订单工单不存在" });
      const createdAt = new Date().toISOString();
      const attachments = photos.map((photo) => {
        const saved = saveDataUrlFile(photo, { prefix: "delivery" });
        if (saved.error) throw new Error(saved.error);
        return { ...saved, id: id("att"), attachmentType: "delivery-proof", orderId: order.id, deliveryId: delivery.id, uploaderId: user.id, createdAt };
      });
      latest.attachments.push(...attachments);
      Object.assign(delivery, { status: "delivered", deliveredAt: createdAt, deliveredBy: user.id, note: String(body.note || "").trim(), proofAttachmentIds: attachments.map((attachment) => attachment.id) });
      order.deliveredAt = createdAt;
      order.deliveredBy = user.id;
      const tripDeliveries = latest.deliveries.filter((item) => item.tripId === delivery.tripId);
      const trip = latest.deliveryTrips.find((item) => item.id === delivery.tripId);
      if (trip && tripDeliveries.every((item) => item.id === delivery.id || item.status === "delivered")) Object.assign(trip, { status: "completed", completedAt: createdAt });
      const webhookEvent = queueDeliveryWebhook(latest, order, workOrder, delivery);
      appendAudit(latest, user, "delivery-complete", "delivery", delivery.id, { orderId: order.id, tripId: delivery.tripId, proofAttachmentIds: delivery.proofAttachmentIds, note: delivery.note });
      await writeDb(latest);
      return send(res, 200, { ok: true, delivery, trip, proofAttachments: attachments, platformSync: webhookEvent?.status || "not-applicable" });
    }

    if (req.method === "POST" && url.pathname === "/api/deliveries/release") {
      if (!canDrive(user)) return send(res, 403, { error: "无权退回配送任务" });
      const body = await parseBody(req);
      const reason = String(body.reason || "").trim();
      const latest = await readDb();
      const delivery = latest.deliveries.find((item) => item.orderId === String(body.orderId || ""));
      if (!delivery) return send(res, 404, { error: "配送记录不存在" });
      if (delivery.status === "delivered" && !canSupervise(user)) return send(res, 409, { error: "司机不能撤销已送达记录" });
      if (!["delivering", "delivered"].includes(delivery.status)) return send(res, 409, { error: "配送记录当前不能退回" });
      if (!canSupervise(user) && delivery.driverId !== user.id) return send(res, 403, { error: "该订单由其他司机配送" });
      if (canSupervise(user) && !reason) return send(res, 400, { error: "管理者纠正状态必须填写原因" });
      const before = { status: delivery.status, driverId: delivery.driverId, deliveredAt: delivery.deliveredAt || "" };
      const previousTripId = delivery.tripId;
      Object.assign(delivery, { status: "waiting", tripId: "", driverId: "", startedAt: "", deliveredAt: "", deliveredBy: "", correctedAt: new Date().toISOString(), correctionReason: reason });
      const order = latest.orders.find((item) => item.id === delivery.orderId);
      if (order) { order.deliveredAt = ""; order.deliveredBy = ""; }
      const trip = latest.deliveryTrips.find((item) => item.id === previousTripId);
      if (trip && !latest.deliveries.some((item) => item.tripId === trip.id && item.status === "delivering")) { trip.status = "completed"; trip.completedAt ||= new Date().toISOString(); }
      appendAudit(latest, user, "delivery-release", "delivery", delivery.id, { orderId: delivery.orderId, before, reason });
      await writeDb(latest);
      return send(res, 200, { ok: true, delivery });
    }

    if (req.method === "GET" && url.pathname === "/api/reports/management-export") {
      if (!canManage(user)) return send(res, 403, { error: "无权导出管理分析" });
      const {
        buildManagementReportData,
        buildManagementWorkbook,
        validateReportDateRange,
      } = require("./lib/management-report-export");
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      try {
        validateReportDateRange(from, to);
      } catch (error) {
        return send(res, 400, { error: error.message });
      }
      try {
        const workbook = await buildManagementWorkbook(buildManagementReportData(db, from, to));
        const filename = `波波工单报工管理分析_${from}_${to}.xlsx`;
        res.writeHead(200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Length": workbook.length,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "Cache-Control": "private, no-store",
        });
        res.end(workbook);
      } catch (error) {
        console.error("management report export failed", error);
        return send(res, 500, { error: "管理分析生成失败" });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      return send(res, 200, {
        user: {
          ...user,
          tenantId: requestContext.getStore()?.tenantId || "legacy",
          role: getPrimaryRole(user),
          roles: getUserRoles(user),
          roleName: roles[getPrimaryRole(user)],
          roleNames: getUserRoles(user).map((role) => roles[role]),
          viewBoardCustomer: canViewRestrictedBoard(user),
        },
        roles,
        permissions: userPermissions(user),
        featureModules: requestContext.getStore()?.featureModules || FEATURE_MODULES.map((item) => item.key),
        featureCatalog: publicFeatureCatalog(requestContext.getStore()?.slug),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/logout") {
      appendAudit(db, user, "logout", "user", user.id, { name: user.name, phone: user.phone });
      await writeDb(db);
      if (SAAS_ENABLED && req.saasSessionId) await getSaasStore().revokeSession(req.saasSessionId);
      if (SAAS_ENABLED) res.setHeader("Set-Cookie", "bobo_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/bootstrap") {
      const data = enrich(db);
      const features = new Set(requestContext.getStore()?.featureModules || (SAAS_ENABLED
        ? FEATURE_MODULES.map((item) => item.key)
        : ["dashboard", "customers", "orders", "dispatch", "quality", "customerFeedback", "history", "reports", "settings", "outsourcing", "auditLogs"]));
      const outsourceAccess = await partnerOutsourcePermissions(db);
      data.companyName = requestContext.getStore()?.name || "";
      if (SAAS_ENABLED && context?.tenantId === "future-machinery") {
        const tasks = await getSaasStore().listOutsourceTasks(context.tenantId, "owner");
        data.outsourcedOrderIds = [...new Set(tasks.filter((task) => task.status !== "cancelled").map((task) => task.ownerOrderId))];
      }
      delete data.auditLogs;
      data.featureModules = [...features];
      data.featureCatalog = publicFeatureCatalog(context?.slug);
      data.customers = features.has("customers") || features.has("orders") ? db.customers.filter((customer) => customer.active !== false) : [];
      data.routes = (data.routes || []).filter((route) => canViewOutsourcePermission(outsourceAccess, route.workOrderId,
        route.processName === "质检" ? "quality" : "progress"));
      data.workOrders = (data.workOrders || []).map((workOrder) => {
        const permissions = outsourceAccess.get(workOrder.id);
        const routes = (workOrder.routes || []).filter((route) => canViewOutsourcePermission(outsourceAccess, workOrder.id,
          route.processName === "质检" ? "quality" : "progress"));
        const canViewProgress = !permissions || permissions.has("progress");
        return {
          ...workOrder,
          routes,
          drawings: (workOrder.drawings || []).filter((item) => canViewOutsourcePermission(outsourceAccess, workOrder.id, "attachments")),
          progress: canViewProgress ? workOrder.progress : 0,
          completedAt: canViewProgress ? workOrder.completedAt : "",
          hasException: Boolean((!permissions || permissions.has("exceptions")) && workOrder.hasException),
        };
      });
      data.reports = (data.reports || []).filter((report) => {
        const route = db.routes.find((item) => item.id === report.routeId);
        return !route || canViewOutsourcePermission(outsourceAccess, report.workOrderId,
          route.processName === "质检" ? "quality" : "progress");
      });
      data.exceptions = (data.exceptions || []).filter((item) => canViewOutsourcePermission(outsourceAccess, item.workOrderId, "exceptions"));
      data.drawings = (data.drawings || []).filter((item) => canViewOutsourcePermission(outsourceAccess, item.workOrderId, "attachments"));
      data.attachments = (data.attachments || []).filter((item) => !item.workOrderId
        || canViewOutsourcePermission(outsourceAccess, item.workOrderId, "attachments"));
      if (!features.has("orders")) {
        data.orders = [];
        data.workOrders = [];
      }
      if (!features.has("dispatch")) {
        data.routes = [];
        data.reports = [];
        data.workOrders = data.workOrders.map((item) => ({ ...item, routes: [] }));
      }
      if (!features.has("quality")) data.exceptions = [];
      if (!features.has("customerFeedback") || !canViewRestrictedBoard(user)) delete data.customerFeedbacks;
      if (!features.has("settings")) data.processes = [];
      return send(res, 200, { ...data, roles, permissions: userPermissions(user), featureModules: [...features], featureCatalog: publicFeatureCatalog(context?.slug) });
    }

    if (req.method === "GET" && url.pathname === "/api/mobile/completions") {
      const period = String(url.searchParams.get("period") || "today");
      const includeItems = url.searchParams.get("includeItems") === "1";
      const result = mobileCompletionData(db, period, includeItems);
      if (!result) return send(res, 400, { error: "完工统计时间范围不正确" });
      if (includeItems && !canViewRestrictedBoard(user)) return send(res, 403, { error: "无权查看完工详情" });
      if (includeItems) result.canManageOrderFulfillment = userPermissions(user).manageOrderFulfillment;
      return send(res, 200, result);
    }

    if (req.method === "GET" && url.pathname === "/api/audit-logs") {
      if (!canSupervise(user)) return send(res, 403, { error: "无权查看操作日志" });
      const page = Math.max(1, Number(url.searchParams.get("page") || 1));
      const pageSize = Math.max(1, Math.min(100, Number(url.searchParams.get("pageSize") || 20)));
      const startDate = String(url.searchParams.get("startDate") || "");
      const endDate = String(url.searchParams.get("endDate") || "");
      const actorId = String(url.searchParams.get("actorId") || "");
      const action = String(url.searchParams.get("action") || "").toLowerCase();
      const keyword = String(url.searchParams.get("keyword") || "").toLowerCase();
      const sortBy = String(url.searchParams.get("sortBy") || "createdAt");
      const sortDir = url.searchParams.get("sortDir") === "asc" ? "asc" : "desc";
      const auditSorters = {
        createdAt: (item) => item.createdAt || "",
        actorName: (item) => item.actorName || "",
        action: (item) => item.action || "",
        target: (item) => `${item.targetType || ""}/${item.targetId || ""}`,
        detail: (item) => JSON.stringify(item.detail || {}),
      };
      if (!auditSorters[sortBy]) return send(res, 400, { error: "操作日志排序字段不正确" });
      const items = (db.auditLogs || [])
        .filter((item) => !startDate || String(item.createdAt || "").slice(0, 10) >= startDate)
        .filter((item) => !endDate || String(item.createdAt || "").slice(0, 10) <= endDate)
        .filter((item) => !actorId || item.actorId === actorId)
        .filter((item) => !action || String(item.action || "").toLowerCase().includes(action))
        .filter((item) => !keyword || JSON.stringify(item).toLowerCase().includes(keyword))
        .map((item) => {
          const actor = resolveUser(db, item.actorId);
          return { ...item, actorName: actor?.name || "未知用户", actorPhone: actor?.phone || "" };
        })
        .sort((a, b) => String(auditSorters[sortBy](a)).localeCompare(String(auditSorters[sortBy](b)), "zh-CN", { numeric: true }) * (sortDir === "asc" ? 1 : -1));
      const offset = (page - 1) * pageSize;
      return send(res, 200, { page, pageSize, total: items.length, items: items.slice(offset, offset + pageSize) });
    }

    if (req.method === "GET" && url.pathname === "/api/history/work-orders") {
      if (!canManage(user) && !userHasRole(user, "quality")) return send(res, 403, { error: "无权查看历史工单" });
      const sourceFiltersEnabled = SAAS_ENABLED && context?.tenantId === "future-machinery";
      const outsourcingTasks = [];
      if (sourceFiltersEnabled) {
        const store = getSaasStore();
        for (const task of await store.listOutsourceTasks(context.tenantId, "owner")) {
          if (task.status === "cancelled") continue;
          const partner = await store.findTenantById(task.partnerTenantId);
          const partnerDb = partner
            ? await withTenantDatabaseLock(partner, () => requestContext.run(partner, () => readDb()))
            : {};
          outsourcingTasks.push({
            ...outsourceTaskProjection(partnerDb, task, "owner", ["progress"], context.name || "", partner?.name || "外协单位"),
            side: "owner",
          });
        }
      }
      const filters = historyFilters(url, sourceFiltersEnabled);
      return send(res, 200, { items: workOrderHistoryItems(db, filters, canViewRestrictedBoard(user), sourceFiltersEnabled, outsourcingTasks) });
    }

    if (req.method === "GET" && url.pathname === "/api/history/exceptions") {
      if (!canManage(user) && !userHasRole(user, "quality")) return send(res, 403, { error: "无权查看异常记录" });
      return send(res, 200, { items: exceptionHistoryItems(db, historyFilters(url)) });
    }

    if (req.method === "GET" && url.pathname === "/api/customer-feedbacks") {
      if (!canViewRestrictedBoard(user)) return send(res, 403, { error: "无权查看客户反馈" });
      return send(res, 200, { items: db.customerFeedbacks.slice().sort((a, b) => String(b.feedbackAt || b.createdAt).localeCompare(String(a.feedbackAt || a.createdAt))) });
    }

    if (req.method === "POST" && url.pathname === "/api/customer-feedbacks") {
      if (!canViewRestrictedBoard(user)) return send(res, 403, { error: "无权登记客户反馈" });
      const body = await parseBody(req);
      const workOrder = db.workOrders.find((item) => item.id === body.workOrderId && item.status === "已完成");
      const order = workOrder && db.orders.find((item) => item.id === workOrder.orderId && item.customerId === body.customerId);
      const route = workOrder && db.routes.find((item) => item.id === body.routeId && item.workOrderId === workOrder.id);
      const description = String(body.description || "").trim();
      const feedbackAt = normalizeDate(body.feedbackAt);
      if (!workOrder || !order) return send(res, 400, { error: "请选择已完成订单工单" });
      if (!route) return send(res, 400, { error: "请选择该工单的问题工序" });
      if (!feedbackAt || !description) return send(res, 400, { error: "反馈时间和问题描述必填" });
      const item = { id: id("cf"), customerId: order.customerId, orderId: order.id, workOrderId: workOrder.id, routeId: route.id, feedbackAt, description, images: Array.isArray(body.images) ? body.images : [], status: "待处理", solution: "", reporterId: user.id, createdAt: new Date().toISOString() };
      db.customerFeedbacks.push(item);
      appendAudit(db, user, "customer-feedback-create", "customer-feedback", item.id, { customerId: item.customerId, workOrderId: item.workOrderId, routeId: item.routeId, feedbackAt, description });
      await writeDb(db);
      return send(res, 200, { ok: true, item });
    }

    if (req.method === "POST" && url.pathname === "/api/customer-feedbacks/resolve") {
      if (!canViewRestrictedBoard(user)) return send(res, 403, { error: "无权处理客户反馈" });
      const body = await parseBody(req);
      const item = db.customerFeedbacks.find((entry) => entry.id === body.id);
      const solution = String(body.solution || "").trim();
      if (!item) return send(res, 404, { error: "客户反馈不存在" });
      if (!solution) return send(res, 400, { error: "请填写处理结果" });
      item.status = "已处理";
      item.solution = solution;
      item.resolvedBy = user.id;
      item.resolvedAt = new Date().toISOString();
      appendAudit(db, user, "customer-feedback-resolve", "customer-feedback", item.id, { solution });
      await writeDb(db);
      return send(res, 200, { ok: true, item });
    }

    if (req.method === "POST" && url.pathname === "/api/orders/fulfillment") {
      if (!canViewRestrictedBoard(user)) return send(res, 403, { error: "无权更新发货开票状态" });
      const body = await parseBody(req);
      const order = db.orders.find((item) => item.id === body.orderId);
      const workOrders = order ? db.workOrders.filter((item) => item.orderId === order.id) : [];
      if (!order || !workOrders.length) return send(res, 404, { error: "订单工单不存在" });
      if (workOrders.some((item) => item.source === "saas-outsourcing")) return send(res, 403, { error: "外协任务交付请在外协监管中处理" });
      if (workOrders.some((item) => item.status !== "已完成")) return send(res, 400, { error: "工单尚未完成" });
      const before = { shippedAt: order.shippedAt || "", invoicedAt: order.invoicedAt || "" };
      const now = new Date().toISOString();
      order.shippedAt = body.shipped === true ? order.shippedAt || now : "";
      order.shippedBy = body.shipped === true ? order.shippedBy || user.id : "";
      order.invoicedAt = body.invoiced === true ? order.invoicedAt || now : "";
      order.invoicedBy = body.invoiced === true ? order.invoicedBy || user.id : "";
      order.status = orderFulfillmentStatus(workOrders[0], order);
      const shipmentEvent = body.shipped === true
        ? queuePlatformShipment(db, order, workOrders[0], order.shippedAt || now)
        : null;
      appendAudit(db, user, "order-fulfillment-update", "order", order.id, { before, after: { shippedAt: order.shippedAt, invoicedAt: order.invoicedAt }, status: order.status });
      await writeDb(db);
      if (shipmentEvent && shipmentEvent.status !== "delivered") setTimeout(() => void processPlatformWebhooks(), 50);
      return send(res, 200, { ok: true, status: order.status, order, platformSync: shipmentEvent?.status || "not-applicable" });
    }

    if (req.method === "POST" && url.pathname === "/api/settings/tv") {
      if (!["admin", "manager", "owner"].includes(user.role)) return send(res, 403, { error: "无权维护看板设置" });
      const body = await parseBody(req);
      const allowedRatios = ["auto", "16:9", "16:10", "21:9", "4:3"];
      const seconds = Math.max(30, Math.min(600, Number(body.tvCarouselSeconds || defaultSettings.tvCarouselSeconds)));
      const tvDisplayRatio = allowedRatios.includes(body.tvDisplayRatio) ? body.tvDisplayRatio : defaultSettings.tvDisplayRatio;
      db.settings = {
        ...defaultSettings,
        ...(db.settings || {}),
        tvCarouselEnabled: body.tvCarouselEnabled !== false,
        tvCarouselSeconds: seconds,
        tvDisplayRatio,
      };
      appendAudit(db, user, "tv-settings-save", "settings", "tv", db.settings);
      await writeDb(db);
      return send(res, 200, { ok: true, settings: db.settings });
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard") {
      const data = enrich(db);
      const openExceptions = db.exceptions.filter((e) => e.status !== "已解决").length;
      const overdue = data.workOrders.filter((w) => w.overdue).length;
      const active = data.workOrders.filter((w) => w.status !== "已完成").length;
      const finished = data.workOrders.filter((w) => w.status === "已完成").length;
      const processLoad = buildProcessLoad(db);
      return send(res, 200, { active, finished, overdue, openExceptions, processLoad, workOrders: data.workOrders });
    }

    if (req.method === "GET" && url.pathname === "/api/my-tasks") {
      const data = enrich(db);
      const tasks = db.routes
        .filter((route) => route.status !== "已完成" && canOperateRoute(user, route).ok)
        .map((r) => ({ ...enrichRoute(db, r), workOrder: data.workOrders.find((w) => w.id === r.workOrderId) }));
      return send(res, 200, { tasks });
    }

    const routeDrawingsMatch = req.method === "GET" && url.pathname.match(/^\/api\/routes\/([^/]+)\/drawings$/);
    if (routeDrawingsMatch) {
      const routeId = decodeURIComponent(routeDrawingsMatch[1]);
      const route = db.routes.find((item) => item.id === routeId);
      if (!route) return send(res, 404, { error: "工序不存在" });
      const permission = canOperateRoute(user, route);
      if (!permission.ok) return send(res, 403, { error: permission.error });
      const workOrder = db.workOrders.find((item) => item.id === route.workOrderId);
      if (!workOrder) return send(res, 404, { error: "工单不存在" });
      const items = db.drawings.filter((item) => !item.removedAt && (item.workOrderId === workOrder.id || item.orderId === workOrder.orderId));
      return send(res, 200, { items });
    }

    if (req.method === "POST" && url.pathname === "/api/customers") {
      if (!canManage(user.role)) return send(res, 403, { error: "无权维护客户" });
      const body = await parseBody(req);
      if (!body.name) return send(res, 400, { error: "客户名称必填" });
      const customer = { id: id("c"), name: body.name, contact: body.contact || "", phone: body.phone || "", address: body.address || "", note: body.note || "", active: true };
      db.customers.push(customer);
      appendAudit(db, user, "customer-create", "customer", customer.id, { name: customer.name, phone: customer.phone });
      await writeDb(db);
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/customers/delete") {
      if (!canDeleteCustomers(user)) return send(res, 403, { error: "仅最高权限账号可以停用客户" });
      const body = await parseBody(req);
      const customer = db.customers.find((c) => c.id === body.customerId && c.active !== false);
      if (!customer) return send(res, 404, { error: "客户不存在" });
      customer.active = false;
      customer.deletedAt = new Date().toISOString();
      customer.deletedBy = user.id;
      appendAudit(db, user, "customer-deactivate", "customer", customer.id, { name: customer.name });
      await writeDb(db);
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/users") {
      if (!getUserRoles(user).some((role) => ["admin", "manager", "owner"].includes(role))) return send(res, 403, { error: "无权维护员工" });
      const body = await parseBody(req);
      const userRoles = normalizeRoles(Array.isArray(body.roles) ? body.roles : body.role);
      const name = String(body.name || "").trim();
      const phone = String(body.phone || "").trim();
      const requestedPassword = String(body.password || "");
      if (!name || !phone || userRoles.length === 0) return send(res, 400, { error: "姓名、手机号和岗位角色必填" });
      if (!/^\+?[0-9]{7,18}$/.test(phone)) return send(res, 400, { error: "手机号格式无效，请填写 7–18 位数字" });
      if (SAAS_ENABLED && requestedPassword && requestedPassword.length < 8) return send(res, 400, { error: "初始密码至少需要 8 位" });
      const inactiveUser = db.users.find((u) => u.phone === phone && u.active === false);
      if (inactiveUser) {
        inactiveUser.name = name;
        inactiveUser.roles = userRoles;
        inactiveUser.role = primaryRoleFromRoles(userRoles);
        if (requestedPassword) inactiveUser.password = SAAS_ENABLED ? hashPassword(requestedPassword) : requestedPassword;
        if (!inactiveUser.password) inactiveUser.password = SAAS_ENABLED ? "" : "123456";
        if (!inactiveUser.password) return send(res, 400, { error: "恢复员工账号时必须设置新密码" });
        inactiveUser.active = true;
        inactiveUser.deletedAt = "";
        inactiveUser.deletedBy = "";
        appendAudit(db, user, "user-reactivate", "user", inactiveUser.id, { name: inactiveUser.name, phone: inactiveUser.phone, roles: userRoles });
        await writeDb(db);
        return send(res, 200, { ok: true, user: inactiveUser });
      }
      if (db.users.some((u) => u.phone === phone)) return send(res, 400, { error: "手机号已存在" });
      const password = requestedPassword || (SAAS_ENABLED ? "" : "123456");
      if (!password) return send(res, 400, { error: "请设置员工初始密码" });
      const newUser = { id: id("u"), name, phone, roles: userRoles, password: SAAS_ENABLED ? hashPassword(password) : password, active: true };
      newUser.role = primaryRoleFromRoles(userRoles);
      db.users.push(newUser);
      appendAudit(db, user, "user-create", "user", newUser.id, { name: newUser.name, phone: newUser.phone, roles: userRoles });
      await writeDb(db);
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/users/update-role") {
      if (!getUserRoles(user).some((role) => ["admin", "manager", "owner"].includes(role))) return send(res, 403, { error: "无权修改员工角色" });
      const body = await parseBody(req);
      const target = db.users.find((u) => u.id === body.userId && u.active !== false);
      if (!target) return send(res, 404, { error: "员工不存在" });
      if (target.id === user.id) return send(res, 400, { error: "不能修改当前登录账号角色" });
      const nextRoles = normalizeRoles(Array.isArray(body.roles) ? body.roles : body.role);
      if (nextRoles.length === 0) return send(res, 400, { error: "至少选择一个岗位角色" });
      const oldRoles = getUserRoles(target);
      target.roles = nextRoles;
      target.role = primaryRoleFromRoles(nextRoles);
      let clearedAssignments = 0;
      db.routes.forEach((route) => {
        const assignedRole = route.assignedRole || getProcessRole(route.processName);
        if (route.assignedTo === target.id && route.status !== "已完成" && assignedRole && !userHasRole(target, assignedRole)) {
          route.assignedTo = "";
          clearedAssignments += 1;
        }
      });
      appendAudit(db, user, "user-role-update", "user", target.id, { name: target.name, phone: target.phone, oldRoles, newRoles: nextRoles, clearedAssignments });
      await writeDb(db);
      return send(res, 200, { ok: true, user: target, clearedAssignments });
    }

    if (req.method === "POST" && url.pathname === "/api/users/delete") {
      if (!["admin", "manager", "owner"].includes(user.role)) return send(res, 403, { error: "无权删除员工" });
      const body = await parseBody(req);
      const target = db.users.find((u) => u.id === body.userId && u.active !== false);
      if (!target) return send(res, 404, { error: "员工不存在" });
      if (target.id === user.id) return send(res, 400, { error: "不能删除当前登录账号" });
      const deletedAt = new Date().toISOString();
      const deletedSnapshot = {
        id: target.id,
        name: target.name,
        phone: target.phone,
        role: target.role,
        roles: getUserRoles(target),
        roleName: roles[target.role] || target.role,
        deletedAt,
        deletedBy: user.id,
      };
      db.deletedUsers = (db.deletedUsers || []).filter((item) => item.id !== target.id);
      db.deletedUsers.push(deletedSnapshot);
      let clearedAssignments = 0;
      db.routes.forEach((route) => {
        if (route.assignedTo === target.id && route.status !== "已完成") {
          route.assignedTo = "";
          clearedAssignments += 1;
        }
      });
      db.users = db.users.filter((item) => item.id !== target.id);
      appendAudit(db, user, "user-delete", "user", target.id, { name: target.name, phone: target.phone, role: target.role, clearedAssignments });
      await writeDb(db);
      return send(res, 200, { ok: true, clearedAssignments });
    }

    if (req.method === "POST" && url.pathname === "/api/processes") {
      if (!["admin", "manager", "owner"].includes(user.role)) return send(res, 403, { error: "无权维护工序" });
      const body = await parseBody(req);
      const processName = normalizeProcessName(body.name);
      if (!processName) return send(res, 400, { error: "工序名称必填" });
      if (db.processes.some((process) => process.name === processName)) return send(res, 400, { error: "工序名称已存在" });
      const process = { id: id("p"), name: processName, sort: db.processes.length + 1, active: true };
      db.processes.push(process);
      appendAudit(db, user, "process-create", "process", process.id, { name: process.name });
      await writeDb(db);
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/processes/update-status") {
      if (!getUserRoles(user).some((role) => ["admin", "manager", "owner"].includes(role))) return send(res, 403, { error: "无权维护工序" });
      const body = await parseBody(req);
      const process = db.processes.find((item) => item.id === body.processId && defaultProcesses.includes(item.name));
      if (!process) return send(res, 404, { error: "标准工序不存在" });
      if (typeof body.active !== "boolean") return send(res, 400, { error: "工序状态必须为布尔值" });
      process.active = body.active;
      appendAudit(db, user, "process-status-update", "process", process.id, { name: process.name, active: process.active });
      await writeDb(db);
      return send(res, 200, { ok: true, process });
    }

    if (req.method === "POST" && url.pathname === "/api/orders/repeat") {
      if (!canManage(user)) return send(res, 403, { error: "无权创建返单" });
      const body = await parseBody(req);
      const sourceWorkOrder = db.workOrders.find((item) => item.id === body.sourceWorkOrderId);
      if (!sourceWorkOrder) return send(res, 404, { error: "原工单不存在" });
      if (sourceWorkOrder.source === "saas-outsourcing") return send(res, 403, { error: "外协任务不能从本地订单创建返单" });
      if (sourceWorkOrder.status !== "已完成") return send(res, 409, { error: "只有已完成工单可以返单" });
      const sourceOrder = db.orders.find((item) => item.id === sourceWorkOrder.orderId);
      if (!sourceOrder) return send(res, 404, { error: "原订单不存在" });
      const source = normalizedOrderSource(sourceOrder);
      const customer = db.customers.find((item) => item.id === sourceOrder.customerId && item.active !== false);
      if (!customer) return send(res, 409, { error: "原订单客户不存在或已停用" });

      const orderNo = String(body.orderNo || "").trim();
      const quantity = Number(body.quantity);
      const dueDate = normalizeDate(body.dueDate);
      const priority = String(body.priority || "").trim();
      const weight = normalizeWeightKg(body.weightKg);
      if (!orderNo) return send(res, 400, { error: "新订单号必填" });
      if (orderNo === sourceOrder.orderNo) return send(res, 409, { error: "新订单号不能与原订单号相同" });
      if (db.orders.some((item) => item.orderNo === orderNo)) return send(res, 409, { error: "订单号已存在" });
      if (!Number.isInteger(quantity) || quantity < 1) return send(res, 400, { error: "数量必须为大于 0 的整数" });
      if (!dueDate) return send(res, 400, { error: "交期格式请填写 YYYY/MM/DD" });
      if (!["普通", "急单"].includes(priority)) return send(res, 400, { error: "优先级不正确" });
      if (weight.error) return send(res, 400, { error: weight.error });

      const sourceRoutes = db.routes
        .filter((route) => route.workOrderId === sourceWorkOrder.id && route.routeType !== "rework")
        .sort((a, b) => a.sequence - b.sequence);
      if (!sourceRoutes.length) return send(res, 409, { error: "原工单没有可复制的正式工序" });
      const processes = sourceRoutes.map((route) => db.processes.find((process) => process.id === route.processId));
      if (processes.some((process) => !process || process.active === false)) return send(res, 409, { error: "原工单包含不存在或已停用的工序，请先处理工序配置" });

      const orderId = id("o");
      const workOrderId = id("w");
      const createdAt = new Date().toISOString();
      const order = {
        id: orderId,
        orderNo,
        customerId: sourceOrder.customerId,
        productName: sourceOrder.productName,
        drawingNo: sourceOrder.drawingNo || "",
        weightKg: weight.value,
        quantity,
        quantityUnit: normalizeQuantityUnit(sourceOrder.quantityUnit),
        dueDate,
        priority,
        status: "未开始",
        note: String(body.note || ""),
        orderOrigin: source.orderOrigin,
        sourceChannel: source.sourceChannel,
        externalOrderNumber: "",
        createdAt,
      };
      const workOrder = {
        id: workOrderId,
        workNo: orderNo,
        orderId,
        productName: sourceOrder.productName,
        planQty: quantity,
        status: "未开始",
        currentProcess: "",
        assigneeId: user.id,
        qrToken: id("qr"),
        createdAt,
      };
      const routes = sourceRoutes.map((sourceRoute, index) => ({
        id: id("r"),
        workOrderId,
        processId: sourceRoute.processId,
        processName: normalizeProcessName(sourceRoute.processName),
        assignedRole: getProcessRole(sourceRoute.processName),
        sequence: index + 1,
        assignedTo: "",
        qrToken: qrToken("rt"),
        status: "待开始",
        planQty: quantity,
        completedQty: 0,
        goodQty: 0,
        badQty: 0,
        reworkQty: 0,
      }));
      const sourceDrawings = db.drawings.filter((drawing) => !drawing.removedAt && (drawing.workOrderId === sourceWorkOrder.id || drawing.orderId === sourceOrder.id));
      const drawings = sourceDrawings.map((sourceDrawing) => {
        const drawing = {
          ...sourceDrawing,
          id: id("drw"),
          orderId,
          workOrderId,
          customerId: sourceOrder.customerId,
          uploaderId: user.id,
          createdAt,
        };
        delete drawing.removedAt;
        delete drawing.removedBy;
        return drawing;
      });
      const attachments = drawings.map((drawing) => ({ ...drawing, id: id("att"), attachmentType: "drawing" }));

      db.orders.push(order);
      db.workOrders.push(workOrder);
      db.routes.push(...routes);
      db.drawings.push(...drawings);
      db.attachments.push(...attachments);
      syncWorkOrder(db, workOrderId);
      appendAudit(db, user, "order-repeat-create", "order", orderId, {
        sourceOrderId: sourceOrder.id,
        sourceWorkOrderId: sourceWorkOrder.id,
        newOrderId: orderId,
        newWorkOrderId: workOrderId,
        orderNo,
        quantity,
        dueDate,
        priority,
        weightKg: weight.value,
        note: order.note,
        processNames: routes.map((route) => route.processName),
        drawingIds: drawings.map((drawing) => drawing.id),
      });
      await writeDb(db);
      return send(res, 200, { ok: true, order, workOrder, routes, drawings });
    }

    if (req.method === "POST" && url.pathname === "/api/orders/update") {
      if (!canSupervise(user)) return send(res, 403, { error: "无权编辑订单" });
      const body = await parseBody(req);
      const canEditFinancials = res.viewOrderFinancials;
      if (!canEditFinancials && (Object.hasOwn(body, "unitPrice") || Object.hasOwn(body, "totalAmount"))) {
        return send(res, 403, { error: "无权编辑订单金额" });
      }
      const order = db.orders.find((item) => item.id === body.orderId);
      if (!order) return send(res, 404, { error: "订单不存在" });
      if (isOutsourcedOrder(db, order.id)) return send(res, 403, { error: "外协任务订单信息由委派方维护" });
      const orderNo = String(body.orderNo || "").trim();
      if (normalizedOrderSource(order).orderOrigin === "platform" && orderNo !== order.orderNo) {
        return send(res, 400, { error: "平台订单号不可修改" });
      }
      const productName = String(body.productName || "").trim();
      const customer = db.customers.find((item) => item.id === body.customerId && item.active !== false);
      const dueDate = normalizeDate(body.dueDate);
      const weight = normalizeWeightKg(body.weightKg);
      const quantity = Number(body.quantity);
      if (!isValidQuantityUnit(body.quantityUnit)) return send(res, 400, { error: "数量单位仅支持件或套" });
      const quantityUnit = body.quantityUnit === undefined || String(body.quantityUnit).trim() === ""
        ? normalizeQuantityUnit(order.quantityUnit)
        : normalizeQuantityUnit(body.quantityUnit);
      if (!orderNo || !customer || !productName || !dueDate) return send(res, 400, { error: "订单号、客户、产品和交期必填" });
      if (weight.error) return send(res, 400, { error: weight.error });
      if (!Number.isInteger(quantity) || quantity < 1) return send(res, 400, { error: "数量必须为大于 0 的整数" });
      if (db.orders.some((item) => item.id !== order.id && item.orderNo === orderNo)) return send(res, 400, { error: "订单号已存在" });
      const priceResult = canEditFinancials && Object.hasOwn(body, "unitPrice")
        ? normalizeUnitPrice(body.unitPrice)
        : { value: order.unitPrice ?? null, error: "" };
      if (priceResult.error) return send(res, 400, { error: priceResult.error });
      const totalAmount = calculateOrderTotal(priceResult.value, quantity);
      if (priceResult.value !== null && totalAmount === null) return send(res, 400, { error: "订单总金额超出可处理范围" });

      const before = {
        orderNo: order.orderNo,
        customerId: order.customerId,
        productName: order.productName,
        quantity: order.quantity,
        quantityUnit: normalizeQuantityUnit(order.quantityUnit),
        drawingNo: order.drawingNo,
        weightKg: order.weightKg ?? null,
        dueDate: order.dueDate,
        priority: order.priority,
        note: order.note,
      };
      const oldOrderNo = order.orderNo;
      Object.assign(order, {
        orderNo,
        customerId: customer.id,
        productName,
        quantity,
        unitPrice: priceResult.value,
        totalAmount,
        quantityUnit,
        drawingNo: String(body.drawingNo || "").trim(),
        weightKg: weight.value,
        dueDate,
        priority: body.priority || order.priority,
        note: String(body.note || ""),
        updatedAt: new Date().toISOString(),
        updatedBy: user.id,
      });
      const linkedWorkOrders = db.workOrders.filter((item) => item.orderId === order.id);
      linkedWorkOrders.forEach((workOrder) => {
        if (workOrder.workNo === oldOrderNo) workOrder.workNo = orderNo;
        workOrder.productName = productName;
        workOrder.planQty = quantity;
      });
      const linkedWorkOrderIds = new Set(linkedWorkOrders.map((workOrder) => workOrder.id));
      const reopenedWorkOrders = new Set();
      db.routes.forEach((route) => {
        if (!linkedWorkOrderIds.has(route.workOrderId) || route.routeType === "rework") return;
        const increased = quantity > Number(route.planQty);
        route.planQty = quantity;
        if (increased && canReopenOrder(order) && reopenIncompleteRoute(db, route)) reopenedWorkOrders.add(route.workOrderId);
      });
      for (const workOrderId of reopenedWorkOrders) syncWorkOrder(db, workOrderId);

      const addedDrawings = [];
      [...new Set(Array.isArray(body.addDrawingIds) ? body.addDrawingIds : [])].forEach((drawingId) => {
        const drawing = db.drawings.find((item) => item.id === drawingId && !item.removedAt);
        if (!drawing) return;
        drawing.orderId = order.id;
        drawing.workOrderId = linkedWorkOrders[0]?.id || "";
        drawing.customerId = customer.id;
        addedDrawings.push({ id: drawing.id, name: drawing.name });
      });
      const removedDrawings = [];
      [...new Set(Array.isArray(body.removeDrawingIds) ? body.removeDrawingIds : [])].forEach((drawingId) => {
        const drawing = db.drawings.find((item) => item.id === drawingId && item.orderId === order.id && !item.removedAt);
        if (!drawing) return;
        drawing.removedAt = new Date().toISOString();
        drawing.removedBy = user.id;
        removedDrawings.push({ id: drawing.id, name: drawing.name });
      });
      appendAudit(db, user, "order-update", "order", order.id, {
        before,
        after: { orderNo, customerId: customer.id, productName, quantity, quantityUnit, drawingNo: order.drawingNo, weightKg: order.weightKg, dueDate, priority: order.priority, note: order.note },
        addedDrawings,
        removedDrawings,
      });
      await writeDb(db);
      return send(res, 200, { ok: true, order, workOrders: linkedWorkOrders });
    }

    if (req.method === "POST" && url.pathname === "/api/orders") {
      if (!canManage(user.role)) return send(res, 403, { error: "无权创建订单" });
      const body = await parseBody(req);
      const canEditFinancials = res.viewOrderFinancials;
      if (!canEditFinancials && (Object.hasOwn(body, "unitPrice") || Object.hasOwn(body, "totalAmount"))) {
        return send(res, 403, { error: "无权填写订单金额" });
      }
      const priceResult = canEditFinancials ? normalizeUnitPrice(body.unitPrice) : { value: null, error: "" };
      if (priceResult.error) return send(res, 400, { error: priceResult.error });
      const orderNo = String(body.orderNo || "").trim();
      const productName = String(body.productName || "").trim();
      const weight = normalizeWeightKg(body.weightKg);
      if (!isValidQuantityUnit(body.quantityUnit)) return send(res, 400, { error: "数量单位仅支持件或套" });
      const quantityUnit = normalizeQuantityUnit(body.quantityUnit);
      if (!orderNo || !body.customerId || !productName || !body.quantity || !body.dueDate) return send(res, 400, { error: "订单号、客户、产品、数量和交期必填" });
      if (weight.error) return send(res, 400, { error: weight.error });
      if (!db.customers.some((customer) => customer.id === body.customerId && customer.active !== false)) return send(res, 400, { error: "客户不存在或已停用" });
      const dueDate = normalizeDate(body.dueDate);
      if (!dueDate) return send(res, 400, { error: "交期格式请填写 YYYY/MM/DD" });
      if (!Array.isArray(body.processIds) || body.processIds.length === 0) return send(res, 400, { error: "至少选择一道工序" });
      const selectedProcesses = [...new Set(body.processIds)]
        .map((processId) => db.processes.find((process) => process.id === processId))
        .filter(Boolean);
      if (selectedProcesses.length !== new Set(body.processIds).size) return send(res, 400, { error: "所选工序不存在" });
      if (selectedProcesses.some((process) => process.active === false)) return send(res, 400, { error: "所选工序已停用，请刷新后重试" });
      if (!selectedProcesses.some((process) => process.name !== "质检")) return send(res, 400, { error: "质检前至少选择一道生产工序" });
      selectedProcesses.sort((a, b) => {
        const order = processOrderIndex(a.name) - processOrderIndex(b.name);
        return order || body.processIds.indexOf(a.id) - body.processIds.indexOf(b.id);
      });
      const orderId = id("o");
      const workOrderId = id("w");
      const createdAt = new Date().toISOString();
      const quantity = Number(body.quantity);
      const totalAmount = calculateOrderTotal(priceResult.value, quantity);
      if (priceResult.value !== null && totalAmount === null) return send(res, 400, { error: "订单总金额超出可处理范围" });
      const order = { id: orderId, orderNo, customerId: body.customerId, productName, drawingNo: body.drawingNo || "", weightKg: weight.value, quantity, unitPrice: priceResult.value, totalAmount, quantityUnit, dueDate, priority: body.priority || "普通", status: "未开始", note: body.note || "", orderOrigin: "factory", sourceChannel: "factory_manual", externalOrderNumber: "", createdAt };
      const workOrder = { id: workOrderId, workNo: String(body.workNo || orderNo).trim(), orderId, productName, planQty: Number(body.quantity), status: "未开始", currentProcess: "", assigneeId: user.id, qrToken: id("qr"), createdAt };
      db.orders.push(order);
      db.workOrders.push(workOrder);
      (Array.isArray(body.drawingIds) ? body.drawingIds : []).forEach((drawingId) => {
        const drawing = db.drawings.find((item) => item.id === drawingId);
        if (!drawing) return;
        drawing.orderId = orderId;
        drawing.workOrderId = workOrderId;
        drawing.customerId = body.customerId;
      });
      selectedProcesses.forEach((process, index) => {
          db.routes.push({
            id: id("r"),
            workOrderId,
            processId: process.id,
            processName: normalizeProcessName(process.name),
            assignedRole: getProcessRole(process.name),
            sequence: index + 1,
            assignedTo: "",
            qrToken: qrToken("rt"),
            status: "待开始",
            planQty: Number(body.quantity),
            completedQty: 0,
            goodQty: 0,
            badQty: 0,
            reworkQty: 0,
          });
      });
      syncWorkOrder(db, workOrderId);
      appendAudit(db, user, "order-create", "order", order.id, { orderNo, productName, customerId: body.customerId, quantity: order.quantity, quantityUnit, drawingIds: body.drawingIds || [] });
      await writeDb(db);
      return send(res, 200, { ok: true, order, workOrder });
    }

    if (req.method === "POST" && url.pathname === "/api/routes/publish-schedule") {
      if (!canManage(user.role)) return send(res, 403, { error: "无权发布排期" });
      const body = await parseBody(req);
      const workOrder = db.workOrders.find((item) => item.id === body.workOrderId);
      if (!workOrder) return send(res, 409, { error: "工单不存在，请放弃草稿并刷新" });
      if (!Array.isArray(body.routes) || !body.routes.length) return send(res, 400, { error: "没有需要发布的排期" });
      const seen = new Set();
      const updates = [];
      for (const item of body.routes) {
        if (!item || typeof item.routeId !== "string" || seen.has(item.routeId)) return send(res, 400, { error: "工序ID无效或重复" });
        seen.add(item.routeId);
        const route = db.routes.find((entry) => entry.id === item.routeId && entry.workOrderId === workOrder.id);
        if (!route) return send(res, 409, { error: "工序不存在或不属于该工单，请放弃草稿并刷新", routeId: item.routeId });
        const beforeStart = String(route.plannedStartDate || "");
        const beforeEnd = String(route.plannedEndDate || route.targetFinishTime?.slice(0, 10) || "");
        if (beforeStart !== item.expectedStartDate || beforeEnd !== item.expectedEndDate) return send(res, 409, { error: `${route.processName}排期已被修改，请放弃草稿并刷新`, routeId: route.id });
        const schedule = normalizeRouteSchedule(item.plannedStartDate, item.plannedEndDate);
        if (schedule.error) return send(res, 400, { error: `${route.processName}：${schedule.error}`, routeId: route.id });
        updates.push({ route, schedule, beforeStart, beforeEnd });
      }
      for (const { route, schedule } of updates) {
        Object.assign(route, schedule);
        route.targetFinishTime = schedule.plannedEndDate ? `${schedule.plannedEndDate}T23:00` : "";
      }
      appendAudit(db, user, "schedule-publish", "workOrder", workOrder.id, {
        routes: updates.map(({ route, beforeStart, beforeEnd }) => ({ routeId: route.id, beforeStart, beforeEnd, plannedStartDate: route.plannedStartDate, plannedEndDate: route.plannedEndDate })),
      });
      await writeDb(db);
      return send(res, 200, { ok: true, routes: updates.map(({ route }) => route) });
    }

    if (req.method === "POST" && url.pathname === "/api/assign") {
      if (!canManage(user.role)) return send(res, 403, { error: "无权派工" });
      const body = await parseBody(req);
      const route = db.routes.find((r) => r.id === body.routeId);
      if (!route) return send(res, 404, { error: "工序不存在" });
      const routePermission = route.processName === "质检" ? "quality" : "progress";
      const outsourceError = await outsourceWorkOrderPermissionError(db, route.workOrderId, routePermission);
      if (outsourceError) return send(res, 403, { error: outsourceError });
      const assigneePermission = validateAssignee(db, route.processName, body.userId || "");
      if (!assigneePermission.ok) return send(res, 400, { error: assigneePermission.error });
      const hasSchedule = ["plannedStartDate", "plannedEndDate", "targetFinishTime"].some((key) => Object.hasOwn(body, key));
      if (hasSchedule) {
        const targetFinishTime = body.targetFinishTime ? normalizeTargetFinishTime(body.targetFinishTime) : "";
        if (body.targetFinishTime && !targetFinishTime) return send(res, 400, { error: "目标完成时间格式不正确" });
        const schedule = normalizeRouteSchedule(body.plannedStartDate, body.plannedEndDate || targetFinishTime.slice(0, 10));
        if (schedule.error) return send(res, 400, { error: schedule.error });
        Object.assign(route, schedule, { targetFinishTime });
      }
      route.assignedRole = getProcessRole(route.processName);
      route.assignedTo = body.userId || "";
      appendAudit(db, user, "route-assign", "route", route.id, { assignedTo: route.assignedTo, targetFinishTime: route.targetFinishTime || "", plannedStartDate: route.plannedStartDate, plannedEndDate: route.plannedEndDate });
      await writeDb(db);
      return send(res, 200, { ok: true, route });
    }

    if (req.method === "POST" && url.pathname === "/api/routes") {
      if (!canManage(user.role)) return send(res, 403, { error: "无权调整工艺路线" });
      const body = await parseBody(req);
      const workOrder = db.workOrders.find((w) => w.id === body.workOrderId);
      const process = db.processes.find((p) => p.id === body.processId);
      if (!workOrder) return send(res, 404, { error: "工单不存在" });
      if (workOrder.source === "saas-outsourcing") return send(res, 403, { error: "外协任务工序由委派任务确定，不能在此增删" });
      if (!process) return send(res, 404, { error: "工序不存在" });
      if (process.active === false) return send(res, 400, { error: "该工序已停用，不能新增" });
      const assigneePermission = validateAssignee(db, process.name, body.assignedTo || "");
      if (!assigneePermission.ok) return send(res, 400, { error: assigneePermission.error });
      const targetFinishTime = body.targetFinishTime ? normalizeTargetFinishTime(body.targetFinishTime) : "";
      if (body.targetFinishTime && !targetFinishTime) return send(res, 400, { error: "目标完成时间格式不正确" });
      const schedule = normalizeRouteSchedule(body.plannedStartDate, body.plannedEndDate || targetFinishTime.slice(0, 10));
      if (schedule.error) return send(res, 400, { error: schedule.error });
      const existingRoutes = db.routes.filter((r) => r.workOrderId === workOrder.id);
      let sequence = Number(body.sequence || existingRoutes.length + 1);
      if (!body.sequence) {
        const laterRoute = existingRoutes
          .filter((route) => processOrderIndex(route.processName) > processOrderIndex(process.name))
          .sort((a, b) => a.sequence - b.sequence)[0];
        sequence = Number(laterRoute?.sequence || existingRoutes.length + 1);
      }
      db.routes
        .filter((r) => r.workOrderId === workOrder.id && r.sequence >= sequence)
        .forEach((r) => {
          r.sequence += 1;
        });
      const route = {
        id: id("r"),
        workOrderId: workOrder.id,
        processId: process.id,
        processName: normalizeProcessName(process.name),
        assignedRole: getProcessRole(process.name),
        sequence,
        assignedTo: body.assignedTo || "",
        qrToken: qrToken("rt"),
        targetFinishTime,
        plannedStartDate: schedule.plannedStartDate,
        plannedEndDate: schedule.plannedEndDate,
        status: "待开始",
        planQty: Number(body.planQty || workOrder.planQty || 0),
        completedQty: 0,
        goodQty: 0,
        badQty: 0,
        reworkQty: 0,
      };
      db.routes.push(route);
      syncWorkOrder(db, workOrder.id);
      appendAudit(db, user, "route-create", "route", route.id, { workOrderId: workOrder.id, processName: route.processName, sequence: route.sequence });
      await writeDb(db);
      return send(res, 200, { ok: true, route });
    }

    if (req.method === "POST" && url.pathname === "/api/routes/delete") {
      if (!canManage(user.role)) return send(res, 403, { error: "无权调整工艺路线" });
      const body = await parseBody(req);
      const route = db.routes.find((r) => r.id === body.routeId);
      if (!route) return send(res, 404, { error: "工序不存在" });
      if (db.workOrders.find((item) => item.id === route.workOrderId)?.source === "saas-outsourcing") return send(res, 403, { error: "外协任务工序不能删除" });
      if (Number(route.completedQty || 0) > 0 || route.status === "已完成") return send(res, 400, { error: "已有报工的工序不能删除，可改为暂停或返工" });
      db.routes = db.routes.filter((r) => r.id !== route.id);
      db.routes
        .filter((r) => r.workOrderId === route.workOrderId)
        .sort((a, b) => a.sequence - b.sequence)
        .forEach((r, index) => {
          r.sequence = index + 1;
        });
      syncWorkOrder(db, route.workOrderId);
      appendAudit(db, user, "route-delete", "route", route.id, { workOrderId: route.workOrderId, processName: route.processName });
      await writeDb(db);
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/work-orders/delete") {
      const forceDelete = canForceDeleteWorkOrders(user);
      if (!canManage(user.role) && !forceDelete) return send(res, 403, { error: "无权删除工单" });
      const body = await parseBody(req);
      const workOrder = db.workOrders.find((w) => w.id === body.workOrderId);
      if (!workOrder) return send(res, 404, { error: "工单不存在" });
      if (workOrder.source === "saas-outsourcing") return send(res, 403, { error: "外协委派工单不能在此删除" });
      const hasReports = db.reports.some((report) => report.workOrderId === workOrder.id);
      const hasCompletedQty = db.routes.some((route) => route.workOrderId === workOrder.id && Number(route.completedQty || 0) > 0);
      if ((hasReports || hasCompletedQty) && !forceDelete) return send(res, 400, { error: "已有报工记录的工单不能删除" });
      const deletedReportCount = db.reports.filter((report) => report.workOrderId === workOrder.id).length;
      const deletedExceptionCount = db.exceptions.filter((item) => item.workOrderId === workOrder.id).length;
      db.reports = db.reports.filter((report) => report.workOrderId !== workOrder.id);
      db.routes = db.routes.filter((route) => route.workOrderId !== workOrder.id);
      db.exceptions = db.exceptions.filter((item) => item.workOrderId !== workOrder.id);
      db.workOrders = db.workOrders.filter((item) => item.id !== workOrder.id);
      if (!db.workOrders.some((item) => item.orderId === workOrder.orderId)) {
        db.orders = db.orders.filter((item) => item.id !== workOrder.orderId);
      }
      appendAudit(db, user, forceDelete ? "work-order-force-delete" : "work-order-delete", "workOrder", workOrder.id, { workNo: workOrder.workNo, orderId: workOrder.orderId, forceDelete, deletedReportCount, deletedExceptionCount });
      await writeDb(db);
      return send(res, 200, { ok: true, forceDelete });
    }

    if (req.method === "POST" && url.pathname === "/api/route-status") {
      const body = await parseBody(req);
      const route = db.routes.find((r) => r.id === body.routeId);
      if (!route) return send(res, 404, { error: "工序不存在" });
      const routePermission = route.processName === "质检" ? "quality" : body.status === "异常" ? "exceptions" : "progress";
      const outsourceError = await outsourceWorkOrderPermissionError(db, route.workOrderId, routePermission);
      if (outsourceError) return send(res, 403, { error: outsourceError });
      const allowed = ["待开始", "进行中", "暂停", "返工", "异常", "已完成"];
      if (!allowed.includes(body.status)) return send(res, 400, { error: "工序状态不正确" });
      const operationPermission = canOperateRoute(user, route);
      if (!operationPermission.ok) return send(res, 403, { error: operationPermission.error });
      if (!isShopWorker(user) && !canManage(user)) return send(res, 403, { error: "无权修改工序状态" });
      if (isShopWorker(user) && !canManage(user)) {
        const validTransition =
          (route.status === "待开始" && body.status === "进行中") ||
          (route.status === "进行中" && body.status === "暂停") ||
          (route.status === "暂停" && body.status === "进行中");
        if (!validTransition) return send(res, 400, { error: "当前工序状态不允许该操作，请刷新后重试" });
      }
      const statusValidation = validateRouteStatusChange(db, route, body.status);
      if (!statusValidation.ok) return send(res, 409, { error: statusValidation.error });
      const beforeStatus = route.status;
      route.status = body.status;
      if (body.status === "进行中" && !route.startedAt) route.startedAt = new Date().toISOString();
      if (body.status === "暂停") route.pausedAt = new Date().toISOString();
      syncWorkOrder(db, route.workOrderId);
      appendAudit(db, user, "route-status", "route", route.id, {
        beforeStatus, afterStatus: route.status, planQty: Number(route.planQty || 0), completedQty: Number(route.completedQty || 0),
      });
      await writeDb(db);
      return send(res, 200, { ok: true, route });
    }

    if (req.method === "POST" && ["/api/report", "/api/dispatch-board/report"].includes(url.pathname)) {
      const body = await parseBody(req);
      const route = db.routes.find((r) => r.id === body.routeId);
      if (!route) return send(res, 404, { error: "工序不存在" });
      const proxyReport = url.pathname === "/api/dispatch-board/report";
      const submissionId = String(body.submissionId || "");
      const submissionHash = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
      if (proxyReport) {
        if (!/^[a-zA-Z0-9-]{16,80}$/.test(submissionId)) return send(res, 400, { error: "报工提交标识无效" });
        const previous = db.reports.find((item) => item.dispatchSubmissionId === submissionId && item.reporterId === user.id);
        if (previous) {
          if (previous.dispatchSubmissionHash !== submissionHash || previous.routeId !== route.id) return send(res, 409, { error: "该提交已处理，请关闭后重新打开报工窗口" });
          return send(res, 200, { ok: true, route, report: previous, dashboard: buildTvDashboard(db, true, false, ["factory", "platform"].includes(body.source) ? body.source : "all") });
        }
        if (route.status !== "进行中" || Number(body.expectedCompletedQty) !== Number(route.completedQty || 0)) return send(res, 409, { error: "工序状态或剩余数量已变化，请关闭后重新打开" });
        if (route.processName === "质检" && Number(body.expectedInspectionAvailableQty) !== Number(qualityRouteMeta(db, route).inspectionAvailableQty || 0)) return send(res, 409, { error: "可送检数量已变化，请重新打开" });
      }
      const routePermission = route.processName === "质检" ? "quality" : "progress";
      const outsourceError = await outsourceWorkOrderPermissionError(db, route.workOrderId, routePermission);
      if (outsourceError) return send(res, 403, { error: outsourceError });
      if ((route.processName === "质检" && Number(body.badQty || 0) > 0)
        || (route.processName !== "质检" && (body.exceptionType || body.exceptionDescription))) {
        const exceptionError = await outsourceWorkOrderPermissionError(db, route.workOrderId, "exceptions");
        if (exceptionError) return send(res, 403, { error: exceptionError });
      }
      const permission = proxyReport ? { ok: true } : canReportProcess(user, route);
      if (!permission.ok) return send(res, 403, { error: permission.error });
      if (proxyReport && !canManage(user)) return send(res, 403, { error: "无权代报工" });
      const beforeStatus = route.status;
      const isQuality = route.processName === "质检";
      const reportWorkOrder = db.workOrders.find((item) => item.id === route.workOrderId);
      const reportOrder = db.orders.find((item) => item.id === reportWorkOrder?.orderId);
      const isOutsourceReport = reportWorkOrder?.source === "saas-outsourcing";
      const reportQuantityUnit = normalizeQuantityUnit(reportOrder?.quantityUnit);
      if (body.autoStartQuality) {
        if (!isQuality || !canManage(user)) return send(res, 403, { error: "无权自动开启质检" });
        const qualityMeta = qualityRouteMeta(db, route);
        if (!qualityMeta.sourceCompleted) return send(res, 400, { error: "质检前一道工序尚未完成" });
        if (route.status === "待开始") {
          route.status = "进行中";
          route.startedAt = new Date().toISOString();
        }
      }
      const statusPermission = canReportRouteStatus(route);
      if (!statusPermission.ok) return send(res, 409, { error: statusPermission.error });
      let completedQty = Number(body.completedQty || 0);
      let submittedQty = 0;
      let inspectedQty = 0;
      let goodQty = 0;
      let badQty = 0;
      let reworkQty = Number(body.reworkQty || 0);
      let disposition = "";
      let qualityIssueRoute = null;
      const remainingQty = Math.max(0, Number(route.planQty) - Number(route.completedQty || 0));
      let reservedQty = 0;
      if (SAAS_ENABLED && requestContext.getStore()?.slug === "future-machinery" && reportWorkOrder && reportOrder) {
        const reservations = await getSaasStore().listTaskReservations(requestContext.getStore().tenantId, reportOrder.id);
        reservedQty = reservations.reduce((sum, reservation) => {
          const process = (reservation.snapshot.processes || []).find((item) => item.routeId ? item.routeId === route.id : item.name === route.processName && (item.sourceSequence ? Number(item.sourceSequence) === Number(route.sequence) : true));
          return sum + (process ? Number(reservation.snapshot.quantity || 0) : 0);
        }, 0);
      }
      if (isQuality) {
        submittedQty = Number(body.submittedQty);
        inspectedQty = Number(body.inspectedQty);
        goodQty = Number(body.goodQty);
        badQty = Number(body.badQty || 0);
        disposition = String(body.disposition || "无需处理");
        if (submittedQty < 1 || inspectedQty < 1) return send(res, 400, { error: "送检数量和检验数量必须大于 0" });
        if (inspectedQty !== submittedQty) return send(res, 400, { error: "检验数量必须等于送检数量" });
        if (goodQty < 0 || badQty < 0 || goodQty + badQty !== inspectedQty) return send(res, 400, { error: "检验数量必须等于合格数量与不合格数量之和" });
        if (!["无需处理", "返工", "让步接收", "报废"].includes(disposition)) return send(res, 400, { error: "质检处理方式无效" });
        if (badQty > 0 && disposition === "无需处理") return send(res, 400, { error: "存在不合格品时必须选择处理方式" });
        if (badQty > 0 && !String(body.exceptionDescription || "").trim()) return send(res, 400, { error: "存在不合格品时必须填写问题说明" });
        const qualityMeta = qualityRouteMeta(db, route);
        if (submittedQty > qualityMeta.inspectionAvailableQty) return send(res, 400, { error: `本次最多可送检 ${qualityMeta.inspectionAvailableQty} ${reportQuantityUnit}` });
        if (badQty > 0) {
          const issueRouteId = body.issueRouteId || body.reworkTargetRouteId;
          qualityIssueRoute = db.routes.find((item) => item.id === issueRouteId && item.workOrderId === route.workOrderId && item.processName !== "质检" && item.routeType !== "rework");
          if (!qualityIssueRoute) return send(res, 400, { error: "请选择本工单的问题工序" });
        }
        if (disposition === "返工") {
          const targetRoute = db.routes.find((item) => item.id === body.reworkTargetRouteId && item.workOrderId === route.workOrderId && item.processName !== "质检" && item.routeType !== "rework");
          if (!targetRoute) return send(res, 400, { error: "请选择本工单的返工工序" });
          const targetProcess = db.processes.find((item) => item.id === targetRoute.processId || item.name === targetRoute.processName);
          if (!targetProcess || targetProcess.active === false) return send(res, 400, { error: "返工目标工序已停用" });
        }
        completedQty = goodQty + (disposition === "让步接收" ? badQty : 0);
        reworkQty = disposition === "返工" ? badQty : 0;
      } else {
        if (!completedQty || completedQty < 1) return send(res, 400, { error: "完成数量必须大于 0" });
        if (reworkQty < 0 || reworkQty > completedQty) return send(res, 400, { error: "返工数量不能超过完成数量" });
      }
      if (reservedQty && completedQty > Math.max(0, remainingQty - reservedQty)) return send(res, 409, { error: `该工序已委派 ${reservedQty}，本次内部报工最多 ${Math.max(0, remainingQty - reservedQty)} ${reportQuantityUnit}` });
      if (completedQty > remainingQty) return send(res, 400, { error: "本次计入完成的数量不能超过剩余数量" });
      const outsourceImages = isOutsourceReport
        ? normalizeOutsourceReportImages(body.images || [], requestContext.getStore()?.tenantId)
        : null;
      if (isOutsourceReport && !outsourceImages) return send(res, 400, { error: "外协报工图片无效，请重新上传任务照片" });
      if (requiresOutsourceCompletionPhoto(isOutsourceReport, route.completedQty, route.planQty, completedQty)
        && outsourceImages.length < 1) return send(res, 400, { error: "外协工序完工报工必须上传至少一张现场照片" });
      route.completedQty = Math.min(Number(route.planQty), Number(route.completedQty || 0) + completedQty);
      route.goodQty = Number(route.goodQty || 0) + goodQty;
      route.badQty = Number(route.badQty || 0) + badQty;
      route.reworkQty = Number(route.reworkQty || 0) + reworkQty;
      route.lastReportedAt = new Date().toISOString();
      route.lastReporterId = user.id;
      route.status = canonicalRouteStatus(db, route, "进行中");
      if (route.status === "已完成") route.completedAt = route.lastReportedAt;
      const schedule = reportSchedule(route, route.lastReportedAt);
      const report = {
        id: id("rep"),
        routeId: route.id,
        workOrderId: route.workOrderId,
        reporterId: user.id,
        reportType: isQuality ? "quality" : "production",
        completedQty,
        submittedQty,
        inspectedQty,
        goodQty,
        badQty,
        reworkQty,
        disposition,
        reworkTargetRouteId: isQuality && disposition === "返工" ? body.reworkTargetRouteId : "",
        note: body.note || "",
        images: isOutsourceReport ? outsourceImages : body.images || [],
        createdAt: route.lastReportedAt,
        ...schedule,
      };
      if (proxyReport) {
        report.dispatchSubmissionId = submissionId;
        report.dispatchSubmissionHash = submissionHash;
        report.dispatchRouteResult = { ...route };
        report.source = "dispatch-board";
      }
      db.reports.push(report);
      let reworkRoute = null;
      if (isQuality && disposition === "返工" && badQty > 0) {
        const targetRoute = db.routes.find((item) => item.id === body.reworkTargetRouteId);
        db.routes
          .filter((item) => item.workOrderId === route.workOrderId && item.sequence >= route.sequence)
          .forEach((item) => {
            item.sequence += 1;
          });
        reworkRoute = {
          id: id("r"),
          workOrderId: route.workOrderId,
          processId: targetRoute.processId,
          processName: targetRoute.processName,
          assignedRole: getProcessRole(targetRoute.processName),
          sequence: route.sequence - 1,
          assignedTo: "",
          qrToken: qrToken("rt"),
          status: "待开始",
          planQty: badQty,
          completedQty: 0,
          goodQty: 0,
          badQty: 0,
          reworkQty: 0,
          routeType: "rework",
          sourceQualityRouteId: route.id,
          sourceQualityReportId: report.id,
          reworkOfRouteId: targetRoute.id,
        };
        db.routes.push(reworkRoute);
      }
      if (isQuality && badQty > 0) {
        db.exceptions.push({
          id: id("e"),
          workOrderId: route.workOrderId,
          routeId: reworkRoute ? reworkRoute.id : qualityIssueRoute.id,
          qualityRouteId: route.id,
          qualityReportId: report.id,
          reworkRouteId: reworkRoute ? reworkRoute.id : "",
          type: body.exceptionType || qualityIssueRoute.processName || `质检${disposition}`,
          description: String(body.exceptionDescription || "").trim(),
          status: "待处理",
          reporterId: user.id,
          createdAt: route.lastReportedAt,
          images: isOutsourceReport ? outsourceImages : body.images || [],
          badQty,
          reworkQty,
          disposition,
          issueRouteId: qualityIssueRoute.id,
          reworkTargetRouteId: reworkRoute ? body.reworkTargetRouteId : "",
        });
      } else if (!isQuality && (body.exceptionType || body.exceptionDescription)) {
        route.status = "异常";
        db.exceptions.push({ id: id("e"), workOrderId: route.workOrderId, routeId: route.id, type: body.exceptionType || "现场异常", description: body.exceptionDescription || body.note || "", status: "待处理", reporterId: user.id, createdAt: new Date().toISOString(), images: isOutsourceReport ? outsourceImages : body.images || [] });
      }
      if (route.status === "已完成" && route.routeType === "rework") {
        db.exceptions
          .filter((item) => item.reworkRouteId === route.id && item.status !== "已解决")
          .forEach((item) => {
            item.status = "已解决";
            item.solution = "返工任务已完成，等待重新质检";
            item.resolvedBy = user.id;
            item.resolvedAt = route.completedAt;
          });
      }
      syncWorkOrder(db, route.workOrderId);
      queuePlatformProgress(db, route, report.id, report.createdAt);
      appendAudit(db, user, "report-create", "report", report.id, {
        routeId: route.id,
        workOrderId: route.workOrderId,
        processName: route.processName,
        beforeStatus,
        afterStatus: route.status,
        planQty: Number(route.planQty || 0),
        routeCompletedQty: Number(route.completedQty || 0),
        completedQty: report.completedQty,
        submittedQty: report.submittedQty,
        inspectedQty: report.inspectedQty,
        goodQty: report.goodQty,
        badQty: report.badQty,
        reworkQty: report.reworkQty,
      });
      if (proxyReport) appendAudit(db, user, "dispatch-report-create", "report", report.id, { routeId: route.id, submissionId, managerId: user.id });
      await writeDb(db);
      setTimeout(() => void processPlatformWebhooks(), 50);
      return send(res, 200, { ok: true, route, report, ...(proxyReport ? { dashboard: buildTvDashboard(db, true, false, ["factory", "platform"].includes(body.source) ? body.source : "all") } : {}) });
    }

    if (req.method === "POST" && url.pathname === "/api/exceptions/resolve") {
      if (!["manager", "quality", "admin", "owner"].includes(user.role)) return send(res, 403, { error: "无权处理异常" });
      const body = await parseBody(req);
      const item = db.exceptions.find((e) => e.id === body.id);
      if (!item) return send(res, 404, { error: "异常不存在" });
      const outsourceError = await outsourceWorkOrderPermissionError(db, item.workOrderId, "exceptions");
      if (outsourceError) return send(res, 403, { error: outsourceError });
      const route = db.routes.find((r) => r.id === item.routeId);
      const beforeStatus = route?.status || "";
      item.status = body.status || "已解决";
      item.solution = body.solution || "";
      item.resolvedBy = user.id;
      item.resolvedAt = new Date().toISOString();
      if (route && item.status === "已解决" && ["异常", "返工"].includes(route.status)) {
        route.status = canonicalRouteStatus(db, route, "进行中");
      }
      if (route) syncWorkOrder(db, route.workOrderId);
      appendAudit(db, user, "exception-resolve", "exception", item.id, {
        status: item.status, solution: item.solution, workOrderId: item.workOrderId, routeId: item.routeId,
        beforeStatus, afterStatus: route?.status || "", planQty: Number(route?.planQty || 0), completedQty: Number(route?.completedQty || 0),
      });
      await writeDb(db);
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/exceptions") {
      if (!["manager", "quality", "admin", "owner"].includes(user.role)) return send(res, 403, { error: "无权登记异常" });
      const body = await parseBody(req);
      const workOrder = db.workOrders.find((item) => item.id === body.workOrderId && item.status !== "已完成");
      if (!workOrder) return send(res, 404, { error: "生产中工单不存在" });
      const outsourceError = await outsourceWorkOrderPermissionError(db, workOrder.id, "exceptions");
      if (outsourceError) return send(res, 403, { error: outsourceError });
      const issueProcessName = normalizeProcessName(body.processName || body.type || "");
      const route = body.routeId
        ? db.routes.find((item) => item.id === body.routeId && item.workOrderId === workOrder.id)
        : db.routes.find((item) => item.workOrderId === workOrder.id && item.processName === issueProcessName)
          || db.routes.find((item) => item.workOrderId === workOrder.id && item.processName === "质检")
          || db.routes.find((item) => item.workOrderId === workOrder.id && item.status !== "已完成")
          || db.routes.find((item) => item.workOrderId === workOrder.id);
      if (!route) return send(res, 404, { error: "工单缺少工序，不能登记异常" });
      const beforeStatus = route.status;
      const description = String(body.description || body.exceptionDescription || "").trim();
      if (!description) return send(res, 400, { error: "请填写问题描述" });
      const item = {
        id: id("e"),
        workOrderId: workOrder.id,
        routeId: route.id,
        type: issueProcessName || String(body.exceptionType || "质检问题").trim(),
        description,
        status: "待处理",
        reporterId: user.id,
        createdAt: new Date().toISOString(),
        images: Array.isArray(body.images) ? body.images : [],
        source: userHasRole(user, "quality") ? "quality-inspection" : "manual",
      };
      db.exceptions.push(item);
      route.status = "异常";
      syncWorkOrder(db, workOrder.id);
      appendAudit(db, user, "exception-create", "exception", item.id, {
        workOrderId: item.workOrderId, routeId: item.routeId, type: item.type, description: item.description,
        beforeStatus, afterStatus: route.status, planQty: Number(route.planQty || 0), completedQty: Number(route.completedQty || 0),
      });
      await writeDb(db);
      return send(res, 200, { ok: true, item });
    }

    if (req.method === "POST" && url.pathname === "/api/drawings/preview") {
      if (!user) return send(res, 401, { error: "请先登录" });
      const body = await parseBody(req);
      const drawing = db.drawings.find((item) => item.id === body.drawingId);
      if (!drawing) return send(res, 404, { error: "图纸不存在" });
      if (drawing.workOrderId) {
        const outsourceError = await outsourceWorkOrderPermissionError(db, drawing.workOrderId, "attachments");
        if (outsourceError) return send(res, 403, { error: outsourceError });
      }
      if (!isCadDrawing(drawing.fileType)) return send(res, 200, { previewUrl: drawing.url, previewError: "" });
      const previewFile = drawing.previewUrl ? path.join(tenantUploadDirectory("previews"), path.basename(drawing.previewUrl)) : "";
      if (previewFile && fs.existsSync(previewFile)) {
        const previewSvg = normalizeCadSvg(fs.readFileSync(previewFile, "utf8"));
        fs.writeFileSync(previewFile, previewSvg);
        return send(res, 200, {
          previewUrl: cadPreviewUrl(drawing.previewUrl),
          previewPageUrl: cadPreviewPageUrl(drawing.previewUrl, drawing.url, drawing.originalName || drawing.name || path.basename(drawing.url)),
          previewError: ""
        });
      }
      const preview = await generateCadPreview(drawing);
      drawing.previewUrl = preview.previewUrl;
      drawing.previewError = preview.previewError;
      db.attachments.filter((item) => item.url === drawing.url).forEach((item) => {
        item.previewUrl = preview.previewUrl;
        item.previewError = preview.previewError;
      });
      await writeDb(db);
      return send(res, 200, {
        ...preview,
        previewUrl: cadPreviewUrl(preview.previewUrl),
        previewPageUrl: cadPreviewPageUrl(preview.previewUrl, drawing.url, drawing.originalName || drawing.name || path.basename(drawing.url))
      });
    }

    if (req.method === "POST" && url.pathname === "/api/drawings/upload") {
      if (!canManage(user)) return send(res, 403, { error: "无权上传图纸" });
      const body = await parseBody(req);
      if (body.workOrderId) {
        const outsourceError = await outsourceWorkOrderPermissionError(db, String(body.workOrderId), "attachments");
        if (outsourceError) return send(res, 403, { error: outsourceError });
      }
      const saved = saveDataUrlFile(body, {
        allowImagesOnly: false,
        allowedExts: ["png", "jpg", "jpeg", "gif", "pdf", "dwg", "dxf"],
        targetDir: DRAWING_DIR,
        urlPrefix: "/uploads/drawings",
        prefix: "drawing",
      });
      if (saved.error) return send(res, 400, { error: saved.error });
      const preview = await generateCadPreview(saved);
      const item = {
        id: id("drw"),
        url: saved.url,
        thumbnailUrl: "",
        previewUrl: preview.previewUrl,
        previewError: preview.previewError,
        fileName: saved.fileName,
        name: saved.originalName,
        fileType: saved.fileType,
        contentType: saved.contentType,
        orderId: body.orderId || "",
        workOrderId: body.workOrderId || "",
        customerId: body.customerId || "",
        uploaderId: user.id,
        createdAt: new Date().toISOString(),
      };
      db.drawings.push(item);
      db.attachments.push({ ...item, id: id("att"), attachmentType: "drawing" });
      appendAudit(db, user, "drawing-upload", "drawing", item.id, { name: item.name, fileType: item.fileType, orderId: item.orderId, workOrderId: item.workOrderId });
      await writeDb(db);
      return send(res, 200, item);
    }

    if (req.method === "POST" && url.pathname === "/api/dispatch-board/report-upload") {
      const body = await parseBody(req);
      const route = db.routes.find((item) => item.id === String(body.routeId || ""));
      if (!route || route.status !== "进行中") return send(res, 409, { error: "工序状态已变化，请关闭并重新打开报工窗口" });
      const saved = saveDataUrlFile(body, { prefix: "img", allowImagesOnly: true });
      if (saved.error) return send(res, 400, { error: saved.error });
      const item = { id: id("att"), url: saved.url, thumbnailUrl: saved.url, name: saved.originalName, fileType: saved.fileType, contentType: saved.contentType, workOrderId: route.workOrderId, routeId: route.id, attachmentType: "dispatch-report-photo", uploaderId: user.id, createdAt: new Date().toISOString() };
      db.attachments.push(item);
      appendAudit(db, user, "dispatch-report-photo-upload", "report-photo", item.id, { name: item.name, routeId: route.id, workOrderId: route.workOrderId });
      await writeDb(db);
      return send(res, 200, item);
    }

    if (req.method === "POST" && url.pathname === "/api/upload") {
      const body = await parseBody(req);
      const route = db.routes.find((item) => item.id === String(body.routeId || ""));
      const workOrderId = String(body.workOrderId || route?.workOrderId || "");
      const uploadWorkOrder = db.workOrders.find((item) => item.id === workOrderId);
      const isOutsourceReportUpload = uploadWorkOrder?.source === "saas-outsourcing" && route?.workOrderId === workOrderId;
      if (workOrderId) {
        const uploadPermission = isOutsourceReportUpload ? (route.processName === "质检" ? "quality" : "progress") : "attachments";
        const outsourceError = await outsourceWorkOrderPermissionError(db, workOrderId, uploadPermission);
        if (outsourceError) return send(res, 403, { error: outsourceError });
      }
      const saved = saveDataUrlFile(body, { prefix: "img" });
      if (saved.error) return send(res, 400, { error: saved.error });
      const item = { id: id("att"), url: saved.url, thumbnailUrl: saved.url, workOrderId, name: saved.originalName, fileType: saved.fileType, contentType: saved.contentType, uploaderId: user.id, createdAt: new Date().toISOString() };
      if (!isOutsourceReportUpload) db.attachments.push(item);
      appendAudit(db, user, isOutsourceReportUpload ? "outsource-report-photo-upload" : "attachment-upload", isOutsourceReportUpload ? "outsource-report-photo" : "attachment", item.id, { name: item.name, fileType: item.fileType, workOrderId });
      if (!isOutsourceReportUpload) await writeDb(db);
      return send(res, 200, item);
    }

    return send(res, 404, { error: "接口不存在" });
  } catch (error) {
    if (res.headersSent || res.writableEnded) {
      console.error("API request failed after response was sent", error);
      return;
    }
    return send(res, 500, { error: error.message });
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let file = path.normalize(path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, "index.html");
  const ext = path.extname(file).toLowerCase();
  const type = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml; charset=utf-8", ".pdf": "application/pdf" }[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(file).pipe(res);
}

async function serveTenantUpload(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    const tenant = await resolveRequestTenant(req, res, url);
    if (!tenant) return;
    return withTenantDatabaseLock(tenant, () => requestContext.run(tenant, async () => {
      const db = await readDb();
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return send(res, 400, { error: "文件路径无效" });
      }
      const referenced = [...(db.attachments || []), ...(db.drawings || [])].some((item) =>
        [item.url, item.thumbnailUrl, item.previewUrl].includes(pathname));
      if (!referenced) return send(res, 404, { error: "文件不存在或无权访问" });
      const drawing = (db.drawings || []).find((item) => [item.url, item.thumbnailUrl, item.previewUrl].includes(pathname));
      const attachment = (db.attachments || []).find((item) => [item.url, item.thumbnailUrl, item.previewUrl].includes(pathname));
      const workOrderId = drawing?.workOrderId || attachment?.workOrderId;
      if (workOrderId) {
        const outsourceError = await outsourceWorkOrderPermissionError(db, workOrderId, "attachments");
        if (outsourceError) return send(res, 403, { error: outsourceError });
      }
      const file = path.resolve(PUBLIC, `.${pathname}`);
      const uploadRoot = path.resolve(UPLOAD_DIR) + path.sep;
      if (!file.startsWith(uploadRoot)) return send(res, 403, { error: "文件路径无效" });
      return sendLocalFile(res, file, drawingContentType({}, file));
    }));
  } catch (error) {
    return send(res, 500, { error: error.message });
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (req.method === "POST" && pathname === "/api/orders/update") {
      return serializeOrderNumberWrite(() => serializeDispatchBoardWrite(() => handleApi(req, res)));
    }
    if (req.method === "POST" && ORDER_NUMBER_WRITE_PATHS.has(pathname)) {
      return serializeOrderNumberWrite(() => handleApi(req, res));
    }
    if (req.method === "POST" && DISPATCH_BOARD_WRITE_PATHS.has(pathname)) {
      return serializeDispatchBoardWrite(() => handleApi(req, res));
    }
    return handleApi(req, res);
  }
  serveStatic(req, res);
});


server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.log(`端口 ${PORT} 已被占用，系统可能已经启动。请直接打开：http://localhost:${PORT}`);
    return;
  }
  console.error(error);
});

async function startServer() {
  await ensureDb();
  await ensureSaasCatalog();
  const backfillIndex = process.argv.indexOf("--backfill-platform-order");
  if (backfillIndex >= 0) {
    await backfillPlatformOrder(process.argv[backfillIndex + 1]);
    return;
  }
  server.listen(PORT, () => {
    console.log(`非标钣金工单系统已启动：http://localhost:${PORT}`);
  });
  if (SAAS_ENABLED ? Object.values(SAAS_TENANT_INTEGRATIONS).some((item) => item.webhookUrl) : Boolean(FUTURE_WEBHOOK_URL && BOBO_INTEGRATION_SECRET)) {
    setInterval(() => processPlatformWebhooks().catch((error) => console.error("平台回调处理失败", error)), 5000).unref();
  }
}

startServer().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
