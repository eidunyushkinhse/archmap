// C4-палитра: цвет узла по типу (внутренний/внешний) и глубине уровня.
import type { NodeColors } from "./types";
import type { NodeStatus } from "../../types";

// Статусные палитры (planned/deprecated) — без рампы по глубине. Сознательная
// цена «варианта A»: у не-existing узла цветом кодируется статус, а глубина и
// внутренний/внешний уже не различаются (для внешних — лишь приглушённый тон).
const STATUS_FILL: Record<"internal" | "external", Record<"planned" | "deprecated", NodeColors>> = {
  internal: {
    planned: { bg: "#1f9d57", border: "#157243", text: "#ffffff" },
    deprecated: { bg: "#cb5a4f", border: "#a23f37", text: "#ffffff" },
  },
  external: {
    // приглушённый тон — частично сохраняет «внешность» узла
    planned: { bg: "#6f9d83", border: "#4f7d63", text: "#ffffff" },
    deprecated: { bg: "#b9756c", border: "#8f5048", text: "#ffffff" },
  },
};

export function getNodeColors(
  isExternal: boolean,
  depth: number,
  status: NodeStatus = "existing",
): NodeColors {
  if (status !== "existing") {
    return STATUS_FILL[isExternal ? "external" : "internal"][status];
  }
  // existing — прежняя рампа по глубине (без изменений)
  const d = Math.min(depth, 4);
  if (!isExternal) {
    const palette: NodeColors[] = [
      { bg: "#1168bd", border: "#0d5196", text: "#ffffff" },
      { bg: "#2389cc", border: "#1a70ae", text: "#ffffff" },
      { bg: "#4da8da", border: "#2d8bbf", text: "#ffffff" },
      { bg: "#7ec8e3", border: "#5ab0cf", text: "#1a365d" },
      { bg: "#b8dff0", border: "#8ec5e3", text: "#1a365d" },
    ];
    return palette[d];
  }
  const palette: NodeColors[] = [
    { bg: "#555555", border: "#333333", text: "#ffffff" },
    { bg: "#888888", border: "#666666", text: "#ffffff" },
    { bg: "#aaaaaa", border: "#888888", text: "#ffffff" },
    { bg: "#cccccc", border: "#aaaaaa", text: "#333333" },
    { bg: "#e0e0e0", border: "#c0c0c0", text: "#444444" },
  ];
  return palette[d];
}

// Метаданные статуса для бейджа на узле, легенды и цвета рёбер. badge=null —
// у existing бейджа нет; edge — цвет связи, конец которой носит этот статус.
export const STATUS_META: Record<NodeStatus, {
  label: string; badge: string | null; edge: string;
}> = {
  existing: { label: "Существует", badge: null, edge: "#94a3b8" },
  planned: { label: "Проектируется", badge: "новый", edge: "#3f9e6e" },
  deprecated: { label: "Выводится", badge: "выводится", edge: "#cf6d63" },
};
