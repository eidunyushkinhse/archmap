// Кастомный тип ребра с HTML-лейблом (поддерживает перенос) и реестр edgeTypes.
// На основной схеме путь можно гнуть жестом: грипы на сегментах тянут излом за курсором
// (см. edgePath.ts), новая форма хранится в waypoints ребра.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useReactFlow,
  Position,
  type EdgeProps,
  type EdgeTypes,
} from "@xyflow/react";
import { wrapLabel } from "./text";
import type { WrappedEdgeData } from "./types";
import type { EdgePoint } from "../../types";
import { buildRenderPoints, orthogonalPointsForHandles, ensureOutwardStubs, cleanup, segments, dragSegment, interior, snapDragCursor, pointAtFraction, nearestFraction, type EdgeSide } from "./edgePath";
import { buildPathWithJumps } from "./edgeJumps";
import { useEdgeJumps } from "./EdgeJumpContext";
import { EDGE_SNAP_PX, JUMP_RADIUS } from "./constants";

// Position (сторона хэндла) → сторона для хэндл-ориентированного маршрута грипов.
function sideOf(p: Position): EdgeSide {
  return p === Position.Left ? "left"
    : p === Position.Right ? "right"
    : p === Position.Top ? "top"
    : "bottom";
}

// SVG-путь по ортогональной ломаной со скруглением углов радиуса r. Используется и для
// обхода «не родной» стрелки bidi (контекст), и для кастомного пути с waypoints (level).
function roundedPolyline(pts: Array<{ x: number; y: number }>, r: number): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
    const l1 = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
    const l2 = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const aX = p1.x - ((p1.x - p0.x) / l1) * rr, aY = p1.y - ((p1.y - p0.y) / l1) * rr;
    const bX = p1.x + ((p2.x - p1.x) / l2) * rr, bY = p1.y + ((p2.y - p1.y) / l2) * rr;
    d += ` L ${aX},${aY} Q ${p1.x},${p1.y} ${bX},${bY}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last.x},${last.y}`;
  return d;
}

// Сравнение двух наборов точек по координатам (для «проп догнал коммит»).
function samePoints(a: EdgePoint[], b: EdgePoint[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => p.x === b[i].x && p.y === b[i].y);
}

// Середина ломаной (для плашки подписи кастомного пути): центр среднего сегмента.
function pathMidpoint(pts: EdgePoint[]): { x: number; y: number } {
  const segs = segments(pts);
  if (segs.length === 0) return pts[0] ?? { x: 0, y: 0 };
  const m = segs[Math.floor(segs.length / 2)];
  return { x: (m.x1 + m.x2) / 2, y: (m.y1 + m.y2) / 2 };
}

