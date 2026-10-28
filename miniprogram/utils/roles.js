const ROLE_NAMES = {
  owner: "老板",
  manager: "生产主管",
  office: "办公室/跟单",
  worker: "车间工人",
  design_worker: "设计师",
  rivet_worker: "压铆师傅",
  tap_worker: "攻丝师傅",
  assembly_worker: "装配师傅",
  quality: "质检员",
  admin: "管理员",
  laser_worker: "激光师傅",
  bend_worker: "折弯师傅",
  polish_worker: "打磨师傅",
  weld_worker: "焊接师傅",
  machining_worker: "机加师傅",
  powder_worker: "喷塑师傅",
  driver: "司机"
};

function roleName(role) {
  return ROLE_NAMES[role] || role || "";
}

function roleNames(user) {
  const values = [...new Set([...(Array.isArray(user && user.roles) ? user.roles : []), user && user.role].filter(Boolean))];
  return values.map(roleName).join("、");
}

module.exports = {
  ROLE_NAMES,
  roleName,
  roleNames
};