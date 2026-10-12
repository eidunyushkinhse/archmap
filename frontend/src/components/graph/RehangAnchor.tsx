// Ручка перевеса конца связи — НА ТОЧКЕ РОУТЕРА (Ф5 эпика «стрелки без жёстких
// хэндлов», edge.md E1a, canvas.md CV20b). Рисуется самим ребром (edges.tsx) в конце
// его ломаной: там, где линия реально упирается в рамку. RF-ручка (EdgeUpdateAnchors)
// стояла у служебного хэндла центра стороны — после Ф1 это не точка стыковки.
//
// Жест ведёт тот же XYHandle.onPointerDown из @xyflow/system, что и RF-ручка, с теми
// же параметрами из стора: превью-линия холста с наконечником (ConnectionLine, E76),
// автопан, защёлка на хэндл цели (connectionRadius), общие onConnectStart/onConnectEnd
// холста (их метит перевесом useEdgeConnect — иначе дроп открывал бы «Новую связь»).
// Отличия от RF-ручки:
//   • допустимость цели — своя (член той же рамки, через контекст ReconnectContext),
//     а не isValidConnection холста (та — про НОВУЮ связь);
//   • дроп на ТЕЛО узла внутри рамки принимается (elementFromPoint по отпусканию, если
//     защёлки на хэндл не было): с одним хэндлом на сторону «бросай у точки» стало бы
//     лотереей по месту отпускания;
//   • допустимая цель под курсором подсвечивается (класс lg-rehang-target на DOM-узле,
//     как lg-into-target у протяжки).
import { useRef, type MouseEvent as ReactMouseEvent } from "react";
import { useStoreApi, type Connection } from "@xyflow/react";
import { XYHandle } from "@xyflow/system";
import { useRehang, type RehangEdge, type RehangEnd } from "./ReconnectContext";

/** Радиус невидимой зоны захвата (px холста): видимая точка мала, промахнуться легко. */
export const REHANG_HIT_R = 11;
/** Радиус видимой точки: как у прежнего дота хэндла (тело 9px + кайма 2px, CSS). */
const DOT_R = 5.5;

/** Узел, на который перенесли конец: тянем target → RF ведёт жест от source и отдаёт
 * {source: неподвижный, target: новый}; тянем source — наоборот. */
export function movedEndOf(conn: Connection, end: RehangEnd): string | null {
  return end === "target" ? conn.target : conn.source;
}

/** Узел холста под точкой экрана (data-id ближайшего .react-flow__node), как в useEdgeConnect. */
export function nodeIdAtPoint(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  return el?.closest<HTMLElement>(".react-flow__node")?.getAttribute("data-id") ?? null;
}

// Координаты точки отпускания (мышь или тач).
function eventPoint(event: MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ("changedTouches" in event && event.changedTouches.length > 0) {
    const t = event.changedTouches[0];
    return { x: t.clientX, y: t.clientY };
  }
  if ("clientX" in event) return { x: event.clientX, y: event.clientY };
  return null;
}

interface Props {
  edge: RehangEdge;
  /** какой конец ребра держит эта ручка */
  end: RehangEnd;
  /** точка роутера — конец ломаной (координаты холста) */
  x: number;
  y: number;
  /** жест начат/окончен: ребро прячет плашку и приглушает линию на время перевеса */
  onActive: (active: boolean) => void;
}

