// «Показать на схеме» (locate): центрируем холст на цели и коротко её подсвечиваем.
// Запрос приходит из индикатора незавершённости (SchemaAlerts → MapEditorPage → проп
// locate). Раскладка асинхронна, а при кросс-уровневом переходе холст ещё и ремаунтится —
// поэтому эффект зависит от rfNodes/rfEdges и срабатывает ОТЛОЖЕННО: ждёт, пока цель
// появится на холсте, после чего по token фиксирует обработку (повторно не дёргает).
//
// Поведение: одиночный узел → setCenter (zoom 1.2, крупнее обычного fitView — привлечь
// внимание); связь/группа → fitBounds по bbox целей. Связь ищем по id И по членству в
// пучке (мастер-стрелка merge:* несёт сырые id в memberIds); связь, скрытую проекцией
// (конец = раскрытый контейнер, E6/C19), фокусируем по КОНЦАМ — их представители на
// холсте: узел либо рамка (id рамки = id узла, C3). Подсветка — императивно по data-id
// на DOM-элементах xyflow (не ввязываем пересборку rfNodes из async-раскладки), класс
// lg-locate-flash снимаем по таймеру.
//
// Вынесено из LevelGraph.tsx (Фаза 3б) без изменения поведения: эффект самодостаточен,
// наружу ничего не возвращает. RF-API (getInternalNode/setCenter/fitBounds) передаётся
// параметрами — владелец (LevelGraphInner) берёт их из useReactFlow.
import { useEffect, useRef } from "react";
import type {
  Node as RFNode,
  Edge as RFEdge,
  ReactFlowInstance,
  ViewportHelperFunctions,
} from "@xyflow/react";
import { NODE_W, NODE_H } from "../constants";
import type { LocateRequest } from "../types";

interface UseLevelLocateArgs {
  locate?: LocateRequest | null;
  rfNodes: RFNode[];
  rfEdges: RFEdge[];
  getInternalNode: ReactFlowInstance["getInternalNode"];
  setCenter: ViewportHelperFunctions["setCenter"];
  fitBounds: ViewportHelperFunctions["fitBounds"];
}

export function useLevelLocate({
  locate,
  rfNodes,
  rfEdges,
  getInternalNode,
  setCenter,
  fitBounds,
}: UseLevelLocateArgs): void {
  // Дедуп по token: повторный тот же запрос (та же цель, тот же token) не центрирует
  // дважды при пере-раскладке. MapEditorPage инкрементит token на каждый клик.
  const locateHandledRef = useRef(0);
  useEffect(() => {
    if (!locate || locate.token === locateHandledRef.current) return;

    // Абсолютный прямоугольник узла по id (позиция графа + измеренный размер).
    const rectOf = (id: string): { x: number; y: number; w: number; h: number } | null => {
      const n = rfNodes.find((x) => x.id === id);
      if (!n) return null;
      const internal = getInternalNode(id);
      const pos = internal?.internals.positionAbsolute ?? n.position;
      const w = internal?.measured?.width ?? (typeof n.width === "number" ? n.width : NODE_W);
      const h = internal?.measured?.height ?? (typeof n.height === "number" ? n.height : NODE_H);
      return { x: pos.x, y: pos.y, w, h };
    };

    // Собираем прямоугольники цели и селекторы подсветки. Связь ищем по id И по
    // членству в пучке (мастер-стрелка merge:* несёт сырые id в memberIds); связь,
    // скрытую проекцией (конец = раскрытый контейнер, E6/C19), фокусируем по
    // КОНЦАМ — их представители на холсте: узел либо рамка (id рамки = id узла, C3).
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    let flashSelectors: string[];
    if (locate.kind === "edge") {
      const rawId = locate.ids[0];
      const e = rfEdges.find(
        (x) =>
          x.id === rawId ||
          ((x.data as { memberIds?: string[] } | undefined)?.memberIds ?? []).includes(rawId),
      );
      if (e) {
        for (const id of [e.source, e.target]) {
          const r = rectOf(id);
          if (r) rects.push(r);
        }
        flashSelectors = [`.react-flow__edge[data-id="${CSS.escape(e.id)}"]`];
      } else {
        const foundEnds = (locate.endIds ?? []).filter((id) => rfNodes.some((n) => n.id === id));
        for (const id of foundEnds) {
          const r = rectOf(id);
          if (r) rects.push(r);
        }
        // ни ребра, ни представителей концов — ещё не собрано, ждём следующего прогона
        if (rects.length === 0) return;
        flashSelectors = foundEnds.map((id) => `.react-flow__node[data-id="${CSS.escape(id)}"]`);
      }
    } else {
      for (const id of locate.ids) {
        const r = rectOf(id);
        if (r) rects.push(r);
      }
      flashSelectors = locate.ids.map((id) => `.react-flow__node[data-id="${CSS.escape(id)}"]`);
    }
    if (rects.length === 0) return; // ни одной цели ещё нет на холсте — ждём раскладку

    locateHandledRef.current = locate.token;

    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.w));
    const maxY = Math.max(...rects.map((r) => r.y + r.h));
    if (rects.length === 1) {
      // одиночный узел — центрируем чуть крупнее обычного fitView (привлечь внимание)
      setCenter(minX + (maxX - minX) / 2, minY + (maxY - minY) / 2, { zoom: 1.2, duration: 600 });
    } else {
      // связь/группа — вписываем bbox целей с запасом
      fitBounds({ x: minX, y: minY, width: maxX - minX, height: maxY - minY }, { padding: 0.4, duration: 600 });
    }

    // Подсветка — прямо на DOM-элементах xyflow (узлы и рёбра несут data-id), чтобы не
    // ввязывать пересборку rfNodes из async-раскладки. Класс снимаем по таймеру.
    const sel = flashSelectors.join(",");
    const raf = requestAnimationFrame(() => {
      const els = sel ? Array.from(document.querySelectorAll(sel)) : [];
      for (const el of els) el.classList.add("lg-locate-flash");
      window.setTimeout(() => {
        for (const el of els) el.classList.remove("lg-locate-flash");
      }, 2200);
    });
    return () => cancelAnimationFrame(raf);
  }, [locate, rfNodes, rfEdges, getInternalNode, setCenter, fitBounds]);
}
