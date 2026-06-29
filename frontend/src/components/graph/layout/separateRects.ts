// Плоское взвешенное разведение прямоугольников с минимальным смещением (Ф4.2a).
//
// Собирает связку Ф4.0+Ф4.1 в один проход overlap-removal: по текущим прямоугольникам
// генерим separation-ограничения (по оси мин. перекрытия), решаем VPSC по X, затем по Y,
// и повторяем, пока остаются наложения (новые могли возникнуть от сдвига) либо до предела
// итераций. Веса задают приоритет подвижности [R4]: «прибитому» прямоугольнику (локал,
// пиннящаяся раскрытая рамка) дать большой вес — он почти не сдвинется, расходятся соседи.
//
// Без контекста рамок: native keep-out и супер-узлы (рамка как жёсткая группа) — слой выше
// (Ф4.2b). Здесь чистая геометрия: вход — прямоугольники + веса, выход — новые прямоугольники
// (сдвинутые трансляцией, размеры неизменны). Вход не мутируется. См. REFACTOR_OWNERSHIP_F4.md.

import { generateOverlapConstraints, type Rect } from "./overlapConstraints";
import { solveSeparation } from "./vpsc";

const centerX = (r: Rect): number => (r.minX + r.maxX) / 2;
const centerY = (r: Rect): number => (r.minY + r.maxY) / 2;

// сдвигает прямоугольник так, чтобы его центр по оси встал в `c` (размер сохраняется)
const moveToCenterX = (r: Rect, c: number): Rect => {
  const dx = c - centerX(r);
  return { minX: r.minX + dx, maxX: r.maxX + dx, minY: r.minY, maxY: r.maxY };
};
const moveToCenterY = (r: Rect, c: number): Rect => {
  const dy = c - centerY(r);
  return { minX: r.minX, maxX: r.maxX, minY: r.minY + dy, maxY: r.maxY + dy };
};

const MAX_ITER = 8;

/**
 * Разводит налегающие прямоугольники с минимальным взвешенным смещением, сохраняя
 * относительный порядок. `weights[i]` > 0 — «жёсткость» прямоугольника (больше = меньше
 * двигается). `pad` — зазор между сторонами после развода. Возвращает новые прямоугольники
 * в исходном порядке. Чистая функция; если наложений нет — возвращает копию входа без сдвигов.
 */
export function separateRects(rects: Rect[], weights: number[], pad: number): Rect[] {
  let cur = rects.map((r) => ({ ...r }));

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const cons = generateOverlapConstraints(cur, pad);
    if (cons.x.length === 0 && cons.y.length === 0) break;

    // сначала разводим по X (ограничения, назначенные на эту ось)
    if (cons.x.length > 0) {
      const nx = solveSeparation(cur.map(centerX), weights, cons.x);
      cur = cur.map((r, i) => moveToCenterX(r, nx[i]));
    }
    // затем по Y; y-набор был назначен по геометрии до X-сдвига, но Y-перекрытия X-проход
    // не менял, поэтому решаем по уже X-сдвинутым прямоугольникам корректно
    if (cons.y.length > 0) {
      const ny = solveSeparation(cur.map(centerY), weights, cons.y);
      cur = cur.map((r, i) => moveToCenterY(r, ny[i]));
    }
  }

  return cur;
}
