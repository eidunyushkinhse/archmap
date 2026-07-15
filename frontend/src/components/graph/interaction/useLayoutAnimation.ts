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
//                позиции; конец разъезда — «мёртвая зона»: gate.flush() досчитывает
//                прогоны, отложенные тихим окном (Ф1), и по ПРИМЕНЕНИИ — проявление
//                рамок и отрисовка стрелок уже свежими маршрутами;
//      collapse — фаза 1 на ТЕКУЩЕМ снимке (потомки съезжаются в точку, рамка
//                гаснет, соседи едут); по концу фазы gate.flush() досчитывает
//                отложенное (свежая раскладка ложится в pendingRef через apply)
//                и своп применяет самое свежее целиком;
//      прочее  — применение как есть, но внутри окна анимации повторно
//                маскируются скрытые рамки/стрелки (флаш приходит в окно и
//                иначе разоблачал бы концовку).
//    На окно режиссуры прогоны конвейера ОТЛОЖЕНЫ (gate.hold — «тихое окно» Ф1),
//    а реестр мостиков на паузе (jumpsPaused) до unmask/свопа: счёт, тотальный
//    apply и двойной проход рендера рёбер не дёргают кадры разъезда.
//  - cancel() — драг/смена уровня: мгновенно доиграть (применить отложенное,
//    показать скрытое, снять класс), чтобы transition не цеплял жест.
//
// prefers-reduced-motion уважается: интент сбрасывается, применение мгновенное
// (плюс страховка в CSS — транзишены отключены медиа-запросом).
import { useCallback, useEffect, useRef, useState } from "react";
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import {
  planExpand, planCollapse, markDrawIn, clearDrawIn, changedEdgeIds,
  ANIM_MOVE_MS, ANIM_FADE_MS, drawSpanMs,
} from "./layoutAnimation";

// Интент старше — протух (например, раскрыли пустой контейнер и рамка так и
// не появилась): не держим маску вечно.
const INTENT_TTL_MS = 15_000;

// Окно жеста (noteGesture): раскладка, применённая в этом окне после ручного
// действия, перерисовывает ИЗМЕНЁННЫЕ стрелки анимированно. Флаг потребляется
// первым применением с изменениями; TTL — страховка, если пересчёта не было
// (позиция не изменилась → commitLayout задедупил → прогона нет).
const GESTURE_TTL_MS = 4_000;

type Intent = { kind: "expand" | "collapse"; id: string; ts: number };

// «Тихое окно» (Ф1 плавности): шлюз отложенного пересчёта раскладки. Владелец —
// LevelGraph (holdRef/dirtyRef/computeNow там); хук только дёргает фазы:
//  - hold()    — окно режиссуры открылось: прогоны конвейера НЕ считать, копить dirty;
//  - flush()   — «мёртвая зона» (узлы доехали, рёбра ещё скрыты): досчитать отложенное
//                и ДОЖДАТЬСЯ применения (резолв — после applyLayout этого прогона);
//  - release() — окно закрыто: hold снять; накопившееся досчитать в фоне (не ждём);
//  - reset()   — смена уровня: hold снять, накопленное выбросить (уровень пересчитает
//                собственный эффект по смене deps).
export interface LayoutGate {
  hold: () => void;
  flush: () => Promise<void>;
  release: () => void;
  reset: () => void;
}

interface UseLayoutAnimationArgs {
  getNodes: () => RFNode[];
  getEdges: () => RFEdge[];
  setRfNodes: (updater: RFNode[] | ((prev: RFNode[]) => RFNode[])) => void;
  setRfEdges: (updater: RFEdge[] | ((prev: RFEdge[]) => RFEdge[])) => void;
  gate: LayoutGate;
}

