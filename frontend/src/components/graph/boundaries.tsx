// Границы уровней (C4-подобные вложенные boundary) и центральные направляющие
// магнитного выравнивания. Оба рендерятся через ViewportPortal — в координатах графа.
import type { Node as RFNode } from "@xyflow/react";
import {
  NODE_W, NODE_H,
  BOUNDARY_PAD, BOUNDARY_STEP, BOUNDARY_LABEL_PAD, BOUNDARY_LABEL_STEP,
} from "./constants";
import type { GhostData, ContainerData } from "./types";
import type { AncestorRef } from "../../types";

interface FrameDef {
  id: string;
  name: string;
  depth: number;          // 0 — самый внешний предок; глубже → меньше отступ
  memberIds: Set<string>; // id отображаемых узлов-потомков этого контейнера
}

/**
 * Рамки уровней (C4-boundary). Для каждого контейнера рисуется пунктирный
 * прямоугольник вокруг bbox всех его отображаемых узлов-потомков. Контейнеры:
 *  - предки из breadcrumb (ancestorIds/Names, корень → непосредственный родитель);
 *  - промежуточные контейнеры гостей между общим предком и гостем — «условно-
 *    гостевые» рамки (показывают иерархию: гость лежит в своём контейнере).
 * Так гость (напр. Zabbix Web) попадает внутрь рамки общего предка (HelixMon),
 * внутри подрамки своего родителя (ProdMon). Гость без общего предка-рамки
 * (общий предок только корень) остаётся снаружи.
 * Рендерится через ViewportPortal — в координатах графа, пан/зум вместе с узлами.
 */
export function LevelBoundary({
  rfNodes, ancestorIds, ancestorNames, expanded, onCollapse,
}: {
  rfNodes: RFNode[]; ancestorIds: string[]; ancestorNames: string[];
  expanded: Set<string>; onCollapse: (id: string) => void;
}) {
  if (ancestorIds.length === 0) return null;
  const blocks = rfNodes.filter((n) => n.type === "block");
  // внешние отображаемые узлы: гости (leaf) и свёрнутые контейнеры
  const externals = rfNodes.filter((n) => n.type === "ghost" || n.type === "container");
  if (blocks.length === 0) return null;

  const extAncestors = (n: RFNode): AncestorRef[] =>
    n.type === "ghost"
      ? (n.data as GhostData).appNode.ancestors ?? []
      : ((n.data as ContainerData).ancestors ?? []);

  const localIds = blocks.map((b) => b.id);
  const bcIndex = new Map(ancestorIds.map((id, i) => [id, i]));

  const frames = new Map<string, FrameDef>();
  // breadcrumb-рамки: локальные узлы — потомки каждого предка
  ancestorIds.forEach((id, i) => {
    frames.set(id, { id, name: ancestorNames[i], depth: i, memberIds: new Set(localIds) });
  });

  for (const g of externals) {
    const anc = extAncestors(g);
    // общий предок = самый глубокий breadcrumb-предок среди предков
    let lcaIdx = -1, lcaPos = -1;
    anc.forEach((a, pos) => {
      const idx = bcIndex.get(a.id);
      if (idx !== undefined && idx > lcaIdx) { lcaIdx = idx; lcaPos = pos; }
    });
    if (lcaIdx === -1) continue; // нет общего предка-рамки → снаружи
    // узел — член breadcrumb-рамок до общего предка включительно
    for (let i = 0; i <= lcaIdx; i++) frames.get(ancestorIds[i])!.memberIds.add(g.id);
    // промежуточные контейнеры (ниже общего предка) — рамки развёрнутых контейнеров
    for (let pos = lcaPos + 1; pos < anc.length; pos++) {
      const a = anc[pos];
      const depth = lcaIdx + (pos - lcaPos);
      if (!frames.has(a.id)) frames.set(a.id, { id: a.id, name: a.name, depth, memberIds: new Set() });
      frames.get(a.id)!.memberIds.add(g.id);
    }
  }

  const posById = new Map(rfNodes.map((n) => [n.id, n.position]));
  const maxDepth = Math.max(...[...frames.values()].map((f) => f.depth));

  const rects = [...frames.values()].map((f) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of f.memberIds) {
      const p = posById.get(id);
      if (!p) continue;
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H);
    }
    if (!isFinite(minX)) return null;
    const pad = BOUNDARY_PAD + (maxDepth - f.depth) * BOUNDARY_STEP;
    // рамку растягиваем вниз сильнее, чем по остальным сторонам, чтобы подпись получила
    // свою полосу под содержимым. Внешним рамкам (меньший depth) добавка больше — так их
    // подпись уходит ниже нижнего края вложенных рамок и не царапает их.
    const labelPad = BOUNDARY_LABEL_PAD + (maxDepth - f.depth) * BOUNDARY_LABEL_STEP;
    return {
      id: f.id, name: f.name, depth: f.depth,
      x: minX - pad, y: minY - pad,
      w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad + labelPad,
    };
  }).filter((r): r is NonNullable<typeof r> => r !== null);

  // внешние рамки (меньший depth) рисуем первыми — под внутренними
  rects.sort((a, b) => a.depth - b.depth);

  return (
    <>
      {rects.map((r) => {
        const collapsible = expanded.has(r.id); // развёрнутый контейнер — можно свернуть
        return (
          <div
            key={r.id}
            style={{
              position: "absolute", left: r.x, top: r.y, width: r.w, height: r.h,
              border: "1px dashed #9ca3af", borderRadius: 12, background: "transparent",
              boxSizing: "border-box", pointerEvents: "none",
            }}
          >
            <div
              className={collapsible ? "nodrag nopan" : undefined}
              onClick={collapsible ? () => onCollapse(r.id) : undefined}
              title={collapsible ? "Свернуть" : undefined}
              style={{
                position: "absolute", left: 10, bottom: 8, fontSize: 12, fontWeight: 600,
                color: "#64748b", background: "#fff", padding: "2px 8px", borderRadius: 5,
                border: "1px solid #e5e7eb", whiteSpace: "nowrap",
                pointerEvents: collapsible ? "auto" : "none",
                cursor: collapsible ? "pointer" : "default",
              }}
            >
              {collapsible ? `🔍 ${r.name} ✕` : r.name}
            </div>
          </div>
        );
      })}
    </>
  );
}

// Центральные направляющие при магнитном выравнивании. Рендерятся внутри
// ViewportPortal, поэтому координаты — в системе графа. Линии тонкие, длинные
// (перекрывают видимую область при любом зуме/панораме).
export function AlignmentGuides({ x, y }: { x: number | null; y: number | null }) {
  const SPAN = 1_000_000; // заведомо больше любого практического холста
  return (
    <>
      {x != null && (
        <div
          style={{
            position: "absolute", left: x, top: -SPAN / 2, width: 0, height: SPAN,
            borderLeft: "1px solid #22c55e", pointerEvents: "none", zIndex: 4,
          }}
        />
      )}
      {y != null && (
        <div
          style={{
            position: "absolute", top: y, left: -SPAN / 2, height: 0, width: SPAN,
            borderTop: "1px solid #22c55e", pointerEvents: "none", zIndex: 4,
          }}
        />
      )}
    </>
  );
}
