// Пан/зум превью диаграммы: окно схемы логики (чтение и превью при правке), ER-диаграмма
// во весь экран, просмотр документа в вопросах слияния. Схему открывают, чтобы ПРОЧИТАТЬ,
// поэтому:
//   • первое открытие — вид для чтения (readingView): текст не мельче 0,9 от натурального,
//     высокая схема стоит верхом у поля, а не сжимается целиком в окно;
//   • колесо прокручивает схему (по вертикали; по горизонтали — deltaX тачпада или Shift),
//     не уводя её за края (wheelPan); Ctrl или ⌘ с колесом (так же приходит щипок тачпада)
//     — зум к курсору;
//   • drag — пан, двойной клик и «Вписать» — схема целиком, −/+ — зум к центру.
// Хук отдаёт style (transform) для обёртки контента и обработчики контейнера. Wheel
// вешается нативным addEventListener с passive:false: React-обработчик wheel пассивен и не
// может звать preventDefault (страница под окном прокручивалась бы).
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from "react";

const SCALE_MIN = 0.25;
const SCALE_MAX = 4;
const SCALE_STEP = 1.15;
const FIT_PAD = 24; // поля вокруг вписанной диаграммы и край прокрутки колесом
// Нижний предел масштаба при открытии для чтения: мельче текст схемы не прочитать
// (урок фазы 3а редизайна: предел 0,6 дал текст 7,4 px).
const READ_MIN_SCALE = 0.9;
// Строка колеса (deltaMode 1, Firefox) в пикселях.
const WHEEL_LINE = 16;

interface PanZoom {
  x: number;
  y: number;
  scale: number;
}

/** Сцена (cw × ch) и схема в масштабе 1 (bw × bh). */
interface ViewSize {
  cw: number;
  ch: number;
  bw: number;
  bh: number;
}

function clampScale(s: number): number {
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, s));
}

/**
 * Вид при открытии для чтения. s_all — масштаб, при котором схема целиком помещается в
 * сцену с полями FIT_PAD.
 *   • s_all ≥ 0,9: масштаб min(s_all, 1), схема по центру (мелкую не раздуваем сверх 100%);
 *   • s_all < 0,9: масштаб по ширине сцены, но не меньше 0,9 и не больше 1; верх схемы у
 *     верхнего поля; по горизонтали по центру, а шире сцены — левым краем у левого поля.
 * Дальше человек читает схему колесом сверху вниз.
 */
export function readingView({ cw, ch, bw, bh }: ViewSize): PanZoom {
  const roomW = cw - FIT_PAD * 2;
  const roomH = ch - FIT_PAD * 2;
  const all = Math.min(roomW / bw, roomH / bh);
  if (all >= READ_MIN_SCALE) {
    const scale = Math.min(all, 1);
    return { x: (cw - bw * scale) / 2, y: (ch - bh * scale) / 2, scale };
  }
  const scale = Math.min(1, Math.max(READ_MIN_SCALE, roomW / bw));
  const w = bw * scale;
  return { x: w <= roomW ? (cw - w) / 2 : FIT_PAD, y: FIT_PAD, scale };
}

/**
 * Сдвиг колесом по одной оси: pos — положение края схемы, size — её размер на экране,
 * view — размер сцены, delta — прокрутка (положительная — вниз или вправо, схема уезжает
 * вверх или влево). Схема, которая по оси помещается в сцену с полями, по ней не двигается.
 * Не помещается — край схемы не отходит от края сцены дальше поля. Схему, которую уже
 * увели за поле перетаскиванием, колесо назад не дёргает: только не даёт уйти дальше.
 */
export function wheelAxis(pos: number, delta: number, size: number, view: number): number {
  if (delta === 0 || size <= view - FIT_PAD * 2) return pos;
  const next = pos - delta;
  if (delta > 0) return Math.max(next, Math.min(view - FIT_PAD - size, pos));
  return Math.min(next, Math.max(FIT_PAD, pos));
}

/** Прокрутка колесом по обеим осям в текущем масштабе. */
export function wheelPan(t: PanZoom, dx: number, dy: number, size: ViewSize): PanZoom {
  return {
    ...t,
    x: wheelAxis(t.x, dx, size.bw * t.scale, size.cw),
    y: wheelAxis(t.y, dy, size.bh * t.scale, size.ch),
  };
}

// mermaid отдаёт svg с width:100%/max-width — для пан/зума фиксируем натуральный
// размер из viewBox, чтобы масштаб контролировал ТОЛЬКО transform обёртки. Живёт
// здесь, а не в рендерере: нужен ровно тем, кто зумит трансформом (превью дока,
// полноэкранная ER-диаграмма), и парой с этим хуком не расходится.
export function pinSvgSize(wrap: HTMLElement | null): void {
  const svg = wrap?.querySelector("svg");
  if (!svg) return;
  const vb = svg.viewBox.baseVal;
  if (vb && vb.width > 0) {
    svg.style.width = `${vb.width}px`;
    svg.style.height = `${vb.height}px`;
    svg.style.maxWidth = "none";
  }
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
  const measure = useCallback((): ViewSize | null => {
    const box = containerRef.current;
    const content = contentRef.current;
    if (!box || !content) return null;
    const el = content.querySelector("svg") ?? content;
    const r = el.getBoundingClientRect();
    const s = tRef.current.scale;
    if (r.width < 1 || r.height < 1) return null;
    return { bw: r.width / s, bh: r.height / s, cw: box.clientWidth, ch: box.clientHeight };
  }, [containerRef, contentRef]);

  // «Вписать» и двойной клик: контент целиком по центру, мелкий — крупнее.
  const fit = useCallback(() => {
    const m = measure();
    if (!m) return;
    const raw = Math.min((m.cw - FIT_PAD * 2) / m.bw, (m.ch - FIT_PAD * 2) / m.bh);
    const s = clampScale(raw);
    setT({ x: (m.cw - m.bw * s) / 2, y: (m.ch - m.bh * s) / 2, scale: s });
  }, [measure]);
  // Первое открытие (и смена ширины сцены у читателя): вид для чтения.
  const fitInitial = useCallback(() => {
    const m = measure();
    if (m) setT(readingView(m));
  }, [measure]);

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
      // Колесо над сценой гасится всегда, и когда схема упёрлась в край: страница под
      // окном прокручиваться не должна.
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        if (e.deltaY === 0) return;
        const r = box.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? SCALE_STEP : 1 / SCALE_STEP);
        return;
      }
      const m = measure();
      if (!m) return;
      const kx = e.deltaMode === 1 ? WHEEL_LINE : e.deltaMode === 2 ? box.clientWidth : 1;
      const ky = e.deltaMode === 1 ? WHEEL_LINE : e.deltaMode === 2 ? box.clientHeight : 1;
      let dx = e.deltaX * kx;
      let dy = e.deltaY * ky;
      // Shift с колесом мыши — прокрутка вбок (браузер сам меняет оси не везде).
      if (e.shiftKey && dx === 0) {
        dx = dy;
        dy = 0;
      }
      setT((prev) => wheelPan(prev, dx, dy, m));
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, [containerRef, zoomAt, measure]);

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
