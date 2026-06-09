// Реконнект концов рёбер: смена хэндла на том же узле + персист хэндлов.
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { MouseEvent } from "react";
import { reconnectEdge, type Edge as RFEdge, type Connection } from "@xyflow/react";
import { nodesApi, edgesApi } from "../../../api/nodes";
import type { Node as AppNode } from "../../../types";
import type { WrappedEdgeData } from "../types";

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

  // После жеста реконнекта React Flow может выпустить click по ребру (особенно когда
  // конец отпущен в зоне активации хэндла, но ВНЕ тела узла — дроп не регистрируется
  // на узле, и pointerup трактуется как клик по ребру) → открывался бы поповер
  // информации о связи. Латчим завершение реконнекта и гасим этот клик-эхо.
  const justReconnectedRef = useRef(false);

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

        let ghost: { node_id: string; handle: string } | undefined;
        if (containerId) {
          if (!sourceLocal) ghost = { node_id: newConn.source!, handle: newConn.sourceHandle };
          else if (!targetLocal) ghost = { node_id: newConn.target!, handle: newConn.targetHandle };
        }

        // Мастер-стрелка — синтетическое ребро без строки в БД (id вида merge:src->target):
        // хэндл общий для всех её членов (одна линия), поэтому «размазываем» его по всем
        // memberIds. У одиночной стрелки memberId один. Узел-конец общий для всех членов,
        // значит node_id гостевого хэндла одинаков. Стейт уровня синхронизируем теми же
        // значениями, что вернул бы рефетч, иначе пересчёт раскладки откатит к autoHandles.
        const memberIds = (oldEdge.data as WrappedEdgeData | undefined)?.memberIds ?? [oldEdge.id];
        for (const mid of memberIds) {
          if (hasColumn) edgesApi.update(mid, column);
          if (ghost && containerId) nodesApi.saveGhostEdgeHandle(containerId, mid, ghost);
          onEdgeHandlesChanged?.(mid, { column: hasColumn ? column : undefined, ghost });
        }
      }
    },
    [isArchitect, nodes, containerId, onEdgeHandlesChanged, setRfEdges],
  );

  const handleReconnectEnd = useCallback(() => {
    // Если не успешно — ничего не делаем, ребро остаётся на месте
    stopTracking();
    reconnectingEdge.current = null;
    reconnectSucceeded.current = true;
    // Латчим: следующий клик по ребру — эхо этого жеста, его гасит handleEdgeClick.
    // Снимаем латч на ближайшем pointerdown: клик-эхо приходит БЕЗ нового pointerdown
    // (проглотится), а честный последующий клик начинается со своего pointerdown →
    // латч сброшен заранее, клик пройдёт. Без таймеров — нет гонки с порядком событий.
    justReconnectedRef.current = true;
    document.addEventListener(
      "pointerdown",
      () => { justReconnectedRef.current = false; },
      { once: true, capture: true },
    );
  }, [stopTracking]);

  // Клик по ребру — эхо только что завершённого реконнекта? (consume-once: гасит ровно
  // один клик-эхо, открытие поповера информации о связи при нём не происходит)
  const consumeReconnectClick = useCallback(() => {
    if (!justReconnectedRef.current) return false;
    justReconnectedRef.current = false;
    return true;
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

  return {
    handleReconnectStart, handleReconnect, handleReconnectEnd,
    isValidConnection, isReconnecting,
    // курсор над не родным узлом во время реконнекта — для запрещающего курсора и тоста
    reconnectBlocked: blocked,
    // гасит клик-эхо по ребру сразу после жеста реконнекта (иначе всплывал бы поповер)
    consumeReconnectClick,
  };
}
