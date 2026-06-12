// Границы уровней (C4-подобные вложенные boundary) и центральные направляющие
// магнитного выравнивания. Оба рендерятся через ViewportPortal — в координатах графа.
// Геометрия рамок (членство + прямоугольники) живёт в layout/frames.ts — единый
// источник правды, общий с энфорсом запрета проникновения гостей (keepGhostsOut.ts).
import type { Node as RFNode } from "@xyflow/react";
import { computeFrames } from "./layout/frames";
import type { GhostData, ContainerData } from "./types";
import type { AncestorRef } from "../../types";

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

  const posById = new Map(rfNodes.map((n) => [n.id, n.position]));
  const rects = computeFrames({
    localIds: blocks.map((b) => b.id),
    externals: externals.map((n) => ({ id: n.id, ancestors: extAncestors(n) })),
    pos: (id) => posById.get(id),
    ancestorIds, ancestorNames,
  });

  return (
    <>
      {rects.map((f) => {
        const r = f.rect;
        const collapsible = expanded.has(f.id); // развёрнутый контейнер — можно свернуть
        return (
          <div
            key={f.id}
            style={{
              position: "absolute", left: r.x, top: r.y, width: r.w, height: r.h,
              border: "1px dashed #9ca3af", borderRadius: 12, background: "transparent",
              boxSizing: "border-box", pointerEvents: "none",
            }}
          >
            <div
              className={collapsible ? "nodrag nopan" : undefined}
              onClick={collapsible ? () => onCollapse(f.id) : undefined}
              title={collapsible ? "Свернуть" : undefined}
              style={{
                position: "absolute", left: 10, bottom: 8, fontSize: 12, fontWeight: 600,
                color: "#64748b", background: "#fff", padding: "2px 8px", borderRadius: 5,
                border: "1px solid #e5e7eb", whiteSpace: "nowrap",
                pointerEvents: collapsible ? "auto" : "none",
                cursor: collapsible ? "pointer" : "default",
              }}
            >
              {collapsible ? `🔍 ${f.name} ✕` : f.name}
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
