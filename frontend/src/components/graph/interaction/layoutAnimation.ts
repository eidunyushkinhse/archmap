// Планировщики анимации раскрытия/сворачивания контейнеров (чистые функции).
// Анимация — ЧИСТО ПРЕЗЕНТАЦИОННАЯ: раскладку не меняет, только режиссирует
// переход между двумя её состояниями средствами CSS-transition (класс
// lg-canvas--anim на холсте живёт лишь на окно анимации, см. useLayoutAnimation).
//
// Раскрытие (planExpand): новые узлы (дети раскрытого контейнера) монтируются
// СТОПКОЙ в центре прежнего свёрнутого узла и через кадр отпускаются на свои
// финальные позиции — CSS развозит их плавно. Рамка раскрытия при этом скрыта
// (opacity 0) и проявляется ПОСЛЕ разъезда — её финальный rect статичен, ей
// нечего анимировать, а ранняя пунктирная коробка выдавала бы концовку.
// Соседи, сдвинутые keep-out'ом, получают финальные позиции сразу в первом же
// кадре: их DOM-узлы живы, transition сам провезёт их со старых мест —
// параллельно разъезду детей.
//
// Сворачивание (planCollapse) — двухфазное: сперва потомки рамки СЪЕЗЖАЮТСЯ в
// точку, где встанет свёрнутый узел (рамка гаснет, соседи параллельно едут на
// свои новые места), и только по завершении хук подменяет стопку настоящим
// узлом-контейнером (свежая раскладка применяется целиком).
//
// Стрелки в обеих фазах ЧЕСТНО ПРЯЧУТСЯ (hidden), если хоть один их конец
// движется/появляется/исчезает: их геометрия посчитана под финал и во время
// разъезда висела бы оторванной от узлов. Показ по завершении; анимированная
// отрисовка стрелок — отдельный будущий заход.
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import { absPositionOf } from "../absPos";
import { NODE_W, NODE_H } from "../constants";

// Тайминги (мс). ДОЛЖНЫ совпадать с CSS (LevelGraph.css): move — transition
// transform/width/height у .lg-canvas--anim, fade — transition opacity, draw —
// keyframes lg-edge-draw (отрисовка стрелки штрихом).
export const ANIM_MOVE_MS = 420;
export const ANIM_FADE_MS = 200;
export const ANIM_DRAW_MS = 400;

/** Показать спрятанные рёбра ids С анимированной отрисовкой (drawIn — edges.tsx
 *  рисует линию штрихом от source к target, плашка и наконечник появятся по
 *  снятии флага). Прочие рёбра не трогаем. */
export const markDrawIn = (edges: RFEdge[], ids: Set<string>): RFEdge[] =>
  edges.map((e) => (ids.has(e.id)
    ? { ...e, hidden: false, data: { ...e.data, drawIn: true } }
    : e));

/** Снять флаг отрисовки (конец draw-анимации: проявить плашки и наконечники). */
export const clearDrawIn = (edges: RFEdge[]): RFEdge[] =>
  edges.map((e) => (e.data?.drawIn ? { ...e, data: { ...e.data, drawIn: false } } : e));

// Сигнатура ГЕОМЕТРИИ ребра: всё, от чего зависит его нарисованный путь и плашка —
// хэндлы, абсолютные позиции концов, авто-маршрут, центр плашки. Координаты
// огрубляются до 0.5px: микро-дрейф пересчёта не должен считаться изменением.
const q = (v: number): number => Math.round(v * 2) / 2;
const edgeGeoSig = (e: RFEdge, byId: Map<string, RFNode>): string => {
  const d = e.data as {
    autoRoute?: { x: number; y: number }[];
    labelPlacement?: { center?: { x: number; y: number } };
  } | undefined;
  const end = (id: string): string => {
    const n = byId.get(id);
    if (!n) return "?";
    const p = absPositionOf(n, byId);
    return `${q(p.x)},${q(p.y)}`;
  };
  const rt = d?.autoRoute?.map((p) => `${q(p.x)},${q(p.y)}`).join(";") ?? "";
  const c = d?.labelPlacement?.center;
  return [
    e.sourceHandle ?? "", e.targetHandle ?? "",
    end(e.source), end(e.target),
    rt, c ? `${q(c.x)},${q(c.y)}` : "",
  ].join("|");
};

/**
 * Рёбра, чья геометрия ИЗМЕНИЛАСЬ между снимками (для анимированной перерисовки
 * после ручного жеста): живут в обоих снимках, но путь/хэндлы/концы/плашка другие.
 * Новые и исчезнувшие рёбра не входят (их монтаж/демонтаж — не «перекладка»).
 */
