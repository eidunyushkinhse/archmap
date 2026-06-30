// Раздвижка узлов ради инлайн-места под плашку короткого ребра (A10, эпик стрелок).
//
// ПРОБЛЕМА: связь между СОСЕДНИМИ узлами (зазор в десятки px) короче, чем плашка её
// подписи. Инлайн-плашка не лезет на плечо и вынужденно отскакивает мимо стрелки/под
// узел (см. BUG B в [[arrows-routing-epic]]). Решение архитектора — РАЗДВИНУТЬ узлы по
// доминантной оси ребра, чтобы плечо стало длиннее текста, и плашка легла инлайн.
//
// КРИТИЧНО (own-on-first-render, REFACTOR_OWNERSHIP_F4.md): нельзя ре-каплить позиции
// узлов с раскладкой стрелок. Поэтому ВЛАДЕЕМЫЕ позиции (локал в levelPositions, гость с
// ghost_positions) ПРИБИТЫ намертво (weight = Infinity) — двигаются только ELK-производные
// (свежие на каждый рендер, никем не «присвоены»). Если оба конца владеемы — ребро не
// раздвигаем (остаётся leader-выноска как fallback R2).
//
// Машинерия — та же, что Ф4-разведение прямоугольников: VPSC (solveSeparation) для
// «минимально сдвинуть, сохранив порядок», плюс separateRects для зачистки наложений,
// которые раздвижка могла внести (каскад). Чистая функция; вход не мутируется.

import type { Rect } from "./overlapConstraints";
import type { Size } from "./labelBox";
import { solveSeparation, type SepConstraint } from "./vpsc";
import { separateRects } from "./separateRects";

/** Ребро-кандидат на раздвижку: индексы концов в `rects` + габариты его плашки. */
export interface LabelEdge {
  source: number;
  target: number;
  box: Size;
}

export interface SeparateForLabelsOpts {
  /** Зазор между сторонами при зачистке наложений (как в separateRects). */
  pad: number;
  /** Доп. клиренс вдоль плеча с каждой стороны плашки. */
  margin: number;
}

const centerX = (r: Rect): number => (r.minX + r.maxX) / 2;
const centerY = (r: Rect): number => (r.minY + r.maxY) / 2;
const halfW = (r: Rect): number => (r.maxX - r.minX) / 2;
const halfH = (r: Rect): number => (r.maxY - r.minY) / 2;

const moveToCenterX = (r: Rect, c: number): Rect => {
  const dx = c - centerX(r);
  return { minX: r.minX + dx, maxX: r.maxX + dx, minY: r.minY, maxY: r.maxY };
};
const moveToCenterY = (r: Rect, c: number): Rect => {
  const dy = c - centerY(r);
  return { minX: r.minX, maxX: r.maxX, minY: r.minY + dy, maxY: r.maxY + dy };
};

// separation-ограничение «развести концы ребра по оси `axis` так, чтобы между их
// обращёнными сторонами поместилась плашка (её протяжённость вдоль оси) + 2·margin».
// Зазор по центрам = полусумма габаритов вдоль оси + протяжённость плашки + 2·margin.
// Сторона (left/right) — по текущему порядку центров, чтобы не переворачивать порядок [R3].
function labelConstraint(
  s: Rect, si: number, t: Rect, ti: number, box: Size, axis: "x" | "y", margin: number,
): SepConstraint {
  if (axis === "x") {
    const gap = halfW(s) + halfW(t) + box.w + 2 * margin;
    return centerX(s) <= centerX(t)
      ? { left: si, right: ti, gap }
      : { left: ti, right: si, gap };
  }
  const gap = halfH(s) + halfH(t) + box.h + 2 * margin;
  return centerY(s) <= centerY(t)
    ? { left: si, right: ti, gap }
    : { left: ti, right: si, gap };
}

// доминантная ось ребра по дельте центров концов (вдоль неё идёт инлайн-плечо).
function dominantAxis(s: Rect, t: Rect): "x" | "y" {
  return Math.abs(centerX(t) - centerX(s)) >= Math.abs(centerY(t) - centerY(s)) ? "x" : "y";
}

// один проход раздвижки по оси: solve VPSC по label-ограничениям этой оси + применить
// трансляцию вдоль оси. Узлы без ограничений остаются в desired (свой блок, нет нарушения).
function widenAxis(rects: Rect[], weights: number[], cons: SepConstraint[], axis: "x" | "y"): Rect[] {
  if (cons.length === 0) return rects;
  const center = axis === "x" ? centerX : centerY;
  const move = axis === "x" ? moveToCenterX : moveToCenterY;
  const solved = solveSeparation(rects.map(center), weights, cons);
  return rects.map((r, i) => move(r, solved[i]));
}

/**
 * Раздвигает концы «голодных по месту» рёбер, чтобы их плашки легли инлайн.
 * `weights[i]` > 0 — жёсткость узла (Infinity — владеемый, прибит намертво). `edges` —
 * рёбра-кандидаты (см. LabelEdge). Возвращает новые позиции прямоугольников в исходном
 * порядке; раздвижка не создаёт наложений (зачистка separateRects). Чистая функция.
 *
 * Рёбра, у которых ОБА конца владеемы (вес Infinity), пропускаются — их не раздвинуть, не
 * нарушив ownership; вызывающий оставляет такому ребру leader-выноску.
 */
export function separateForLabels(
  rects: Rect[],
  weights: number[],
  edges: LabelEdge[],
  opts: SeparateForLabelsOpts,
): Rect[] {
  // ограничения копим по осям: ортогональные трансляции решаются независимо.
  const consX: SepConstraint[] = [];
  const consY: SepConstraint[] = [];
  for (const e of edges) {
    // оба конца прибиты — раздвинуть нечем без нарушения ownership, ребро остаётся на leader
    if (weights[e.source] === Infinity && weights[e.target] === Infinity) continue;
    const s = rects[e.source];
    const t = rects[e.target];
    const axis = dominantAxis(s, t);
    const c = labelConstraint(s, e.source, t, e.target, e.box, axis, opts.margin);
    (axis === "x" ? consX : consY).push(c);
  }
  if (consX.length === 0 && consY.length === 0) return rects.map((r) => ({ ...r }));

  // раздвигаем по X, затем по Y (ортогонально), затем зачищаем возможные наложения каскада
  let cur = widenAxis(rects, weights, consX, "x");
  cur = widenAxis(cur, weights, consY, "y");
  return separateRects(cur, weights, opts.pad);
}
