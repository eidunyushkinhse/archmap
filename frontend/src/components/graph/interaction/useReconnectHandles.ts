// Реконнект концов рёбер: смена хэндла на том же узле + персист хэндлов.
import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
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

  const handleReconnectStart = useCallback((_: MouseEvent, edge: RFEdge) => {
    reconnectingEdge.current = edge;
    reconnectSucceeded.current = false;
  }, []);

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
    reconnectingEdge.current = null;
    reconnectSucceeded.current = true;
  }, []);

  // Разрешаем реконнект только к хэндлам того же узла
  const isValidConnection = useCallback((conn: Connection | RFEdge) => {
    const orig = reconnectingEdge.current;
    if (!orig) return false;
    return conn.source === orig.source && conn.target === orig.target;
  }, []);

  // Идёт ли сейчас реконнект существующего ребра (а не протягивание новой связи) —
  // вызывающий разводит по этому флагу общий isValidConnection между двумя потоками.
  const isReconnecting = useCallback(() => reconnectingEdge.current != null, []);

  return { handleReconnectStart, handleReconnect, handleReconnectEnd, isValidConnection, isReconnecting };
}
