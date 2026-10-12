// Раскладка обычного уровня: авто-назначение хэндлов рёбер по позициям узлов.
// Позиции считает ELK (`layoutLevel` в engine.ts); здесь — только чистая логика
// хэндлов под тестами. Не зависит от context.ts / nodes / edges.
import { hid } from "../constants";
import type { LayoutEdge } from "../../../types";

/** Авто-назначение хэндлов ребру по относительным позициям узлов: стороны, смотрящие
 * друг на друга по доминантной оси; хэндл — центр стороны (слотов нет, Ф5 эпика
 * «стрелки без жёстких хэндлов»). ФОЛБЭК для ребра, которое роутер не посчитал
 * (бюджет, контекст): концы такого ребра RF рисует smoothstep от этих хэндлов. */
export function autoHandles(
  srcId: string, tgtId: string,
  positions: Map<string, { x: number; y: number }>,
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

  return {
    sourceHandle: hid(srcId, srcSide),
    targetHandle: hid(tgtId, tgtSide),
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
  const edgeHandles = new Map<string, { sourceHandle: string; targetHandle: string }>();
  for (const e of edges) {
    if (!idSet.has(e.source_id) || !idSet.has(e.target_id)) continue;
    edgeHandles.set(e.id, autoHandles(e.source_id, e.target_id, positions));
  }
  return edgeHandles;
}
