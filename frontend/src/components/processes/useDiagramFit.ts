// Вписывание диаграммы процесса в окно (редизайн, фаза 3а) — только в режиме чтения.
// Масштаб = min(1, доступная ширина / ширина диаграммы), не ниже FIT_MIN; ниже — масштаб
// остаётся на пределе, появляется прокрутка вбок. Перед масштабом диаграмма сама
// переносит подписи (fitWidth: предел ширины подписи опускается), чтобы уместиться при
// FIT_MIN. В правке масштаб всегда 100%: жесты считают координаты курсора, и
// масштабировать их незачем.
//
// Петли нет: доступная ширина — ширина области прокрутки (полоса прокрутки под неё
// зарезервирована, scrollbar-gutter), диаграмма считает свою ширину геометрией, а не
// замером; масштаб (CSS zoom) не меняет ни того, ни другого.
import { useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

export const FIT_MIN = 0.6;
// Поля обёртки диаграммы по горизонтали (processes.css, .proc-diagram) — их тоже
// масштабирует zoom.
const PAD_X = 16;

// Ширина области прокрутки; null — не разложена (jsdom) — вписывания нет.
function useClientWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [w, setW] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setW(el.clientWidth > 0 ? el.clientWidth : null);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

export interface DiagramLayout {
  // Ширина холста диаграммы сейчас и при обычном пределе подписи.
  width: number;
  fullWidth: number;
}

/**
 * active — вписывание включено (чтение и выбор «Вписать»); readMode — режим чтения
 * (переключатель «Вписать / 100%» живёт только в нём).
 */
export function useDiagramFit(
  scrollRef: RefObject<HTMLElement | null>,
  layout: DiagramLayout | null,
  active: boolean,
  readMode: boolean,
) {
  const avail = useClientWidth(scrollRef);
  // Запас в пиксель: дробная ширина под масштабом не должна дать полосу прокрутки.
  const room = avail != null ? avail - 1 : null;
  const fitWidth = active && room != null ? Math.max(0, room / FIT_MIN - PAD_X) : undefined;
  let scale = 1;
  if (active && room != null && layout) {
    const s = room / (layout.width + PAD_X);
    scale = Math.max(FIT_MIN, Math.min(1, Math.floor(s * 1000) / 1000));
  }
  // Переключатель нужен, только когда диаграмма в полный размер шире окна.
  const wider = readMode && avail != null && layout != null && layout.fullWidth + PAD_X > avail;
  return { fitWidth, scale, wider };
}
