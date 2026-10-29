// Границы уровней (C4-подобные вложенные boundary) и центральные направляющие
// магнитного выравнивания. Оба рендерятся через ViewportPortal — в координатах графа.
// Геометрия рамок (членство + прямоугольники) живёт в layout/frames.ts — единый
// источник правды, общий с энфорсом запрета проникновения гостей (keepGhostsOut.ts).
import { Fragment } from "react";
import type { Node as RFNode } from "@xyflow/react";
import { computeFrames, frameLocalIds, EMPTY_LEVEL_MEMBER, EMPTY_LEVEL_ORIGIN } from "./layout/frames";
import FramePlaque from "./FramePlaque";
import { frameStyle } from "./frameStyle";
import { framedBlockRefs } from "./frameChains";
import { absPositionOf } from "./absPos";
import type { GhostData, ContainerData } from "./types";
import type { SpacingGuide } from "./interaction/distribute";
import type { AncestorRef } from "../../types";

/**
 * НАТИВНЫЕ рамки уровней (C4-boundary): по одной на каждого предка из breadcrumb,
 * пунктирный прямоугольник вокруг bbox всех отображаемых членов. Живой bbox-follow:
 * пересчитывается на каждый рендер rfNodes, поэтому рамка растёт за перетаскиваемым
 * узлом. Рендерится через ViewportPortal — в координатах графа, пан/зум с узлами.
 * Плашка с именем — в слое плашек подписей (FramePlaque, CV33): над линиями стрелок,
 * под блоками, как у compound-рамок.
 * РАСКРЫТЫЕ гостевые рамки здесь больше не рисуются (R4): они — настоящие
 * compound-узлы RF (type "frame", см. nodes.tsx), их rect задаёт раскладка.
 */
export function LevelBoundary({
  rfNodes, ancestorIds, ancestorNames,
}: {
  rfNodes: RFNode[]; ancestorIds: string[]; ancestorNames: string[];
}) {
  if (ancestorIds.length === 0) return null;
  const blocks = rfNodes.filter((n) => n.type === "block");
  // внешние отображаемые узлы: гости (leaf) и свёрнутые контейнеры
  const externals = rfNodes.filter((n) => n.type === "ghost" || n.type === "container");
  // ПУСТОЙ УРОВЕНЬ: рамка родителя рисуется всегда, вокруг синтетического бокса
  // (frames.ts). Признак берём не из «блоков ноль», а из наличия узла-якоря рамки:
  // так решение принимает раскладка, и рамка не мигает на полпути загрузки уровня,
  // пока узлы ещё не приехали.
  const emptyLevel = blocks.length === 0 && rfNodes.some((n) => n.type === "framedock");
  if (blocks.length === 0 && !emptyLevel) return null;

  const extAncestors = (n: RFNode): AncestorRef[] =>
    n.type === "ghost"
      ? (n.data as GhostData).appNode.ancestors ?? []
      : ((n.data as ContainerData).ancestors ?? []);

  // Дети раскрытых ЛОКАЛОВ (R5) — блоки, их принадлежность рамкам computeFrames по
  // externals не видит (у блока нет ancestors). Без синтеза цепочек кольца нативных
  // границ схлопываются (см. frameChains.ts — единый источник, общий с живыми
  // клампами useSnapAlignment).
  const framedBlocks = framedBlockRefs(rfNodes, ancestorIds, ancestorNames);

  // Позиции — АБСОЛЮТНЫЕ: дети compound-рамок несут относительные координаты (R4).
  const byId = new Map(rfNodes.map((n) => [n.id, n]));
  const rects = computeFrames({
    localIds: frameLocalIds(blocks.map((b) => b.id), ancestorIds),
    externals: [
      ...externals.map((n) => ({ id: n.id, ancestors: extAncestors(n) })),
      ...framedBlocks,
    ],
    pos: (id) => {
      if (id === EMPTY_LEVEL_MEMBER) return EMPTY_LEVEL_ORIGIN;
      const n = byId.get(id);
      return n ? absPositionOf(n, byId) : undefined;
    },
    ancestorIds, ancestorNames,
  }).filter((f) => f.native);

  return (
    <>
      {rects.map((f) => {
        const r = f.rect;
        return (
          <Fragment key={f.id}>
            <div
              // класс — стабильный хук для полигона (scripts/dump-levels.mjs): рамки
              // входят в структурную сигнатуру уровня
              className="lg-frame"
              data-frame-id={f.id}
              style={{
                position: "absolute", left: r.x, top: r.y, width: r.w, height: r.h,
                // вид — общий с compound-рамкой и оверлеем драга (frameStyle.ts)
                ...frameStyle(),
                pointerEvents: "none",
              }}
            />
            <FramePlaque frameId={f.id} x={r.x} bottom={r.y + r.h} interactive={false}>
              {f.name}
            </FramePlaque>
          </Fragment>
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
