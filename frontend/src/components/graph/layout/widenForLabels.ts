// Раздвижка узлов под плашку короткого ребра (эпик стрелок A10, R2; вынесено из
// pipeline при распиле Ф2 аудита 2026-07-09).
//
// Связь между СОСЕДНИМИ узлами бывает короче своей плашки — инлайн она не лезет и
// отскакивает мимо стрелки/под узел (BUG B из A9.0). Раздвигаем концы такого ребра
// по доминантной оси, чтобы плечо стало длиннее текста. КРИТ (own-on-first-render):
// двигаем ТОЛЬКО свежие ELK-локалы (нет в ownedPositions, никем не присвоены) —
// владеемые позиции прибиты намертво. МЕСТО В КОНВЕЙЕРЕ: ПОСЛЕ цикла инвариантов
// (керн раздвижки не знает о рамках) и ДО засева владения (засев фиксирует
// ПОКАЗАННЫЕ позиции); если раздвижка двигала — вызывающий прогоняет инварианты
// ПОВТОРНО (keep-out и разведение не сжимают зазоры — раздвинутое место не отберут).
import { NODE_W, NODE_H } from "../constants";
import type { LevelPos } from "../../../types";
import type { EdgeGroup } from "../types";
import { separateForLabels, type LabelEdge } from "./separateForLabels";
import { metaLabelBox } from "./labelBox";
import type { Rect } from "./overlapConstraints";
import type { LabelMeta } from "./labelLayout";

const SEP_MARGIN = 8; // клиренс вдоль плеча с каждой стороны плашки
const SEP_PAD = 12;   // зазор при каскадной зачистке наложений (как separateGuests)

/**
 * Раздвигает «голодные» рёбра (инлайн-зазор короче плашки). `positions` МУТИРУЕТСЯ.
 * Возвращает true, если хоть один узел сдвинут (вызывающий повторяет инварианты).
 */
export function widenNodesForLabels(params: {
  groupArr: EdgeGroup[];
  displayIds: string[];
  /** id локальных узлов — двигаем только их (и только без владеемой позиции) */
  localIds: Set<string>;
  ownedPositions: Record<string, LevelPos>;
  positions: Map<string, { x: number; y: number }>;
  labelMeta: (g: EdgeGroup) => LabelMeta | null;
}): boolean {
  const { groupArr, displayIds, localIds, ownedPositions, positions, labelMeta } = params;

  const idxOf = new Map<string, number>();
  const rects: Rect[] = [];
  const weights: number[] = [];
  for (const id of displayIds) {
    const p = positions.get(id);
    if (!p) continue;
    idxOf.set(id, rects.length);
    rects.push({ minX: p.x, minY: p.y, maxX: p.x + NODE_W, maxY: p.y + NODE_H });
    const movable = localIds.has(id) && !ownedPositions[id];
    weights.push(movable ? 1 : Infinity);
  }
  // Сколько рёбер на каждой НЕУПОРЯДОЧЕННОЙ паре узлов — встречную/много-рёберную пару
  // раздвигать бессмысленно: их плечи совпадают (R4), инлайн на прямом коридоре всё равно
  // запрещён → за это отвечают рельсы (A11) и детур (A12), а не раздвижка. Иначе A10 зря
  // выселял бы узел (см. дамп A10.2: ObsCore уезжал, плашка всё равно leader).
  const pairCount = new Map<string, number>();
  for (const g of groupArr) {
    const k = g.source < g.target ? `${g.source}|${g.target}` : `${g.target}|${g.source}`;
    pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
  }
  const labelEdges: LabelEdge[] = [];
  for (const g of groupArr) {
    const pk = g.source < g.target ? `${g.source}|${g.target}` : `${g.target}|${g.source}`;
    if ((pairCount.get(pk) ?? 0) > 1) continue; // встречная/много-рёберная пара → не раздвигаем
    const si = idxOf.get(g.source);
    const ti = idxOf.get(g.target);
    if (si == null || ti == null) continue;
    // оба конца прибиты — раздвинуть нечем без нарушения ownership, оставляем leader
    if (weights[si] === Infinity && weights[ti] === Infinity) continue;
    const meta = labelMeta(g);
    if (!meta) continue;
    const box = metaLabelBox(meta);
    // голодное ли ребро: инлайн-зазор по доминантной оси короче плашки + 2·margin?
    const s = rects[si];
    const t = rects[ti];
    const dx = Math.abs((s.minX + s.maxX - t.minX - t.maxX) / 2);
    const dy = Math.abs((s.minY + s.maxY - t.minY - t.maxY) / 2);
    const axisX = dx >= dy;
    const gap = axisX
      ? dx - (s.maxX - s.minX + t.maxX - t.minX) / 2
      : dy - (s.maxY - s.minY + t.maxY - t.minY) / 2;
    const need = (axisX ? box.w : box.h) + 2 * SEP_MARGIN;
    if (gap >= need) continue; // места хватает — не раздвигаем
    labelEdges.push({ source: si, target: ti, box });
  }
  if (labelEdges.length === 0) return false;

  const widened = separateForLabels(rects, weights, labelEdges, { pad: SEP_PAD, margin: SEP_MARGIN });
  // пишем новые позиции только подвижным узлам (прибитые VPSC не двигает — но не
  // трогаем их координаты вовсе, чтобы исключить дрейф владеемых позиций).
  let moved = false;
  for (const [id, i] of idxOf) {
    if (weights[i] === Infinity) continue;
    const p = positions.get(id)!;
    if (Math.abs(widened[i].minX - p.x) > 1e-6 || Math.abs(widened[i].minY - p.y) > 1e-6) moved = true;
    positions.set(id, { ...p, x: widened[i].minX, y: widened[i].minY });
  }
  return moved;
}
