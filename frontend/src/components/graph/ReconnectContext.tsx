// Контекст ПЕРЕВЕСА конца связи (Ф5 эпика «стрелки без жёстких хэндлов»). Ручку
// перевеса рисует само ребро (RehangAnchor из edges.tsx) в конце своей ломаной — на
// точке роутера, а не на DOM-хэндле React Flow; правила жеста (какой конец и куда
// можно перевесить, запись) живут в LevelGraph. Контекст соединяет их: ребро не знает
// рамок, холст не знает геометрии линии. Пропсы ReactFlow onReconnect/onReconnectStart/
// onReconnectEnd больше не используются: RF-ручки (EdgeUpdateAnchors) стояли у
// служебного хэндла центра стороны, а линия кончается на порту роутера (у рамки —
// проекция дальнего конца, до полстороны от центра).
//
// Обработчики держатся в latest-ref: значение контекста стабильно, рёбра не
// перерисовываются при смене идентичности колбэков холста (как cbRef в LevelGraph).
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";

export type RehangEnd = "source" | "target";

/** Ребро глазами ручки: концы, служебные хэндлы (от неподвижного RF ведёт превью-линию)
 * и реальные связи группы (у мастер-стрелки их несколько — переезжают все). */
export interface RehangEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
  memberIds: string[];
}

export interface RehangHandlers {
  /** можно ли повесить конец end ребра на узел nodeId (член той же рамки, edge.md E1a) */
  isValidTarget: (edge: RehangEdge, end: RehangEnd, nodeId: string) => boolean;
  /** конец end перенесён на узел toNodeId (цель уже прошла isValidTarget) */
  reconnect: (edge: RehangEdge, end: RehangEnd, toNodeId: string) => void;
  /** начало/конец жеста: метка перевеса для потока протяжки (useEdgeConnect) и класс холста */
  onStart: () => void;
  onEnd: () => void;
}

const RehangContext = createContext<RehangHandlers | null>(null);

export function ReconnectProvider({ handlers, children }: { handlers: RehangHandlers; children?: ReactNode }) {
  const ref = useRef(handlers);
  // канонический latest-ref: обновляем после каждого рендера (обработчики читаются в
  // событиях указателя — всегда после рендера)
  useEffect(() => { ref.current = handlers; });
  const value = useMemo<RehangHandlers>(() => ({
    isValidTarget: (edge, end, nodeId) => ref.current.isValidTarget(edge, end, nodeId),
    reconnect: (edge, end, toNodeId) => ref.current.reconnect(edge, end, toNodeId),
    onStart: () => ref.current.onStart(),
    onEnd: () => ref.current.onEnd(),
  }), []);
  return <RehangContext.Provider value={value}>{children}</RehangContext.Provider>;
}

// null — холст без перевеса (контекст-схема, read-only, превью): ручек нет.
export function useRehang(): RehangHandlers | null {
  return useContext(RehangContext);
}
