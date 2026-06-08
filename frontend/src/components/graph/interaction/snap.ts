// Чистые хелперы магнитного выравнивания по центру при драге узла/превью.
import type { Node as RFNode } from "@xyflow/react";
import { SNAP_THRESHOLD, NODE_W, NODE_H } from "../constants";

// Фактический размер узла: берём измеренный React Flow, иначе заданный явно,
// иначе дефолт. Нужен для выравнивания по центру при узлах разного размера.
export function nodeSize(n: RFNode | undefined): { w: number; h: number } {
  return {
    w: n?.measured?.width ?? n?.width ?? NODE_W,
    h: n?.measured?.height ?? n?.height ?? NODE_H,
  };
}

// Магнитное выравнивание по ЦЕНТРУ: для центра (cx, cy) ищем ближайшего по X и по Y
// соседа из rfNodes и, если он ближе SNAP_THRESHOLD, «прилипаем» центром к нему.
// Оси независимы. Возвращаем притянутый центр и флаги попадания (для направляющих).
// Используется и при перетаскивании существующего узла (excludeId — он сам), и при
// перетаскивании превью нового узла из палитры (excludeId не задан).
export function snapCenter(
  cx: number, cy: number, rfNodes: RFNode[], excludeId?: string,
): { snapCx: number; snapCy: number; hitX: boolean; hitY: boolean } {
  let snapCx = cx, snapCy = cy;
  let bestDx = SNAP_THRESHOLD, bestDy = SNAP_THRESHOLD;
  let hitX = false, hitY = false;
  for (const other of rfNodes) {
    if (excludeId && other.id === excludeId) continue;
    const { w: ow, h: oh } = nodeSize(other);
    const ocx = other.position.x + ow / 2;
    const ocy = other.position.y + oh / 2;
    const dx = Math.abs(ocx - cx);
    if (dx <= bestDx) { bestDx = dx; snapCx = ocx; hitX = true; }
    const dy = Math.abs(ocy - cy);
    if (dy <= bestDy) { bestDy = dy; snapCy = ocy; hitY = true; }
  }
  return { snapCx, snapCy, hitX, hitY };
}
