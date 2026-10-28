"use strict";

const fs = require("fs");
const path = require("path");
const { FEATURE_MODULES, effectiveFeatureModules, normalizeFeatureModules } = require("./saas-features");
const { hasActiveOutsourcePermission, requiredOutsourcePermission } = require("./saas-outsourcing-access");

function parseJson(value, fallback) {
  if (typeof value === "object" && value !== null) return value;
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function dateText(value) {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return String(value || "").slice(0, 10);
}

function todayInShanghai() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function createSaasStore(pool) {
  if (!pool || typeof pool.execute !== "function") throw new Error("SaaS store requires a MySQL promise pool");

  async function ensureSchema() {
    const schemaPath = path.join(__dirname, "..", "db", "saas-schema.sql");
    const statements = fs.readFileSync(schemaPath, "utf8").split(";").map((item) => item.trim()).filter(Boolean);
    for (const statement of statements) await pool.execute(statement);
    for (const [name, definition] of [
      ["production_value_fen", "BIGINT UNSIGNED NOT NULL DEFAULT 0"],
      ["owner_accepted_at", "DATETIME NULL"],
      ["partner_accepted_at", "DATETIME NULL"],
    ]) {
      const [columns] = await pool.execute(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'saas_outsource_tasks' AND COLUMN_NAME = ?`,
        [name]
      );
      if (!columns.length) await pool.execute(`ALTER TABLE saas_outsource_tasks ADD COLUMN ${name} ${definition}`);
    }
    const modules = JSON.stringify(FEATURE_MODULES.map((item) => item.key));
    await pool.execute(
      `INSERT IGNORE INTO saas_feature_plans
        (plan_id, name, description, modules_json, active, sort_order, created_by, created_at, updated_at)
       VALUES ('legacy-full', '兼容全功能', '为已有租户保留现有模块权限', CAST(? AS JSON), 1, 0, 'system', NOW(), NOW())`,
      [modules]
    );
    await pool.execute(
      `INSERT IGNORE INTO saas_tenant_feature_assignments
        (tenant_id, plan_id, overrides_json, updated_by, updated_at)
       SELECT tenant_id, 'legacy-full', JSON_OBJECT(), 'system', NOW() FROM saas_tenants`
    );
  }

  async function listTenants() {
    const [rows] = await pool.execute(
      `SELECT t.tenant_id, t.slug, t.name, t.tenant_type, t.status, t.created_at,
        e.annual_amount_fen, e.currency, e.starts_at, e.ends_at, e.payment_status,
        p.name AS plan_name, dbp.database_name
       FROM saas_tenants t
       LEFT JOIN saas_tenant_feature_assignments fa ON fa.tenant_id = t.tenant_id
       LEFT JOIN saas_feature_plans p ON p.plan_id = fa.plan_id
       LEFT JOIN saas_tenant_database_provisions dbp ON dbp.tenant_id = t.tenant_id
       LEFT JOIN saas_entitlements e ON e.entitlement_id = (
         SELECT e2.entitlement_id FROM saas_entitlements e2
         WHERE e2.tenant_id = t.tenant_id ORDER BY e2.created_at DESC LIMIT 1
       )
       ORDER BY t.created_at DESC`
    );
    return rows.map((row) => ({
      tenantId: row.tenant_id,
      slug: row.slug,
      name: row.name,
      tenantType: row.tenant_type,
      status: row.status,
      createdAt: row.created_at,
      annualAmountFen: row.annual_amount_fen === null ? null : Number(row.annual_amount_fen),
      currency: row.currency,
      startsAt: row.starts_at === null ? null : dateText(row.starts_at),
      endsAt: row.ends_at === null ? null : dateText(row.ends_at),
      paymentStatus: row.payment_status,
      planName: row.plan_name || "兼容全功能",
      databaseConfigured: Boolean(row.database_name),
    }));
  }

  async function listFeaturePlans() {
    const [rows] = await pool.execute(
      `SELECT plan_id, name, description, modules_json, active, sort_order
       FROM saas_feature_plans ORDER BY sort_order, created_at, name`
    );
    return rows.map((row) => ({
      planId: row.plan_id,
      name: row.name,
      description: row.description,
      modules: normalizeFeatureModules(parseJson(row.modules_json, [])),
      active: Boolean(row.active),
      sortOrder: Number(row.sort_order),
    }));
  }

  async function getTenantFeatureModules(tenant) {
    if (!tenant?.tenantId || !tenant?.slug) throw new Error("tenant context is required");
    const [rows] = await pool.execute(
      `SELECT p.modules_json, a.overrides_json
       FROM saas_tenant_feature_assignments a
       JOIN saas_feature_plans p ON p.plan_id = a.plan_id
       WHERE a.tenant_id = ? LIMIT 1`,
      [tenant.tenantId]
    );
    const planModules = rows.length ? parseJson(rows[0].modules_json, []) : FEATURE_MODULES.map((item) => item.key);
    const overrides = rows.length ? parseJson(rows[0].overrides_json, {}) : {};
    const features = effectiveFeatureModules({ slug: tenant.slug, planModules, overrides });
    if (String(tenant.slug).toLowerCase() === "future-machinery") return features;
    const [releaseRows] = await pool.execute(
      `SELECT r.release_id, r.modules_json, r.status, r.created_at, rr.status AS rollout_status
       FROM saas_feature_releases r
       LEFT JOIN saas_feature_release_rollouts rr ON rr.release_id = r.release_id AND rr.tenant_id = ?
       WHERE r.status <> 'draft' ORDER BY r.created_at DESC`, [tenant.tenantId]
    );
    const latestByModule = new Map();
    for (const release of releaseRows) {
      for (const key of normalizeFeatureModules(parseJson(release.modules_json, []))) {
        if (!latestByModule.has(key)) latestByModule.set(key, release);
      }
    }
    return features.filter((key) => {
      const release = latestByModule.get(key);
      if (!release) return true;
      if (release.status === "stable") return true;
      return release.status === "gray" && release.rollout_status === "included";
    });
  }

  async function listFeatureReleases() {
    const [rows] = await pool.execute(
      `SELECT release_id, version, notes, modules_json, status, created_by, created_at, updated_at
       FROM saas_feature_releases ORDER BY created_at DESC`
    );
    const [rollouts] = await pool.execute(
      `SELECT release_id, tenant_id, status FROM saas_feature_release_rollouts ORDER BY tenant_id`
    );
    const rolloutMap = new Map();
    for (const row of rollouts) {
      if (!rolloutMap.has(row.release_id)) rolloutMap.set(row.release_id, []);
      rolloutMap.get(row.release_id).push({ tenantId: row.tenant_id, status: row.status });
    }
    return rows.map((row) => ({
      releaseId: row.release_id,
      version: row.version,
      notes: row.notes,
      modules: normalizeFeatureModules(parseJson(row.modules_json, [])),
      status: row.status,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      rollouts: rolloutMap.get(row.release_id) || [],
    }));
  }

  async function saveFeaturePlan({ planId, name, description = "", modules, actorUserId }) {
    const normalizedModules = normalizeFeatureModules(modules);
    const normalizedName = String(name || "").trim().slice(0, 120);
    if (!normalizedName || normalizedModules.length !== (Array.isArray(modules) ? new Set(modules).size : -1)) {
      throw new Error("套餐名称或模块配置无效");
    }
    const id = String(planId || `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const [existingRows] = await pool.execute(
      "SELECT plan_id, name, description, modules_json, active, sort_order FROM saas_feature_plans WHERE plan_id = ? LIMIT 1", [id]
    );
    const before = existingRows[0] ? {
      planId: id,
      name: existingRows[0].name,
      description: existingRows[0].description,
      modules: normalizeFeatureModules(parseJson(existingRows[0].modules_json, [])),
      active: Boolean(existingRows[0].active),
      sortOrder: Number(existingRows[0].sort_order),
    } : null;
    await pool.execute(
      `INSERT INTO saas_feature_plans
        (plan_id, name, description, modules_json, active, sort_order, created_by, created_at, updated_at)
       VALUES (?, ?, ?, CAST(? AS JSON), 1, 0, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), modules_json = VALUES(modules_json), updated_at = NOW()`,
      [id, normalizedName, String(description || "").trim().slice(0, 500), JSON.stringify(normalizedModules), actorUserId]
    );
    await recordAudit({
      actorUserId, action: before ? "feature_plan.update" : "feature_plan.create", entityId: id,
      details: { before, after: { planId: id, name: normalizedName, description: String(description || "").trim().slice(0, 500), modules: normalizedModules } },
    });
    return { planId: id, name: normalizedName, description: String(description || "").trim().slice(0, 500), modules: normalizedModules, active: true };
  }

  async function assignTenantFeatures({ tenantId, planId, overrides, actorUserId }) {
    const [tenantRows] = await pool.execute("SELECT slug FROM saas_tenants WHERE tenant_id = ? LIMIT 1", [tenantId]);
    if (!tenantRows.length) return false;
    if (tenantRows[0].slug === "future-machinery") throw new Error("宁波未来机械为主程序租户，固定开放全部功能");
    const [planRows] = await pool.execute("SELECT modules_json FROM saas_feature_plans WHERE plan_id = ? AND active = 1 LIMIT 1", [planId]);
    if (!planRows.length) throw new Error("套餐不存在或已停用");
    const nextOverrides = {};
    for (const [key, value] of Object.entries(overrides || {})) {
      if (!FEATURE_MODULES.some((item) => item.key === key) || typeof value !== "boolean") throw new Error("单户模块覆盖配置无效");
      nextOverrides[key] = value;
    }
    const [beforeRows] = await pool.execute(
      `SELECT a.plan_id, a.overrides_json, p.name AS plan_name
       FROM saas_tenant_feature_assignments a JOIN saas_feature_plans p ON p.plan_id = a.plan_id
       WHERE a.tenant_id = ? LIMIT 1`, [tenantId]
    );
    const before = beforeRows[0] ? { planId: beforeRows[0].plan_id, planName: beforeRows[0].plan_name, overrides: parseJson(beforeRows[0].overrides_json, {}) } : null;
    await pool.execute(
      `INSERT INTO saas_tenant_feature_assignments (tenant_id, plan_id, overrides_json, updated_by, updated_at)
       VALUES (?, ?, CAST(? AS JSON), ?, NOW())
       ON DUPLICATE KEY UPDATE plan_id = VALUES(plan_id), overrides_json = VALUES(overrides_json), updated_by = VALUES(updated_by), updated_at = NOW()`,
      [tenantId, planId, JSON.stringify(nextOverrides), actorUserId]
    );
    await recordAudit({
      actorUserId, targetTenantId: tenantId, action: "tenant.features.update", entityId: tenantId,
      details: { before, after: { planId, planName: "", overrides: nextOverrides } },
    });
    return true;
  }

  async function createFeatureRelease({ releaseId, version, notes = "", modules, status = "draft", tenantIds = [], actorUserId }) {
    const normalizedVersion = String(version || "").trim();
    const normalizedModules = normalizeFeatureModules(modules);
    if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(normalizedVersion) || !normalizedModules.length) throw new Error("版本号或发布模块无效");
    if (!["draft", "gray", "stable"].includes(status)) throw new Error("新发布状态无效");
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO saas_feature_releases (release_id, version, notes, modules_json, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, CAST(? AS JSON), ?, ?, NOW(), NOW())`,
        [releaseId, normalizedVersion, String(notes || "").slice(0, 2000), JSON.stringify(normalizedModules), status, actorUserId]
      );
      for (const tenantId of [...new Set(tenantIds.map(String))].filter((item) => item !== "future-machinery")) {
        await connection.execute(
          `INSERT INTO saas_feature_release_rollouts (release_id, tenant_id, status, updated_by, updated_at)
           VALUES (?, ?, 'included', ?, NOW())`, [releaseId, tenantId, actorUserId]
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    await recordAudit({ actorUserId, action: "feature_release.create", entityId: releaseId,
      details: { version: normalizedVersion, modules: normalizedModules, status, tenantIds } });
    return { releaseId, version: normalizedVersion, notes, modules: normalizedModules, status };
  }

  async function setFeatureReleaseStatus(releaseId, status, actorUserId) {
    if (!["gray", "stable", "paused", "rolled_back"].includes(status)) throw new Error("发布状态无效");
    const [rows] = await pool.execute("SELECT status, version FROM saas_feature_releases WHERE release_id = ? LIMIT 1", [releaseId]);
    if (!rows.length) return false;
    const before = rows[0].status;
    await pool.execute("UPDATE saas_feature_releases SET status = ?, updated_at = NOW() WHERE release_id = ?", [status, releaseId]);
    await recordAudit({ actorUserId, action: "feature_release.status", entityId: releaseId,
      details: { version: rows[0].version, before, after: status } });
    return true;
  }

  async function setFeatureReleaseRollouts(releaseId, tenantIds, actorUserId) {
    const normalizedIds = [...new Set(tenantIds.map(String))].filter((item) => item && item !== "future-machinery");
    const connection = await pool.getConnection();
    let before = [];
    try {
      await connection.beginTransaction();
      const [releaseRows] = await connection.execute("SELECT release_id FROM saas_feature_releases WHERE release_id = ? LIMIT 1", [releaseId]);
      if (!releaseRows.length) { await connection.rollback(); return false; }
      const [tenantRows] = normalizedIds.length
        ? await connection.execute(`SELECT tenant_id FROM saas_tenants WHERE tenant_id IN (${normalizedIds.map(() => "?").join(",")})`, normalizedIds)
        : [[]];
      if (tenantRows.length !== normalizedIds.length) throw new Error("灰度租户列表包含不存在的公司");
      const [currentRows] = await connection.execute("SELECT tenant_id FROM saas_feature_release_rollouts WHERE release_id = ? AND status = 'included'", [releaseId]);
      before = currentRows.map((row) => row.tenant_id);
      await connection.execute("DELETE FROM saas_feature_release_rollouts WHERE release_id = ?", [releaseId]);
      for (const tenantId of normalizedIds) {
        await connection.execute(
          `INSERT INTO saas_feature_release_rollouts (release_id, tenant_id, status, updated_by, updated_at)
           VALUES (?, ?, 'included', ?, NOW())`, [releaseId, tenantId, actorUserId]
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    await recordAudit({ actorUserId, action: "feature_release.rollout", entityId: releaseId,
      details: { before, after: normalizedIds } });
    return true;
  }

  async function getTenantAdminDetails(tenantId) {
    const [rows] = await pool.execute(
      `SELECT t.tenant_id, t.slug, t.name, t.status, dbp.database_name, dbp.database_user
       FROM saas_tenants t LEFT JOIN saas_tenant_database_provisions dbp ON dbp.tenant_id = t.tenant_id
       WHERE t.tenant_id = ? LIMIT 1`,
      [tenantId]
    );
    if (!rows.length) return null;
    const tenant = { tenantId: rows[0].tenant_id, slug: rows[0].slug, name: rows[0].name, status: rows[0].status };
    const [assignmentRows] = await pool.execute(
      `SELECT a.plan_id, a.overrides_json, p.name AS plan_name, p.modules_json
       FROM saas_tenant_feature_assignments a JOIN saas_feature_plans p ON p.plan_id = a.plan_id
       WHERE a.tenant_id = ? LIMIT 1`, [tenantId]
    );
    const [entitlements] = await pool.execute(
      `SELECT entitlement_id, annual_amount_fen, currency, starts_at, ends_at, status, payment_status, note, created_by, created_at
       FROM saas_entitlements WHERE tenant_id = ? ORDER BY created_at DESC`, [tenantId]
    );
    const [auditRows] = await pool.execute(
      `SELECT action, entity_id, details_json, actor_user_id, created_at
       FROM saas_audit_logs WHERE target_tenant_id = ? ORDER BY created_at DESC LIMIT 100`, [tenantId]
    );
    const assignment = assignmentRows[0];
    const [releaseRows] = await pool.execute(
      `SELECT r.release_id, r.version, r.status, rr.status AS rollout_status
       FROM saas_feature_release_rollouts rr JOIN saas_feature_releases r ON r.release_id = rr.release_id
       WHERE rr.tenant_id = ? ORDER BY r.created_at DESC`, [tenantId]
    );
    return {
      tenant,
      database: { configured: Boolean(rows[0].database_name), name: rows[0].database_name || "", user: rows[0].database_user || "" },
      plan: assignment ? {
        planId: assignment.plan_id,
        name: assignment.plan_name,
        modules: normalizeFeatureModules(parseJson(assignment.modules_json, [])),
        overrides: parseJson(assignment.overrides_json, {}),
      } : { planId: "legacy-full", name: "兼容全功能", modules: FEATURE_MODULES.map((item) => item.key), overrides: {} },
      entitlements: entitlements.map((row) => ({
        entitlementId: row.entitlement_id,
        annualAmountFen: Number(row.annual_amount_fen),
        currency: row.currency,
        startsAt: dateText(row.starts_at),
        endsAt: dateText(row.ends_at),
        status: row.status,
        paymentStatus: row.payment_status,
        note: row.note,
        createdBy: row.created_by,
        createdAt: row.created_at,
      })),
      auditLogs: auditRows.map((row) => ({ action: row.action, entityId: row.entity_id, details: parseJson(row.details_json, {}), actorUserId: row.actor_user_id, createdAt: row.created_at })),
      releases: releaseRows.map((row) => ({ releaseId: row.release_id, version: row.version, status: row.status, rolloutStatus: row.rollout_status })),
    };
  }

  async function findTenantBySlug(slug) {
    const [rows] = await pool.execute(
      `SELECT tenant_id, slug, name, tenant_type, status, state_key, created_at, updated_at
       FROM saas_tenants WHERE slug = ? LIMIT 1`,
      [slug]
    );
    return rows.length ? mapTenant(rows[0]) : null;
  }

  async function findTenantById(tenantId) {
    const [rows] = await pool.execute(
      `SELECT tenant_id, slug, name, tenant_type, status, state_key, created_at, updated_at
       FROM saas_tenants WHERE tenant_id = ? LIMIT 1`,
      [tenantId]
    );
    return rows.length ? mapTenant(rows[0]) : null;
  }

  async function findActiveEntitlement(tenantId, today = todayInShanghai()) {
    const [rows] = await pool.execute(
      `SELECT entitlement_id, tenant_id, annual_amount_fen, currency, starts_at, ends_at, status, payment_status, note
       FROM saas_entitlements WHERE tenant_id = ? AND status = 'active' AND starts_at <= ? AND ends_at >= ?
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, today, today]
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      entitlementId: row.entitlement_id,
      tenantId: row.tenant_id,
      annualAmountFen: Number(row.annual_amount_fen),
      currency: row.currency,
      startsAt: dateText(row.starts_at),
      endsAt: dateText(row.ends_at),
      status: row.status,
      paymentStatus: row.payment_status,
      note: row.note,
    };
  }

  async function createSession({ sessionId, tenantId, userId, expiresAt }) {
    await pool.execute(
      `INSERT INTO saas_sessions (session_id, tenant_id, user_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, NOW())`,
      [sessionId, tenantId, userId, expiresAt]
    );
  }

  async function findSession(sessionId) {
    const [rows] = await pool.execute(
      `SELECT session_id, tenant_id, user_id, expires_at, revoked_at
       FROM saas_sessions WHERE session_id = ? LIMIT 1`,
      [sessionId]
    );
    if (!rows.length) return null;
    const row = rows[0];
    if (row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) return null;
    return { sessionId: row.session_id, tenantId: row.tenant_id, userId: row.user_id, expiresAt: row.expires_at };
  }

  async function revokeSession(sessionId) {
    await pool.execute("UPDATE saas_sessions SET revoked_at = NOW() WHERE session_id = ? AND revoked_at IS NULL", [sessionId]);
  }

  async function revokeUserSessions(tenantId, userId) {
    await pool.execute(
      "UPDATE saas_sessions SET revoked_at = NOW() WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL",
      [tenantId, userId]
    );
  }

  async function findTenantAdminUserId(tenantId) {
    const [rows] = await pool.execute(
      `SELECT user_id FROM saas_memberships
       WHERE tenant_id = ? AND platform_role = 'tenant_admin' AND status = 'active'
       ORDER BY created_at LIMIT 1`,
      [tenantId]
    );
    return rows[0]?.user_id || "";
  }

  async function ensureTenantAdminMembership(tenantId, userId) {
    const currentUserId = await findTenantAdminUserId(tenantId);
    if (currentUserId === userId) return false;
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `UPDATE saas_memberships SET platform_role = 'member'
         WHERE tenant_id = ? AND platform_role = 'tenant_admin' AND user_id <> ?`,
        [tenantId, userId]
      );
      await connection.execute(
        `INSERT INTO saas_memberships (tenant_id, user_id, platform_role, status, created_at)
         VALUES (?, ?, 'tenant_admin', 'active', NOW())
         ON DUPLICATE KEY UPDATE platform_role = 'tenant_admin', status = 'active'`,
        [tenantId, userId]
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    await recordAudit({ actorUserId: "system", targetTenantId: tenantId,
      action: "tenant.admin_membership_repaired", entityId: userId,
      details: { previousUserId: currentUserId, userId } });
    return true;
  }

  async function createPlatformSession({ sessionId, adminUserId, expiresAt }) {
    await pool.execute(
      `INSERT INTO saas_platform_sessions (session_id, admin_user_id, expires_at, created_at)
       VALUES (?, ?, ?, NOW())`,
      [sessionId, adminUserId, expiresAt]
    );
  }

  async function findPlatformSession(sessionId) {
    const [rows] = await pool.execute(
      `SELECT session_id, admin_user_id, expires_at, revoked_at
       FROM saas_platform_sessions WHERE session_id = ? LIMIT 1`,
      [sessionId]
    );
    if (!rows.length) return null;
    const row = rows[0];
    if (row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) return null;
    return { sessionId: row.session_id, adminUserId: row.admin_user_id, expiresAt: row.expires_at };
  }

  async function revokePlatformSession(sessionId) {
    await pool.execute("UPDATE saas_platform_sessions SET revoked_at = NOW() WHERE session_id = ? AND revoked_at IS NULL", [sessionId]);
  }

  async function createTenantWithEntitlement(tenant, adminUserId, entitlement, databaseProvision, planId = "legacy-full") {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO saas_tenants (tenant_id, slug, name, tenant_type, status, state_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [tenant.tenantId, tenant.slug, tenant.name, tenant.tenantType, tenant.status, tenant.stateKey]
      );
      await connection.execute(
        `INSERT INTO saas_tenant_database_provisions
          (tenant_id, slug, database_name, database_user, account_host, created_at)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [tenant.tenantId, tenant.slug, databaseProvision.database, databaseProvision.user, databaseProvision.accountHost]
      );
      await connection.execute(
        `INSERT INTO saas_memberships (tenant_id, user_id, platform_role, status, created_at)
         VALUES (?, ?, 'tenant_admin', 'active', NOW())`,
        [tenant.tenantId, adminUserId]
      );
      await connection.execute(
        `INSERT INTO saas_entitlements
          (entitlement_id, tenant_id, annual_amount_fen, currency, starts_at, ends_at, status, payment_status, note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [entitlement.entitlementId, entitlement.tenantId, entitlement.annualAmountFen, entitlement.currency,
          entitlement.startsAt, entitlement.endsAt, entitlement.status, entitlement.paymentStatus,
          entitlement.note, entitlement.createdBy]
      );
      await connection.execute(
        `INSERT INTO saas_tenant_feature_assignments (tenant_id, plan_id, overrides_json, updated_by, updated_at)
         VALUES (?, ?, JSON_OBJECT(), ?, NOW())`,
        [tenant.tenantId, planId, entitlement.createdBy]
      );
      await connection.execute(
        `INSERT INTO saas_audit_logs (audit_id, actor_tenant_id, target_tenant_id, actor_user_id, action, entity_id, details_json, created_at)
         VALUES (?, NULL, ?, ?, 'tenant.create', ?, CAST(? AS JSON), NOW())`,
        [`audit_${tenant.tenantId}_${Date.now()}`, tenant.tenantId, "platform", tenant.tenantId,
          JSON.stringify({ slug: tenant.slug, name: tenant.name, database: databaseProvision.database, planId })]
      );
      await connection.execute(
        `INSERT INTO saas_audit_logs (audit_id, actor_tenant_id, target_tenant_id, actor_user_id, action, entity_id, details_json, created_at)
         VALUES (?, NULL, ?, ?, 'entitlement.create', ?, CAST(? AS JSON), NOW())`,
        [`audit_${entitlement.entitlementId}`, tenant.tenantId, "platform", entitlement.entitlementId,
          JSON.stringify({ annualAmountFen: entitlement.annualAmountFen, startsAt: entitlement.startsAt, endsAt: entitlement.endsAt })]
      );
      await connection.execute(
        `INSERT INTO saas_audit_logs (audit_id, actor_tenant_id, target_tenant_id, actor_user_id, action, entity_id, details_json, created_at)
         VALUES (?, NULL, ?, ?, 'tenant.bootstrap', ?, CAST(? AS JSON), NOW())`,
        [`audit_bootstrap_${tenant.tenantId}`, tenant.tenantId, "platform", tenant.tenantId,
          JSON.stringify({ adminUserId })]
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function listTenantDatabaseProvisions() {
    const [rows] = await pool.execute(
      `SELECT tenant_id, slug, database_name, database_user, account_host
       FROM saas_tenant_database_provisions ORDER BY created_at`
    );
    return rows.map((row) => ({
      tenantId: row.tenant_id,
      slug: row.slug,
      database: row.database_name,
      user: row.database_user,
      accountHost: row.account_host,
    }));
  }

  async function setTenantStatus(tenantId, status, actorUserId) {
    if (!["active", "suspended", "closed"].includes(status)) throw new Error("公司状态无效");
    const [result] = await pool.execute(
      "UPDATE saas_tenants SET status = ?, updated_at = NOW() WHERE tenant_id = ?",
      [status, tenantId]
    );
    if (!result.affectedRows) return false;
    await recordAudit({ actorUserId, targetTenantId: tenantId, action: "tenant.status", entityId: tenantId, details: { status } });
    return true;
  }

  async function createEntitlement(entitlement) {
    await pool.execute(
      `INSERT INTO saas_entitlements
        (entitlement_id, tenant_id, annual_amount_fen, currency, starts_at, ends_at, status, payment_status, note, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [entitlement.entitlementId, entitlement.tenantId, entitlement.annualAmountFen, entitlement.currency,
        entitlement.startsAt, entitlement.endsAt, entitlement.status, entitlement.paymentStatus,
        entitlement.note, entitlement.createdBy]
    );
    await recordAudit({
      actorUserId: entitlement.createdBy,
      targetTenantId: entitlement.tenantId,
      action: "entitlement.create",
      entityId: entitlement.entitlementId,
      details: { annualAmountFen: entitlement.annualAmountFen, startsAt: entitlement.startsAt, endsAt: entitlement.endsAt, paymentStatus: entitlement.paymentStatus },
    });
  }

  async function updateEntitlementPaymentStatus({ entitlementId, tenantId, paymentStatus, actorUserId }) {
    const [rows] = await pool.execute(
      `SELECT payment_status FROM saas_entitlements WHERE entitlement_id = ? AND tenant_id = ? LIMIT 1`,
      [entitlementId, tenantId]
    );
    if (!rows.length) return null;
    const previousStatus = rows[0].payment_status;
    if (previousStatus === paymentStatus) return { previousStatus, paymentStatus };
    await pool.execute(
      `UPDATE saas_entitlements SET payment_status = ? WHERE entitlement_id = ? AND tenant_id = ?`,
      [paymentStatus, entitlementId, tenantId]
    );
    await recordAudit({
      actorUserId,
      targetTenantId: tenantId,
      action: "entitlement.payment_status",
      entityId: entitlementId,
      details: { previousStatus, paymentStatus },
    });
    return { previousStatus, paymentStatus };
  }

  async function createDelegation(delegation) {
    await pool.execute(
      `INSERT INTO saas_delegations
        (delegation_id, owner_tenant_id, partner_tenant_id, status, starts_at, ends_at, permissions_json, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, NOW())`,
      [delegation.delegationId, delegation.ownerTenantId, delegation.partnerTenantId, delegation.status,
        delegation.startsAt, delegation.endsAt, JSON.stringify(delegation.permissions), delegation.createdBy]
    );
    await recordAudit({
      actorUserId: delegation.createdBy,
      actorTenantId: delegation.ownerTenantId,
      targetTenantId: delegation.partnerTenantId,
      action: "delegation.create",
      entityId: delegation.delegationId,
      details: { startsAt: delegation.startsAt, endsAt: delegation.endsAt, permissions: delegation.permissions },
    });
  }

  async function revokeDelegation(delegationId, ownerTenantId, actorUserId) {
    const [result] = await pool.execute(
      `UPDATE saas_delegations SET status = 'revoked', revoked_by = ?, revoked_at = NOW()
       WHERE delegation_id = ? AND owner_tenant_id = ? AND status = 'active'`,
      [actorUserId, delegationId, ownerTenantId]
    );
    if (!result.affectedRows) return false;
    await recordAudit({ actorUserId, actorTenantId: ownerTenantId, action: "delegation.revoke", entityId: delegationId, details: {} });
    return true;
  }

  async function listDelegations(tenantId) {
    const [rows] = await pool.execute(
      `SELECT delegation_id, owner_tenant_id, partner_tenant_id, status, starts_at, ends_at, permissions_json, created_by, created_at
       FROM saas_delegations WHERE owner_tenant_id = ? OR partner_tenant_id = ? ORDER BY created_at DESC`,
      [tenantId, tenantId]
    );
    return rows.map((row) => ({
      delegationId: row.delegation_id,
      ownerTenantId: row.owner_tenant_id,
      partnerTenantId: row.partner_tenant_id,
      status: row.status,
      startsAt: dateText(row.starts_at),
      endsAt: dateText(row.ends_at),
      permissions: parseJson(row.permissions_json, []),
      createdBy: row.created_by,
      createdAt: row.created_at,
    }));
  }

  async function findDelegation(delegationId) {
    const [rows] = await pool.execute(
      `SELECT delegation_id, owner_tenant_id, partner_tenant_id, status, starts_at, ends_at, permissions_json, created_by, created_at
       FROM saas_delegations WHERE delegation_id = ? LIMIT 1`,
      [delegationId]
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      delegationId: row.delegation_id,
      ownerTenantId: row.owner_tenant_id,
      partnerTenantId: row.partner_tenant_id,
      status: row.status,
      startsAt: dateText(row.starts_at),
      endsAt: dateText(row.ends_at),
      permissions: parseJson(row.permissions_json, []),
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }

  async function createOutsourceTask(task) {
    await pool.execute(
      `INSERT INTO saas_outsource_tasks
        (task_id, delegation_id, owner_tenant_id, partner_tenant_id, owner_order_id, partner_work_order_id,
         source_revision, status, due_date, production_value_fen, snapshot_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, NOW(), NOW())`,
      [task.taskId, task.delegationId, task.ownerTenantId, task.partnerTenantId, task.ownerOrderId,
        task.partnerWorkOrderId, task.sourceRevision, task.status, task.dueDate, task.productionValueFen,
        JSON.stringify(task.snapshot), task.createdBy]
    );
    await recordAudit({
      actorUserId: task.createdBy,
      actorTenantId: task.ownerTenantId,
      targetTenantId: task.partnerTenantId,
      action: "outsource-task.create",
      entityId: task.taskId,
        details: { ownerOrderId: task.ownerOrderId, dueDate: task.dueDate, productionValueFen: task.productionValueFen },
    });
  }

  async function updateOutsourceTaskStatus(taskId, tenantId, nextStatus, actorUserId) {
    const [rows] = await pool.execute(
      `SELECT t.task_id, t.delegation_id, t.owner_tenant_id, t.partner_tenant_id, t.owner_order_id, t.partner_work_order_id,
        t.source_revision, t.status, t.due_date, t.production_value_fen, t.owner_accepted_at, t.partner_accepted_at, t.snapshot_json, t.created_by, t.created_at, t.updated_at,
        d.status AS delegation_status, d.starts_at AS delegation_starts_at, d.ends_at AS delegation_ends_at,
        d.permissions_json AS delegation_permissions
       FROM saas_outsource_tasks t
       JOIN saas_delegations d ON d.delegation_id = t.delegation_id
       WHERE t.task_id = ? AND (t.owner_tenant_id = ? OR t.partner_tenant_id = ?) LIMIT 1`,
      [taskId, tenantId, tenantId]
    );
    if (!rows.length) return null;
    const row = rows[0];
    const previousStatus = row.status;
    const allowed = {
      sent: { owner: ["cancelled"], partner: ["accepted", "cancelled"] },
      accepted: { owner: ["cancelled"], partner: ["blocked", "submitted"] },
      in_progress: { owner: ["cancelled"], partner: ["blocked", "submitted"] },
      blocked: { partner: ["in_progress", "submitted"] },
      submitted: { owner: ["accepted_by_owner", "revision_requested"] },
      revision_requested: { partner: ["in_progress", "blocked", "submitted"] },
    };
    const actor = tenantId === row.owner_tenant_id ? "owner" : "partner";
    if (!allowed[previousStatus]?.[actor]?.includes(nextStatus)) throw new Error("外协任务状态流转无效");
    if (actor === "partner") {
      const requiredPermission = requiredOutsourcePermission(actor, nextStatus);
      const delegation = {
        status: row.delegation_status,
        startsAt: dateText(row.delegation_starts_at),
        endsAt: dateText(row.delegation_ends_at),
        permissions: parseJson(row.delegation_permissions, []),
      };
      if (!requiredPermission || !hasActiveOutsourcePermission(delegation, requiredPermission, todayInShanghai())) {
        const error = new Error("当前委派关系不允许此操作，或授权已失效");
        error.statusCode = 403;
        throw error;
      }
    }
    const requiredPermission = requiredOutsourcePermission(actor, nextStatus);
    const updateSql = actor === "owner"
      ? `UPDATE saas_outsource_tasks SET status = ?,
           owner_accepted_at = IF(? = 'accepted_by_owner', NOW(), owner_accepted_at), updated_at = NOW()
         WHERE task_id = ? AND owner_tenant_id = ? AND status = ?`
      : `UPDATE saas_outsource_tasks t JOIN saas_delegations d ON d.delegation_id = t.delegation_id
         SET t.status = ?,
           t.partner_accepted_at = IF(? = 'accepted' AND t.partner_accepted_at IS NULL, NOW(), t.partner_accepted_at),
           t.updated_at = NOW()
         WHERE t.task_id = ? AND t.partner_tenant_id = ? AND t.status = ?
           AND d.status = 'active' AND d.starts_at <= ? AND d.ends_at >= ?
           AND JSON_CONTAINS(d.permissions_json, JSON_QUOTE(?))`;
    const updateParams = actor === "owner"
      ? [nextStatus, nextStatus, taskId, tenantId, previousStatus]
      : [nextStatus, nextStatus, taskId, tenantId, previousStatus, todayInShanghai(), todayInShanghai(), requiredPermission];
    const [updateResult] = await pool.execute(updateSql, updateParams);
    if (!updateResult.affectedRows) {
      const error = new Error("委派关系已变更，或当前关系不允许此操作");
      error.statusCode = actor === "partner" ? 403 : 409;
      throw error;
    }
    await recordAudit({ actorUserId, actorTenantId: tenantId, targetTenantId: actor === "owner" ? row.partner_tenant_id : row.owner_tenant_id,
      action: "outsource-task.status", entityId: taskId, details: { previousStatus, nextStatus } });
    return { taskId, previousStatus, status: nextStatus };
  }

  async function listTaskReservations(ownerTenantId, ownerOrderId) {
    const [rows] = await pool.execute(
      `SELECT task_id, status, snapshot_json FROM saas_outsource_tasks
       WHERE owner_tenant_id = ? AND owner_order_id = ? AND status NOT IN ('cancelled', 'accepted_by_owner')`,
      [ownerTenantId, ownerOrderId]
    );
    return rows.map((row) => ({ taskId: row.task_id, status: row.status, snapshot: parseJson(row.snapshot_json, {}) }));
  }

  async function listOutsourceTasks(tenantId, side) {
    const ownerSide = side === "owner";
    const column = ownerSide ? "owner_tenant_id" : "partner_tenant_id";
    const [rows] = await pool.execute(
      `SELECT t.task_id, t.delegation_id, t.owner_tenant_id, t.partner_tenant_id, t.owner_order_id, t.partner_work_order_id,
        t.source_revision, t.status, t.due_date, t.production_value_fen, t.owner_accepted_at,
        COALESCE(t.created_at, (
          SELECT MIN(a.created_at) FROM saas_audit_logs a
          WHERE a.action = 'outsource-task.create' AND a.entity_id = t.task_id
        )) AS created_at,
        COALESCE(t.partner_accepted_at, (
          SELECT MIN(a.created_at) FROM saas_audit_logs a
          WHERE a.action = 'outsource-task.status' AND a.entity_id = t.task_id
            AND JSON_UNQUOTE(JSON_EXTRACT(a.details_json, '$.nextStatus')) = 'accepted'
        )) AS partner_accepted_at,
        t.snapshot_json, t.created_by, t.created_at, t.updated_at
       FROM saas_outsource_tasks t WHERE t.${column} = ? ORDER BY t.due_date, t.created_at DESC`,
      [tenantId]
    );
    return rows.map((row) => ({
      taskId: row.task_id,
      delegationId: row.delegation_id,
      ownerTenantId: row.owner_tenant_id,
      partnerTenantId: row.partner_tenant_id,
      ownerOrderId: row.owner_order_id,
      partnerWorkOrderId: row.partner_work_order_id,
      sourceRevision: Number(row.source_revision),
      status: row.status,
      dueDate: dateText(row.due_date),
      productionValueFen: Number(row.production_value_fen || 0),
      ownerAcceptedAt: row.owner_accepted_at || null,
      partnerAcceptedAt: row.partner_accepted_at || null,
      snapshot: parseJson(row.snapshot_json, {}),
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async function listOutsourceRebatePeriods(ownerTenantId) {
    const [rows] = await pool.execute(
      `SELECT p.tenant_id AS partner_tenant_id, p.name AS partner_name, p.slug AS partner_slug,
        e.entitlement_id, e.annual_amount_fen, e.currency, e.starts_at, e.ends_at, e.payment_status,
        r.period_id, r.first_target_fen, r.full_target_fen, r.settled_refund_fen, r.settled_at, r.settlement_note,
        COALESCE(SUM(CASE WHEN t.status = 'accepted_by_owner'
          AND t.owner_accepted_at >= e.starts_at
          AND t.owner_accepted_at < DATE_ADD(e.ends_at, INTERVAL 1 DAY)
          THEN t.production_value_fen ELSE 0 END), 0) AS output_fen,
        SUM(CASE WHEN t.status = 'accepted_by_owner'
          AND t.owner_accepted_at >= e.starts_at
          AND t.owner_accepted_at < DATE_ADD(e.ends_at, INTERVAL 1 DAY)
          THEN 1 ELSE 0 END) AS accepted_task_count
       FROM saas_tenants p
       JOIN saas_entitlements e ON e.tenant_id = p.tenant_id
       LEFT JOIN saas_outsource_rebate_periods r ON r.entitlement_id = e.entitlement_id
       LEFT JOIN saas_outsource_tasks t ON t.owner_tenant_id = ? AND t.partner_tenant_id = p.tenant_id
       WHERE p.tenant_type = 'company' AND p.tenant_id <> ?
       GROUP BY p.tenant_id, p.name, p.slug, e.entitlement_id, e.annual_amount_fen, e.currency,
        e.starts_at, e.ends_at, e.payment_status, r.period_id, r.first_target_fen, r.full_target_fen,
        r.settled_refund_fen, r.settled_at, r.settlement_note
       ORDER BY p.name, e.starts_at DESC`,
      [ownerTenantId, ownerTenantId]
    );
    return rows.map((row) => ({
      partnerTenantId: row.partner_tenant_id,
      partnerName: row.partner_name,
      partnerSlug: row.partner_slug,
      entitlementId: row.entitlement_id,
      annualAmountFen: Number(row.annual_amount_fen),
      currency: row.currency,
      startsAt: dateText(row.starts_at),
      endsAt: dateText(row.ends_at),
      paymentStatus: row.payment_status,
      periodId: row.period_id || "",
      firstTargetFen: row.first_target_fen === null ? null : Number(row.first_target_fen),
      fullTargetFen: row.full_target_fen === null ? null : Number(row.full_target_fen),
      settledRefundFen: row.settled_refund_fen === null ? null : Number(row.settled_refund_fen),
      settledAt: dateText(row.settled_at),
      settlementNote: row.settlement_note || "",
      outputFen: Number(row.output_fen || 0),
      acceptedTaskCount: Number(row.accepted_task_count || 0),
    }));
  }

  async function saveOutsourceRebateTargets({ periodId, ownerTenantId, partnerTenantId, entitlementId, firstTargetFen, fullTargetFen, actorUserId }) {
    const [rows] = await pool.execute(
      "SELECT settled_refund_fen FROM saas_outsource_rebate_periods WHERE entitlement_id = ? LIMIT 1",
      [entitlementId]
    );
    if (rows[0]?.settled_refund_fen !== null && rows[0]?.settled_refund_fen !== undefined) {
      throw new Error("该授权周期已登记退款，不能修改产值门槛");
    }
    const [entitlements] = await pool.execute(
      "SELECT entitlement_id FROM saas_entitlements WHERE entitlement_id = ? AND tenant_id = ? LIMIT 1",
      [entitlementId, partnerTenantId]
    );
    if (!entitlements.length) throw new Error("返还周期与外协单位授权不匹配");
    await pool.execute(
      `INSERT INTO saas_outsource_rebate_periods
        (period_id, owner_tenant_id, partner_tenant_id, entitlement_id, first_target_fen, full_target_fen,
         created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE first_target_fen = VALUES(first_target_fen),
         full_target_fen = VALUES(full_target_fen), updated_by = VALUES(updated_by), updated_at = NOW()`,
      [periodId, ownerTenantId, partnerTenantId, entitlementId, firstTargetFen, fullTargetFen, actorUserId, actorUserId]
    );
    await recordAudit({ actorUserId, actorTenantId: ownerTenantId, targetTenantId: partnerTenantId,
      action: "outsource-rebate.targets", entityId: entitlementId, details: { firstTargetFen, fullTargetFen } });
  }

  async function recordOutsourceRebateSettlement({ entitlementId, refundFen, settledAt, note, actorUserId }) {
    const [result] = await pool.execute(
      `UPDATE saas_outsource_rebate_periods r
       JOIN saas_entitlements e ON e.entitlement_id = r.entitlement_id
       SET r.settled_refund_fen = ?, r.settled_at = ?, r.settlement_note = ?, r.updated_by = ?, r.updated_at = NOW()
       WHERE r.entitlement_id = ? AND e.ends_at <= CURDATE() AND r.settled_refund_fen IS NULL`,
      [refundFen, settledAt, note, actorUserId, entitlementId]
    );
    if (!result.affectedRows) throw new Error("仅可在授权周期结束后登记，且不能重复登记退款");
    await recordAudit({ actorUserId, action: "outsource-rebate.settlement", entityId: entitlementId,
      details: { refundFen, settledAt, note } });
  }

  async function recordAudit({ actorUserId, actorTenantId = null, targetTenantId = null, action, entityId = "", details = {} }) {
    const id = `audit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    await pool.execute(
      `INSERT INTO saas_audit_logs
        (audit_id, actor_tenant_id, target_tenant_id, actor_user_id, action, entity_id, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), NOW())`,
      [id, actorTenantId, targetTenantId, actorUserId, action, entityId, JSON.stringify(details)]
    );
  }

  function mapTenant(row) {
    return {
      tenantId: row.tenant_id,
      slug: row.slug,
      name: row.name,
      tenantType: row.tenant_type,
      status: row.status,
      stateKey: row.state_key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  return {
    assignTenantFeatures,
    createDelegation,
    createEntitlement,
    updateEntitlementPaymentStatus,
    createFeatureRelease,
    createOutsourceTask,
    createTenantWithEntitlement,
    ensureSchema,
    ensureTenantAdminMembership,
    findSession,
    findActiveEntitlement,
    findDelegation,
    findTenantAdminUserId,
    findTenantById,
    findTenantBySlug,
    findPlatformSession,
    getTenantAdminDetails,
    getTenantFeatureModules,
    listDelegations,
    listFeaturePlans,
    listFeatureReleases,
    listOutsourceTasks,
    listOutsourceRebatePeriods,
    listTaskReservations,
    listTenants,
    listTenantDatabaseProvisions,
    recordAudit,
    revokeDelegation,
    revokeSession,
    revokeUserSessions,
    revokePlatformSession,
    recordOutsourceRebateSettlement,
    saveFeaturePlan,
    saveOutsourceRebateTargets,
    setFeatureReleaseRollouts,
    setFeatureReleaseStatus,
    createPlatformSession,
    createSession,
    setTenantStatus,
    updateOutsourceTaskStatus,
  };
}

module.exports = { createSaasStore };
