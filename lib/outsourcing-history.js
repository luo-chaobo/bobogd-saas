"use strict";

const OWNER_SUPERVISION_RETENTION_MS = 60 * 60 * 1000;

function isOwnerTaskWithinSupervision(task, now = Date.now()) {
  if (task?.side !== "owner" || task.status !== "accepted_by_owner") return true;
  const acceptedAt = new Date(task.ownerAcceptedAt).getTime();
  if (!Number.isFinite(acceptedAt)) return true;
  return now < acceptedAt + OWNER_SUPERVISION_RETENTION_MS;
}

function filterWorkOrderSources(items, filters = {}, enabled = false) {
  if (!enabled) return items;
  return items.filter((item) => {
    const outsourced = item.isOutsourced === true;
    if (filters.source === "outsourcing" && !outsourced) return false;
    if (filters.source === "factory" && (outsourced || item.orderOrigin === "platform")) return false;
    if (filters.source === "platform" && (outsourced || item.orderOrigin !== "platform")) return false;
    if (filters.sourceChannel && (outsourced || item.orderOrigin !== "platform" || item.sourceChannel !== filters.sourceChannel)) return false;
    return true;
  });
}

function finalOutsourceProcessCompletedAt(routes = []) {
  const plannedRoutes = routes
    .filter((route) => route.routeType !== "rework")
    .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
  const finalRoute = plannedRoutes.at(-1);
  if (!finalRoute || plannedRoutes.some((route) => {
    const planQty = Number(route.planQty || 0);
    return route.status !== "已完成" || planQty <= 0 || Number(route.completedQty || 0) < planQty;
  })) return "";
  return finalRoute.completedAt || finalRoute.lastReportedAt || "";
}

module.exports = { filterWorkOrderSources, finalOutsourceProcessCompletedAt, isOwnerTaskWithinSupervision };
