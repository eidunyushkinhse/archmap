// Реконнект концов рёбер: смена хэндла на том же узле + персист хэндлов.
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { MouseEvent } from "react";
import { reconnectEdge, type Edge as RFEdge, type Connection } from "@xyflow/react";
import { nodesApi, edgesApi } from "../../../api/nodes";
import type { Node as AppNode } from "../../../types";

interface Params {
  setRfEdges: Dispatch<SetStateAction<RFEdge[]>>;
  nodes: AppNode[];
  isArchitect: boolean;
  containerId: string | null;
  // reconnect сохранил новые хэндлы конца стрелки — родитель синхронизирует стейт
  // уровня, чтобы пересчёт раскладки не откатывал их к autoHandles. column — хэндл
  // локального конца (колонка ребра), ghost — гостевого конца (по проекции node_id).
  onEdgeHandlesChanged?: (
    edgeId: string,
    changes: {
      column?: { source_handle?: string; target_handle?: string };
      ghost?: { node_id: string; handle: string };
    },
  ) => void;
}

export function useReconnectHandles({
  setRfEdges, nodes, isArchitect, containerId, onEdgeHandlesChanged,
}: Params) {
  // Reconnect: отслеживаем активное ребро и успех операции
  const reconnectingEdge = useRef<RFEdge | null>(null);
  const reconnectSucceeded = useRef(true);

  // Курсор с зажатым концом связи находится над НЕ РОДНЫМ узлом (ни источник, ни цель
  // ребра) — перепривязать конец к нему нельзя. Драйвит запрещающий курсор и тост.
  // Конец связи цепляется только к хэндлам того же узла; чужой узел — это «заведи
  // новую связь». :hover при pointer-capture драга ненадёжен, поэтому ведём цель сами
  // (pointermove + elementFromPoint), как при протягивании новой связи в useEdgeConnect.
  const [blocked, setBlocked] = useState(false);
  const rafRef = useRef<number | null>(null);

  const updateBlocked = useCallback((x: number, y: number) => {
    const edge = reconnectingEdge.current;
    if (!edge) { setBlocked(false); return; }
    const nodeEl = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>(".react-flow__node");
    const id = nodeEl?.getAttribute("data-id");
    // не родной узел = под курсором узел, не являющийся ни источником, ни целью ребра
    setBlocked(!!id && id !== edge.source && id !== edge.target);
  }, []);

  // pointermove частый — пересчёт цели троттлим по кадру
  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (rafRef.current != null) return;
      const { clientX, clientY } = e;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        updateBlocked(clientX, clientY);
      });
    },
    [updateBlocked],
  );

  const stopTracking = useCallback(() => {
    document.removeEventListener("pointermove", handlePointerMove);
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setBlocked(false);
  }, [handlePointerMove]);

  // размонтирование посреди реконнекта — снять слушатель и сбросить тост
  useEffect(() => stopTracking, [stopTracking]);

  const handleReconnectStart = useCallback((_: MouseEvent, edge: RFEdge) => {
    reconnectingEdge.current = edge;
    reconnectSucceeded.current = false;
    document.addEventListener("pointermove", handlePointerMove);
  }, [handlePointerMove]);

  const handleReconnect = useCallback(
    (oldEdge: RFEdge, newConn: Connection) => {
      // Разрешаем только смену хэндла на том же узле
      if (newConn.source !== oldEdge.source || newConn.target !== oldEdge.target) return;
      reconnectSucceeded.current = true;
      // shouldReplaceId:false — сохраняем исходный id ребра (по нему идёт PATCH
      // и клик-обработчик); по умолчанию reconnectEdge сгенерил бы новый id
      setRfEdges((els) => reconnectEdge(oldEdge, newConn, els, { shouldReplaceId: false }));
      if (isArchitect && newConn.sourceHandle && newConn.targetHandle) {
        // Концы ребра делятся на локальные (узел этого уровня) и спроецированные на
        // гостя. На уровне максимум один конец гостевой (второй всегда локальный).
        // Хэндл локального конца — глобальный «домашний», в колонку самого ребра.
        // Хэндл гостевого конца привязан к уровню И к показанной сущности (свёрнутый
        // контейнер ИЛИ развёрнутый лист — это РАЗНЫЕ проекции одного конца), поэтому
        // хранится per-level по node_id отдельно — иначе проекции затирали бы друг
        // друга, а колонка затёрла бы «домашний» хэндл узла на его родном уровне.
        const localIds = new Set(nodes.map((n) => n.id));
        const sourceLocal = localIds.has(newConn.source!);
        const targetLocal = localIds.has(newConn.target!);

        const column: { source_handle?: string; target_handle?: string } = {};
        if (sourceLocal) column.source_handle = newConn.sourceHandle;
        if (targetLocal) column.target_handle = newConn.targetHandle;
        const hasColumn = Boolean(column.source_handle || column.target_handle);
        if (hasColumn) edgesApi.update(oldEdge.id, column);

        let ghost: { node_id: string; handle: string } | undefined;
        if (containerId) {
          if (!sourceLocal) ghost = { node_id: newConn.source!, handle: newConn.sourceHandle };
          else if (!targetLocal) ghost = { node_id: newConn.target!, handle: newConn.targetHandle };
          if (ghost) nodesApi.saveGhostEdgeHandle(containerId, oldEdge.id, ghost);
        }

        // Синхронизируем стейт уровня теми же значениями, что вернул бы рефетч —
        // иначе пересчёт раскладки (сворачивание/разворачивание без рефетча)
        // откатил бы привязку к autoHandles из устаревших данных.
        onEdgeHandlesChanged?.(oldEdge.id, {
          column: hasColumn ? column : undefined,
          ghost,
        });
      }
    },
    [isArchitect, nodes, containerId, onEdgeHandlesChanged, setRfEdges],
  );

  const handleReconnectEnd = useCallback(() => {
    // Если не успешно — ничего не делаем, ребро остаётся на месте
    stopTracking();
    reconnectingEdge.current = null;
    reconnectSucceeded.current = true;
  }, [stopTracking]);

  // Разрешаем реконнект только к хэндлам того же узла
  const isValidConnection = useCallback((conn: Connection | RFEdge) => {
    const orig = reconnectingEdge.current;
    if (!orig) return false;
    return conn.source === orig.source && conn.target === orig.target;
  }, []);

  // Идёт ли сейчас реконнект существующего ребра (а не протягивание новой связи) —
  // вызывающий разводит по этому флагу общий isValidConnection между двумя потоками.
  const isReconnecting = useCallback(() => reconnectingEdge.current != null, []);

  return {
    handleReconnectStart, handleReconnect, handleReconnectEnd,
    isValidConnection, isReconnecting,
    // курсор над не родным узлом во время реконнекта — для запрещающего курсора и тоста
    reconnectBlocked: blocked,
  };
}
