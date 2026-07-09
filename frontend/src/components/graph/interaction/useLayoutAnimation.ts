// Оркестратор анимации раскрытия/сворачивания контейнеров. Владеет ЕДИНСТВЕННОЙ
// точкой применения свежей раскладки к RF-стейту (apply вместо прямых
// setRfNodes/setRfEdges в эффекте-сборщике LevelGraph): без интента раскладка
// применяется как раньше (мгновенно), с интентом — режиссируется переход
// (планировщики layoutAnimation.ts + CSS-класс lg-canvas--anim на холсте).
//
// Жизненный цикл:
//  - noteExpand/noteCollapse(id) — пользователь нажал лупу/свернул рамку; интент
//    ждёт ПОДХОДЯЩЕГО прогона раскладки (дети локала грузятся async — первые
//    прогоны могут прийти ещё без рамки) и протухает по таймауту.
//  - apply(next):
//      expand  — первый кадр по плану (дети стопкой в точке спавна, рамки
//                скрыты, задетые стрелки hidden), через 2×rAF отпуск на финальные
//                позиции, по концу разъезда — проявление рамок и стрелок;
//      collapse — фаза 1 на ТЕКУЩЕМ снимке (потомки съезжаются в точку, рамка
//                гаснет, соседи едут), свежая раскладка стоит в pendingRef и
//                применяется целиком по концу фазы; прогоны, прилетевшие во
//                время фазы (зеркало viewLayout), откладываются туда же;
//      прочее  — применение как есть, но внутри окна анимации повторно
//                маскируются скрытые рамки/стрелки (прогон по замерам детей
//                приходит СРАЗУ после спавна и иначе разоблачал бы концовку).
//  - cancel() — драг/смена уровня: мгновенно доиграть (применить отложенное,
//    показать скрытое, снять класс), чтобы transition не цеплял жест.
//
// prefers-reduced-motion уважается: интент сбрасывается, применение мгновенное
// (плюс страховка в CSS — транзишены отключены медиа-запросом).
import { useCallback, useEffect, useRef, useState } from "react";
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import {
  planExpand, planCollapse, markDrawIn, clearDrawIn,
  ANIM_MOVE_MS, ANIM_FADE_MS, ANIM_DRAW_MS,
} from "./layoutAnimation";

// Интент старше — протух (например, раскрыли пустой контейнер и рамка так и
// не появилась): не держим маску вечно.
const INTENT_TTL_MS = 15_000;

type Intent = { kind: "expand" | "collapse"; id: string; ts: number };

interface UseLayoutAnimationArgs {
  getNodes: () => RFNode[];
  getEdges: () => RFEdge[];
  setRfNodes: (updater: RFNode[] | ((prev: RFNode[]) => RFNode[])) => void;
  setRfEdges: (updater: RFEdge[] | ((prev: RFEdge[]) => RFEdge[])) => void;
}

export interface LayoutAnimation {
  /** применить свежесобранную раскладку (единственная точка записи в RF-стейт) */
  apply: (nextNodes: RFNode[], nextEdges: RFEdge[]) => void;
  noteExpand: (id: string) => void;
  noteCollapse: (id: string) => void;
  /** мгновенно доиграть анимацию (старт драга: применить отложенное, показать скрытое) */
  cancel: () => void;
  /** жёсткий сброс БЕЗ доигровки (смена уровня: отложенное протухло, применит сборщик) */
  reset: () => void;
  /** окно анимации открыто — холсту нужен класс lg-canvas--anim */
  active: boolean;
}

const reducedMotion = (): boolean =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Снять маску opacity:0, не тронув прочие стили узла.
const unhideNode = (n: RFNode): RFNode => {
  if (!n.style || n.style.opacity !== 0) return n;
  const style = { ...n.style };
  delete style.opacity;
  return { ...n, style };
};

