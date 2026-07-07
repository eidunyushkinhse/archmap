// Разведение гостей МЕЖДУ СОБОЙ при раскрытии вложенной гостевой рамки (Ф4.3+Ф4.4).
//
// Недостающий движку класс ограничений (диагноз — REFACTOR_OWNERSHIP_F4.md §2): когда
// раскрывают ПРОМЕЖУТОЧНОГО гостя (вложенную рамку Ж внутри уже раскрытого Б), его новый
// ребёнок (И) садится ПОВЕРХ владеемых соседей (З). ringPlacement обрабатывает только
// АВТО-группы (а группа Б не авто — Е/З уже владеемы), keep-out выталкивает лишь из
// нативных рамок. Поэтому И остаётся на ELK-позиции в чужой системе координат.
//
// Решение (VPSC по слоям containment, Ф4.0–Ф4.2b): строим лес супер-узлов (рамка = bbox
// членов), разводим наложения изнутри наружу с минимальным взвешенным смещением. Полярность
// движения (решение архитектора 2026-06-29):
//   • ЛОКАЛЫ — строго запинены при любом раскрытии (вес Infinity);
//   • РАСКРЫТАЯ РАМКА — якорь жеста: большой КОНЕЧНЫЙ вес → стоит на месте старого свёрнутого
//     узла (expand-in-place, R1), но сдвигается МИНИМАЛЬНО, если запинить нельзя (упёрлась бы
//     в keep-out родительской рамки) — это и есть поведение VPSC при большом конечном весе;
//   • ВЛАДЕЕМЫЕ СОСЕДИ — средний вес: уступают место первыми (их новые позиции персистятся, Ф4.4);
//   • НОВИЧОК — лёгкий.
//
// Срабатывает ТОЛЬКО когда есть новичок от раскрытия вложенной рамки (нет levelPosition и его
// не разместило кольцо). Иначе — no-op (early-out): первый уровень раскрытия (авто-группа на
// кольце) и устоявшиеся схемы не трогаются. Чистый построитель леса (buildGuestForest) под
// тестами; separateGuests — тонкая оркестрация (МУТИРУЕТ positions), как enforceFramesKeepOut.
import { NODE_W, NODE_H, KEEPOUT_GAP } from "../constants";
import { computeFrames, type FrameRect } from "./frames";
import { separateContainment, type CFrame, type CLeaf } from "./separateContainment";
import { assignEdgeHandles } from "./level";
import type { Rect } from "./overlapConstraints";
import type { KeepOutResult } from "./keepGhostsOut";
import type { DisplayExternal } from "../types";
import type { LayoutEdge, AncestorRef, LevelPos } from "../../../types";

type XY = { x: number; y: number };

// Веса подвижности [R4]: больше = меньше двигается.
const W_LOCAL = Infinity; // локал — строго запинен при любом раскрытии
const W_PIN = 1e6;        // раскрытая рамка — якорь жеста (минимальный сдвиг, если запинить нельзя)
const W_OWNED = 1e3;      // владеемый сосед — уступает место
const W_NEW = 1;          // новичок — самый подвижный

/**
 * Строит лес containment (CFrame-корень) по геометрии уровня для separateContainment.
 * Локалы и гости — листья (вес по статусу), гостевые рамки — вложенные CFrame. Чистая
 * функция: позиции читает через `pos`, ничего не мутирует.
 *  - `localSet` — id локальных узлов (вес Infinity);
 *  - `lightIds` — новички от раскрытия вложенной рамки (вес W_NEW; рамка, их содержащая, — пин);
 *  - прочие гости (есть levelPosition / размещены кольцом) — вес W_OWNED.
 */
