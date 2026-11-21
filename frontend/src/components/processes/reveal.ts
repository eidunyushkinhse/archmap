// Довести прямоугольник до видимости в окне кратчайшим путём (экран процесса: выбранный
// шаг при открытой панели шага). Чистая функция координат: сдвиг прокрутки по каждой
// оси. Цель выше или левее окна — к её началу; ниже или правее — к её концу, но так,
// чтобы начало не ушло за край (цель больше окна — видно её начало).
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function along(lo: number, hi: number, a: number, b: number): number {
  if (a < lo) return a - lo;
  if (b > hi) return Math.min(b - hi, a - lo);
  return 0;
}

export function revealDelta(view: Box, target: Box): { dx: number; dy: number } {
  return {
    dx: along(view.left, view.right, target.left, target.right),
    dy: along(view.top, view.bottom, target.top, target.bottom),
  };
}