export interface LayoutAnimation {
  /** применить свежесобранную раскладку (единственная точка записи в RF-стейт) */
  apply: (nextNodes: RFNode[], nextEdges: RFEdge[]) => void;
  noteExpand: (id: string) => void;
  noteCollapse: (id: string) => void;
  /** ручной жест изменил раскладку (отпускание драга, undo/redo) — изменённые
      стрелки следующего пересчёта перерисовать анимированно (drawIn) */
  noteGesture: () => void;
  /** мгновенно доиграть анимацию (старт драга: применить отложенное, показать скрытое) */
  cancel: () => void;
  /** жёсткий сброс БЕЗ доигровки (смена уровня: отложенное протухло, применит сборщик) */
  reset: () => void;
  /** окно анимации открыто — холсту нужен класс lg-canvas--anim */
  active: boolean;
  /** пауза реестра «мостиков» на фазу move (снимается на unmask/свопе — реестр
      пересобирается одним батчем ДО первого кадра отрисовки стрелок) */
  jumpsPaused: boolean;
}

const reducedMotion = (): boolean =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Снять маску opacity:0, не тронув прочие стили узла. Опустевший style удаляется
// целиком (не остаётся {}): размаскированный узел структурно равен свежесобранному —
// без этого реконсиляция сборки (Ф2) считала бы его вечно изменённым.
const unhideNode = (n: RFNode): RFNode => {
  if (!n.style || n.style.opacity !== 0) return n;
  const style = { ...n.style };
  delete style.opacity;
  if (Object.keys(style).length === 0) {
    const rest = { ...n };
    delete rest.style;
    return rest;
  }
  return { ...n, style };
};

// Показать скрытое ребро БЕЗ отрисовки: ключ hidden удаляется (см. unhideNode —
// структурное равенство со свежей сборкой).
const unhideEdge = (e: RFEdge): RFEdge => {
  const rest = { ...e };
  delete rest.hidden;
  return rest;
};

