// Токены бизнес-процессов — портированы 1:1 из дизайн-референса (bp-parts.jsx BPT).
// Визуальный язык хрома: system-ui, slate-нейтрали, единый синий #2563eb, янтарь
// только для валидатора/фрагментов. Новых цветов не вводим.
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
} as const;

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
