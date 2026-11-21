// Линейные иконки термов меты (16×16, currentColor) окна связи на странице объекта
// (EdgeEditModal, прежний язык до фазы окон). Панели редактора-карты иконок у подписей
// не держат (редизайн, фаза 4а).
import type { ReactNode } from "react";

const ms = {
  width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
  stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round",
} as const;

type MetaIcon = "tech" | "source" | "target" | "desc" | "invert";

export const META_ICON: Record<MetaIcon, ReactNode> = {
  tech: <svg {...ms}><path d="M6 5.4 3 8l3 2.6" /><path d="M10 5.4 13 8l-3 2.6" /></svg>,
  source: <svg {...ms}><circle cx="3.5" cy="8" r="2.25" /><path d="M6 8h7" /><path d="M10.5 5.4 13.2 8l-2.7 2.6" /></svg>,
  target: <svg {...ms}><path d="M2.8 8h7" /><path d="M7.3 5.4 10 8l-2.7 2.6" /><circle cx="12.5" cy="8" r="2.25" /></svg>,
  desc: <svg {...ms}><path d="M8.4 2.6 13 7.2a1.3 1.3 0 0 1 0 1.8l-3.9 3.9a1.3 1.3 0 0 1-1.8 0L2.7 8.3V4a1.3 1.3 0 0 1 1.3-1.3Z" /><circle cx="5.6" cy="5.5" r=".9" fill="currentColor" stroke="none" /></svg>,
  invert: <svg {...ms} width={15} height={15}><path d="M2.5 5.5h9.5" /><path d="M9.8 3.2 12 5.5l-2.2 2.3" /><path d="M13.5 10.5H4" /><path d="M6.2 8.2 4 10.5l2.2 2.3" /></svg>,
};
