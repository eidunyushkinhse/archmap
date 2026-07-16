// Пан/зум превью диаграммы в DocOverlay: колесо — зум к курсору, drag — пан,
// программные zoomIn/zoomOut/fit для пилюли контролов, двойной клик — fit.
// Хук отдаёт style (transform) для обёртки контента и обработчики контейнера.
// Wheel вешается нативным addEventListener с passive:false: React-обработчик
// wheel пассивен и не может звать preventDefault (страница бы скроллилась).
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from "react";

const SCALE_MIN = 0.25;
const SCALE_MAX = 4;
const SCALE_STEP = 1.15;
const FIT_PAD = 24; // поля вокруг вписанной диаграммы

interface PanZoom {
  x: number;
  y: number;
  scale: number;
}

function clampScale(s: number): number {
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, s));
}

export function usePanZoom(
  containerRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
) {
  const [t, setT] = useState<PanZoom>({ x: 0, y: 0, scale: 1 });
  // Зеркало для чтения из обработчиков/колбэков (писать в ref в рендере нельзя)
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  });
  const [dragging, setDragging] = useState(false);
  const dragFrom = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  // Габариты контента в масштабе 1 (текущий rect, поделённый на текущий scale) +
  // размеры контейнера. null — мерить нечего (нет DOM или контент пуст).
  const measure = useCallback(() => {
    const box = containerRef.current;
    const content = contentRef.current;
    if (!box || !content) return null;
    const el = content.querySelector("svg") ?? content;
    const r = el.getBoundingClientRect();
    const s = tRef.current.scale;
    if (r.width < 1 || r.height < 1) return null;
    return { bw: r.width / s, bh: r.height / s, cw: box.clientWidth, ch: box.clientHeight };
  }, [containerRef, contentRef]);

  // Вписать контент целиком по центру. maxScale ограничивает раздувание:
  // первичное открытие не увеличивает мелкую диаграмму сверх 100%.
  const fitTo = useCallback(
    (maxScale: number = SCALE_MAX) => {
      const m = measure();
      if (!m) return;
      const raw = Math.min((m.cw - FIT_PAD * 2) / m.bw, (m.ch - FIT_PAD * 2) / m.bh);
      const s = clampScale(Math.min(raw, maxScale));
      setT({ x: (m.cw - m.bw * s) / 2, y: (m.ch - m.bh * s) / 2, scale: s });
    },
    [measure],
  );
  const fit = useCallback(() => fitTo(), [fitTo]);
  const fitInitial = useCallback(() => fitTo(1), [fitTo]);

  // Зум к точке (cx, cy) в координатах контейнера: точка под курсором остаётся на месте.
  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    setT((prev) => {
      const scale = clampScale(prev.scale * factor);
      const k = scale / prev.scale;
      return { x: cx - (cx - prev.x) * k, y: cy - (cy - prev.y) * k, scale };
    });
  }, []);

  // Кнопки −/+ зумят к центру контейнера.
  const zoomCenter = useCallback(
    (factor: number) => {
      const box = containerRef.current;
      if (!box) return;
      zoomAt(box.clientWidth / 2, box.clientHeight / 2, factor);
    },
    [containerRef, zoomAt],
  );
  const zoomIn = useCallback(() => zoomCenter(SCALE_STEP), [zoomCenter]);
  const zoomOut = useCallback(() => zoomCenter(1 / SCALE_STEP), [zoomCenter]);

  useEffect(() => {
    const box = containerRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = box.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? SCALE_STEP : 1 / SCALE_STEP);
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, [containerRef, zoomAt]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      // Кнопки контролов (зум-пилюля) — не начало панорамирования
      if (e.button !== 0 || (e.target as Element).closest("button")) return;
      const box = containerRef.current;
      if (!box) return;
      // Гасим нативное выделение текста: без preventDefault браузер стартует
      // selection от точки mousedown, и пан «растягивает» его по SVG-тексту
      // диаграммы (user-select:none на сцене — второй пояс той же защиты).
      e.preventDefault();
      box.setPointerCapture(e.pointerId);
      dragFrom.current = { px: e.clientX, py: e.clientY, x: tRef.current.x, y: tRef.current.y };
      setDragging(true);
    },
    [containerRef],
  );
  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const from = dragFrom.current;
    if (!from) return;
    setT((prev) => ({ ...prev, x: from.x + e.clientX - from.px, y: from.y + e.clientY - from.py }));
  }, []);
  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!dragFrom.current) return;
      dragFrom.current = null;
      setDragging(false);
      containerRef.current?.releasePointerCapture(e.pointerId);
    },
    [containerRef],
  );
  const onDoubleClick = useCallback(
    (e: ReactPointerEvent<HTMLElement> | React.MouseEvent<HTMLElement>) => {
      if ((e.target as Element).closest("button")) return;
      fit();
    },
    [fit],
  );

  const style: CSSProperties = {
    transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`,
    transformOrigin: "0 0",
  };

  return {
    style,
    scale: t.scale,
    dragging,
    zoomIn,
    zoomOut,
    fit,
    fitInitial,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onDoubleClick },
  };
}
