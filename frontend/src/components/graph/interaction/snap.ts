// Чистые хелперы магнитного выравнивания при драге узла/превью: совпадение центров
// (snapCenter) + равные зазоры между соседями в линии (distribution, snapNode).
import type { Node as RFNode } from "@xyflow/react";
import { SNAP_THRESHOLD, NODE_W, NODE_H } from "../constants";
import { absPositionOf } from "../absPos";
import { distributeAxis, type LineBox, type SpacingGuide } from "./distribute";

// Фактический размер узла: берём измеренный React Flow, иначе заданный явно,
// иначе дефолт. Нужен для выравнивания по центру при узлах разного размера.
export function nodeSize(n: RFNode | undefined): { w: number; h: number } {
  return {
    w: n?.measured?.width ?? n?.width ?? NODE_W,
    h: n?.measured?.height ?? n?.height ?? NODE_H,
  };
}

// Узлы-соседи для магнита: рамки и распорки не участвуют (рамка — не «сосед», её
// центр как магнит бессмыслен). Дети compound-рамок участвуют АБСОЛЮТНЫМИ центрами.
const isSnapPeer = (n: RFNode): boolean => n.type !== "frame" && n.type !== "spacer";

// Магнитное выравнивание по ЦЕНТРУ: для центра (cx, cy) ищем ближайшего по X и по Y
// соседа из rfNodes и, если он ближе SNAP_THRESHOLD, «прилипаем» центром к нему.
// Оси независимы. Возвращаем притянутый центр и флаги попадания (для направляющих).
// Используется и при перетаскивании существующего узла (excludeId — он сам), и при
// перетаскивании превью нового узла из палитры (excludeId не задан).
// Оптимизация (2026-07-21): byId передаётся извне (один раз на кадр), чтобы не
// создавать Map многократно при мультидраге.
export function snapCenter(
  cx: number, cy: number, rfNodes: RFNode[], excludeId?: string,
  byId?: Map<string, RFNode>,
): { snapCx: number; snapCy: number; hitX: boolean; hitY: boolean } {
  let snapCx = cx, snapCy = cy;
  let bestDx = SNAP_THRESHOLD, bestDy = SNAP_THRESHOLD;
  let hitX = false, hitY = false;
  const nodeById = byId ?? new Map(rfNodes.map((n) => [n.id, n]));
  for (const other of rfNodes) {
    if ((excludeId && other.id === excludeId) || !isSnapPeer(other)) continue;
    const { w: ow, h: oh } = nodeSize(other);
    const op = absPositionOf(other, nodeById);
    const ocx = op.x + ow / 2;
    const ocy = op.y + oh / 2;
    const dx = Math.abs(ocx - cx);
    if (dx <= bestDx) { bestDx = dx; snapCx = ocx; hitX = true; }
    const dy = Math.abs(ocy - cy);
    if (dy <= bestDy) { bestDy = dy; snapCy = ocy; hitY = true; }
  }
  return { snapCx, snapCy, hitX, hitY };
}

export interface SnapResult {
  snapCx: number; snapCy: number;
  hitX: boolean; hitY: boolean;
  // Distribution-индикаторы (равные зазоры): что подсветить, если сработал снап по
  // зазорам. По оси, где снап по зазорам применён, центр-выравнивание не срабатывало.
  spacing: SpacingGuide[];
}

// Полный снап узла: сначала выравнивание по ЦЕНТРУ соседа (snapCenter), затем —
// на осях, где центр не сработал, снап по РАВНЫМ ЗАЗОРАМ. Горизонтальный ряд снапит
// X (зазоры вдоль X, линия общая по Y → cross = snapCy после центр-снапа), вертикальный
// ряд — Y (cross = snapCx). Центр-выравнивание приоритетнее: distribution применяем
// только там, где центр свободен (главная ось ряда обычно как раз свободна).
// Оптимизация (2026-07-21): byId передаётся извне (один раз на кадр).
export function snapNode(
  cx: number, cy: number, w: number, h: number, rfNodes: RFNode[], excludeId?: string,
  byId?: Map<string, RFNode>,
): SnapResult {
  const nodeById = byId ?? new Map(rfNodes.map((n) => [n.id, n]));
  const { snapCx, snapCy, hitX, hitY } = snapCenter(cx, cy, rfNodes, excludeId, nodeById);

  // Боксы соседей (без самого узла) в АБСОЛЮТНЫХ координатах графа
  const boxes: { cx: number; cy: number; w: number; h: number }[] = [];
  for (const n of rfNodes) {
    if ((excludeId && n.id === excludeId) || !isSnapPeer(n)) continue;
    const { w: ow, h: oh } = nodeSize(n);
    const p = absPositionOf(n, nodeById);
    boxes.push({ cx: p.x + ow / 2, cy: p.y + oh / 2, w: ow, h: oh });
  }

  let outCx = snapCx, outCy = snapCy;
  const spacing: SpacingGuide[] = [];

  // Горизонтальный ряд: главная ось X, линия по Y (cross = выровненный центр snapCy).
  if (!hitX) {
    const rowBoxes: LineBox[] = boxes.map((b) => ({ main: b.cx, size: b.w, cross: b.cy }));
    const hit = distributeAxis(cx, w, snapCy, rowBoxes, SNAP_THRESHOLD);
    if (hit) {
      outCx = hit.snap;
      spacing.push({ axis: "x", cross: snapCy, gap: hit.gap, segments: [hit.ref, hit.fresh] });
    }
  }
  // Вертикальный ряд: главная ось Y, линия по X (cross = выровненный центр snapCx).
  if (!hitY) {
    const colBoxes: LineBox[] = boxes.map((b) => ({ main: b.cy, size: b.h, cross: b.cx }));
    const hit = distributeAxis(cy, h, snapCx, colBoxes, SNAP_THRESHOLD);
    if (hit) {
      outCy = hit.snap;
      spacing.push({ axis: "y", cross: snapCx, gap: hit.gap, segments: [hit.ref, hit.fresh] });
    }
  }

  return { snapCx: outCx, snapCy: outCy, hitX, hitY, spacing };
}