export function buildGuestForest(params: {
  localIds: string[];
  entityIds: string[];
  frames: FrameRect[];
  pos: (id: string) => XY | undefined;
  localSet: Set<string>;
  lightIds: Set<string>;
}): CFrame {
  const { localIds, entityIds, frames, pos, localSet, lightIds } = params;
  const guestFrames = frames.filter((f) => !f.native).sort((a, b) => a.depth - b.depth);

  const rectOf = (id: string): Rect | null => {
    const p = pos(id);
    return p ? { minX: p.x, minY: p.y, maxX: p.x + NODE_W, maxY: p.y + NODE_H } : null;
  };
  const leafWeight = (id: string): number =>
    localSet.has(id) ? W_LOCAL : lightIds.has(id) ? W_NEW : W_OWNED;

  // CFrame-узлы по id гостевой рамки (дети добираются ниже). pad — горизонтальный
  // паддинг рамки (content.minX − rect.x); separateContainment воссоздаёт rect рамки
  // как bbox разведённых детей + этот симметричный паддинг.
  const frameNode = new Map<string, CFrame>();
  for (const f of guestFrames) {
    const pad = Math.max(0, f.content.minX - f.rect.x);
    frameNode.set(f.id, { kind: "frame", weight: W_OWNED, pad, children: [] });
  }

  // родитель гостевой рамки = глубочайшая ДРУГАЯ гостевая рамка-надмножество по членам
  // (рамки концентрически вложены). Нет такой — рамка садится в корень.
  const parentFrameOf = (f: FrameRect): string | null => {
    let best: string | null = null, bestDepth = -Infinity;
    for (const g of guestFrames) {
      if (g.id === f.id || g.depth >= f.depth) continue;
      let superset = true;
      for (const m of f.memberIds) if (!g.memberIds.has(m)) { superset = false; break; }
      if (superset && g.depth > bestDepth) { bestDepth = g.depth; best = g.id; }
    }
    return best;
  };
  // глубочайшая гостевая рамка, содержащая лист (null → лист садится в корень)
  const deepestFrameOf = (id: string): string | null => {
    let best: string | null = null, bestDepth = -Infinity;
    for (const f of guestFrames) {
      if (f.memberIds.has(id) && f.depth > bestDepth) { bestDepth = f.depth; best = f.id; }
    }
    return best;
  };

  const root: CFrame = { kind: "frame", weight: W_OWNED, pad: 0, children: [] };

  // листья (локалы + гости) — в свою глубочайшую гостевую рамку либо в корень
  for (const id of [...localIds, ...entityIds]) {
    const r = rectOf(id);
    if (!r) continue;
    const leaf: CLeaf = { kind: "leaf", id, rect: r, weight: leafWeight(id) };
    const host = deepestFrameOf(id);
    (host ? frameNode.get(host)! : root).children.push(leaf);
  }
  // гостевые рамки — к родителям; вес рамки: содержит новичка → пин, иначе владеемая
  for (const f of guestFrames) {
    const node = frameNode.get(f.id)!;
    let hasLight = false;
    for (const m of f.memberIds) if (lightIds.has(m)) { hasLight = true; break; }
    node.weight = hasLight ? W_PIN : W_OWNED;
    const par = parentFrameOf(f);
    (par ? frameNode.get(par)! : root).children.push(node);
  }

  // отбрасываем пустые рамки (все члены ушли глубже / без позиции) — иначе bbox по пустому
  const prune = (n: CFrame): void => {
    n.children = n.children.filter((c) => c.kind === "leaf" || (prune(c), c.children.length > 0));
  };
  prune(root);
  return root;
}

/**
 * Разводит гостей между собой при раскрытии вложенной рамки. `positions` МУТИРУЕТСЯ.
 * Возвращает null, если разводить нечего (нет новичков от раскрытия вложенной рамки или
 * никто не сдвинут). `moved` — id сдвинутых сущностей (новичок + уступившие соседи).
 */
export function separateGuests(params: {
  nodes: { id: string }[];
  entities: DisplayExternal[];
  ancestorIds: string[];
  levelPositions: Record<string, LevelPos>;
  layoutEdges: LayoutEdge[];
  positions: Map<string, XY>;
  /** id сущности → раскрытый контейнер-предок прямо над ней (projectGhosts.emergedFrom) */
  emergedFrom: Map<string, string>;
  /** гости, уже размещённые кольцом (их не считаем новичками от вложенного раскрытия) */
  placedOutside: Set<string>;
}): KeepOutResult | null {
  const { nodes, entities, ancestorIds, levelPositions, layoutEdges, positions, emergedFrom, placedOutside } = params;
  if (ancestorIds.length === 0 || nodes.length === 0 || entities.length === 0) return null;

  // новички от раскрытия ВЛОЖЕННОЙ рамки: нет постоянной позиции и кольцо их не ставило
  const lightIds = new Set<string>();
  for (const e of entities) {
    if (!levelPositions[e.id] && !placedOutside.has(e.id)) lightIds.add(e.id);
  }
  if (lightIds.size === 0) return null; // нечего разводить — no-op

  // expand-in-place [R1]: сажаем новичка в позицию старого свёрнутого узла его раскрытого
  // родителя (тот узел теперь рамка; прежняя позиция персистнута в levelPositions).
  for (const id of lightIds) {
    const lp = levelPositions[emergedFrom.get(id) ?? ""];
    if (lp) positions.set(id, { x: lp.pos_x, y: lp.pos_y });
  }

  const localIds = nodes.map((n) => n.id);
  const entAncestors = (e: DisplayExternal): AncestorRef[] =>
    e.kind === "leaf" ? (e.ghost.ancestors ?? []) : e.ancestors;
  const externals = entities.map((e) => ({ id: e.id, ancestors: entAncestors(e) }));
  const pos = (id: string) => positions.get(id);
  const frames = computeFrames({ localIds, externals, pos, ancestorIds, ancestorNames: ancestorIds });
  const root = buildGuestForest({
    localIds, entityIds: entities.map((e) => e.id), frames, pos,
    localSet: new Set(localIds), lightIds,
  });

  const solved = separateContainment(root, KEEPOUT_GAP);

  // применяем разведённые позиции (локалы с весом Infinity вернулись без изменений)
  const moved = new Set<string>();
  for (const [id, p] of solved) {
    const cur = positions.get(id);
    if (!cur || Math.abs(cur.x - p.x) > 1e-6 || Math.abs(cur.y - p.y) > 1e-6) {
      positions.set(id, p);
      moved.add(id);
    }
  }
  if (moved.size === 0) return null;

  const displayed = [...localIds.map((id) => ({ id })), ...externals.map((e) => ({ id: e.id }))];
  return { moved, edgeHandles: assignEdgeHandles(displayed, layoutEdges, positions) };
}