export function changedEdgeIds(
  prevNodes: RFNode[], prevEdges: RFEdge[],
  nextNodes: RFNode[], nextEdges: RFEdge[],
): Set<string> {
  const prevById = new Map(prevNodes.map((n) => [n.id, n]));
  const nextById = new Map(nextNodes.map((n) => [n.id, n]));
  const prevE = new Map(prevEdges.map((e) => [e.id, e]));
  const out = new Set<string>();
  for (const e of nextEdges) {
    const pe = prevE.get(e.id);
    if (!pe || e.hidden) continue;
    if (edgeGeoSig(pe, prevById) !== edgeGeoSig(e, nextById)) out.add(e.id);
  }
  return out;
}

// Габариты RF-узла: замер → явные width/height → фолбэк-константы (новые узлы
// ещё не замерены — для центрирования стопки хватает номинала).
const sizeOf = (n: RFNode): { w: number; h: number } => ({
  w: n.measured?.width ?? (typeof n.width === "number" ? n.width : NODE_W),
  h: n.measured?.height ?? (typeof n.height === "number" ? n.height : NODE_H),
});

// Сущности, участвующие в анимации позиций (спорные типы — рамки и распорки —
// обрабатываются отдельно/пропускаются).
const isMovable = (n: RFNode): boolean =>
  n.type === "block" || n.type === "ghost" || n.type === "container";

// Смещение узла между двумя снимками заметно глазу? (движение соседей)
const MOVED_EPS = 0.5;

export interface ExpandPlan {
  /** первый кадр: дети — стопкой в центре свёрнутого узла, рамки скрыты */
  initialNodes: RFNode[];
  /** второй кадр (rAF): id → финальная ОТНОСИТЕЛЬНАЯ позиция спавнутых узлов */
  finalPositions: Map<string, { x: number; y: number }>;
  /** новые рамки — скрыты на разъезд, проявить по его завершении */
  hiddenFrameIds: Set<string>;
  /** рёбра с движущимся/новым концом — hidden до конца разъезда */
  hiddenEdgeIds: Set<string>;
}

export interface CollapsePlan {
  /** фаза 1: потомки съезжаются в центр будущего узла, рамки гаснут, соседи едут */
  phase1Nodes: RFNode[];
  /** рёбра текущего снимка с движущимся/исчезающим концом — hidden на фазу 1 */
  hiddenEdgeIds: Set<string>;
}

// Скрыть узел, сохранив прочие стили (dim-фильтр вида и т.п.).
const hideNode = (n: RFNode): RFNode => ({ ...n, style: { ...n.style, opacity: 0 } });

// Абсолют цепочки родителей узла (= абсолют узла минус его rel-позиция):
// перевод произвольной абсолютной точки в систему координат родителя узла.
const parentChainAbs = (n: RFNode, byId: Map<string, RFNode>): { x: number; y: number } => {
  const abs = absPositionOf(n, byId);
  return { x: abs.x - n.position.x, y: abs.y - n.position.y };
};

// Рёбра, у которых хоть один конец входит в affected.
const edgesTouching = (edges: RFEdge[], affected: Set<string>): Set<string> => {
  const out = new Set<string>();
  for (const e of edges) if (affected.has(e.source) || affected.has(e.target)) out.add(e.id);
  return out;
};

// Узлы, реально сместившиеся между снимками (по АБСОЛЮТУ — rel мог смениться
// вместе с родителем при том же месте на холсте).
const movedIds = (
  prevById: Map<string, RFNode>, nextById: Map<string, RFNode>,
): Set<string> => {
  const out = new Set<string>();
  for (const [id, n] of nextById) {
    const p = prevById.get(id);
    if (!p || !isMovable(n)) continue;
    const a = absPositionOf(p, prevById);
    const b = absPositionOf(n, nextById);
    if (Math.abs(a.x - b.x) > MOVED_EPS || Math.abs(a.y - b.y) > MOVED_EPS) out.add(id);
  }
  return out;
};

/**
 * План анимации РАСКРЫТИЯ контейнера containerId. null — анимировать нечего:
 * в prev нет свёрнутого узла (спавнить неоткуда) или в next ещё нет рамки
 * (дети локального контейнера грузятся async — интент ждёт следующего прогона).
 */
