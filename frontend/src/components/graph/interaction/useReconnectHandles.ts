// Реконнект концов рёбер: смена хэндла на том же узле + персист хэндлов.
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { MouseEvent } from "react";
import { reconnectEdge, type Edge as RFEdge, type Connection } from "@xyflow/react";
import { bundleKey, type EdgePoint, type ViewLayoutPayload } from "../../../types";
import type { WrappedEdgeData } from "../types";
import type { History } from "./useHistory";

interface Params {
  setRfEdges: Dispatch<SetStateAction<RFEdge[]>>;
  isArchitect: boolean;
  // Единая запись раскладки вида (R3): хэндлы (и сбрасываемые при их смене изломы)
  // живут на ключе ПУЧКА "b:<src>><tgt>" — общие для членов мастер-стрелки по
  // построению, у каждой проекции свои. Персист+зеркало — LevelGraph.commitLayout.
  commitLayout: (items: Record<string, Partial<ViewLayoutPayload> | null>) => void;
  // запись смены хэндла в историю Undo/Redo (составная инверсия: хэндлы + изломы)
  push?: History["push"];
}

// Сколько конец связи должен «зависнуть» над зоной входа своего узла-родителя, прежде
// чем счесть это явной попыткой провалить конец в дочерний объект (и показать тост).
// Проезд над узлом к дальнему хэндлу короче этого — ложного срабатывания не будет.
const CHILD_DRILL_DWELL_MS = 2000;

export function useReconnectHandles({
  setRfEdges, isArchitect, commitLayout, push,
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

  // Отдельный запрет: конец завис над зоной входа СВОЕГО узла-родителя (data-into) —
  // явная попытка провалить его в дочерний объект. В отличие от «чужого узла» (живой
  // тост сразу), наведение на свой узел легитимно (можно идти к дальнему хэндлу),
  // поэтому требуем зависания CHILD_DRILL_DWELL_MS на одном и том же узле. Движение
  // ВНУТРИ того же узла таймер не перезапускает — считаем «зависание над узлом».
  const [childDrill, setChildDrill] = useState(false);
  const dwellNodeRef = useRef<string | null>(null); // id узла, над которым сейчас зависаем
  const dwellTimerRef = useRef<number | null>(null);

  const cancelDwell = useCallback(() => {
    if (dwellTimerRef.current != null) {
      clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
    }
    dwellNodeRef.current = null;
    setChildDrill(false);
  }, []);

  const updateBlocked = useCallback((x: number, y: number) => {
    const edge = reconnectingEdge.current;
    if (!edge) { setBlocked(false); cancelDwell(); return; }
    const el = document.elementFromPoint(x, y);
    const nodeEl = el?.closest<HTMLElement>(".react-flow__node");
    const id = nodeEl?.getAttribute("data-id");
    const own = !!id && (id === edge.source || id === edge.target);
    // не родной узел = под курсором узел, не являющийся ни источником, ни целью ребра
    setBlocked(!!id && !own);

    // Кандидат на «проваливание»: свой узел-родитель в зоне входа (data-into="1" — атрибут
    // на ВНУТРЕННЕМ div BlockNode, не на обёртке .react-flow__node, поэтому ищем closest),
    // курсор НЕ на хэндле (хэндл — легитимная смена точки стыковки, а не проваливание).
    const onHandle = !!el?.closest(".react-flow__handle");
    const inIntoZone = !!el?.closest('[data-into="1"]');
    const candidate = own && !onHandle && inIntoZone ? id! : null;
    if (candidate !== dwellNodeRef.current) {
      // цель зависания сменилась (вошли/вышли/перескочили) — сброс и перезапуск таймера
      cancelDwell();
      dwellNodeRef.current = candidate;
      if (candidate) {
        dwellTimerRef.current = window.setTimeout(() => {
          dwellTimerRef.current = null;
          setChildDrill(true);
        }, CHILD_DRILL_DWELL_MS);
      }
    }
  }, [cancelDwell]);

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
    cancelDwell();
  }, [handlePointerMove, cancelDwell]);

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
        // R3: хэндлы живут на ключе ПУЧКА (пара отображаемых концов = source/target
        // RF-ребра) в view_layout вида. Ключ кодирует проекцию (у свёрнутого
        // контейнера и раскрытого листа — разные пары → разные строки), а члены
        // мастер-стрелки делят одну строку по построению — fan-out больше не нужен.
        const bundleId = bundleKey(newConn.source!, newConn.target!);
        const newPatch: Partial<ViewLayoutPayload> = {
          source_handle: newConn.sourceHandle,
          target_handle: newConn.targetHandle,
        };
        // Сброс изломов в дефолт ТОЛЬКО при реальной смене хэндла (путь стал кривым
        // относительно новых концов). Повторный дроп на тот же хэндл путь не трогает.
        const newFull: Partial<ViewLayoutPayload> = handleChanged
          ? { ...newPatch, waypoints: null, anchor: null }
          : newPatch;
        commitLayout({ [bundleId]: newFull });

        // История: смена хэндла — одна команда с СОСТАВНОЙ инверсией (вернуть и прежние
        // хэндлы, и сброшенный путь oldEdge.data.waypoints). Без смены хэндла — не пишем.
        if (push && handleChanged) {
          const oldWp = (oldEdge.data as WrappedEdgeData | undefined)?.waypoints ?? [];
          const oldPatch: Partial<ViewLayoutPayload> = {
            source_handle: oldEdge.sourceHandle ?? null,
            target_handle: oldEdge.targetHandle ?? null,
            waypoints: oldWp.length > 0 ? (oldWp as EdgePoint[]) : null,
            anchor: null,
          };
          push({
            label: "Смена точки стыковки связи",
            undo: () => commitLayout({ [bundleId]: oldPatch }),
            redo: () => commitLayout({ [bundleId]: newFull }),
          });
        }
      }
    },
    [isArchitect, commitLayout, push, setRfEdges],
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
    // конец завис над зоной входа своего узла-родителя (попытка провалить в ребёнка) — тост
    reconnectChildDrill: childDrill,
    // гасит клик-эхо по ребру сразу после жеста реконнекта (иначе всплывал бы поповер)
    consumeReconnectClick,
  };
}
