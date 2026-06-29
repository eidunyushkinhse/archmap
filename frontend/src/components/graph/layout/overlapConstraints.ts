// Генерация separation-ограничений из геометрии прямоугольников для VPSC (Ф4.1).
//
// Для overlap-removal даём ограничения вдоль ОДНОЙ оси: на каждую фактически налегающую
// пару — ограничение «развести по этой оси» (зазор = полусумма габаритов вдоль оси + pad,
// сторона по центрам, поэтому относительный порядок сохраняется [R3]). Выбор оси (X или Y)
// делает уровень выше (separateRects, Ф4.2a): он пробует обе и берёт более дешёвую допустимую,
// что для изолированной пары совпадает с «осью минимального перекрытия», а в «сэндвиче»
// (узел зажат тяжёлыми соседями по одной оси) корректно уводит его по другой. Чистая функция.

import type { SepConstraint } from "./vpsc";

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type Axis = "x" | "y";

const centerX = (r: Rect): number => (r.minX + r.maxX) / 2;
const centerY = (r: Rect): number => (r.minY + r.maxY) / 2;
const halfW = (r: Rect): number => (r.maxX - r.minX) / 2;
const halfH = (r: Rect): number => (r.maxY - r.minY) / 2;

/** Глубина перекрытия пары по каждой оси; ≤ 0 хотя бы по одной → не налегают. */
export const penetration = (a: Rect, b: Rect): { x: number; y: number } => ({
  x: Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX),
  y: Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY),
});

/**
 * Separation-ограничения вдоль оси `axis` для всех ФАКТИЧЕСКИ налегающих пар (перекрытие по
 * обеим осям). `pad` — зазор между сторонами после развода. Индексы — в массив `rects`.
 */
export function generateAxisConstraints(rects: Rect[], axis: Axis, pad: number): SepConstraint[] {
  const out: SepConstraint[] = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const pen = penetration(a, b);
      if (pen.x <= 0 || pen.y <= 0) continue; // не налегают — разводить нечего
      if (axis === "x") {
        const gap = halfW(a) + halfW(b) + pad;
        if (centerX(a) <= centerX(b)) out.push({ left: i, right: j, gap });
        else out.push({ left: j, right: i, gap });
      } else {
        const gap = halfH(a) + halfH(b) + pad;
        if (centerY(a) <= centerY(b)) out.push({ left: i, right: j, gap });
        else out.push({ left: j, right: i, gap });
      }
    }
  }
  return out;
}

/** Число фактически налегающих пар среди прямоугольников. */
export function countOverlaps(rects: Rect[]): number {
  let n = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const pen = penetration(rects[i], rects[j]);
      if (pen.x > 0 && pen.y > 0) n++;
    }
  }
  return n;
}
