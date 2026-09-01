// Кастомный тип ребра с HTML-лейблом (поддерживает перенос) и реестр edgeTypes.
// Геометрия стрелки целиком авто (ручной слой изломов/хэндлов/драга плашки удалён
// 2026-07-09): линия — авто-маршрут роутера либо smoothstep, плашка — авто-размещение.
import { useCallback, useEffect, useRef, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Position,
  type EdgeProps,
  type EdgeTypes,
} from "@xyflow/react";
import { wrapLabel } from "./text";
import type { WrappedEdgeData } from "./types";
import type { EdgePoint } from "../../types";
import type { LabelPlacement } from "./layout/labelLayout";
import { ensureOutwardStubs, cleanup, segments, type EdgeSide } from "./edgePath";
import { buildPathWithJumps } from "./edgeJumps";
import { useEdgeJumps } from "./EdgeJumpContext";
import { JUMP_RADIUS, EDGE_CORNER_RADIUS } from "./constants";

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

// Середина ломаной (для плашки подписи без авто-размещения): центр среднего сегмента.
function pathMidpoint(pts: EdgePoint[]): { x: number; y: number } {
  const segs = segments(pts);
  if (segs.length === 0) return pts[0] ?? { x: 0, y: 0 };
  const m = segs[Math.floor(segs.length / 2)];
  return { x: (m.x1 + m.x2) / 2, y: (m.y1 + m.y2) / 2 };
}

// Ближайшая точка ломаной к заданной точке (ортогональная проекция на сегменты). Чистая.
function nearestOnPolyline(p: EdgePoint, route: EdgePoint[]): EdgePoint {
  let best: EdgePoint = route[0];
  let bestDist = Infinity;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i], b = route[i + 1];
    const abx = b.x - a.x, aby = b.y - a.y;
    const lenSq = abx * abx + aby * aby;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq));
    const qx = a.x + t * abx, qy = a.y + t * aby;
    const d = (p.x - qx) * (p.x - qx) + (p.y - qy) * (p.y - qy);
    if (d < bestDist) { bestDist = d; best = { x: qx, y: qy }; }
  }
  return best;
}

// Привязка плашки к НАРИСОВАННОЙ ломаной: опорная точка (якорь у выноски, центр у online)
// проецируется на ближайшую точку фактического маршрута, вся плашка (центр/якорь/конец поводка)
// едет на ту же дельту. Чистая — тестируется без React/RF.
//
// Фикс сползания плашек при драге (2026-07-22): драг-хук кладёт плашку на ИНТЕРПОЛИРОВАННЫЙ
// маршрут (дельта по позиции на снимке), а рендер рисует линию по ЖИВЫМ хэндлам — «ШОВ V2.2b»
// выпрямляет концевые сегменты до оси, а ensureOutwardStubs ВСТАВЛЯЕТ изломы, когда концы не
// выходят из узлов перпендикулярно стороне хэндла (диагональ из 2 точек превращается в 3-плечую
// ортогональ; у маршрутов с изломами выпрямляются концы). Нарисованная линия расходится с
// интерполированным маршрутом, и без привязки плашка сползает со стрелки (жалоба: ортогональные
// стрелки при драге, в т.ч. одноплечая в покое → 3-плечая при драге). Здесь плашка ОКОНЧАТЕЛЬНО
// ложится на видимую линию (WYSIWYG). В покое — no-op: раскладка и так ставит опорную точку на
// маршрут, и проекция возвращает её же (расстояние ~0).
export function projectLabelOntoRoute(lp: LabelPlacement, route: EdgePoint[]): LabelPlacement {
  if (route.length < 2) return lp;
  const ref = lp.mode === "leader" ? lp.anchor : lp.center;
  const q = nearestOnPolyline(ref, route);
  const dx = q.x - ref.x, dy = q.y - ref.y;
  if (dx === 0 && dy === 0) return lp;
  return {
    mode: lp.mode,
    center: { x: lp.center.x + dx, y: lp.center.y + dy },
    anchor: { x: lp.anchor.x + dx, y: lp.anchor.y + dy },
    leaderEnd: { x: lp.leaderEnd.x + dx, y: lp.leaderEnd.y + dy },
  };
}

