// УСТОЙЧИВАЯ подсветка связанного по двойному клику (П5/П6): что открыто в правой панели,
// то и подсвечено, пока открыто. Узел → он сам + инцидентные отрисованные стрелки; связь
// → её отрисованное ребро (панель держит ЧЛЕНА пучка — ищем несущее ребро) + оба его узла.
// Как и locate — императивно по data-id (не ввязываем пересборку rfNodes из async-раскладки);
// отличие: держим до смены выделения (класс снимаем в cleanup, а не по таймеру). Зависимость
// от rfNodes/rfEdges — переналожение после пере-раскладки/ремаунта холста.
//
// Подсвеченные рёбра поднимаем НАД прочими рёбрами перестановкой их <svg> в конец
// контейнера .react-flow__edges (стекинг по DOM-порядку; z-index бесполезен и опасен:
// рёбра делят stacking-контекст с узлами). Возврат на место — в cleanup.
//
// Вынесено из LevelGraph.tsx (Фаза 3б) без изменения поведения: эффект самодостаточен,
// наружу ничего не возвращает. onClearSelection (сброс по двойному клику на пустом холсте)
// остаётся в cbRef владельца — это триггер выделения, а не его подсветка.
import { useEffect } from "react";
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import type { WrappedEdgeData } from "../types";

// Что открыто в правой панели — цель устойчивой подсветки. Гость сводится к kind:"node".
export type LinkedHighlight = { kind: "node" | "edge"; id: string };

interface UseLevelSelectionArgs {
  linkedHighlight?: LinkedHighlight | null;
  rfNodes: RFNode[];
  rfEdges: RFEdge[];
}

export function useLevelSelection({
  linkedHighlight,
  rfNodes,
  rfEdges,
}: UseLevelSelectionArgs): void {
  useEffect(() => {
    if (!linkedHighlight) return;
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    if (linkedHighlight.kind === "node") {
      nodeIds.add(linkedHighlight.id);
      for (const e of rfEdges) {
        if (e.source === linkedHighlight.id || e.target === linkedHighlight.id) edgeIds.add(e.id);
      }
    } else {
      const re = rfEdges.find((e) => {
        const mids = (e.data as WrappedEdgeData | undefined)?.memberIds;
        return mids ? mids.includes(linkedHighlight.id) : e.id === linkedHighlight.id;
      });
      if (re) {
        edgeIds.add(re.id);
        if (re.source) nodeIds.add(re.source);
        if (re.target) nodeIds.add(re.target);
      }
    }
    if (nodeIds.size === 0 && edgeIds.size === 0) return;
    let applied: Element[] = [];
    // Подсвеченные рёбра поднимаем НАД прочими рёбрами перестановкой их <svg> в конец
    // контейнера .react-flow__edges: RF рисует каждое ребро отдельным <svg>, стекинг между
    // ними — по DOM-порядку (z-index бесполезен и опасен: рёбра делят stacking-контекст с
    // узлами и положительный z накрыл бы узлы). Так дуги-мостики подсвеченного ребра идут
    // ПОВЕРХ пересекаемых серых стрелок, но ребро остаётся под узлами (узлы — в своём div
    // после контейнера рёбер). Возврат на место — по восстановлению исходного соседа.
    let restore: Array<{ svg: Element; parent: Node; before: Node | null }> = [];
    const raf = requestAnimationFrame(() => {
      for (const id of nodeIds) {
        const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
        if (el) { el.classList.add("lg-linked-node"); applied.push(el); }
      }
      for (const id of edgeIds) {
        // Плашка подписи живёт в другом контейнере (edgelabel-renderer) — поднимаем её
        // над соседними плашками классом (z внутри stacking context renderer'а; жалоба
        // «плашки друг на друге — выбранную не прочитать»). Адрес — data-lg-edge (edges.tsx).
        const lb = document.querySelector(`.react-flow__edgelabel-renderer [data-lg-edge="${CSS.escape(id)}"]`);
        if (lb) { lb.classList.add("lg-linked-label"); applied.push(lb); }
        const el = document.querySelector(`.react-flow__edge[data-id="${CSS.escape(id)}"]`);
        if (!el) continue;
        el.classList.add("lg-linked-edge");
        applied.push(el);
        const svg = el.closest("svg");
        const parent = svg?.parentElement;
        if (svg && parent && parent.classList.contains("react-flow__edges") && svg !== parent.lastElementChild) {
          restore.push({ svg, parent, before: svg.nextSibling });
          parent.appendChild(svg); // в конец → рисуется поверх прочих рёбер
        }
      }
    });
    return () => {
      cancelAnimationFrame(raf);
      for (const el of applied) el.classList.remove("lg-linked-node", "lg-linked-edge", "lg-linked-label");
      // Возврат <svg> ребра на исходную позицию (best-effort: только если узлы ещё в DOM
      // на прежних местах — иначе RF уже перерисовал список и сам восстановил порядок).
      for (const r of restore) {
        if (r.svg.parentElement !== r.parent) continue;
        if (r.before && r.before.parentNode === r.parent) r.parent.insertBefore(r.svg, r.before);
        else if (!r.before) r.parent.appendChild(r.svg);
      }
      applied = [];
      restore = [];
    };
    // rfNodes — зависимость-триггер (тело его не читает): переналожение подсветки
    // после пере-раскладки/ремаунта холста.
  }, [linkedHighlight, rfNodes, rfEdges]);
}
