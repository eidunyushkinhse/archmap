// Раскладка обычного уровня: позиции узлов (dagre) и авто-назначение хэндлов рёбер.
// Чистые функции под характеризационными тестами Фазы 1. Не зависит от
// context.ts / nodes / edges.
import Dagre from "@dagrejs/dagre";
import { NODE_W, NODE_H, hid } from "../constants";
import { maxLineLength } from "../text";
import type { Edge as AppEdge } from "../../../types";

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
 * ЧЕМ посчитаны позиции (dagre/ELK) — только от их значений: сохранённый хэндл берётся,
 * если валиден для текущей проекции, иначе autoHandles по взаимному положению.
 * Вынесено из computeLayout, чтобы ELK-движок (layoutLevel) переиспользовал ту же логику.
 */
export function assignEdgeHandles(
  allNodes: Array<{ id: string }>,
  edges: AppEdge[],
  positions: Map<string, { x: number; y: number }>,
): Map<string, { sourceHandle: string; targetHandle: string }> {
  const idSet = new Set(allNodes.map((n) => n.id));

  const pairGroups = new Map<string, AppEdge[]>();
  for (const e of edges) {
    const key = [e.source_id, e.target_id].sort().join("|");
    if (!pairGroups.has(key)) pairGroups.set(key, []);
    pairGroups.get(key)!.push(e);
  }
  const pairInfo = new Map<string, { idx: number; total: number }>();
  for (const [, group] of pairGroups) {
    group.forEach((e, i) => pairInfo.set(e.id, { idx: i, total: group.length }));
  }

  const edgeHandles = new Map<string, { sourceHandle: string; targetHandle: string }>();
  for (const e of edges) {
    if (!idSet.has(e.source_id) || !idSet.has(e.target_id)) continue;

    // Сохранённые хэндлы валидны только если указывают на текущие проекционные узлы.
    // Один и тот же edge на разных уровнях проецируется на разные узлы (A→B1 на уровне 0
    // отображается как A→B, а на уровне 1 — как A→B1). Хэндл, сохранённый на уровне 0
    // для узла B, не существует на уровне 1, где target — B1.
    const srcHandleValid = e.source_handle?.startsWith(e.source_id + "--") ?? false;
    const tgtHandleValid = e.target_handle?.startsWith(e.target_id + "--") ?? false;

    if (srcHandleValid && tgtHandleValid) {
      edgeHandles.set(e.id, { sourceHandle: e.source_handle!, targetHandle: e.target_handle! });
    } else {
      const { idx, total } = pairInfo.get(e.id) ?? { idx: 0, total: 1 };
      edgeHandles.set(e.id, autoHandles(e.source_id, e.target_id, positions, idx, total));
    }
  }

  return edgeHandles;
}

export function computeLayout(
  allNodes: Array<{ id: string; savedPos?: { x: number; y: number } | null }>,
  edges: AppEdge[],
): {
  positions: Map<string, { x: number; y: number }>;
  edgeHandles: Map<string, { sourceHandle: string; targetHandle: string }>;
} {
  // 1. Dagre для позиционирования (LR — прямые рёбра идут слева направо)
  const g = new Dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", ranksep: 120, nodesep: 60, marginx: 30, marginy: 30 });

  const idSet = new Set(allNodes.map((n) => n.id));
  for (const n of allNodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) {
    if (!idSet.has(e.source_id) || !idSet.has(e.target_id)) continue;
    const labelText = [e.label, e.technology].filter(Boolean).join(" · ");
    const maxLen = labelText ? maxLineLength(labelText) : 0;
    const minlen = maxLen > 20 ? Math.max(2, Math.ceil(maxLen / 12)) : 1;
    g.setEdge(e.source_id, e.target_id, { minlen });
  }
  Dagre.layout(g);

  const positions = new Map<string, { x: number; y: number }>();
  for (const id of g.nodes()) {
    const n = g.node(id);
    if (n) positions.set(id, { x: n.x - NODE_W / 2, y: n.y - NODE_H / 2 });
  }

  // Переопределяем позиции сохранёнными значениями из БД
  for (const node of allNodes) {
    if (node.savedPos != null) positions.set(node.id, node.savedPos);
  }

  // 2. Назначаем хэндлы рёбрам (логика общая с ELK-движком)
  const edgeHandles = assignEdgeHandles(allNodes, edges, positions);

  return { positions, edgeHandles };
}