// «ШОВ V2.2b»: концы маршрута переснимаются с ЖИВЫХ хэндлов (s/t), концевые сегменты
// выпрямляются по ОСИ ХЭНДЛА (внешней нормали стороны), крайний излом наследует
// перпендикулярную координату живого конца. Мьютирует и возвращает raw (свежая копия).
//
// Фикс петель при драге (2026-07-22): ось выпрямления берётся из СТОРОНЫ ХЭНДЛА, а НЕ из
// ориентации интерполированного сегмента. При драге интерполяция может поставить первый
// сегмент «боком» к хэндлу (напр. вертикальным при правом хэндле); выпрямление по его же
// ориентации направило бы сегмент ВНУТРЬ/вдоль края узла, и ensureOutwardStubs вставил бы
// крюк-петлю, чтобы вывести наружу (жалоба: петли на изломах перед диагональными плечами).
// Выпрямление по оси хэндла гарантирует чистый выход наружу → ensureOutwardStubs no-op,
// петли нет. В покое роутер и так кладёт концевой сегмент по оси хэндла — поведение то же.
export function seamRoute(
  raw: EdgePoint[], s: EdgePoint, t: EdgePoint, sSide: EdgeSide, tSide: EdgeSide,
): EdgePoint[] {
  if (raw.length >= 3) {
    const headHoriz = sSide === "left" || sSide === "right";
    const tailHoriz = tSide === "left" || tSide === "right";
    if (headHoriz) raw[1].y = s.y; else raw[1].x = s.x;
    if (tailHoriz) raw[raw.length - 2].y = t.y; else raw[raw.length - 2].x = t.x;
  }
  raw[0] = s;
  raw[raw.length - 1] = t;
  return raw;
}

