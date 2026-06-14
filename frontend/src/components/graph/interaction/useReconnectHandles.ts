// Реконнект концов рёбер: смена хэндла на том же узле + персист хэндлов.
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { MouseEvent } from "react";
import { reconnectEdge, type Edge as RFEdge, type Connection } from "@xyflow/react";
import { nodesApi, edgesApi } from "../../../api/nodes";
import { guardPersist } from "./persistGuard";
import type { Node as AppNode, EdgePoint } from "../../../types";
import type { WrappedEdgeData } from "../types";
import type { History } from "./useHistory";

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
  // коммит изломов (оба слоя по флагу ghost). При смене хэндла дропаем путь в дефолт
  // (пустой массив) — он считался относительно прежних концов и после смены кривой;
  // он же используется в команде Undo для восстановления СТАРОГО пути.
  commitWaypoints: (edgeIds: string[], waypoints: EdgePoint[], ghost: boolean) => void;
  // запись смены хэндла в историю Undo/Redo (составная инверсия: хэндлы + изломы)
  push?: History["push"];
  // фоновый персист хэндлов упал — вернуть зеркало к истине (ресинк уровня из БД)
  onPersistError?: (e: unknown) => void;
}

export function useReconnectHandles({
  setRfEdges, nodes, isArchitect, containerId, onEdgeHandlesChanged, commitWaypoints, push, onPersistError,
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
      // Хэндл реально сменился (а не повторное отпускание на тот же) — только тогда
      // дропаем изломы: иначе случайный «дроп на то же место» затёр бы заданный путь.
      const handleChanged =
        newConn.sourceHandle !== oldEdge.sourceHandle ||
        newConn.targetHandle !== oldEdge.targetHandle;
      // shouldReplaceId:false — сохраняем исходный id ребра (по нему идёт PATCH
      // и клик-обработчик); по умолчанию reconnectEdge сгенерил бы новый id.
      // При смене хэндла тут же гасим waypoints на самом RF-ребре, чтобы до пересчёта
      // раскладки не мелькнул кривой путь (старые изломы относительно прежних концов).
      setRfEdges((els) => {
        const next = reconnectEdge(oldEdge, newConn, els, { shouldReplaceId: false });
        return handleChanged
          ? next.map((e) => (e.id === oldEdge.id ? { ...e, data: { ...e.data, waypoints: undefined } } : e))
          : next;
      });
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
        // Слой хранения изломов: оба конца локальны → колонка; иначе пер-уровневый слой.
        const ghostLayer = !(sourceLocal && targetLocal);
        // Мастер-стрелка — синтетическое ребро без строки в БД (id вида merge:src->target):
        // хэндл/путь общие для всех её членов (одна линия), поэтому «размазываем» по всем
        // memberIds. У одиночной стрелки memberId один. Узел-конец общий для всех членов,
        // значит node_id гостевого хэндла одинаков.
        const memberIds = (oldEdge.data as WrappedEdgeData | undefined)?.memberIds ?? [oldEdge.id];

        // Набор хэндлов конца(ов) ребра по конкретным точкам стыковки. Концы ребра делятся
        // на локальные (узел этого уровня → колонка самого ребра, «домашний» хэндл) и
        // спроецированные на гостя (per-level по node_id — иначе разные проекции затирали
        // бы друг друга, а колонка затёрла бы домашний хэндл на родном уровне). Узлы-концы
        // при реконнекте не меняются, меняется лишь точка стыковки.
        type HandleSet = {
          column?: { source_handle?: string; target_handle?: string };
          ghost?: { node_id: string; handle: string };
        };
        const handleSet = (srcH?: string | null, tgtH?: string | null): HandleSet => {
          const column: { source_handle?: string; target_handle?: string } = {};
          if (sourceLocal && srcH) column.source_handle = srcH;
          if (targetLocal && tgtH) column.target_handle = tgtH;
          let ghost: { node_id: string; handle: string } | undefined;
          if (containerId) {
            if (!sourceLocal && srcH) ghost = { node_id: newConn.source!, handle: srcH };
            else if (!targetLocal && tgtH) ghost = { node_id: newConn.target!, handle: tgtH };
          }
          return { column: column.source_handle || column.target_handle ? column : undefined, ghost };
        };
        // Персист набора хэндлов по всем членам (+ зеркало в стейт уровня тем же значением,
        // что вернул бы рефетч, иначе пересчёт раскладки откатит к autoHandles).
        const persistHandles = (h: HandleSet) => {
          for (const mid of memberIds) {
            if (h.column) guardPersist(edgesApi.update(mid, h.column), onPersistError);
            if (h.ghost && containerId) guardPersist(nodesApi.saveGhostEdgeHandle(containerId, mid, h.ghost), onPersistError);
            onEdgeHandlesChanged?.(mid, { column: h.column, ghost: h.ghost });
          }
        };
        // Составное применение «хэндлы + путь» — для команд Undo/Redo.
        const apply = (h: HandleSet, wp: EdgePoint[]) => {
          persistHandles(h);
          commitWaypoints(memberIds, wp, ghostLayer);
        };

        const newSet = handleSet(newConn.sourceHandle, newConn.targetHandle);
        persistHandles(newSet);
        // Сброс изломов в дефолт ТОЛЬКО при реальной смене хэндла (путь стал кривым
        // относительно новых концов). Повторный дроп на тот же хэндл путь не трогает.
        if (handleChanged) commitWaypoints(memberIds, [], ghostLayer);

        // История: смена хэндла — одна команда с СОСТАВНОЙ инверсией (вернуть и прежние
        // хэндлы, и сброшенный путь oldEdge.data.waypoints). Без смены хэндла — не пишем.
        if (push && handleChanged) {
          const oldSet = handleSet(oldEdge.sourceHandle, oldEdge.targetHandle);
          const oldWp = (oldEdge.data as WrappedEdgeData | undefined)?.waypoints ?? [];
          push({
            label: "Смена точки стыковки связи",
            undo: () => apply(oldSet, oldWp),
            redo: () => apply(newSet, []),
          });
        }
      }
    },
    [isArchitect, nodes, containerId, onEdgeHandlesChanged, commitWaypoints, push, setRfEdges, onPersistError],
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
