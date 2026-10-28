const PROCESS_COLORS = {
  设计: "#4f46e5",
  激光: "#e11d48",
  切管: "#059669",
  折弯: "#2563eb",
  压铆: "#d97706",
  攻丝: "#7c3aed",
  焊接: "#ea580c",
  机加: "#0891b2",
  打磨: "#64748b",
  喷塑: "#16a34a",
  装配: "#0f766e",
  质检: "#0891b2"
};

function colorOf(name) {
  return PROCESS_COLORS[name] || "#64748b";
}

module.exports = {
  PROCESS_COLORS,
  colorOf
};