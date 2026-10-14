// Отклик холста уровня на зум — императивно, без ре-рендера графа (аудит F-1: вынесено
// из LevelGraph).
//
// АДАПТИВНАЯ ТОЛЩИНА РАМОК ПОД ЗУМ: рамки (нативные C4-boundary и compound-рамки
// раскрытий) рисуются 1px-пунктиром в координатах графа — на сильном отдалении
// физический 1px тает до долей экранного пикселя и рамка исчезает. Держим на холсте
// CSS-переменную --lg-frame-bw = max(1, 1/zoom)px: при приближении рамка остаётся
// прежним аккуратным 1px, при отдалении растёт физически ровно настолько, чтобы на
// экране оставаться ~1px. Пишем императивно (не через стейт) — зум не должен
// ре-рендерить граф; квант 0.25px гасит дёрганье стилей на каждом тике колеса.
//
// ДАЛЬНИЙ РЕЖИМ (решение пользователя 2026-10-12 — предел отдаления снят): ниже
// FAR_ZOOM холст получает атрибут data-far — линии стрелок держат экранную толщину
// (vector-effect), а сетка точек прячется (на отдалении она сливалась в серую муть).
// Тоже императивно, по тому же тику вьюпорта. Атрибут, а не класс: className корня
// пишет React на каждом рендере и стёр бы класс, поставленный мимо него.
import { useCallback, useRef } from "react";
import type { Viewport } from "@xyflow/react";

const FAR_ZOOM = 0.4;

// canvasRef — корень холста (его держит LevelGraph: реф из хука не возвращаем).
export function useFarZoom(canvasRef: { current: HTMLDivElement | null }): (vp: Viewport) => void {
  const frameBwRef = useRef(0);
  const farRef = useRef(false);
  return useCallback((vp: Viewport) => {
    const far = vp.zoom < FAR_ZOOM;
    if (far !== farRef.current) {
      farRef.current = far;
      if (far) canvasRef.current?.setAttribute("data-far", "1");
      else canvasRef.current?.removeAttribute("data-far");
    }
    const bw = Math.round(Math.max(1, 1 / vp.zoom) * 4) / 4;
    if (bw === frameBwRef.current) return;
    frameBwRef.current = bw;
    canvasRef.current?.style.setProperty("--lg-frame-bw", `${bw}px`);
  }, [canvasRef]);
}
