// FLIP-анимация переезда карточек внутри контейнера.
//
// Повод: у таблицы появляется раздел, список перестраивается из плоского в
// сгруппированный, и карточка мгновенно оказывается в другом месте — читается как
// рывок. FLIP решает это без библиотеки: помним, где элемент был, после перестройки
// ставим ему ОБРАТНЫЙ сдвиг (визуально он ещё на старом месте) и снимаем сдвиг
// следующим кадром — браузер доезжает сам.
//
// Элементы ищем по data-flip-id внутри контейнера, а не раздаём рефы наружу: правило
// react-hooks/refs запрещает возвращать рефы из хука (объект становится ref-tainted),
// да и переезд между DOM-родителями рефы всё равно бы не пережили.
import { useLayoutEffect, useRef } from "react";

const DURATION = 260;
const EASING = "cubic-bezier(.2,.7,.3,1)";

function reducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * @param containerRef контейнер со строками `[data-flip-id]`
 * @param signature   строка, меняющаяся при перестройке списка (порядок/группировка):
 *                    по ней эффект понимает, что позиции могли поехать
 */
export function useFlipRows(
  containerRef: { current: HTMLElement | null },
  signature: string,
): void {
  const prev = useRef<Map<string, DOMRect>>(new Map());

  useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>("[data-flip-id]"));
    const next = new Map<string, DOMRect>();
    const skip = reducedMotion();

    for (const el of els) {
      const id = el.dataset.flipId;
      if (!id) continue;
      const after = el.getBoundingClientRect();
      next.set(id, after);
      const before = prev.current.get(id);
      // Новых карточек не двигаем: им «откуда» неизвестно, и подъезд из ниоткуда
      // выглядел бы хуже простого появления.
      if (skip || !before) continue;
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = `transform ${DURATION}ms ${EASING}`;
        el.style.transform = "";
      });
    }
    prev.current = next;
  }, [containerRef, signature]);
}
