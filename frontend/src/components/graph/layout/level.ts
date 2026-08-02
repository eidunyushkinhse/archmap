// Раскладка обычного уровня: авто-назначение хэндлов рёбер по позициям узлов.
// Позиции считает ELK (`layoutLevel` в engine.ts); здесь — только чистая логика
// хэндлов под тестами. Не зависит от context.ts / nodes / edges.
import { hid } from "../constants";
import type { LayoutEdge } from "../../../types";

/** Авто-назначение хэндлов ребру по относительным позициям узлов */
export function autoHandles(
  srcId: string, tgtId: string,
  positions: Map<string, { x: number; y: number }>,
  parallelIdx: number, parallelTotal: number,
): { sourceHandle: string; targetHandle: string } {
  const srcP = positions.get(srcId) ?? { x: 0, y: 0 };
  const tgtP = positions.get(tgtId) ?? { x: 0, y: 0 };
  const dx = tgtP.x - srcP.x;
  const dy = tgtP.y - srcP.y;

  let srcSide: string, tgtSide: string;
  if (Math.abs(dx) >= Math.abs(dy)) {
    srcSide = dx >= 0 ? "right" : "left";
    tgtSide = dx >= 0 ? "left"  : "right";
  } else {
    srcSide = dy >= 0 ? "bottom" : "top";
    tgtSide = dy >= 0 ? "top"    : "bottom";
  }

  // 1 ребро → центр (idx=1); 2 → края (0,2); 3 → все три (0,1,2)
  const idxMap = parallelTotal === 1 ? [1] : parallelTotal === 2 ? [0, 2] : [0, 1, 2];
  const hi = idxMap[parallelIdx % 3];

  return {
    sourceHandle: hid(srcId, srcSide, hi),
    targetHandle: hid(tgtId, tgtSide, hi),
  };
}

/**
 * Назначение хэндлов рёбрам по уже посчитанным позициям узлов. Не зависит от того,
 * ЧЕМ посчитаны позиции (dagre/ELK) — только от их значений: autoHandles по взаимному
 * положению (сохранённых ручных хэндлов больше нет — ручной слой удалён 2026-07-09).
 * Вынесено из computeLayout, чтобы ELK-движок (layoutLevel) переиспользовал ту же логику.
 */
export function assignEdgeHandles(
  allNodes: Array<{ id: string }>,
  edges: LayoutEdge[],
  positions: Map<string, { x: number; y: number }>,
): Map<string, { sourceHandle: string; targetHandle: string }> {
  const idSet = new Set(allNodes.map((n) => n.id));

  const pairGroups = new Map<string, LayoutEdge[]>();
  for (const e of edges) {
    const key = [e.source_id, e.target_id].sort().join("|");
    let group = pairGroups.get(key);
    if (!group) { group = []; pairGroups.set(key, group); }
    group.push(e);
  }
  const pairInfo = new Map<string, { idx: number; total: number }>();
  for (const [, group] of pairGroups) {
    group.forEach((e, i) => pairInfo.set(e.id, { idx: i, total: group.length }));
  }

  const edgeHandles = new Map<string, { sourceHandle: string; targetHandle: string }>();
  for (const e of edges) {
    if (!idSet.has(e.source_id) || !idSet.has(e.target_id)) continue;
    const { idx, total } = pairInfo.get(e.id) ?? { idx: 0, total: 1 };
    edgeHandles.set(e.id, autoHandles(e.source_id, e.target_id, positions, idx, total));
  }

  return edgeHandles;
}
