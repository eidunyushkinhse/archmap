// Вписывание диаграммы процесса в окно (редизайн, фаза 3а; правки приёмки — читаемость
// важнее вписывания). Порядок:
//   1) раскладка: подписи шагов переносятся под ширину окна при масштабе 1 (fitWidth —
//      наибольшая ширина холста; диаграмма опускает предел ширины подписи до LABEL_MIN);
//   2) не влезло и так — масштаб room / ширина, но не ниже FIT_MIN: текст шага на экране
//      не мельче 12 × 0,9 = 10,8 px. Только в чтении: в правке жесты считают координаты
//      курсора, масштаб там всегда 1, а раскладка та же (переход «Редактировать» ↔
//      «Готово» подписи не перекладывает);
//   3) не влезло и на FIT_MIN — прокрутка вбок.
//
// Ширина окна — ширина тела экрана (.proc-body) без зарезервированной полосы прокрутки:
// по ней, а не по окну прокрутки, чтобы панель шага справа ни раскладку, ни масштаб не
// меняла (она только сужает окно прокрутки, ProcessCanvas доводит выбранный шаг до
// видимости). Петли нет: ни ширина тела, ни полоса прокрутки (scrollbar-gutter: stable)
// от диаграммы не зависят, диаграмма считает свою ширину геометрией, а не замером, и
// масштаб (CSS zoom) не меняет ни того, ни другого.
import { useLayoutEffect, useState } from "react";
import type { RefObject } from "react";

const FIT_MIN = 0.9;
// Поля обёртки диаграммы по горизонтали (processes.css, .proc-diagram) — их тоже
// масштабирует zoom.
const PAD_X = 16;

// Ширина области диаграммы без панели шага; null — не разложена (jsdom) — вписывания нет.
function useFitRoom(
  bodyRef: RefObject<HTMLElement | null>,
  scrollRef: RefObject<HTMLElement | null>,
): number | null {
  const [w, setW] = useState<number | null>(null);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const sc = scrollRef.current;
    if (!body || !sc) return;
    const read = () => {
      // Полоса прокрутки зарезервирована всегда — её ширина постоянна.
      const gutter = sc.offsetWidth - sc.clientWidth;
      setW(body.clientWidth > 0 ? body.clientWidth - gutter : null);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(body);
    return () => ro.disconnect();
  }, [bodyRef, scrollRef]);
  return w;
}

/**
 * width — ширина холста диаграммы после раскладки (SequenceDiagram.onLayout);
 * scaled — масштаб разрешён (режим чтения).
 */
export function useDiagramFit(
  bodyRef: RefObject<HTMLElement | null>,
  scrollRef: RefObject<HTMLElement | null>,
  width: number | null,
  scaled: boolean,
) {
  const avail = useFitRoom(bodyRef, scrollRef);
  // Запас в пиксель: дробная ширина под масштабом не должна дать полосу прокрутки.
  const room = avail != null ? avail - 1 : null;
  const fitWidth = room != null ? Math.max(0, room - PAD_X) : undefined;
  let scale = 1;
  if (scaled && room != null && width != null && width + PAD_X > room) {
    scale = Math.max(FIT_MIN, Math.floor((room / (width + PAD_X)) * 1000) / 1000);
  }
  return { fitWidth, scale };
}
