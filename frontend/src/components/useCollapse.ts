// Раскрывашка с анимацией высоты — для содержимого, которое появляется и исчезает
// (список колонок таблицы).
//
// Почему не CSS: анимировать height можно только между ЧИСЛАМИ, а «сколько там
// контента» знает лишь браузер. Поэтому меряем и ведём height руками, а по окончании
// снимаем — дальше блок живёт с auto и не обрезает разросшийся контент.
//
// Содержимое переживает сворачивание: без этого схлопывание было бы мгновенным
// (анимировать удалённый из DOM элемент нечем). Размонтируем его по окончании
// анимации — постоянно держать колонки всех когда-либо раскрытых таблиц незачем.
//
// Длительность и кривая — общие с переездом карточек (useFlipRows): смешивать разные
// тайминги в одной сцене нельзя.
import { useLayoutEffect, useRef, useState } from "react";
import { ANIM_EASING, ANIM_MS, reducedMotion } from "./useFlipRows";

/**
 * @param boxRef обёртка содержимого (её высоту и ведём)
 * @param open   раскрыто ли сейчас
 * @returns рендерить ли содержимое (при сворачивании — ещё да, пока едет анимация)
 */
export function useCollapse(boxRef: { current: HTMLElement | null }, open: boolean): boolean {
  // Состояние «ещё сворачиваемся» правится В РЕНДЕРЕ по смене пропса (санкционированный
  // React-приём «adjust state when props change»), а не эффектом: setState в теле
  // эффекта — каскад рендеров, и линтер его запрещает.
  const [closing, setClosing] = useState(false);
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    setClosing(!open);
  }
  // Пока едет схлопывание, содержимое остаётся в DOM — иначе анимировать было бы нечего.
  const render = open || closing;

  const animatedFor = useRef(open);
  const cleanup = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    if (animatedFor.current === open) return;
    // Размонтировать «сразу» нельзя: setState в теле эффекта линтер запрещает
    // (каскад рендеров), поэтому откладываем на кадр. Визуально это и есть
    // «мгновенно» — путь для случаев, когда анимировать нечего или незачем.
    const unmountSoon = () => requestAnimationFrame(() => setClosing(false));
    const el = boxRef.current;
    // На раскрытии обёртка появляется этим же рендером, так что она уже здесь;
    // если нет — анимировать нечего, просто фиксируем состояние.
    if (!el) {
      animatedFor.current = open;
      if (!open) unmountSoon();
      return;
    }
    animatedFor.current = open;
    cleanup.current?.();
    if (reducedMotion()) {
      if (!open) unmountSoon();
      return;
    }

    // «Откуда» — фактическая высота сейчас (при быстром переключении она промежуточная),
    // «куда» — натуральная при раскрытии и ноль при сворачивании.
    const from = el.getBoundingClientRect().height;
    el.style.transition = "none";
    el.style.height = "";
    const to = open ? el.getBoundingClientRect().height : 0;

    const done = (e: TransitionEvent) => {
      if (e.target !== el || e.propertyName !== "height") return;
      cleanup.current?.();
      // setState из обработчика события — обычный путь, не каскад эффекта.
      if (!open) setClosing(false);
    };
    cleanup.current = () => {
      el.style.transition = "";
      el.style.height = "";
      el.style.overflow = "";
      el.removeEventListener("transitionend", done);
      cleanup.current = null;
    };
    el.addEventListener("transitionend", done);
    el.style.height = `${from}px`;
    el.style.overflow = "hidden";
    requestAnimationFrame(() => {
      el.style.transition = `height ${ANIM_MS}ms ${ANIM_EASING}`;
      el.style.height = `${to}px`;
    });
  }, [boxRef, open]);

  return render;
}