export function useLayoutAnimation({
  getNodes, getEdges, setRfNodes, setRfEdges, gate,
}: UseLayoutAnimationArgs): LayoutAnimation {
  const [active, setActive] = useState(false);
  // Пауза реестра мостиков на фазу move: его пересчёт даёт второй проход рендера
  // ВСЕХ рёбер (смена версии контекста), а в окне анимации геометрия массово
  // меняется. true — вместе с планом (батчится с его setState), false — на
  // unmask/свопе (пересборка одним батчем до первого кадра drawIn).
  const [jumpsPaused, setJumpsPaused] = useState(false);
  const intentRef = useRef<Intent | null>(null);
  // момент последнего ручного жеста (0 — окна жеста нет)
  const gestureRef = useRef(0);
  // маски открытого окна анимации: что прятать в прогонах-посредниках
  const maskRef = useRef<{ frames: Set<string>; edges: Set<string> } | null>(null);
  // рёбра в фазе ОТРИСОВКИ (drawIn): помечать заново в прогонах-посредниках,
  // пока таймер не снимет флаг (иначе прогон по замерам разоблачал бы концовку)
  const drawRef = useRef<Set<string> | null>(null);
  // отложенная раскладка на время фазы 1 сворачивания
  const pendingRef = useRef<{ nodes: RFNode[]; edges: RFEdge[] } | null>(null);
  // Эпоха окна анимации: инкремент на каждый старт режиссуры и на cancel/reset.
  // Продолжения флаша (async, переживают clearTimers) гейтятся ею: устаревшее
  // продолжение не должно трогать УЖЕ отменённое или новое окно.
  const epochRef = useRef(0);
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
  // Отсчёт от ПЕРВОГО ПОКАЗАННОГО КАДРА, а не от setState (rAF → setTimeout): CSS-анимация
  // фазы стартует на кадре, следующем за коммитом, а тяжёлый пересчёт раскладки (прогон по
  // замерам приходит ровно в окно анимации) откладывает этот кадр. Wall-clock-таймер от
  // setState в таком случае съедал окно ДО видимого старта фазы: конец отрисовки стрелок
  // наступал раньше её первого кадра — «анимация пропадает, когда стрелок много».
  const laterFromFrame = useCallback((ms: number, fn: () => void) => {
    rafsRef.current.push(window.requestAnimationFrame(() => {
      timersRef.current.push(window.setTimeout(fn, ms));
    }));
  }, []);

  // Конец фазы отрисовки стрелок: снять drawIn (проявить плашки и наконечники).
  // Это конечная точка обеих режиссур — тихое окно закрывается здесь (release
  // досчитает накопленное в фоне; зовётся и после drawIn жеста — там hold не
  // открывался, и release без dirty — no-op).
  const endDraw = useCallback(() => {
    drawRef.current = null;
    setRfEdges((prev) => clearDrawIn(prev));
    gate.release();
  }, [setRfEdges, gate]);

  // Показать всё замаскированное (конец разъезда раскрытия). withDraw — рёбра
  // показать через анимированную ОТРИСОВКУ (drawIn на ANIM_DRAW_MS), иначе сразу.
  // Пауза реестра мостиков снимается здесь всегда (батч с проявлением); тихое окно
  // остаётся открытым, только если стартовала фаза отрисовки (закроет endDraw).
  const unmask = useCallback((withDraw: boolean) => {
    const mask = maskRef.current;
    if (!mask) return;
    maskRef.current = null;
    setJumpsPaused(false);
    if (mask.frames.size > 0) {
      setRfNodes((prev) => prev.map((n) => (mask.frames.has(n.id) ? unhideNode(n) : n)));
    }
    let drawStarted = false;
    if (mask.edges.size > 0) {
      if (withDraw) {
        drawRef.current = mask.edges;
        setRfEdges((prev) => markDrawIn(prev, mask.edges));
        // конец фазы — по ПОСЛЕДНЕЙ волне каскада (Ф5): спан растёт с числом рёбер
        laterFromFrame(drawSpanMs(mask.edges.size), endDraw);
        drawStarted = true;
      } else {
        setRfEdges((prev) => prev.map((e) => (mask.edges.has(e.id) && e.hidden ? unhideEdge(e) : e)));
      }
    }
    if (!drawStarted) gate.release();
  }, [setRfNodes, setRfEdges, laterFromFrame, endDraw, gate]);

  const cancel = useCallback(() => {
    clearTimers();
    epochRef.current++; // продолжения флаша в полёте — устаревают
    intentRef.current = null;
    gestureRef.current = 0;
    drawRef.current = null;
    const pending = pendingRef.current;
    pendingRef.current = null;
    setActive(false); // класс долой ДО применения — без transition на доигровке
    setJumpsPaused(false);
    if (pending) {
      maskRef.current = null;
      setRfNodes(pending.nodes);
      setRfEdges(pending.edges);
    } else {
      unmask(false); // мгновенно, без отрисовки — драгу нужна честная сцена сразу
      setRfEdges((prev) => clearDrawIn(prev)); // и доиграть возможную фазу отрисовки
    }
    // тихое окно: снять hold, накопленное досчитать в фоне — свежий прогон доедет
    // обычным путём (как сегодня при драге), потерянных изменений не остаётся
    gate.release();
  }, [clearTimers, unmask, setRfNodes, setRfEdges, gate]);

  const reset = useCallback(() => {
    clearTimers();
    epochRef.current++; // продолжения флаша в полёте — устаревают
    intentRef.current = null;
    gestureRef.current = 0;
    maskRef.current = null;
    drawRef.current = null;
    pendingRef.current = null;
    setActive(false);
    setJumpsPaused(false);
    // смена уровня: накопленное протухло вместе с уровнем — выбросить без досчёта
    gate.reset();
  }, [clearTimers, gate]);

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
          const epoch = ++epochRef.current;
          gate.hold(); // тихое окно: прогоны конвейера копятся до «мёртвой зоны»
          setJumpsPaused(true); // реестр мостиков заморожен до unmask
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
              // конец разъезда: рамки проявляются fade'ом (класс ещё жив), стрелки
              // РИСУЮТСЯ от исходного хэндла к целевому (drawIn на ANIM_DRAW_MS).
              // Отсчёт — ОТ ОТПУСКА (транзишен стартует на кадре этого setState).
              // Конец move — «мёртвая зона» (узлы доехали, рёбра ещё скрыты): здесь
              // флашатся отложенные тихим окном прогоны (замеры детей), и unmask
              // ждёт ПРИМЕНЕНИЯ — drawIn рисует уже СВЕЖИЕ маршруты. Фейд рамок и
              // снятие класса отсчитываются от фактического unmask (флаш сдвигает
              // его на длительность прогона — блок падает в невидимую зону).
              later(ANIM_MOVE_MS, () => {
                void gate.flush().then(() => {
                  if (epoch !== epochRef.current) return; // окно отменено/переоткрыто
                  unmask(true);
                  later(ANIM_FADE_MS + 60, () => setActive(false));
                });
              });
            }));
          }));
          return;
        }
        // рамки в этом прогоне ещё нет (дети локала грузятся) — интент ждёт
      } else {
        const plan = planCollapse(getNodes(), getEdges(), nextNodes, intent.id);
        if (plan) {
          intentRef.current = null;
          clearTimers();
          const epoch = ++epochRef.current;
          gate.hold(); // тихое окно: прогоны копятся до конца фазы 1
          setJumpsPaused(true); // реестр мостиков заморожен до свопа
          // снимок id рёбер ДО фазы 1: на свопе новые пучки (свёрнутого узла)
          // определяются против него и рисуются анимированно
          const prevEdgeIds = new Set(getEdges().map((e) => e.id));
          pendingRef.current = { nodes: nextNodes, edges: nextEdges };
          setActive(true);
          setRfNodes(plan.phase1Nodes);
          setRfEdges((prev) => prev.map((e) => (plan.hiddenEdgeIds.has(e.id) ? { ...e, hidden: true } : e)));
          laterFromFrame(ANIM_MOVE_MS, () => {
            // конец фазы 1 — тоже «мёртвая зона» (потомки съехались, задетые рёбра
            // скрыты): флашим отложенное — свежая раскладка ляжет в pendingRef
            // через apply — и свапаем уже на самое свежее.
            void gate.flush().then(() => {
              if (epoch !== epochRef.current) return; // окно отменено (pending применил cancel)
              // подмена стопки свёрнутым узлом: применяем САМУЮ СВЕЖУЮ раскладку;
              // рёбра, скрытые на фазу 1 или появившиеся заново, — с отрисовкой
              const fin = pendingRef.current;
              pendingRef.current = null;
              setJumpsPaused(false); // реестр пересоберётся батчем со свопом
              let drawStarted = false;
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
                  // отсчёт от первого кадра: сразу за свопом приходит прогон по замерам
                  // вернувшегося узла, и wall-clock-отсчёт съедал бы окно отрисовки;
                  // конец — по последней волне каскада (Ф5)
                  laterFromFrame(drawSpanMs(drawIds.size), endDraw);
                  drawStarted = true;
                } else {
                  setRfEdges(fin.edges);
                }
              }
              if (!drawStarted) gate.release(); // отрисовки не будет — окно закрыто
              later(60, () => setActive(false));
            });
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

    // ОКНО ЖЕСТА (noteGesture): ручное действие изменило раскладку — стрелки, чья
    // геометрия пересчиталась ИНАЧЕ, чем показывало живое превью, перерисовываем
    // анимированно (drawIn). Прячет расхождение превью драга и финального маршрута.
    // Флаг потребляется первым применением, реально изменившим геометрию.
    if (gestureRef.current) {
      if (Date.now() - gestureRef.current >= GESTURE_TTL_MS) {
        gestureRef.current = 0;
      } else if (!reducedMotion()) {
        const changed = changedEdgeIds(getNodes(), getEdges(), nextNodes, nextEdges);
        if (changed.size > 0) {
          gestureRef.current = 0;
          drawRef.current = new Set([...(drawRef.current ?? []), ...changed]);
          laterFromFrame(drawSpanMs(drawRef.current.size), endDraw);
        }
      } else {
        gestureRef.current = 0;
      }
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
  }, [getNodes, getEdges, setRfNodes, setRfEdges, clearTimers, later, laterFromFrame, unmask, endDraw, gate]);

  const noteExpand = useCallback((id: string) => {
    intentRef.current = { kind: "expand", id, ts: Date.now() };
  }, []);
  const noteCollapse = useCallback((id: string) => {
    intentRef.current = { kind: "collapse", id, ts: Date.now() };
  }, []);
  const noteGesture = useCallback(() => {
    gestureRef.current = Date.now();
  }, []);

  return { apply, noteExpand, noteCollapse, noteGesture, cancel, reset, active, jumpsPaused };
}
