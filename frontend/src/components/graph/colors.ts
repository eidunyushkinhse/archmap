// C4-палитра: цвет узла по типу (внутренний/внешний) и глубине уровня.
import type { NodeColors } from "./types";

export function getNodeColors(isExternal: boolean, depth: number): NodeColors {
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
  } else {
    const palette: NodeColors[] = [
      { bg: "#555555", border: "#333333", text: "#ffffff" },
      { bg: "#888888", border: "#666666", text: "#ffffff" },
      { bg: "#aaaaaa", border: "#888888", text: "#ffffff" },
      { bg: "#cccccc", border: "#aaaaaa", text: "#333333" },
      { bg: "#e0e0e0", border: "#c0c0c0", text: "#444444" },
    ];
    return palette[d];
  }
}
