// Токены бизнес-процессов — портированы 1:1 из дизайн-референса (bp-parts.jsx BPT).
// Визуальный язык хрома: system-ui, slate-нейтрали, единый синий #2563eb, янтарь
// только для валидатора/фрагментов. Новых цветов не вводим.
import type { NodeStatus } from "../../types";

export const BPT = {
  accent: "#2563eb",
  accentHover: "#1d4ed8",
  tint: "#dbeafe",
  wash: "#eff6ff",
  ink: "#0f172a",
  head: "#1e293b",
  sec: "#475569",
  micro: "#64748b",
  mut: "#94a3b8",
  line: "#e2e8f0",
  line2: "#eef2f6",
  panelBg: "#fbfcfd",
  canvas: "#f8fafc",
  amber: "#b45309",
  amberBg: "#fffbeb",
  amberLine: "#fcd9a8",
  amberDot: "#f59e0b",
  retInk: "#7c5cff", // плечо-«ответ» — холодный фиолетовый
  asyncInk: "#0e7490", // асинхронное сообщение
  actFill: "#eaf1fe",
  actLine: "#cfe0fd", // полоса активации
  // Индикация целей при протягивании сообщения: связь между парой в эту сторону
  // задокументирована или нет. Новых оттенков не изобретаем — зелёный/красный те
  // же, что у статусов схемы и ошибок форм.
  okBg: "#dcfce7",
  okLine: "#16a34a",
  okWash: "rgba(22,163,74,.18)",
  badBg: "#fee2e2",
  badLine: "#dc2626",
  badWash: "rgba(220,38,38,.16)",
} as const;

// Цвет плеча по статусу узла. existing — чёрный (как стрелки связей на C4-схеме),
// planned/deprecated — те же edge-тона, что у рёбер C4 (STATUS_META.edge).
export const STATUS_LEG: Record<NodeStatus, string> = {
  existing: "#1e293b",
  planned: "#3f9e6e",
  deprecated: "#cf6d63",
};

// Повисшее сообщение (valid=false) переезжает на янтарь валидатора: красный занят под
// deprecated. Глиф «разорванная цепь» + чип «связь удалена». ln — янтарная линия (amber-600).
export const BROKEN = { ln: "#d97706", soft: BPT.amberBg, border: BPT.amberLine, ink: BPT.amber } as const;

// Полупрозрачный тинт hex-цвета (мягкая заливка шапки/активации статусной дорожки —
// «посветлённый» тон из той же палитры, без новых цветов). hex — #rrggbb.
export function withAlpha(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// Геометрия sequence-диаграммы (bp-parts.jsx SQ).
export const SQ = {
  MARGIN: 96,
  COL_W: 168,
  PHEAD_H: 52,
  TOP: 14,
  ROW_GAP: 44,
  ROW0: 40,
  FRAG_HEAD: 30,
  ELSE_GAP: 26,
  ACT_W: 9,
} as const;

// Базовые атрибуты контурных SVG-иконок (currentColor).
export const svgBase = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  display: "block" as const,
};