function WrappedLabelEdge({
  id,
  sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
  data,
  markerEnd,
  style,
  selected,
}: EdgeProps) {
  const d = data as WrappedEdgeData | undefined;
  const shelf = d?.shelf;
  const loop = d?.loop;
  // Идёт анимированная ОТРИСОВКА (после раскрытия/сворачивания, useLayoutAnimation):
  // линия рисуется штрихом от source к target (pathLength=1 нормализует длину пути,
  // keyframes lg-edge-draw гонит stroke-dashoffset 1→0), а наконечник, плашка,
  // поводок и грипы скрыты до снятия флага — «плашка появляется по завершении».
  // Каскад (Ф5): drawInDelay сдвигает старт волны этого ребра (animation-delay);
  // до старта линия пуста (fill-mode both держит from-состояние).
  const drawing = d?.drawIn === true;
  const drawDelay = drawing ? (d?.drawInDelay ?? 0) : 0;
  // Приглушение фильтром «Вид схемы»: линию гасит style.opacity (из LevelGraph),
  // а плашку подписи — этот стиль (она рендерится в отдельном слое EdgeLabelRenderer).
  const dimStyle: CSSProperties | null = d?.dimmed ? { opacity: 0.12, pointerEvents: "none" } : null;

  // Реестр «мостиков»: публикуем ломаную этого ребра, читаем его точки-прыжки.
  const { publish, jumpsFor } = useEdgeJumps();

  let edgePath: string;
  let labelX: number;
  let labelY: number;
  // Ортогональная ломаная этого ребра для реестра «мостиков» (null — стрелка не
  // участвует: контекст-полки/петли, smoothstep). Заполняется в орто-ветках.
  let jumpPoly: EdgePoint[] | null = null;
  // Орто-путь со скруглением + полудугами над пересечениями (точки прыжков — из реестра).
  const orthoPath = (pts: EdgePoint[]): string => {
    jumpPoly = pts;
    return buildPathWithJumps(pts, EDGE_CORNER_RADIUS, jumpsFor(id), JUMP_RADIUS);
  };
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
    // Обычное level-ребро: авто-маршрут роутера, иначе smoothstep.
    const s: EdgePoint = { x: sourceX, y: sourceY };
    const t: EdgePoint = { x: targetX, y: targetY };
    if (d?.autoRoute && d.autoRoute.length >= 2) {
      // Авто-маршрут (эпик стрелок A7.1, R1+R3): ортоломаная посчитана на раскладке
      // глобальным роутером (минимум пересечений с другими стрелками + жёсткий обход узлов).
      // Концы переснимаем с ЖИВЫХ хэндлов (s/t) — линия держится узла при его сдвиге;
      // интерьерные изломы берём из снимка. ШОВ (V2.2b, seamRoute): концевые сегменты
      // выпрямляются по оси живого хэндла — без этого микро-сдвиг хэндла лечился стаб-патчем
      // и давал шпильку 1-2px у узла, а при драге — петли (см. seamRoute).
      const sSide = sideOf(sourcePosition);
      const tSide = sideOf(targetPosition);
      const raw = seamRoute(d.autoRoute.map((p) => ({ x: p.x, y: p.y })), s, t, sSide, tSide);
      // страховка направления выхода: minAlong=2, НЕ полный стаб — авто-маршрут кладёт
      // стабы по построению и легально укорачивает их в тесноте (clampStub); пере-стаб
      // полной длиной ломал разведённые плечи (см. комментарий у ensureOutwardStubs)
      const pts = ensureOutwardStubs(cleanup(raw), sSide, tSide, undefined, 2);
      edgePath = orthoPath(pts);
      const mid = pathMidpoint(pts);
      labelX = mid.x;
      labelY = mid.y;
    } else {
      // Нет авто-маршрута (живой драг до пересчёта и т.п.) — авто-smoothstep.
      [edgePath, labelX, labelY] = getSmoothStepPath({
        sourceX, sourceY, sourcePosition,
        targetX, targetY, targetPosition,
        borderRadius: 12,
      });
    }
  }

  // Позиция плашки: авто-размещение (R2+R4, labelPlacement — посчитано на раскладке
  // без наложений), иначе центр из веток выше. Руками плашка не двигается.
  // Привязка к НАРИСОВАННОЙ линии (jumpPoly): фикс сползания при драге — драг-хук кладёт
  // плашку на интерполированный маршрут, а линия рисуется по живым хэндлам (шов V2.2b +
  // ensureOutwardStubs меняют форму, вплоть до смены числа плеч), поэтому окончательно плашка
  // ложится на видимую ломаную (WYSIWYG). В покое проекция — no-op (раскладка и так ставит
  // плашку на маршрут). leader-поводок ниже ведётся от уже привязанного якоря.
  let labelPlacement = d?.labelPlacement;
  if (labelPlacement && jumpPoly) labelPlacement = projectLabelOntoRoute(labelPlacement, jumpPoly);
  if (labelPlacement) {
    labelX = labelPlacement.center.x;
    labelY = labelPlacement.center.y;
  }

  // Публикуем ломаную этого ребра в реестр «мостиков» (пересчёт пересечений) и
  // снимаем при размонтировании. jumpPoly — новый массив каждый рендер, но publish
  // дедупит по координатам, поэтому лишних бампов версии реестра нет.
  useEffect(() => {
    publish(id, jumpPoly);
  }, [id, jumpPoly, publish]);
  // Снятие — ТОЛЬКО на реальный unmount и СВЕЖИМ publish (latest-ref): завязка cleanup
  // на идентичность publish вычищала реестр на каждом переключении паузы драга (cleanup
  // бежал старым, ещё активным publish) — и «заморозка дуг на драге» пустела в ноль.
  // Цена: unmount ВО ВРЕМЯ паузы оставил бы запись до пере-публикации (не встречается:
  // рёбра не размонтируются посреди жеста).
  const publishRef = useRef(publish);
  useEffect(() => { publishRef.current = publish; });
  useEffect(() => () => publishRef.current(id, null), [id]);

  const labelText = d?.label;
  const items = d?.items;
  const capW = d?.maxWidth;
  const lines = labelText ? wrapLabel(labelText) : [];

  // Плашка с описанием — триггер детализации связи (двойной клик; единый триггер по
  // всей схеме). Кликабельна, когда задан onOpenDetails (level-рёбра). Плашка
  // ЗАМОРОЖЕНА: перетаскивание вдоль стрелки удалено вместе с ручным слоем.
  const clickable = d?.onOpenDetails != null;
  const openDetails = useCallback(
    (e: ReactMouseEvent) => { e.stopPropagation(); d?.onOpenDetails?.(); },
    [d],
  );
  // pointerEvents:"all" — иначе клик не дойдёт (контейнер EdgeLabelRenderer его глушит);
  // nodrag/nopan — клик по плашке не начинает pan/драг канвы.
  const boxInteract: CSSProperties = clickable ? { cursor: "pointer", pointerEvents: "all" } : {};
  // lg-edge-label — адрес режима «подписи скрыты» (CV32: display:none через класс
  // корня холста); lg-label--selected — исключение режима: плашка ВЫДЕЛЕННОЙ стрелки
  // остаётся видимой (единственный способ прочитать подпись, не выключая режим).
  const boxCls = "lg-edge-label"
    + (selected ? " lg-label--selected" : "")
    + (clickable ? " nodrag nopan" : "");
  const boxDouble = clickable ? openDetails : undefined;

  const boxBase: CSSProperties = {
    position: "absolute",
    transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
    background: "rgba(255,255,255,0.95)",
    border: "1px solid #e5e7eb",
    borderRadius: 4,
    fontSize: 11,
    color: "#374151",
    lineHeight: 1.4,
    // T5: вынесенная плашка получает лёгкий halo — белая кайма отделяет текст от линий
    // под ним, и выноска не сливается с «паутиной» (online-плашка лежит на своей линии,
    // ей halo не нужен)
    ...(labelPlacement?.mode === "leader"
      ? { boxShadow: "0 0 0 2px rgba(255,255,255,0.9), 0 1px 4px rgba(15,23,42,0.18)" }
      : null),
    // Плашка ВЫДЕЛЕННОЙ стрелки — над соседними плашками (в тесноте они ложатся друг
    // на друга — выбранную не прочитать). Работает внутри stacking context
    // edgelabel-renderer (z:1) — над узлами не поднимает. Панельное индиго-выделение
    // решается классом lg-linked-label (императивный эффект LevelGraph, тот же z).
    ...(selected ? { zIndex: 30 } : null),
  };

  return (
    <>
      {/* Во время отрисовки: наконечник скрыт (появится с плашкой), pathLength=1 +
          inline stroke-dasharray:1 (inline — чтобы перебить пунктир deprecated «6 4»
          на время штриха; после отрисовки пунктир возвращается со style). */}
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={drawing ? undefined : markerEnd}
        className={drawing ? "lg-edge-drawin" : undefined}
        {...(drawing ? { pathLength: 1 } : null)}
        style={drawing
          ? { ...style, strokeDasharray: 1, ...(drawDelay > 0 ? { animationDelay: `${drawDelay}ms` } : null) }
          : style}
      />
      {/* Поводок-выноска (R2-fallback): плашку нельзя поставить на линию без наложения —
          она вынесена сбоку (labelPlacement.center), а пунктирный поводок связывает её с
          точкой на стрелке (anchor). Ведём поводок ДО ЦЕНТРА плашки: непрозрачный фон
          плашки сам прячет хвост. Прежний leaderEnd (обрезка до края бокса, A15) резал
          по ОЦЕНЁННОМУ labelBoxSize-боксу — при других шрифтах реальная плашка уже
          оценки, и пунктир обрывался, не доходя до неё (жалоба 2026-07-09). */}
      {labelPlacement?.mode === "leader" && !drawing && (
        <path
          className={"lg-edge-leader" + (selected ? " lg-label--selected" : "")}
          d={`M ${labelPlacement.anchor.x},${labelPlacement.anchor.y} L ${labelPlacement.center.x},${labelPlacement.center.y}`}
          // T5 «читаемые пучки»: поводок заметнее (1.5px, темнее) — тонкий 1px-пунктир
          // в гуще линий терялся, и вынесенная плашка читалась как «текст ни о чём»
          style={{ stroke: "#6b7280", strokeWidth: 1.5, strokeDasharray: "4 3", fill: "none", pointerEvents: "none" }}
        />
      )}
      {drawing ? null : items && items.length > 0 ? (
        // Мастер-стрелка: буллет-список текстов слитых связей
        <EdgeLabelRenderer>
          {/* data-lg-edge: адрес плашки для императивного панельного выделения (LevelGraph) */}
          <div className={boxCls} onDoubleClick={boxDouble} data-lg-edge={id}
            style={{ ...boxBase, padding: "4px 8px", textAlign: "left", maxWidth: capW ?? 240, whiteSpace: "normal", ...boxInteract, ...dimStyle }}>
            {/* AN28б: быстрое плавное появление плашки при монтировании */}
            <div className="lg-label-in">
              {items.map((it, i) => (
                <div key={i} style={{ display: "flex", gap: 4 }}>
                  <span>•</span><span>{it}</span>
                </div>
              ))}
            </div>
          </div>
        </EdgeLabelRenderer>
      ) : lines.length > 0 ? (
        <EdgeLabelRenderer>
          {/* при заданном capW (контекст) подпись переносится по словам и ограничена по
              ширине, чтобы влезть в зазор между фокусом и колонкой и не лезть на узлы */}
          <div className={boxCls} onDoubleClick={boxDouble} data-lg-edge={id}
            style={{ ...boxBase, padding: "2px 7px", textAlign: "center", whiteSpace: capW ? "normal" : "nowrap", maxWidth: capW, ...boxInteract, ...dimStyle }}>
            {/* AN28б: быстрое плавное появление плашки при монтировании */}
            <div className="lg-label-in">
              {capW ? labelText : lines.map((line, i) => <div key={i}>{line}</div>)}
            </div>
          </div>
        </EdgeLabelRenderer>
      ) : clickable && d?.editable ? (
        // Стрелка без описания: компактный плейсхолдер-плашка как триггер детализации
        // (по тонкой линии двойным кликом попасть трудно).
        <EdgeLabelRenderer>
          <div className={boxCls} title="Открыть связь (двойной клик)" onDoubleClick={boxDouble} data-lg-edge={id}
            style={{ ...boxBase, padding: "0 6px", color: "#9ca3af", fontSize: 13, lineHeight: "16px", cursor: "pointer", pointerEvents: "all", ...boxInteract, ...dimStyle }}>
            {/* AN28б: быстрое плавное появление плашки при монтировании */}
            <div className="lg-label-in">•••</div>
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const edgeTypes = {
  wrapped: WrappedLabelEdge,
} as EdgeTypes;