export function useLayoutAnimation({
  getNodes, getEdges, setRfNodes, setRfEdges,
}: UseLayoutAnimationArgs): LayoutAnimation {
  const [active, setActive] = useState(false);
  const intentRef = useRef<Intent | null>(null);
  // маски открытого окна анимации: что прятать в прогонах-посредниках
  const maskRef = useRef<{ frames: Set<string>; edges: Set<string> } | null>(null);
  // рёбра в фазе ОТРИСОВКИ (drawIn): помечать заново в прогонах-посредниках,
  // пока таймер не снимет флаг (иначе прогон по замерам разоблачал бы концовку)
  const drawRef = useRef<Set<string> | null>(null);
  // отложенная раскладка на время фазы 1 сворачивания
  const pendingRef = useRef<{ nodes: RFNode[]; edges: RFEdge[] } | null>(null);
  const timersRef = useRef<number[]>([]);
  const rafsRef = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    for (const t of timersRef.current) window.clearTimeout(t);
    for (const r of rafsRef.current) window.cancelAnimationFrame(r);
    timersRef.current = [];
    rafsRef.current = [];
  }, []);
  const later = useCallback((ms: number, fn: () => void) => {
    timersRef.current.push(window.setTimeout(fn, ms));
  }, []);

  // Конец фазы отрисовки стрелок: снять drawIn (проявить плашки и наконечники).
  const endDraw = useCallback(() => {
    drawRef.current = null;
    setRfEdges((prev) => clearDrawIn(prev));
  }, [setRfEdges]);

  // Показать всё замаскированное (конец разъезда раскрытия). withDraw — рёбра
  // показать через анимированную ОТРИСОВКУ (drawIn на ANIM_DRAW_MS), иначе сразу.
  const unmask = useCallback((withDraw: boolean) => {
    const mask = maskRef.current;
    if (!mask) return;
    maskRef.current = null;
    if (mask.frames.size > 0) {
      setRfNodes((prev) => prev.map((n) => (mask.frames.has(n.id) ? unhideNode(n) : n)));
    }
    if (mask.edges.size > 0) {
      if (withDraw) {
        drawRef.current = mask.edges;
        setRfEdges((prev) => markDrawIn(prev, mask.edges));
        later(ANIM_DRAW_MS, endDraw);
      } else {
        setRfEdges((prev) => prev.map((e) => (mask.edges.has(e.id) && e.hidden ? { ...e, hidden: false } : e)));
      }
    }
  }, [setRfNodes, setRfEdges, later, endDraw]);

  const cancel = useCallback(() => {
    clearTimers();
    intentRef.current = null;
    drawRef.current = null;
    const pending = pendingRef.current;
    pendingRef.current = null;
    setActive(false); // класс долой ДО применения — без transition на доигровке
    if (pending) {
      maskRef.current = null;
      setRfNodes(pending.nodes);
      setRfEdges(pending.edges);
    } else {
      unmask(false); // мгновенно, без отрисовки — драгу нужна честная сцена сразу
      setRfEdges((prev) => clearDrawIn(prev)); // и доиграть возможную фазу отрисовки
    }
  }, [clearTimers, unmask, setRfNodes, setRfEdges]);

  const reset = useCallback(() => {
    clearTimers();
    intentRef.current = null;
    maskRef.current = null;
    drawRef.current = null;
    pendingRef.current = null;
    setActive(false);
  }, [clearTimers]);

  // На размонтирование — только погасить таймеры (стейт трогать уже нельзя).
  useEffect(() => clearTimers, [clearTimers]);

  const apply = useCallback((nextNodes: RFNode[], nextEdges: RFEdge[]) => {
    // фаза 1 сворачивания в полёте: свежие прогоны откладываем до её конца
    if (pendingRef.current) {
      pendingRef.current = { nodes: nextNodes, edges: nextEdges };
      return;
    }

    const intent = intentRef.current;
    const fresh = intent && Date.now() - intent.ts < INTENT_TTL_MS;
    if (intent && !fresh) intentRef.current = null;

    if (fresh && !reducedMotion()) {
      if (intent.kind === "expand") {
        const plan = planExpand(getNodes(), getEdges(), nextNodes, nextEdges, intent.id);
        if (plan) {
          intentRef.current = null;
          clearTimers();
          maskRef.current = { frames: plan.hiddenFrameIds, edges: plan.hiddenEdgeIds };
          setActive(true);
          setRfNodes(plan.initialNodes);
          setRfEdges(nextEdges.map((e) => (plan.hiddenEdgeIds.has(e.id) ? { ...e, hidden: true } : e)));
          // отпуск на финальные позиции — после фиксации первого кадра в DOM
          rafsRef.current.push(window.requestAnimationFrame(() => {
            rafsRef.current.push(window.requestAnimationFrame(() => {
              setRfNodes((prev) => prev.map((n) => {
                const p = plan.finalPositions.get(n.id);
                return p ? { ...n, position: p } : n;
              }));
            }));
          }));
          // конец разъезда: рамки проявляются fade'ом (класс ещё жив), стрелки
          // РИСУЮТСЯ от исходного хэндла к целевому (drawIn на ANIM_DRAW_MS)
          later(ANIM_MOVE_MS, () => unmask(true));
          later(ANIM_MOVE_MS + ANIM_FADE_MS + 60, () => setActive(false));
          return;
        }
        // рамки в этом прогоне ещё нет (дети локала грузятся) — интент ждёт
      } else {
        const plan = planCollapse(getNodes(), getEdges(), nextNodes, intent.id);
        if (plan) {
          intentRef.current = null;
          clearTimers();
          // снимок id рёбер ДО фазы 1: на свопе новые пучки (свёрнутого узла)
          // определяются против него и рисуются анимированно
          const prevEdgeIds = new Set(getEdges().map((e) => e.id));
          pendingRef.current = { nodes: nextNodes, edges: nextEdges };
          setActive(true);
          setRfNodes(plan.phase1Nodes);
          setRfEdges((prev) => prev.map((e) => (plan.hiddenEdgeIds.has(e.id) ? { ...e, hidden: true } : e)));
          later(ANIM_MOVE_MS, () => {
            // подмена стопки свёрнутым узлом: применяем САМУЮ СВЕЖУЮ раскладку;
            // рёбра, скрытые на фазу 1 или появившиеся заново, — с отрисовкой
            const fin = pendingRef.current;
            pendingRef.current = null;
            if (fin) {
              setRfNodes(fin.nodes);
              const drawIds = new Set(
                fin.edges
                  .filter((e) => plan.hiddenEdgeIds.has(e.id) || !prevEdgeIds.has(e.id))
                  .map((e) => e.id),
              );
              if (drawIds.size > 0) {
                drawRef.current = drawIds;
                setRfEdges(markDrawIn(fin.edges, drawIds));
                later(ANIM_DRAW_MS, endDraw);
              } else {
                setRfEdges(fin.edges);
              }
            }
            later(60, () => setActive(false));
          });
          return;
        }
        // прогон не в той фазе: рамки уже нет и узла ещё нет — применяем как есть,
        // интент ждёт прогона с узлом; если узел уже на месте (проскочили) —
        // planCollapse вернул бы план, сюда не попадаем
      }
    } else if (fresh && reducedMotion()) {
      intentRef.current = null;
    }

    // применение без режиссуры; внутри окна анимации — с повторной маской
    // (скрытые рамки/рёбра) и повторным drawIn (фаза отрисовки ещё идёт)
    const mask = maskRef.current;
    const draw = drawRef.current;
    setRfNodes(
      mask && mask.frames.size > 0
        ? nextNodes.map((n) => (mask.frames.has(n.id) ? { ...n, style: { ...n.style, opacity: 0 } } : n))
        : nextNodes,
    );
    let edgesOut = nextEdges;
    if (mask && mask.edges.size > 0) {
      edgesOut = edgesOut.map((e) => (mask.edges.has(e.id) ? { ...e, hidden: true } : e));
    }
    if (draw && draw.size > 0) edgesOut = markDrawIn(edgesOut, draw);
    setRfEdges(edgesOut);
  }, [getNodes, getEdges, setRfNodes, setRfEdges, clearTimers, later, unmask, endDraw]);

  const noteExpand = useCallback((id: string) => {
    intentRef.current = { kind: "expand", id, ts: Date.now() };
  }, []);
  const noteCollapse = useCallback((id: string) => {
    intentRef.current = { kind: "collapse", id, ts: Date.now() };
  }, []);

  return { apply, noteExpand, noteCollapse, cancel, reset, active };
}
