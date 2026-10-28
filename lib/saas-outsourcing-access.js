"use strict";

const PARTNER_STATUS_PERMISSIONS = {
  accepted: "tasks",
  cancelled: "tasks",
  in_progress: "progress",
  blocked: "exceptions",
  submitted: "delivery",
};

function requiredOutsourcePermission(actor, nextStatus) {
  return actor === "partner" ? PARTNER_STATUS_PERMISSIONS[nextStatus] || null : null;
}

function hasActiveOutsourcePermission(delegation, permission, today) {
  return Boolean(delegation && delegation.status === "active"
    && delegation.startsAt <= today && delegation.endsAt >= today
    && Array.isArray(delegation.permissions) && delegation.permissions.includes(permission));
}

module.exports = { hasActiveOutsourcePermission, requiredOutsourcePermission };
