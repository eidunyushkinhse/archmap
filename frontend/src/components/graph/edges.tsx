// Кастомный тип ребра с HTML-лейблом (поддерживает перенос) и реестр edgeTypes.
// На основной схеме путь можно гнуть жестом: грипы на сегментах тянут излом за курсором
// (см. edgePath.ts), новая форма хранится в waypoints ребра.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useReactFlow,
  type EdgeProps,
  type EdgeTypes,
} from "@xyflow/react";
import { wrapLabel } from "./text";
import type { WrappedEdgeData } from "./types";
import type { EdgePoint } from "../../types";
import { buildRenderPoints, orthogonalPoints, cleanup, segments, dragSegment, interior } from "./edgePath";

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

  const { screenToFlowPosition } = useReactFlow();
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
    const c = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    setDragWp(interior(dragSegment(drag.startPts, drag.index, c)));
  }, [screenToFlowPosition]);

  const onGripUp = useCallback((e: ReactPointerEvent<SVGPathElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const c = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const wp = interior(dragSegment(drag.startPts, drag.index, c));
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* уже снят */ }
    // dragWp НЕ гасим — оставляем закоммиченный путь как предпросмотр, пока проп не догонит
    // (см. pendingRef + эффект ниже), иначе кадр со старым путём → мигание.
    pendingRef.current = wp;
    setDragWp(wp);
    d?.onWaypointsCommit?.(wp);
  }, [screenToFlowPosition, d]);

  // Проп догнал коммит → отпускаем локальный предпросмотр (теперь рисуем от data.waypoints).
  useEffect(() => {
    if (pendingRef.current == null) return;
    if (samePoints(d?.waypoints ?? [], pendingRef.current)) {
      pendingRef.current = null;
      setDragWp(null);
    }
  }, [d?.waypoints]);

  let edgePath: string;
  let labelX: number;
  let labelY: number;
  // Сегменты под грипы перетаскивания (только для редактируемого level-ребра).
  let gripPts: EdgePoint[] | null = null;
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
      const pts = buildRenderPoints(s, t, activeWp);
      edgePath = roundedPolyline(pts, 12);
      const mid = pathMidpoint(pts);
      labelX = mid.x;
      labelY = mid.y;
      if (d?.editable) gripPts = pts;
    } else {
      [edgePath, labelX, labelY] = getSmoothStepPath({
        sourceX, sourceY, sourcePosition,
        targetX, targetY, targetPosition,
        borderRadius: 12,
      });
      // грипы — на каноническом маршруте (совпадает со smoothstep для встречных сторон;
      // первый драг материализует именно его)
      if (d?.editable) gripPts = cleanup(orthogonalPoints(sourceX, sourceY, targetX, targetY));
    }
  }

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
          <div style={{ ...boxBase, padding: "4px 8px", textAlign: "left", maxWidth: capW ?? 240, whiteSpace: "normal" }}>
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
          <div style={{ ...boxBase, padding: "2px 7px", textAlign: "center", whiteSpace: capW ? "normal" : "nowrap", maxWidth: capW }}>
            {capW ? labelText : lines.map((line, i) => <div key={i}>{line}</div>)}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const edgeTypes = {
  wrapped: WrappedLabelEdge,
} as EdgeTypes;
