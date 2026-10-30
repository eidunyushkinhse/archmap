// Вид рамки — ОДИН на три места, где она рисуется (камень 18 docs/plan-c4-elements.md):
// compound-рамка раскрытия и площадки (FrameNode, nodes.tsx), нативная рамка уровня
// (LevelBoundary, boundaries.tsx) и живой оверлей драга (useFrameFollowOverlay), который
// на время жеста ПОДМЕНЯЕТ скрытую рамку и обязан выглядеть так же. Копии успели
// разойтись: оверлей рисовал пунктир ровно в 1px с лупой и над зоной площадки.
//
// Вход — данные рамки (FrameLook): декор, элемент архитектуры, глубина и внешность. Цвет
// считает только этот модуль — ни одно из трёх мест его само не выводит, иначе оверлей
// драга разошёлся бы с подменяемой рамкой.
//  - site — площадка холста «Развёртывание», ЗОНА: лёгкая заливка и тонкая светлая
//    граница вместо линии, которая сливалась со стрелками (deployment.md D5);
//  - group — служебная группа «Размещение не указано»: пунктир, как у раскрытия;
//  - без декора — рамка раскрытия или уровня: пунктир у любого элемента (container.md
//    C14, Р20 эпика «Элемент архитектуры»); у КОНТЕЙНЕРА — заливка его цвета по палитре
//    глубины (getNodeColors(is_external, depth).bg — та же глубина, которой объект
//    красится свёрнутым) с непрозрачностью CONTAINER_FILL_ALPHA; система и составной
//    компонент — прозрачны, как до эпика. Декор приоритетнее элемента: на холсте
//    развёртывания рамок контейнеров не бывает (deployment.md D5).
// Толщина — из --lg-frame-bw (LevelGraph, useFarZoom): 1px при обычном зуме, растёт при
// отдалении, и на экране рамка всегда ~1px. Геометрию и pointer-events задаёт место
// рисования.
import type { CSSProperties } from "react";
import type { FrameDecor, FrameElement } from "./types";
import { getNodeColors, hexToRgba } from "./colors";

// Непрозрачность заливки рамки контейнера (Р20: «около 8 %»).
const CONTAINER_FILL_ALPHA = 0.08;

// Данные рамки, от которых зависит вид. Всё необязательно: нет элемента — система (норма),
// нет глубины — 0, нет внешности — своя.
export interface FrameLook {
  decor?: FrameDecor;
  element?: FrameElement;
  depth?: number;
  is_external?: boolean;
}

// Рамка контейнера без декора — та, что залита; ей же класс-маркер.
const isContainerFrame = (look: FrameLook): boolean => !look.decor && look.element === "container";

// Класс рамки: lg-frame — стабильный хук полигона (scripts/dump-levels.mjs); модификатор —
// вид декора или маркер рамки контейнера (lg-frame--container — для CSS и тестов, стилей
// на нём нет: вид только отсюда, иначе оверлей драга разошёлся бы с рамкой).
export function frameClass(look: FrameLook): string {
  if (look.decor) return `lg-frame lg-frame--${look.decor.kind}`;
  return isContainerFrame(look) ? "lg-frame lg-frame--container" : "lg-frame";
}

export function frameStyle(look: FrameLook = {}): CSSProperties {
  const site = look.decor?.kind === "site";
  const fill = isContainerFrame(look)
    ? hexToRgba(getNodeColors(look.is_external ?? false, look.depth ?? 0).bg, CONTAINER_FILL_ALPHA)
    : "transparent";
  return {
    border: site ? "var(--lg-frame-bw, 1px) solid #cbd5e1" : "var(--lg-frame-bw, 1px) dashed #9ca3af",
    borderRadius: 12,
    background: site ? "rgba(100,116,139,0.07)" : fill,
    boxSizing: "border-box",
  };
}
