// Абсолютная позиция RF-узла в координатах вида (R4, compound-рамки): дети
// раскрытых гостевых рамок несут position ОТНОСИТЕЛЬНО родителя (parentId),
// поэтому абсолют = сумма цепочки родителей. Для top-level узлов — сама position.
// Чистый helper для мест, которые читают позиции из rfNodes (нативные рамки,
// снап, персист) и должны работать в единой системе координат вида.
import type { Node as RFNode } from "@xyflow/react";

export function absPositionOf(
  n: RFNode,
  byId: Map<string, RFNode>,
): { x: number; y: number } {
  let x = n.position.x;
  let y = n.position.y;
  let p = n.parentId ? byId.get(n.parentId) : undefined;
  while (p) {
    x += p.position.x;
    y += p.position.y;
    p = p.parentId ? byId.get(p.parentId) : undefined;
  }
  return { x, y };
}
