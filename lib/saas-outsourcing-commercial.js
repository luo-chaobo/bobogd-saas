"use strict";

function validateFullOutsourceSelection(routes, routeIds, quantity, planQuantity) {
  const fullRouteIds = routes.filter((route) => route.routeType !== "rework").map((route) => route.id);
  if (!fullRouteIds.length) throw new Error("工单没有可委派的生产工序");
  const requestedIds = (Array.isArray(routeIds) ? routeIds : []).map(String);
  const selectedIds = [...new Set(requestedIds)];
  if (selectedIds.length !== requestedIds.length) throw new Error("外协任务工序不能重复选择");
  if (selectedIds.length !== fullRouteIds.length || fullRouteIds.some((routeId) => !selectedIds.includes(routeId))) {
    throw new Error("外协任务必须委派全部工序");
  }
  if (!Number.isSafeInteger(quantity) || quantity !== Number(planQuantity)) {
    throw new Error("外协数量必须等于工单全部计划数量");
  }
  return true;
}

function requiresOutsourceCompletionPhoto(isOutsourced, completedBefore, planQuantity, completedNow) {
  return Boolean(isOutsourced && Number(completedNow) > 0
    && Number(completedBefore) + Number(completedNow) >= Number(planQuantity));
}

function calculateOutsourceRebate({ outputFen, firstTargetFen, fullTargetFen, annualAmountFen, paymentStatus }) {
  const output = Number(outputFen);
  const firstTarget = Number(firstTargetFen);
  const fullTarget = Number(fullTargetFen);
  const annualAmount = Number(annualAmountFen);
  if (!Number.isSafeInteger(output) || !Number.isSafeInteger(firstTarget)
    || !Number.isSafeInteger(fullTarget) || !Number.isSafeInteger(annualAmount)
    || firstTarget < 1 || fullTarget <= firstTarget || annualAmount < 0) {
    return { tier: 0, refundFen: 0 };
  }
  const tier = output >= fullTarget ? 2 : output >= firstTarget ? 1 : 0;
  if (paymentStatus !== "paid") return { tier, refundFen: 0 };
  if (tier === 2) return { tier, refundFen: annualAmount };
  if (tier === 1) return { tier, refundFen: Math.floor(annualAmount / 2) };
  return { tier: 0, refundFen: 0 };
}

module.exports = {
  calculateOutsourceRebate,
  requiresOutsourceCompletionPhoto,
  validateFullOutsourceSelection,
};