export function planExpand(
  prevNodes: RFNode[], prevEdges: RFEdge[],
  nextNodes: RFNode[], nextEdges: RFEdge[],
  containerId: string,
): ExpandPlan | null {
  const prevById = new Map(prevNodes.map((n) => [n.id, n]));
  const nextById = new Map(nextNodes.map((n) => [n.id, n]));
  const collapsed = prevById.get(containerId);
  const frame = nextById.get(containerId);
  if (!collapsed || !isMovable(collapsed) || frame?.type !== "frame") return null;

  // точка спавна — центр прежнего свёрнутого узла (абсолют)
  const cAbs = absPositionOf(collapsed, prevById);
  const cSize = sizeOf(collapsed);
  const spawn = { x: cAbs.x + cSize.w / 2, y: cAbs.y + cSize.h / 2 };

  const finalPositions = new Map<string, { x: number; y: number }>();
  const hiddenFrameIds = new Set<string>();
  const initialNodes = nextNodes.map((n) => {
    if (n.type === "frame") {
      // ВАЖНО: рамка раскрытия наследует id свёрнутого узла — проверка «жил ли
      // id в prev» её не ловит; новизна рамки определяется по ТИПУ в prev
      if (prevById.get(n.id)?.type === "frame") return n; // живая рамка: rect довезёт CSS
      hiddenFrameIds.add(n.id);
      return hideNode(n);
    }
    if (prevById.has(n.id)) return n; // живой узел: финал сразу, CSS довезёт
    if (!isMovable(n)) return n; // распорки и пр. — вне анимации
    // новый узел: стопка в центре спавна, rel — в системе его родителя
    // (рамки в next стоят на финальных местах, цепочка стабильна)
    const { w, h } = sizeOf(n);
    const chain = parentChainAbs(n, nextById);
    finalPositions.set(n.id, { ...n.position });
    return { ...n, position: { x: spawn.x - w / 2 - chain.x, y: spawn.y - h / 2 - chain.y } };
  });
  if (finalPositions.size === 0) return null; // раскрытие без новых узлов — нечего играть

  const affected = new Set([...finalPositions.keys(), ...movedIds(prevById, nextById)]);
  const prevEdgeIds = new Set(prevEdges.map((e) => e.id));
  const hiddenEdgeIds = edgesTouching(nextEdges, affected);
  for (const e of nextEdges) if (!prevEdgeIds.has(e.id)) hiddenEdgeIds.add(e.id); // новые пучки
  return { initialNodes, finalPositions, hiddenFrameIds, hiddenEdgeIds };
}

/**
 * План фазы 1 СВОРАЧИВАНИЯ рамки containerId: потомки съезжаются в центр
 * будущего свёрнутого узла (его место известно из next), рамки поддерева гаснут,
 * общие соседи параллельно едут на свои next-позиции. null — снимки не в той
 * фазе (рамки уже нет в prev или узла ещё нет в next).
 */
export function planCollapse(
  prevNodes: RFNode[], prevEdges: RFEdge[],
  nextNodes: RFNode[],
  containerId: string,
): CollapsePlan | null {
  const prevById = new Map(prevNodes.map((n) => [n.id, n]));
  const nextById = new Map(nextNodes.map((n) => [n.id, n]));
  const frame = prevById.get(containerId);
  const target = nextById.get(containerId);
  if (frame?.type !== "frame" || !target || !isMovable(target)) return null;

  // точка схождения — центр будущего свёрнутого узла (абсолют из next)
  const tAbs = absPositionOf(target, nextById);
  const tSize = sizeOf(target);
  const sink = { x: tAbs.x + tSize.w / 2, y: tAbs.y + tSize.h / 2 };

  // поддерево рамки: узлы, чья цепочка parentId проходит через containerId
  const inSubtree = (n: RFNode): boolean => {
    for (let p = n.parentId; p; p = prevById.get(p)?.parentId) if (p === containerId) return true;
    return false;
  };

  const descendants = new Set<string>();
  const moved = movedIds(prevById, nextById);
  const phase1Nodes = prevNodes.map((n) => {
    if (n.id === containerId || (n.type === "frame" && inSubtree(n))) return hideNode(n);
    if (!isMovable(n)) return n;
    if (inSubtree(n)) {
      descendants.add(n.id);
      const { w, h } = sizeOf(n);
      const chain = parentChainAbs(n, prevById);
      return { ...n, position: { x: sink.x - w / 2 - chain.x, y: sink.y - h / 2 - chain.y } };
    }
    // общий сосед: довезти до next-позиции в СТАРОЙ системе родителей
    // (рамки вне поддерева в фазе 1 неподвижны, абсолюты сходятся)
    if (moved.has(n.id)) {
      const abs = absPositionOf(nextById.get(n.id)!, nextById);
      const chain = parentChainAbs(n, prevById);
      return { ...n, position: { x: abs.x - chain.x, y: abs.y - chain.y } };
    }
    return n;
  });

  const affected = new Set([...descendants, ...moved, containerId]);
  return { phase1Nodes, hiddenEdgeIds: edgesTouching(prevEdges, affected) };
}
