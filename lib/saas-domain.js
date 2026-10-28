"use strict";

const ACTIVE_TENANT_STATUSES = new Set(["active"]);
const ACTIVE_DELEGATION_STATUSES = new Set(["active"]);

function todayInShanghai(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeDate(value, fieldName) {
  const text = String(value || "").trim();
  const date = new Date(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== text) {
    throw new Error(`${fieldName} 必须为 YYYY-MM-DD 日期`);
  }
  return text;
}

function createTenant(input, now = new Date()) {
  const name = String(input.name || "").trim();
  const slug = String(input.slug || "").trim().toLowerCase();
  const tenantId = String(input.tenantId || "").trim();
  if (!name) throw new Error("公司名称不能为空");
  if (!tenantId) throw new Error("公司 ID 不能为空");
  if (!/^[a-z0-9](?:[a-z0-9-]{1,98}[a-z0-9])?$/.test(slug)) throw new Error("公司标识格式无效");
  return {
    tenantId,
    slug,
    name,
    tenantType: "company",
    status: "active",
    stateKey: `tenant:${tenantId}`,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function createEntitlement(input, now = new Date()) {
  const entitlementId = String(input.entitlementId || "").trim();
  const tenantId = String(input.tenantId || "").trim();
  const createdBy = String(input.createdBy || "").trim();
  if (!entitlementId || !tenantId || !createdBy) throw new Error("授权 ID、公司 ID 和操作人不能为空");
  if (input.annualAmountFen === null || input.annualAmountFen === undefined || input.annualAmountFen === "") throw new Error("年费金额不能为空");
  const annualAmountFen = Number(input.annualAmountFen);
  if (!Number.isSafeInteger(annualAmountFen) || annualAmountFen < 0) throw new Error("年费金额必须为非负整数分");
  const startsAt = normalizeDate(input.startsAt, "授权开始日期");
  const endsAt = normalizeDate(input.endsAt, "授权结束日期");
  if (endsAt < startsAt) throw new Error("授权结束日期不能早于开始日期");
  const waived = annualAmountFen === 0;
  const paymentStatus = waived ? "waived" : String(input.paymentStatus || "unpaid");
  if (!["unpaid", "paid", "waived", "not_required"].includes(paymentStatus)) throw new Error("收款状态无效");
  return {
    entitlementId,
    tenantId,
    annualAmountFen,
    currency: "CNY",
    startsAt,
    endsAt,
    status: "active",
    paymentStatus,
    note: String(input.note || "").trim().slice(0, 500),
    createdBy,
    createdAt: now.toISOString(),
  };
}

function createDelegation(input, now = new Date()) {
  const delegationId = String(input.delegationId || "").trim();
  const createdBy = String(input.createdBy || "").trim();
  const ownerTenantId = String(input.ownerTenantId || "").trim();
  const partnerTenantId = String(input.partnerTenantId || "").trim();
  if (!delegationId || !createdBy || !ownerTenantId || !partnerTenantId || ownerTenantId === partnerTenantId) throw new Error("委派 ID、操作人或委派双方公司无效");
  const startsAt = normalizeDate(input.startsAt, "委派开始日期");
  const endsAt = normalizeDate(input.endsAt, "委派结束日期");
  if (endsAt < startsAt) throw new Error("委派结束日期不能早于开始日期");
  const permissions = Array.isArray(input.permissions) ? input.permissions : [];
  const allowedPermissions = new Set(["tasks", "progress", "exceptions", "attachments", "quality", "delivery"]);
  const normalizedPermissions = [...new Set(permissions.map(String))];
  if (normalizedPermissions.some((item) => !allowedPermissions.has(item))) throw new Error("委派权限包含不支持的项目");
  return {
    delegationId,
    ownerTenantId,
    partnerTenantId,
    status: "active",
    startsAt,
    endsAt,
    permissions: normalizedPermissions,
    createdBy,
    createdAt: now.toISOString(),
  };
}

function canUseTenant(tenant, entitlement, today = todayInShanghai()) {
  if (!tenant || !ACTIVE_TENANT_STATUSES.has(tenant.status)) return false;
  return Boolean(entitlement
    && entitlement.status === "active"
    && entitlement.startsAt <= today
    && entitlement.endsAt >= today);
}

function canMonitorTask(delegation, task, viewerTenantId, permission, today = todayInShanghai()) {
  if (!delegation || !task || !ACTIVE_DELEGATION_STATUSES.has(delegation.status)) return false;
  if (delegation.startsAt > today || delegation.endsAt < today) return false;
  if (viewerTenantId !== delegation.ownerTenantId || task.ownerTenantId !== viewerTenantId) return false;
  if (task.delegationId !== delegation.delegationId) return false;
  return Array.isArray(delegation.permissions) && delegation.permissions.includes(permission);
}

function createOutsourceTask(input, now = new Date()) {
  const taskId = String(input.taskId || "").trim();
  const delegationId = String(input.delegationId || "").trim();
  const ownerTenantId = String(input.ownerTenantId || "").trim();
  const partnerTenantId = String(input.partnerTenantId || "").trim();
  const ownerOrderId = String(input.ownerOrderId || "").trim();
  const partnerWorkOrderId = String(input.partnerWorkOrderId || "").trim();
  const createdBy = String(input.createdBy || "").trim();
  if (![taskId, delegationId, ownerTenantId, partnerTenantId, ownerOrderId, partnerWorkOrderId, createdBy].every(Boolean)) {
    throw new Error("外协任务缺少必要关联信息");
  }
  const dueDate = normalizeDate(input.dueDate, "外协交期");
  const source = input.snapshot || {};
  const quantity = Number(source.quantity);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error("外协数量必须为正整数");
  const productionValueFen = Number(input.productionValueFen);
  if (!Number.isSafeInteger(productionValueFen) || productionValueFen <= 0) throw new Error("外协订单产值必须大于 0 元");
  const unit = String(source.quantityUnit || "件");
  if (!["件", "套"].includes(unit)) throw new Error("数量单位无效");
  return {
    taskId,
    delegationId,
    ownerTenantId,
    partnerTenantId,
    ownerOrderId,
    partnerWorkOrderId,
    sourceRevision: 1,
    status: "sent",
    dueDate,
    productionValueFen,
    snapshot: {
      orderNo: String(source.orderNo || "").trim(),
      productName: String(source.productName || "").trim(),
      drawingNumber: String(source.drawingNumber || "").trim(),
      quantity,
      quantityUnit: unit,
      dueDate,
      acceptanceCriteria: String(source.acceptanceCriteria || "").trim().slice(0, 2000),
      drawingIds: Array.isArray(source.drawingIds) ? [...new Set(source.drawingIds.map(String).filter(Boolean))] : [],
      processes: Array.isArray(source.processes)
        ? source.processes.map((item, index) => ({
          name: String(item.name || "").trim().slice(0, 80),
          sequence: Number.isSafeInteger(Number(item.sequence)) ? Number(item.sequence) : index + 1,
          ...(item.routeId ? { routeId: String(item.routeId) } : {}),
          ...(item.sourceSequence && Number.isSafeInteger(Number(item.sourceSequence)) ? { sourceSequence: Number(item.sourceSequence) } : {}),
        })).filter((item) => item.name)
        : [],
    },
    createdBy,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function transitionOutsourceTask(task, nextStatus, actorTenantId, now = new Date()) {
  const transitions = {
    sent: { owner: ["cancelled"], partner: ["accepted", "cancelled"] },
    accepted: { owner: ["cancelled"], partner: ["blocked", "submitted"] },
    in_progress: { owner: ["cancelled"], partner: ["blocked", "submitted"] },
    blocked: { partner: ["in_progress", "submitted"] },
    submitted: { owner: ["accepted_by_owner", "revision_requested"] },
    revision_requested: { partner: ["in_progress", "blocked", "submitted"] },
  };
  if (!task || !task.status || !task.ownerTenantId || !task.partnerTenantId) throw new Error("外协任务不存在或关联信息无效");
  const actor = actorTenantId === task?.ownerTenantId ? "owner" : actorTenantId === task?.partnerTenantId ? "partner" : "";
  if (!actor || !transitions[task.status]?.[actor]?.includes(nextStatus)) throw new Error("外协任务状态流转无效");
  return { ...task, status: nextStatus, updatedAt: now.toISOString() };
}

module.exports = {
  canMonitorTask,
  canUseTenant,
  createDelegation,
  createEntitlement,
  createOutsourceTask,
  createTenant,
  todayInShanghai,
  transitionOutsourceTask,
};
