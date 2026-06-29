// Генерация separation-ограничений из геометрии прямоугольников для VPSC (Ф4.1).
//
// Для overlap-removal с МИНИМАЛЬНЫМ смещением (REFACTOR_OWNERSHIP_F4.md, R2) каждую
// налегающую пару разводим по ОДНОЙ оси — той, где перекрытие меньше (дешевле развести).
// Так пара, чуть налезшая по вертикали и сильно по горизонтали, расходится вверх/вниз
// (короткий путь), а не растаскивается по горизонтали. Ось выбираем по текущей геометрии;
// сторону (кто левее/выше) — по центрам, поэтому относительный порядок сохраняется [R3].
//
// Возвращаем ДВА набора (x и y): solver гоняется по осям раздельно (x с x-набором, затем
// y с y-набором). Пара назначается ровно в один набор → полностью разводится по своей оси,
// исходное наложение уходит. Новые наложения от сдвига добирает итерация оркестрации (Ф4.2),
// как уже делает enforceFramesKeepOut. Чистая функция (вход не мутируется).

import type { SepConstraint } from "./vpsc";

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface AxisConstraints {
  /** ограничения вдоль оси X (индексы в массив rects; desired/веса задаёт оркестрация) */
  x: SepConstraint[];
  /** ограничения вдоль оси Y */
  y: SepConstraint[];
}

const centerX = (r: Rect): number => (r.minX + r.maxX) / 2;
const centerY = (r: Rect): number => (r.minY + r.maxY) / 2;
const halfW = (r: Rect): number => (r.maxX - r.minX) / 2;
const halfH = (r: Rect): number => (r.maxY - r.minY) / 2;

/**
 * По прямоугольникам строит separation-ограничения, разводящие каждую налегающую пару по
 * оси минимального перекрытия. `pad` — дополнительный зазор между сторонами после развода.
 * Пары без фактического наложения (хотя бы по одной оси) пропускаются — их трогать не надо.
 */
export function generateOverlapConstraints(rects: Rect[], pad: number): AxisConstraints {
  const x: SepConstraint[] = [];
  const y: SepConstraint[] = [];

  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      // глубина перекрытия по каждой оси; ≤ 0 хотя бы по одной → прямоугольники не налегают
      const penX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      const penY = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
      if (penX <= 0 || penY <= 0) continue;

      if (penX <= penY) {
        // разводим по X: меньший центр → left, гэп = полусумма ширин + pad
        const gap = halfW(a) + halfW(b) + pad;
        if (centerX(a) <= centerX(b)) x.push({ left: i, right: j, gap });
        else x.push({ left: j, right: i, gap });
      } else {
        // разводим по Y
        const gap = halfH(a) + halfH(b) + pad;
        if (centerY(a) <= centerY(b)) y.push({ left: i, right: j, gap });
        else y.push({ left: j, right: i, gap });
      }
    }
  }

  return { x, y };
}
