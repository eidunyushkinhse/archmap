// Границы уровней (C4-подобные вложенные boundary) и центральные направляющие
// магнитного выравнивания. Оба рендерятся через ViewportPortal — в координатах графа.
// Геометрия рамок (членство + прямоугольники) живёт в layout/frames.ts — единый
// источник правды, общий с энфорсом запрета проникновения гостей (keepGhostsOut.ts).
import type { Node as RFNode } from "@xyflow/react";
import { computeFrames } from "./layout/frames";
import type { GhostData, ContainerData } from "./types";
import type { SpacingGuide } from "./interaction/distribute";
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

// Цвет/размер индикаторов равных зазоров (distribution-снап).
const SPACING_COLOR = "#e635c5";
const TICK = 6; // длина концевой засечки зазора (в координатах графа)

// Индикатор одного равного зазора: тонкая линия вдоль оси ряда + концевые засечки
// поперёк. axis — направление зазора, cross — постоянная координата линии ряда.
function GapMark(
  { axis, cross, start, end }: { axis: "x" | "y"; cross: number; start: number; end: number },
) {
  const base = { position: "absolute" as const, pointerEvents: "none" as const, zIndex: 5 };
  const line = `1px solid ${SPACING_COLOR}`;
  if (axis === "x") {
    return (
      <>
        <div style={{ ...base, left: start, top: cross, width: end - start, height: 0, borderTop: line }} />
        <div style={{ ...base, left: start, top: cross - TICK / 2, width: 0, height: TICK, borderLeft: line }} />
        <div style={{ ...base, left: end, top: cross - TICK / 2, width: 0, height: TICK, borderLeft: line }} />
      </>
    );
  }
  return (
    <>
      <div style={{ ...base, top: start, left: cross, height: end - start, width: 0, borderLeft: line }} />
      <div style={{ ...base, top: start, left: cross - TICK / 2, height: 0, width: TICK, borderTop: line }} />
      <div style={{ ...base, top: end, left: cross - TICK / 2, height: 0, width: TICK, borderTop: line }} />
    </>
  );
}

// Центральные направляющие при магнитном выравнивании + индикаторы равных зазоров
// (distribution-снап). Рендерятся внутри ViewportPortal, поэтому координаты — в
// системе графа. Линии тонкие, длинные (перекрывают видимую область при любом
// зуме/панораме).
export function AlignmentGuides(
  { x, y, spacing = [] }: { x: number | null; y: number | null; spacing?: SpacingGuide[] },
) {
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
      {spacing.flatMap((g, gi) =>
        g.segments.map((s, si) => (
          <GapMark key={`${gi}-${si}`} axis={g.axis} cross={g.cross} start={s.start} end={s.end} />
        )),
      )}
    </>
  );
}
