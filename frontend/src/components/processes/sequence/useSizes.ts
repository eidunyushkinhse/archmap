// Замеры элементов диаграммы по ключу (ширина или высота): подписи шагов, их копии в
// одну строку и шириной min-content (самое длинное слово), копии шапок участников. Элемент отдаёт себя ref-колбэком bind и несёт ключ в
// data-атрибуте; первый замер синхронный (в layout-эффекте, до отрисовки — без вспышки
// раскладки по умолчанию), дальше — ResizeObserver: он ловит и подгрузку шрифта, и
// перенос подписи при смене предела ширины.
//
// ⚠️ Петля «замер → геометрия → рендер → замер». Замеряется только то, что от геометрии
// не зависит (естественная ширина, шапка по имени), либо то, что геометрию по ширине не
// двигает (высота подписи). Сдвиг на пиксель и меньше не считается изменением: под
// масштабом (zoom режима чтения) высоты строк гуляют на ±1 px, и без допуска ответ
// ResizeObserver перерисовывал бы диаграмму впустую.
import { useCallback, useLayoutEffect, useRef, useState } from "react";

const TOLERANCE = 1;

function same(prev: Record<string, number>, next: Record<string, number>): boolean {
  const keys = Object.keys(next);
  if (keys.length !== Object.keys(prev).length) return false;
  return keys.every((k) => prev[k] !== undefined && Math.abs(prev[k] - next[k]) <= TOLERANCE);
}

/**
 * dim — что мерить; attr — имя data-атрибута с ключом (как в dataset: «mid» для data-mid);
 * version — что меняет набор элементов (массив шагов или участников): на нём эффект
 * переподписывает наблюдатель на новые элементы.
 */
export function useSizes(dim: "width" | "height", attr: string, version: unknown) {
  const els = useRef<Map<string, HTMLElement>>(new Map());
  const [sizes, setSizes] = useState<Record<string, number>>({});
  // Ref-колбэк с очисткой (React 19): ушедший элемент уходит и из словаря.
  const bind = useCallback((el: HTMLElement | null) => {
    const key = el?.dataset[attr];
    if (!el || !key) return;
    els.current.set(key, el);
    return () => {
      if (els.current.get(key) === el) els.current.delete(key);
    };
  }, [attr]);
  useLayoutEffect(() => {
    const read = () => {
      const next: Record<string, number> = {};
      for (const [key, el] of els.current) {
        const v = dim === "width" ? el.offsetWidth : el.offsetHeight;
        // 0 — элемент не разложен (jsdom, скрытый предок): замера нет, берётся умолчание.
        if (v > 0) next[key] = v;
      }
      setSizes((prev) => (same(prev, next) ? prev : next));
    };
    read();
    const ro = new ResizeObserver(read);
    for (const el of els.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [dim, version]);
  return { bind, sizes };
}
