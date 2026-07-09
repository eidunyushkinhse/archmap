// ЕДИНЫЙ синтез цепочек предков для детей compound-рамок по RF-узлам.
//
// Модель рамок (computeFrames) видит внешние сущности через их ancestors, но у
// БЛОКА-ребёнка раскрытого ЛОКАЛА (R5) ancestors нет — его принадлежность рамкам
// восстанавливается по цепочке parentId frame-узлов + breadcrumb-префикс. Без
// этого синтеза модель рамки МЕНЬШЕ рисунка (refMaxDepth не видит вложенных колец,
// паддинг нативной границы не прирастает) — ровно это стреляло рассинхроном
// «гость чуть-чуть залезает в видимую рамку» (фикс 2318692).
//
// До 2026-07-09 код жил ТРЕМЯ копиями (boundaries.tsx, useSnapAlignment.levelFrames,
// концептуально pipeline.localFrames) и копии разъезжались. RF-сторона теперь здесь;
// pipeline строит те же цепочки из AppNode-дерева (другой вход) — при правке ОДНОГО
// места проверь и его (pipeline.expandLocal → localFrames).
import type { Node as RFNode } from "@xyflow/react";
import type { AncestorRef } from "../../types";
import type { FrameData } from "./types";

/** breadcrumb-предки уровня как AncestorRef-лайт (для lca в computeFrames важны id). */
export function breadcrumbRefs(ancestorIds: string[], ancestorNames: string[]): AncestorRef[] {
  return ancestorIds.map((id, i) => ({ id, name: ancestorNames[i] ?? id, is_external: false }));
}

/**
 * Цепочки предков для блоков-детей compound-рамок: [{id: блок, ancestors:
 * breadcrumb + цепочка рамок над ним}]. Подмешивается в externals у computeFrames
 * (блок остаётся и в localIds — memberIds это Set, дубль безвреден).
 */
export function framedBlockRefs(
  rfNodes: RFNode[],
  ancestorIds: string[],
  ancestorNames: string[],
): { id: string; ancestors: AncestorRef[] }[] {
  const frameNodes = new Map(rfNodes.filter((n) => n.type === "frame").map((n) => [n.id, n]));
  const bcRefs = breadcrumbRefs(ancestorIds, ancestorNames);
  const frameChain = (startId: string | undefined): AncestorRef[] => {
    const chain: AncestorRef[] = [];
    for (let cur = startId ? frameNodes.get(startId) : undefined; cur;
      cur = cur.parentId ? frameNodes.get(cur.parentId) : undefined) {
      // имя рамки не участвует в членстве/глубине; берём из data, фолбэк — id
      chain.unshift({ id: cur.id, name: (cur.data as FrameData).name ?? cur.id, is_external: false });
    }
    return chain;
  };
  return rfNodes
    .filter((b) => b.type === "block" && b.parentId && frameNodes.has(b.parentId))
    .map((b) => ({ id: b.id, ancestors: [...bcRefs, ...frameChain(b.parentId!)] }));
}
