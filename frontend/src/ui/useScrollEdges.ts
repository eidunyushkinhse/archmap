import { useEffect, useRef, useState } from "react";

/**
 * Хук «у какого края прокрутки модалки мы находимся». Общий для всех крупных
 * модалок с липкой шапкой/футером (узел, связь, …): пока за липкой шапкой/полосой
 * действий есть скрытый контент — у их края виден разделитель и мягкая тень; у
 * самого верха/низа они плавно гаснут (классы --at-top / --at-bottom в modalShell.css).
 *
 * Маяки-сентинелы (невидимые div'ы height:1) ставятся по краям контента; их
 * пересечение со скролл-контейнером (<dialog> модалки) и есть «мы у этого края».
 * Один IntersectionObserver на оба. resubKey — значение, при смене которого нужно
 * пересобрать наблюдатель (у просмотра и редактирования разные футеры — маяки
 * перемонтируются, поэтому, например, передают `editing`).
 */
export function useScrollEdges(resubKey?: unknown) {
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const top = topRef.current;
    const bottom = bottomRef.current;
    const root = (top ?? bottom)?.closest("dialog");
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.target === top) setAtTop(e.isIntersecting);
          if (e.target === bottom) setAtBottom(e.isIntersecting);
        }
      },
      { root },
    );
    if (top) io.observe(top);
    if (bottom) io.observe(bottom);
    return () => io.disconnect();
  }, [resubKey]);

  return { atTop, atBottom, topRef, bottomRef };
}
