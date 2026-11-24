// Меню значения слоем position: fixed от прямоугольника кнопки (редизайн, фаза 9б; приём
// тот же, что у project/remainder/ObjectCombobox и ui/InfoPopover). Нужен значению в
// прокручиваемом теле окна (ui/ds.css, .ds-win-body), например в окне «Новый объект»:
// absolute-меню обрезалось бы телом и раздувало его прокрутку, а у нижней строки его не
// было бы видно. Меню остаётся потомком кнопки и окна: окно — нативный <dialog> в верхнем
// слое, портал в body оказался бы под ним.
//
// Место — под кнопкой, если снизу хватает места, иначе над ней; левый край — левый край
// кнопки (как у absolute-меню строки свойств), но не ближе 12px к краю экрана. Пока меню
// открыто, оно следует за кнопкой: прокрутка тела окна и смена размера окна браузера
// пересчитывают его место. Кнопка целиком ушла из видимой части прокручиваемого предка —
// меню закрывается (onLost): иначе оно висело бы поверх шапки или подвала окна.
//
// Выключенный хук (on = false) ничего не трогает: в панели объекта и на странице объекта
// меню остаются absolute.
import { useCallback, useEffect, useEffectEvent, useLayoutEffect } from "react";
import type { RefObject } from "react";

// Меню от края экрана.
const EDGE = 12;

/** Ближайший прокручиваемый предок (тело окна); null — прокручивается только экран. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let e = el?.parentElement ?? null; e !== null; e = e.parentElement) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(e).overflowY)) return e;
  }
  return null;
}

export function useFixedMenu(
  on: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  // Зазор между кнопкой и меню (у absolute-меню места вызова свой).
  gap: number,
  onLost: () => void,
): void {
  // Место пишется прямо в style по ref, а не в стейт: это измерение, а не производное
  // состояние, и лишний рендер на каждый кадр прокрутки ему не нужен.
  const place = useCallback(() => {
    const menu = menuRef.current;
    const anchor = anchorRef.current;
    if (menu === null || anchor === null) return;
    const s = menu.style;
    s.position = "fixed";
    s.right = "auto";
    s.overflowY = "auto";
    // Высота и ширина без прежнего предела: меню меряется целиком.
    s.maxHeight = "";
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const below = vh - r.bottom - gap - EDGE;
    const above = r.top - gap - EDGE;
    const down = height <= below || below >= above;
    s.left = `${Math.max(EDGE, Math.min(r.left, vw - EDGE - width))}px`;
    // Над кнопкой меню держится нижним краем: так оно не отрывается от кнопки.
    s.top = down ? `${r.bottom + gap}px` : "auto";
    s.bottom = down ? "auto" : `${vh - r.top + gap}px`;
    s.maxHeight = `${Math.max(0, down ? below : above)}px`;
  }, [anchorRef, menuRef, gap]);

  // До отрисовки: меню не мигает в неверном месте.
  useLayoutEffect(() => {
    if (on) place();
  }, [on, place]);

  const lost = useEffectEvent(onLost);

  // Следовать за кнопкой: прокрутка тела окна (capture — до window она не всплывает) и
  // смена размера окна браузера. Кнопка целиком вне видимой части тела — меню закрыть.
  useEffect(() => {
    if (!on) return;
    const onScroll = () => {
      const anchor = anchorRef.current;
      const box = scrollParent(anchor);
      if (anchor !== null && box !== null) {
        const r = anchor.getBoundingClientRect();
        const b = box.getBoundingClientRect();
        if (r.bottom <= b.top || r.top >= b.bottom) {
          lost();
          return;
        }
      }
      place();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [on, place, anchorRef]);
}