export default function RehangAnchor({ edge, end, x, y, onActive }: Props) {
  const store = useStoreApi();
  const rehang = useRehang();
  // DOM-узел допустимой цели под курсором (подсветка lg-rehang-target)
  const targetElRef = useRef<HTMLElement | null>(null);

  const onMouseDown = (event: ReactMouseEvent<SVGGElement>) => {
    if (event.button !== 0 || !rehang) return;
    const s = store.getState();
    // Неподвижный конец: от него RF ведёт превью-линию и считает направление наконечника.
    const fixedEnd: RehangEnd = end === "target" ? "source" : "target";
    const fixedNodeId = fixedEnd === "source" ? edge.source : edge.target;
    const fixedHandleId = fixedEnd === "source" ? edge.sourceHandle : edge.targetHandle;
    const valid = (nodeId: string | null): nodeId is string =>
      nodeId != null && nodeId !== fixedNodeId && rehang.isValidTarget(edge, end, nodeId);
    let made = false; // onConnect уже записал перевес (защёлка на хэндл цели)

    // Слежение за узлом под курсором — подсветка допустимой цели (pointermove троттлится
    // по кадру; :hover при захвате указателя ненадёжен — ведём цель сами).
    let raf: number | null = null;
    const clearTarget = () => {
      targetElRef.current?.classList.remove("lg-rehang-target");
      targetElRef.current = null;
    };
    const onMove = (e: PointerEvent) => {
      if (raf != null) return;
      const { clientX, clientY } = e;
      raf = requestAnimationFrame(() => {
        raf = null;
        const el = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".react-flow__node") ?? null;
        const next = el && valid(el.getAttribute("data-id")) ? el : null;
        if (next === targetElRef.current) return;
        clearTarget();
        if (next) {
          next.classList.add("lg-rehang-target");
          targetElRef.current = next;
        }
      });
    };
    const stopTracking = () => {
      document.removeEventListener("pointermove", onMove);
      if (raf != null) cancelAnimationFrame(raf);
      raf = null;
      clearTarget();
    };

    XYHandle.onPointerDown(event.nativeEvent, {
      autoPanOnConnect: s.autoPanOnConnect,
      connectionMode: s.connectionMode,
      connectionRadius: s.connectionRadius,
      domNode: s.domNode,
      handleId: fixedHandleId,
      nodeId: fixedNodeId,
      nodeLookup: s.nodeLookup,
      isTarget: fixedEnd === "target",
      edgeUpdaterType: fixedEnd,
      lib: s.lib,
      flowId: s.rfId,
      cancelConnection: s.cancelConnection,
      panBy: s.panBy,
      updateConnection: s.updateConnection,
      getTransform: () => store.getState().transform,
      getFromHandle: () => store.getState().connection.fromHandle,
      autoPanSpeed: s.autoPanSpeed,
      dragThreshold: s.connectionDragThreshold,
      handleDomNode: event.currentTarget,
      isValidConnection: (c) => valid(movedEndOf(c as Connection, end)),
      // Порядок — как у RF-ручки: метка перевеса ПЕРЕД общим onConnectStart холста.
      onConnectStart: (ev, params) => {
        onActive(true);
        rehang.onStart();
        document.addEventListener("pointermove", onMove);
        store.getState().onConnectStart?.(ev, params);
      },
      onConnect: (c) => {
        const to = movedEndOf(c, end);
        if (!valid(to)) return;
        made = true;
        rehang.reconnect(edge, end, to);
      },
      onConnectEnd: (ev, state) => store.getState().onConnectEnd?.(ev, state),
      onReconnectEnd: (ev) => {
        stopTracking();
        if (!made) {
          // защёлки не было — дроп на тело узла внутри рамки
          const pt = eventPoint(ev);
          const to = pt ? nodeIdAtPoint(pt.x, pt.y) : null;
          if (valid(to)) rehang.reconnect(edge, end, to);
        }
        rehang.onEnd();
        onActive(false);
      },
    });
  };

  if (!rehang) return null;
  return (
    // Видимая точка хранит класс RF-ручки: её стилизует CSS (CV20b) и находит тур
    // («Перевесьте связь» ищет .react-flow__edgeupdater на рамке). Зона захвата —
    // отдельный прозрачный круг пошире.
    <g className="lg-rehang" onMouseDown={onMouseDown}>
      <circle className={`react-flow__edgeupdater react-flow__edgeupdater-${end}`} cx={x} cy={y} r={DOT_R} />
      <circle className="lg-rehang-hit" cx={x} cy={y} r={REHANG_HIT_R} />
    </g>
  );
}
