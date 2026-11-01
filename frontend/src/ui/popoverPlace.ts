// Место всплывающей панели у кнопки в координатах окна (position: fixed). Панель
// выровнена по правому краю кнопки и раскрывается ВВЕРХ; над кнопкой не помещается —
// под ней; не помещается ни там, ни там — встаёт слева от кнопки, целиком в окне (кнопку
// не закрывает). Длиннее окна — прокручивается (maxHeight). Чистая функция: числа на
// входе, числа на выходе — её проверяют тесты без раскладки браузера.

// Зазор между кнопкой и панелью и поле до края окна.
const GAP = 8;
const MARGIN = 8;

export interface PopoverPlace {
  top: number;
  right: number;
  maxHeight: number;
  // Откуда «выезжает» панель (анимация появления): от кнопки снизу, сверху или сбоку.
  origin: "bottom right" | "top right" | "right";
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));

export function placeAboveButton(
  button: Pick<DOMRect, "top" | "bottom" | "left" | "right">,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
): PopoverPlace {
  // Правый край панели не правее поля окна, левый — не левее.
  const rightOf = (v: number) => clamp(v, MARGIN, viewport.width - panel.width - MARGIN);
  const maxHeight = viewport.height - 2 * MARGIN;
  const right = rightOf(viewport.width - button.right);
  const above = button.top - GAP - panel.height;
  if (above >= MARGIN) return { top: above, right, maxHeight, origin: "bottom right" };
  const below = button.bottom + GAP;
  if (below + panel.height <= viewport.height - MARGIN) return { top: below, right, maxHeight, origin: "top right" };
  // Сбоку: низ панели — по низу кнопки, насколько позволяет окно.
  return {
    top: clamp(button.bottom - panel.height, MARGIN, viewport.height - MARGIN - panel.height),
    right: rightOf(viewport.width - button.left + GAP),
    maxHeight,
    origin: "right",
  };
}
