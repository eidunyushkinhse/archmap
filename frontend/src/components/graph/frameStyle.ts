// Вид рамки — ОДИН на три места, где она рисуется (камень 18 docs/plan-c4-elements.md):
// compound-рамка раскрытия и площадки (FrameNode, nodes.tsx), нативная рамка уровня
// (LevelBoundary, boundaries.tsx) и живой оверлей драга (useFrameFollowOverlay), который
// на время жеста ПОДМЕНЯЕТ скрытую рамку и обязан выглядеть так же. Копии успели
// разойтись: оверлей рисовал пунктир ровно в 1px с лупой и над зоной площадки.
//
// Вход — декор рамки (FrameData.decor). Нет декора — рамка раскрытия или уровня: пунктир
// (container.md C14). site — площадка холста «Развёртывание», ЗОНА: лёгкая заливка и тонкая
// светлая граница вместо линии, которая сливалась со стрелками (deployment.md D5). group —
// служебная группа «Размещение не указано»: пунктир, как у раскрытия. Толщина — из
// --lg-frame-bw (LevelGraph, useFarZoom): 1px при обычном зуме, растёт при отдалении, и на
// экране рамка всегда ~1px. Геометрию и pointer-events задаёт место рисования.
import type { CSSProperties } from "react";
import type { FrameDecor } from "./types";

export function frameStyle(decor?: FrameDecor): CSSProperties {
  const site = decor?.kind === "site";
  return {
    border: site ? "var(--lg-frame-bw, 1px) solid #cbd5e1" : "var(--lg-frame-bw, 1px) dashed #9ca3af",
    borderRadius: 12,
    background: site ? "rgba(100,116,139,0.07)" : "transparent",
    boxSizing: "border-box",
  };
}