function WrappedLabelEdge({
  id,
  sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
  data,
  markerEnd,
  style,
}: EdgeProps) {
  const d = data as WrappedEdgeData | undefined;
  const shelf = d?.shelf;
  const loop = d?.loop;
  // Приглушение фильтром «Вид схемы»: линию гасит style.opacity (из LevelGraph),
  // а плашку подписи — этот стиль (она рендерится в отдельном слое EdgeLabelRenderer).
  const dimStyle: CSSProperties | null = d?.dimmed ? { opacity: 0.12, pointerEvents: "none" } : null;

  // Реестр «мостиков»: публикуем ломаную этого ребра, читаем его точки-прыжки.
  const { publish, jumpsFor } = useEdgeJumps();

  const { screenToFlowPosition, getZoom } = useReactFlow();
  // Курсор в координатах графа + примагничивание плеча к ровному положению относительно
  // хэндла (порог EDGE_SNAP_PX делим на зум — липкость одинакова на любом масштабе).
  const flowCursor = useCallback(
    (clientX: number, clientY: number, drag: { startPts: EdgePoint[]; index: number }): EdgePoint => {
      const c = screenToFlowPosition({ x: clientX, y: clientY });
      return snapDragCursor(drag.startPts, drag.index, c, EDGE_SNAP_PX / getZoom());
    },
    [screenToFlowPosition, getZoom],
  );
  // Живой набор waypoints во время драга сегмента (null — драга нет). Коммит — на отпускании.
  const [dragWp, setDragWp] = useState<EdgePoint[] | null>(null);
  // Снимок исходного пути и индекс тянущегося сегмента (фиксируются в pointerdown): каждый
  // кадр считаем dragSegment от ИСХОДНОГО пути, иначе вставка стабов/cleanup дрейфуют.
  const dragRef = useRef<{ startPts: EdgePoint[]; index: number } | null>(null);
  // Закоммиченный путь, ещё не доехавший до пропа data.waypoints. Коммит дёргает
  // родительский стейт → АСИНХРОННЫЙ пересчёт раскладки; если погасить dragWp сразу,
  // кадр между отпусканием и приходом нового пропа покажет старый (авто) путь — стрелка
  // «мигает назад». Поэтому держим предпросмотр живым, пока проп не догонит коммит.
  const pendingRef = useRef<EdgePoint[] | null>(null);

  const onGripMove = useCallback((e: ReactPointerEvent<SVGPathElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const c = flowCursor(e.clientX, e.clientY, drag);
    setDragWp(interior(dragSegment(drag.startPts, drag.index, c)));
  }, [flowCursor]);

  const onGripUp = useCallback((e: ReactPointerEvent<SVGPathElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const c = flowCursor(e.clientX, e.clientY, drag);
    const wp = interior(dragSegment(drag.startPts, drag.index, c));
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* уже снят */ }
    // dragWp НЕ гасим — оставляем закоммиченный путь как предпросмотр, пока проп не догонит
    // (см. pendingRef + эффект ниже), иначе кадр со старым путём → мигание.
    pendingRef.current = wp;
    setDragWp(wp);
    d?.onWaypointsCommit?.(wp);
  }, [flowCursor, d]);

  // Проп догнал коммит → отпускаем локальный предпросмотр (теперь рисуем от data.waypoints).
  useEffect(() => {
    if (pendingRef.current == null) return;
    if (samePoints(d?.waypoints ?? [], pendingRef.current)) {
      pendingRef.current = null;
      setDragWp(null);
    }
  }, [d?.waypoints]);

  // --- Перетаскивание плашки с описанием вдоль стрелки (доля пути labelT) ---
  // Живая доля во время драга (null — драга нет); предпросмотр до прихода нового пропа.
  const [dragLabelT, setDragLabelT] = useState<number | null>(null);
  const curLabelTRef = useRef<number | null>(null);       // последняя посчитанная доля
  const pendingLabelT = useRef<number | null>(null);      // закоммичено, ждём проп
  const labelMoved = useRef(false);                       // драг сдвинул плашку → проглотить click
  const labelDrag = useRef<{ moved: boolean; startX: number; startY: number } | null>(null);
  // Геометрия плашки latest-ref'ом: ломаная пути под проекцию курсора + коммит доли.
  // Заполняется в рендере (см. ниже), читается в pointer-хэндлерах.
  const labelGeom = useRef<{ pts: EdgePoint[] | null; commit?: (t: number) => void }>({ pts: null });

  const onLabelDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!labelGeom.current.commit || !labelGeom.current.pts) return;
    e.stopPropagation(); // не начинать pan/выделение
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* нет capture */ }
    labelDrag.current = { moved: false, startX: e.clientX, startY: e.clientY };
  }, []);

  const onLabelMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = labelDrag.current;
    if (!drag) return;
    // мёртвая зона: пока курсор не сдвинулся на пару пикселей — это ещё клик, не драг
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 3) return;
      drag.moved = true;
    }
    const pts = labelGeom.current.pts;
    if (!pts) return;
    const c = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const t = nearestFraction(pts, c); // уже зажата в [0,1] → дальше концов не уедет
    curLabelTRef.current = t;
    setDragLabelT(t);
  }, [screenToFlowPosition]);

  const onLabelUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = labelDrag.current;
    labelDrag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* уже снят */ }
    if (!drag || !drag.moved) return; // не двигали — это клик (откроет детали)
    const t = curLabelTRef.current;
    if (t == null) return;
    labelMoved.current = true;        // следующий click по плашке проглотим
    // dragLabelT НЕ гасим — держим предпросмотр, пока проп labelT не догонит коммит
    // (иначе кадр с плашкой по центру → мигание, как у waypoints).
    pendingLabelT.current = t;
    labelGeom.current.commit?.(t);
  }, []);

  // Проп догнал коммит → отпускаем предпросмотр (рисуем от data.labelT).
  useEffect(() => {
    if (pendingLabelT.current == null) return;
    if (d?.labelT === pendingLabelT.current) {
      pendingLabelT.current = null;
      curLabelTRef.current = null;
      setDragLabelT(null);
    }
  }, [d?.labelT]);

  let edgePath: string;
  let labelX: number;
  let labelY: number;
  // Сегменты под грипы перетаскивания (только для редактируемого level-ребра).
  let gripPts: EdgePoint[] | null = null;
  // Ортогональная ломаная этого ребра для реестра «мостиков» (null — стрелка не
  // участвует: контекст-полки/петли, viewer-smoothstep). Заполняется в орто-ветках.
  let jumpPoly: EdgePoint[] | null = null;
  // Орто-путь со скруглением + полудугами над пересечениями (точки прыжков — из реестра).
  const orthoPath = (pts: EdgePoint[]): string => {
    jumpPoly = pts;
    return buildPathWithJumps(pts, 12, jumpsFor(id), JUMP_RADIUS);
  };
  // Ломаная пути для плашки подписи: по ней считаем точку по доле labelT и проекцию
  // курсора при драге. null — у контекст-полок/петель (там плашка не двигается).
  let labelPts: EdgePoint[] | null = null;
  if (loop) {
    // Контекст-схема: «не родная» стрелка bidi огибает колонку. Путь от дальней стороны
    // соседа: полка наружу до loopX → вертикаль до clearY (над/под колонкой) → к центру
    // фокуса по X → в верх/низ-центр фокуса. Точки строим сосед→фокус, затем при нужде
    // разворачиваем, чтобы порядок совпал с source→target (иначе стрелка-маркер не на месте).
    const nIsSrc = loop.neighborEnd === "source";
    const nX = nIsSrc ? sourceX : targetX;
    const nY = nIsSrc ? sourceY : targetY;
    const fX = nIsSrc ? targetX : sourceX;
    const fY = nIsSrc ? targetY : sourceY;
    const seq = [
      { x: nX, y: nY },
      { x: loop.loopX, y: nY },
      { x: loop.loopX, y: loop.clearY },
      { x: fX, y: loop.clearY },
      { x: fX, y: fY },
    ];
    edgePath = roundedPolyline(nIsSrc ? seq : [...seq].reverse(), 12);
    labelX = (nX + loop.loopX) / 2;                  // середина полки у соседа
    labelY = nY;
  } else if (shelf) {
    // Контекст-схема: подпись на горизонтальной «полке» у соседа. Сосед — конец полки
    // (shelf.end), фокус — противоположный конец. Вертикальный сгиб ставим на расстоянии
    // len от соседа, тогда отрезок сосед→сгиб строго горизонтален и равен len (это и есть
    // полка). Длина len единая по колонке → полки соседей выстраиваются ровной лентой.
    const nX = shelf.end === "target" ? targetX : sourceX;
    const nY = shelf.end === "target" ? targetY : sourceY;
    const fX = shelf.end === "target" ? sourceX : targetX;
    const dir = fX >= nX ? 1 : -1;                  // направление от соседа к фокусу
    const MIN_GAP = 24;                             // сгиб не ближе MIN_GAP к фокусу (страховка)
    const cx = dir === 1
      ? Math.min(nX + dir * shelf.len, fX - MIN_GAP)
      : Math.max(nX + dir * shelf.len, fX + MIN_GAP);
    [edgePath] = getSmoothStepPath({
      sourceX, sourceY, sourcePosition,
      targetX, targetY, targetPosition,
      borderRadius: 12, centerX: cx,
    });
    labelX = (nX + cx) / 2;                          // середина фактической полки
    labelY = nY;
  } else {
    // Обычное level-ребро. Есть кастомный путь (waypoints) или идёт драг → рисуем
    // ортогональную ломаную по точкам; иначе — авто-smoothstep как раньше (визуал
    // нетронутых стрелок не меняется).
    const s: EdgePoint = { x: sourceX, y: sourceY };
    const t: EdgePoint = { x: targetX, y: targetY };
    const activeWp = dragWp ?? d?.waypoints ?? null;
    const useCustom = dragWp != null || (d?.waypoints != null && d.waypoints.length > 0);
    if (useCustom) {
      // Обязательный стаб наружу у обоих концов: ломаную из waypoints (после залома грипом
      // или сдвига узла) могло развернуть концевым сегментом внутрь тела узла — стрелка
      // пряталась за ним. ensureOutwardStubs гарантирует выход вдоль нормали хэндла, как у
      // авто-пути. Во время активного драга грипа (dragWp) форму ведёт пользователь — не
      // навязываем, выправим на отпускании (статика).
      const pts = dragWp != null
        ? buildRenderPoints(s, t, activeWp)
        : ensureOutwardStubs(
            buildRenderPoints(s, t, activeWp),
            sideOf(sourcePosition), sideOf(targetPosition),
          );
      edgePath = orthoPath(pts);
      const mid = pathMidpoint(pts);
      labelX = mid.x;
      labelY = mid.y;
      labelPts = pts;
      if (d?.editable) gripPts = pts;
    } else if (d?.detour) {
      // Дефолтный обвод: прямой маршрут гостевой стрелки пересекал бы чужие узлы, поэтому
      // огибаем рамку поверху/понизу на высоте clearY. Концы переназначены раскладкой на
      // верх/низ-центр, поэтому стрелка выходит из источника вертикально, идёт по коридору
      // clearY и вертикально входит в цель. Точки живые (от хэндлов) — обвод следует за
      // узлом при его перетаскивании. Грипы (если editable) дают подправить обвод вручную.
      const pts = cleanup([
        s,
        { x: sourceX, y: d.detour.clearY },
        { x: targetX, y: d.detour.clearY },
        t,
      ]);
      edgePath = orthoPath(pts);
      const mid = pathMidpoint(pts);
      labelX = mid.x;
      labelY = mid.y;
      labelPts = pts;
      if (d?.editable) gripPts = pts;
    } else if (d?.editable) {
      // Редактируемое ребро без waypoints рисуем СВОЕЙ ортогональной ломаной по
      // сторонам хэндлов — теми же точками, что идут под грипы. Так грипы всегда лежат
      // на видимой линии. Раньше линия шла через getSmoothStepPath, а грипы — через
      // orthogonalPoints (доминанта dx/dy): у стрелки с сохранённым хэндлом после
      // сдвига узла они расходились, и грипы «слетали». Для выровненных сторон эта
      // ломаная совпадает со smoothstep, поэтому здоровые стрелки выглядят как прежде.
      const pts = cleanup(
        orthogonalPointsForHandles(
          sourceX, sourceY, sideOf(sourcePosition),
          targetX, targetY, sideOf(targetPosition),
        ),
      );
      edgePath = orthoPath(pts);
      const mid = pathMidpoint(pts);
      labelX = mid.x;
      labelY = mid.y;
      labelPts = pts;
      gripPts = pts;
    } else {
      // Нередактируемое ребро (viewer и т.п.) — прежний авто-smoothstep.
      [edgePath, labelX, labelY] = getSmoothStepPath({
        sourceX, sourceY, sourcePosition,
        targetX, targetY, targetPosition,
        borderRadius: 12,
      });
      // Линию viewer'у не меняем (smoothstep), но если архитектор сдвинул плашку —
      // позицию подписи считаем по ортогональной ломаной (близка к smoothstep).
      if (d?.labelT != null) {
        labelPts = cleanup(
          orthogonalPointsForHandles(
            sourceX, sourceY, sideOf(sourcePosition),
            targetX, targetY, sideOf(targetPosition),
          ),
        );
      }
    }
  }

  // Плашка сдвинута вдоль стрелки (драг или сохранённая доля) — кладём её в точку по
  // доле пути. Иначе остаётся по центру (вычислено выше в ветках). Контекст-полки
  // labelPts не дают → подпись там всегда по центру полки.
  const liveLabelT = dragLabelT ?? d?.labelT ?? null;
  if (labelPts && liveLabelT != null) {
    const p = pointAtFraction(labelPts, liveLabelT);
    labelX = p.x;
    labelY = p.y;
  }
  // latest-ref геометрии для pointer-хэндлеров плашки (читают её при драге). Обновляем
  // в эффекте без deps — после каждого рендера (рефы в рендере трогать нельзя), как cbRef.
  useEffect(() => {
    labelGeom.current = { pts: labelPts, commit: d?.onLabelTCommit };
  });

  // Публикуем ломаную этого ребра в реестр «мостиков» (пересчёт пересечений) и
  // снимаем при размонтировании. jumpPoly — новый массив каждый рендер, но publish
  // дедупит по координатам, поэтому лишних бампов версии реестра нет.
  useEffect(() => {
    publish(id, jumpPoly);
  }, [id, jumpPoly, publish]);
  useEffect(() => () => publish(id, null), [id, publish]);

  const onGripDown = useCallback(
    (e: ReactPointerEvent<SVGPathElement>, index: number, startPts: EdgePoint[]) => {
      if (!d?.editable) return;
      e.stopPropagation(); // не начинать pan/выделение/реконнект
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startPts, index };
    },
    [d],
  );

  const labelText = d?.label;
  const items = d?.items;
  const capW = d?.maxWidth;
  const lines = labelText ? wrapLabel(labelText) : [];

  // Плашка с описанием — триггер детализации связи (клик по линии на основной схеме
  // перехватывают грипы изломов). Кликабельна, когда задан onOpenDetails (level-рёбра).
  const clickable = d?.onOpenDetails != null;
  const openDetails = useCallback(
    (e: ReactMouseEvent) => { e.stopPropagation(); d?.onOpenDetails?.(); },
    [d],
  );
  // pointerEvents:"all" — иначе клик не дойдёт (контейнер EdgeLabelRenderer его глушит);
  // nodrag/nopan — клик по плашке не начинает pan/драг канвы.
  const clickStyle: CSSProperties = clickable ? { cursor: "pointer", pointerEvents: "all" } : {};
  const clickCls = clickable ? "nodrag nopan" : undefined;

  // Плашку можно тащить вдоль стрелки, если задан onLabelTCommit (редактируемое
  // level-ребро) и есть геометрия пути. Мету открывает ДВОЙНОЙ клик (единый триггер по
  // всей схеме); одиночный — только выделение, а после драга плашки глотаем клик-эхо.
  const labelDraggable = d?.onLabelTCommit != null && labelPts != null;
  const onLabelClick = (e: ReactMouseEvent) => {
    if (labelMoved.current) { labelMoved.current = false; e.stopPropagation(); }
  };
  const onLabelDouble = (e: ReactMouseEvent) => { if (clickable) openDetails(e); };
  const dragProps = labelDraggable
    ? { onPointerDown: onLabelDown, onPointerMove: onLabelMove, onPointerUp: onLabelUp }
    : {};
  const boxCls = labelDraggable ? "nodrag nopan" : clickCls;
  const boxClick = labelDraggable || clickable ? onLabelClick : undefined;
  const boxDouble = clickable ? onLabelDouble : undefined;
  // курсор move + pointerEvents:"all" в режиме драга; иначе прежний clickStyle
  const boxInteract: CSSProperties = labelDraggable
    ? { cursor: "move", pointerEvents: "all" }
    : clickStyle;

  const boxBase: CSSProperties = {
    position: "absolute",
    transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
    background: "rgba(255,255,255,0.95)",
    border: "1px solid #e5e7eb",
    borderRadius: 4,
    fontSize: 11,
    color: "#374151",
    lineHeight: 1.4,
  };

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      {/* Грипы перетаскивания сегментов: прозрачная «толстая» линия-хитбокс + видимая
          точка по центру (проявляется при ховере ребра). stopPropagation на клике гасит
          открытие поповера связи после жеста. */}
      {gripPts && segments(gripPts).map((seg) => {
        const mx = (seg.x1 + seg.x2) / 2, my = (seg.y1 + seg.y2) / 2;
        return (
          <g key={seg.index} className="lg-edge-grip">
            <path
              d={`M ${seg.x1},${seg.y1} L ${seg.x2},${seg.y2}`}
              style={{
                stroke: "transparent",
                strokeWidth: 16,
                fill: "none",
                cursor: seg.orient === "h" ? "ns-resize" : "ew-resize",
                pointerEvents: "stroke",
              }}
              onPointerDown={(e) => onGripDown(e, seg.index, gripPts!)}
              onPointerMove={onGripMove}
              onPointerUp={onGripUp}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            />
            <circle className="lg-edge-grip-dot" cx={mx} cy={my} r={3.5} style={{ pointerEvents: "none" }} />
          </g>
        );
      })}
      {items && items.length > 0 ? (
        // Мастер-стрелка: буллет-список текстов слитых связей
        <EdgeLabelRenderer>
          <div className={boxCls} onClick={boxClick} onDoubleClick={boxDouble} {...dragProps}
            style={{ ...boxBase, padding: "4px 8px", textAlign: "left", maxWidth: capW ?? 240, whiteSpace: "normal", ...boxInteract, ...dimStyle }}>
            {items.map((it, i) => (
              <div key={i} style={{ display: "flex", gap: 4 }}>
                <span>•</span><span>{it}</span>
              </div>
            ))}
          </div>
        </EdgeLabelRenderer>
      ) : lines.length > 0 ? (
        <EdgeLabelRenderer>
          {/* при заданном capW (контекст) подпись переносится по словам и ограничена по
              ширине, чтобы влезть в зазор между фокусом и колонкой и не лезть на узлы */}
          <div className={boxCls} onClick={boxClick} onDoubleClick={boxDouble} {...dragProps}
            style={{ ...boxBase, padding: "2px 7px", textAlign: "center", whiteSpace: capW ? "normal" : "nowrap", maxWidth: capW, ...boxInteract, ...dimStyle }}>
            {capW ? labelText : lines.map((line, i) => <div key={i}>{line}</div>)}
          </div>
        </EdgeLabelRenderer>
      ) : clickable && d?.editable ? (
        // Стрелка без описания: грипы изломов перехватывают клик по линии, поэтому даём
        // компактный плейсхолдер-плашку как триггер детализации (и точку входа в правку).
        <EdgeLabelRenderer>
          <div className={boxCls} title="Открыть связь (двойной клик)" onClick={boxClick} onDoubleClick={boxDouble} {...dragProps}
            style={{ ...boxBase, padding: "0 6px", color: "#9ca3af", fontSize: 13, lineHeight: "16px", cursor: "pointer", pointerEvents: "all", ...boxInteract, ...dimStyle }}>
            •••
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const edgeTypes = {
  wrapped: WrappedLabelEdge,
} as EdgeTypes;
