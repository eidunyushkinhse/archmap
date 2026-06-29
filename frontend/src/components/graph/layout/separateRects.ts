// Плоское взвешенное разведение прямоугольников с минимальным смещением (Ф4.2a).
//
// Связка Ф4.0+Ф4.1. На каждой итерации, пока есть наложения, пробуем развести кластер
// ЦЕЛИКОМ по X и ЦЕЛИКОМ по Y (по одному VPSC на ось) и берём результат с МЕНЬШИМ остатком
// наложений, при равенстве — с меньшим суммарным смещением. Так изолированная пара уходит
// по «оси минимального перекрытия» (дешевле), а зажатый тяжёлыми соседями узел («сэндвич»)
// корректно уезжает по свободной оси, без зацикливания, которое давал жадный per-pair выбор.
//
// Веса задают приоритет подвижности [R4]: вес = Infinity прибивает узел намертво (локал),
// большой конечный вес — «почти неподвижен» (владеемый сосед). Без контекста рамок: native
// keep-out и супер-узлы (рамка как жёсткая группа) — слой выше (Ф4.2b). Только трансляция
// (размеры неизменны). Вход не мутируется. См. REFACTOR_OWNERSHIP_F4.md.

import {
  generateAxisConstraints, countOverlaps, type Rect, type Axis,
} from "./overlapConstraints";
import { solveSeparation } from "./vpsc";

const centerX = (r: Rect): number => (r.minX + r.maxX) / 2;
const centerY = (r: Rect): number => (r.minY + r.maxY) / 2;

const moveToCenterX = (r: Rect, c: number): Rect => {
  const dx = c - centerX(r);
  return { minX: r.minX + dx, maxX: r.maxX + dx, minY: r.minY, maxY: r.maxY };
};
const moveToCenterY = (r: Rect, c: number): Rect => {
  const dy = c - centerY(r);
  return { minX: r.minX, maxX: r.maxX, minY: r.minY + dy, maxY: r.maxY + dy };
};

const MAX_ITER = 16;

// один проход разведения по оси: solve VPSC + применить; вернуть результат, остаток наложений
// и суммарное смещение (для выбора более дешёвой оси). Прибитые (Infinity) смещения не дают.
function axisPass(rects: Rect[], weights: number[], pad: number, axis: Axis): {
  rects: Rect[]; residual: number; cost: number;
} {
  const cons = generateAxisConstraints(rects, axis, pad);
  if (cons.length === 0) return { rects, residual: countOverlaps(rects), cost: 0 };
  const center = axis === "x" ? centerX : centerY;
  const move = axis === "x" ? moveToCenterX : moveToCenterY;
  const solved = solveSeparation(rects.map(center), weights, cons);
  const next = rects.map((r, i) => move(r, solved[i]));
  const cost = next.reduce((s, r, i) => s + Math.abs(center(r) - center(rects[i])), 0);
  return { rects: next, residual: countOverlaps(next), cost };
}

/**
 * Разводит налегающие прямоугольники с минимальным взвешенным смещением, сохраняя порядок.
 * `weights[i]` > 0 — «жёсткость» (Infinity — прибит намертво; больше = меньше двигается).
 * `pad` — зазор между сторонами после развода. Возвращает новые прямоугольники в исходном
 * порядке. Чистая функция; нет наложений → копия входа без сдвигов.
 */
export function separateRects(rects: Rect[], weights: number[], pad: number): Rect[] {
  let cur = rects.map((r) => ({ ...r }));
  for (let iter = 0; iter < MAX_ITER; iter++) {
    if (countOverlaps(cur) === 0) break;
    const X = axisPass(cur, weights, pad, "x");
    const Y = axisPass(cur, weights, pad, "y");
    // меньше остаточных наложений лучше; при равенстве — меньше суммарного смещения (X при ничьей)
    cur = X.residual < Y.residual || (X.residual === Y.residual && X.cost <= Y.cost)
      ? X.rects : Y.rects;
  }
  return cur;
}
