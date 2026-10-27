// Линейные иконки термов меты (16×16, currentColor) — одни на правую панель редактора
// (NodeInspector, EdgeInspector) и модалку связи страницы объекта (EdgeEditModal):
// раньше каждый держал свою копию одних и тех же путей (аудит F-15).
import type { ReactNode } from "react";

const ms = {
  width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
  stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round",
} as const;

type MetaIcon =
  | "type" | "membership" | "status" | "role" | "tech"
  | "source" | "target" | "desc" | "channel" | "invert" | "trash";

export const META_ICON: Record<MetaIcon, ReactNode> = {
  type: <svg {...ms}><rect x="2.75" y="3.5" width="10.5" height="9" rx="1.5" /><path d="M2.75 6.25h10.5" /></svg>,
  // Принадлежность (внутренний / внешний относительно организации): глобус.
  membership: <svg {...ms}><circle cx="8" cy="8" r="5.25" /><path d="M2.75 8h10.5" /><path d="M8 2.75c1.7 1.6 1.7 9 0 10.5c-1.7-1.5-1.7-8.9 0-10.5Z" /></svg>,
  status: <svg {...ms}><path d="M1.75 8h2.5l1.6-3.8 2.2 7.2 1.7-5 1 1.6h3.5" /></svg>,
  role: <svg {...ms}><path d="M4 2.9h8v10.2l-4-2.6-4 2.6Z" /></svg>,
  tech: <svg {...ms}><path d="M6 5.4 3 8l3 2.6" /><path d="M10 5.4 13 8l-3 2.6" /></svg>,
  source: <svg {...ms}><circle cx="3.5" cy="8" r="2.25" /><path d="M6 8h7" /><path d="M10.5 5.4 13.2 8l-2.7 2.6" /></svg>,
  target: <svg {...ms}><path d="M2.8 8h7" /><path d="M7.3 5.4 10 8l-2.7 2.6" /><circle cx="12.5" cy="8" r="2.25" /></svg>,
  desc: <svg {...ms}><path d="M8.4 2.6 13 7.2a1.3 1.3 0 0 1 0 1.8l-3.9 3.9a1.3 1.3 0 0 1-1.8 0L2.7 8.3V4a1.3 1.3 0 0 1 1.3-1.3Z" /><circle cx="5.6" cy="5.5" r=".9" fill="currentColor" stroke="none" /></svg>,
  // Канал: конверт события (та же метафора, что у секции каналов брокера).
  channel: <svg {...ms}><rect x="2.2" y="4" width="11.6" height="8" rx="1.3" /><path d="M2.2 5 8 8.9 13.8 5" /></svg>,
  invert: <svg {...ms} width={15} height={15}><path d="M2.5 5.5h9.5" /><path d="M9.8 3.2 12 5.5l-2.2 2.3" /><path d="M13.5 10.5H4" /><path d="M6.2 8.2 4 10.5l2.2 2.3" /></svg>,
  trash: <svg {...ms} width={15} height={15}><path d="M3 4.2h10 M5.5 4.2V3h5v1.2 M4.2 4.2l.6 8.3a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.3" /></svg>,
};
