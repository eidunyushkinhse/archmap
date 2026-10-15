// Жизненный цикл драга узлов и рамки выделения на холсте уровня: старт, ход, отпускание.
// Вынесено из LevelGraph (аудит F-1). Сами расчёты живут у соавторов — магнит и персист
// позиции (useSnapAlignment), живое превью стрелок (useLiveDragHandles), живой bbox рамок
// (useFrameFollowOverlay); здесь — порядок их вызова вокруг жеста и признак «идёт драг».
import { useCallback, useEffect, useRef, useState } from "react";
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import type { History } from "./useHistory";
import type { useLiveDragHandles } from "./useLiveDragHandles";
import type { useFrameFollowOverlay } from "./useFrameFollowOverlay";
import type { useSnapAlignment } from "./useSnapAlignment";
import { emitTourEvent } from "../../tour/tourBus";

type Snap = ReturnType<typeof useSnapAlignment>;

export function useLevelDragLifecycle({
  rfNodes, rfEdges, history, liveDragHandles, frameFollow, noteDragStart,
  handleNodeDragStop, handleSelectionDragStop, cancelAnim, noteGesture,
  gestureActiveRef, dragScopeRef,
}: {
  rfNodes: RFNode[];
  rfEdges: RFEdge[];
  history: History;
  liveDragHandles: ReturnType<typeof useLiveDragHandles>;
  frameFollow: ReturnType<typeof useFrameFollowOverlay>;
  noteDragStart: Snap["noteDragStart"];
  handleNodeDragStop: Snap["handleNodeDragStop"];
  handleSelectionDragStop: Snap["handleSelectionDragStop"];
  // Анимация раскрытия: transition не должен цеплять жест — мгновенно доиграть.
  cancelAnim: () => void;
  // Отпускание — ручной жест: изменённые пересчётом стрелки перерисовать анимированно.
  noteGesture: () => void;
  // Флаг поллинга этапа 1: рефетч не врывается в жест.
  gestureActiveRef?: { current: boolean };
  // Скоуп следующего пересчёта — перетащенные узлы (E82/E84, читает конвейер).
  dragScopeRef: { current: string[] | null };
}) {
  // Идёт ли драг узлов/рамки выделения. На время драга замораживаем реестр «мостиков»
  // (paused у EdgeJumpProvider): иначе его пересчёт каждый кадр перерисовывал бы ВСЕ
  // рёбра по два прохода — лаги и краш на хаотичном мультидраге многих узлов. Старт —
  // на onNodeDragStart/onSelectionDragStart, сброс — в обёртках над стоп-обработчиками.
  const [dragging, setDragging] = useState(false);
  // Зеркало для СИНХРОННОГО чтения вне рендера (таймер фоновой уборки P14): стейт
  // виден только следующему рендеру, а таймеру нужен факт «драг в полёте» сейчас.
  const draggingRef = useRef(false);
  useEffect(() => { draggingRef.current = dragging; });

  const handleNodeDragStart = useCallback(
    (_e: unknown, n: RFNode, ns: RFNode[]) => {
      setDragging(true);
      if (gestureActiveRef) gestureActiveRef.current = true; // поллинг этапа 1: рефетч не врывается в жест
      cancelAnim(); // transition раскрытия не должен цеплять жест — мгновенно доиграть
      const grp = ns.length > 0 ? ns : [n];
      liveDragHandles.begin(rfNodes, rfEdges); // база позиций узлов + снимок маршрутов на старте
      noteDragStart(grp); // фиксируем «старые» позиции для инверсии перемещения
      frameFollow.snapshotPads(); // паддинги рамок для живого bbox-follow
      frameFollow.begin(grp); // скрыть рамки-предки, включить живой оверлей
    },
    [liveDragHandles, rfNodes, rfEdges, noteDragStart, frameFollow, cancelAnim, gestureActiveRef],
  );
  const handleSelectionDragStart = useCallback(
    (_e: unknown, ns: RFNode[]) => {
      setDragging(true);
      if (gestureActiveRef) gestureActiveRef.current = true;
      cancelAnim();
      liveDragHandles.begin(rfNodes, rfEdges);
      noteDragStart(ns);
      frameFollow.snapshotPads();
      frameFollow.begin(ns);
    },
    [liveDragHandles, rfNodes, rfEdges, noteDragStart, frameFollow, cancelAnim, gestureActiveRef],
  );
  const handleNodeDrag = useCallback(
    (_e: unknown, _n: RFNode, ns: RFNode[]) => { liveDragHandles.move(ns); frameFollow.follow(ns); },
    [liveDragHandles, frameFollow],
  );
  const handleSelectionDrag = useCallback(
    (_e: unknown, ns: RFNode[]) => { liveDragHandles.move(ns); frameFollow.follow(ns); },
    [liveDragHandles, frameFollow],
  );
  // Отпускание драга: persistGroup сам кладёт ОДНУ команду на весь жест;
  // beginGroup/commitGroup вокруг — страховка, чтобы сопутствующие push-и
  // (если появятся) не разбили жест на несколько шагов Undo.
  const handleNodeDragStopP = useCallback(
    (e: unknown, n: RFNode, ns: RFNode[]) => {
      setDragging(false);
      frameFollow.finalize(); // рамки: финальный bbox одним setState + вернуть видимость
      noteGesture(); // изменённые пересчётом стрелки перерисовать анимированно
      history.beginGroup();
      try {
        // персист первым: нужен факт записи — жест без неё (нетто-сдвига нет)
        // не сменит viewLayout и не запустит пересчёт, поэтому живое превью
        // рёбер откатывается к состоянию старта (иначе висело бы насовсем)
        const committed = handleNodeDragStop(e, n, ns);
        if (!committed) liveDragHandles.restore();
        else {
          dragScopeRef.current = [n.id]; // пересчёт заскоуплен на перетащенный узел
          emitTourEvent({ type: "node-drag-end", ids: [n.id] }); // ждёт обучающий тур демо
        }
      } finally {
        liveDragHandles.end();
        history.commitGroup("Перемещение группы");
        if (gestureActiveRef) gestureActiveRef.current = false;
      }
    },
    [liveDragHandles, handleNodeDragStop, history, frameFollow, noteGesture, gestureActiveRef, dragScopeRef],
  );
  const handleSelectionDragStopP = useCallback(
    (e: unknown, ns: RFNode[]) => {
      setDragging(false);
      frameFollow.finalize();
      noteGesture();
      history.beginGroup();
      try {
        const committed = handleSelectionDragStop(e, ns);
        if (!committed) liveDragHandles.restore();
        else {
          dragScopeRef.current = ns.map((x) => x.id); // скоуп на всю перетащенную группу
          emitTourEvent({ type: "node-drag-end", ids: ns.map((x) => x.id) }); // ждёт обучающий тур демо
        }
      } finally {
        liveDragHandles.end();
        history.commitGroup("Перемещение группы");
        if (gestureActiveRef) gestureActiveRef.current = false;
      }
    },
    [liveDragHandles, handleSelectionDragStop, history, frameFollow, noteGesture, gestureActiveRef, dragScopeRef],
  );

  return {
    dragging, draggingRef,
    handleNodeDragStart, handleSelectionDragStart, handleNodeDrag, handleSelectionDrag,
    handleNodeDragStopP, handleSelectionDragStopP,
  };
}
