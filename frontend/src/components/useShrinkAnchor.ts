// Удержание позиции скролла при сжатии содержимого.
//
// Сценарий, ради которого хук появился: страница проскроллена вниз, пользователь
// сворачивает раскрывашку — содержимое становится короче, браузер упирает скролл в
// новый конец страницы, и всё уезжает ВВЕРХ относительно курсора. Кнопка, по которой
// только что кликнули, убегает из-под мыши.
//
// Приём: ровно на столько, на сколько не хватило страницы, снизу добавляется пустое
// место, а позиция скролла возвращается. Место ВРЕМЕННОЕ — оно тает по мере того, как
// пользователь скроллит вверх, и исчезает совсем, когда перестаёт быть нужным. Так
// пустоту нельзя увидеть: она существует ровно там, где её загораживает вьюпорт.
//
// ⚠️ Рассчитано на МГНОВЕННОЕ сжатие (анимации перестройки сейчас отключены). Если
// анимации вернутся, высота будет уменьшаться постепенно, и один замер в кадре после
// правки перестанет ловить итог — тогда мерить придётся по окончании анимации.
import { useCallback, useEffect, useRef } from "react";

// Ближайший прокручиваемый предок (на странице объекта это .np-page, а не окно).
function scrollParent(el: HTMLElement): HTMLElement {
  for (let n: HTMLElement | null = el.parentElement; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight) return n;
  }
  return document.scrollingElement as HTMLElement ?? document.body;
}

/**
 * @returns `hold(el)` — вызвать ПЕРЕД тем, как содержимое станет короче
 *          (в обработчике сворачивания, до setState).
 */
export function useShrinkAnchor(): (el: HTMLElement | null) => void {
  // Сколько пустоты добавили мы (в отличие от собственных отступов контейнера).
  const pad = useRef(0);
  const box = useRef<HTMLElement | null>(null);
  const basePad = useRef(0);
  const onScroll = useRef<(() => void) | null>(null);

  const release = useCallback(() => {
    const sc = box.current;
    if (sc && onScroll.current) sc.removeEventListener("scroll", onScroll.current);
    if (sc) sc.style.paddingBottom = basePad.current ? `${basePad.current}px` : "";
    pad.current = 0;
    onScroll.current = null;
    box.current = null;
  }, []);

  useEffect(() => release, [release]);

  return useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const sc = scrollParent(el);
    const top = sc.scrollTop;
    // Уже держим пустоту в другом контейнере — отпускаем: одна страница, один якорь.
    if (box.current && box.current !== sc) release();

    requestAnimationFrame(() => {
      // Сколько высоты не хватает, чтобы скролл остался на месте. scrollHeight уже
      // включает нашу пустоту, поэтому её вычитаем.
      const natural = sc.scrollHeight - pad.current;
      const need = Math.round(top - (natural - sc.clientHeight));
      if (need <= 0) return;

      if (!box.current) {
        box.current = sc;
        basePad.current = parseFloat(getComputedStyle(sc).paddingBottom) || 0;
      }
      pad.current = need;
      sc.style.paddingBottom = `${basePad.current + need}px`;
      sc.scrollTop = top;

      if (onScroll.current) return; // слушатель уже висит
      const listener = () => {
        const s = box.current;
        if (!s) return;
        // Пустота тает вслед за прокруткой вверх: она нужна ровно настолько,
        // насколько текущая позиция выходит за естественный конец страницы.
        const nat = s.scrollHeight - pad.current;
        const still = Math.max(0, Math.round(s.scrollTop - (nat - s.clientHeight)));
        if (still >= pad.current) return; // вниз не растим — только отпускаем
        if (still === 0) {
          release();
          return;
        }
        pad.current = still;
        s.style.paddingBottom = `${basePad.current + still}px`;
      };
      onScroll.current = listener;
      sc.addEventListener("scroll", listener, { passive: true });
    });
  }, [release]);
}
