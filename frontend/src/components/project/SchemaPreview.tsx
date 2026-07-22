import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import type { ProjectPreview } from "../../types";
import { resolvePointsElk } from "./schemaPreviewLayout";

/**
 * Мини-превью схемы для карточки проекта: РЕАЛЬНАЯ топология корневого уровня
 * (узлы-корни + связи между ними, спроецированные на корневых предков — как
 * ghost-проекция на холсте). Бэкенд отдаёт preview в ответе /projects.
 *
 * Раскладка — тот же движок, что и холст (ELK layered через resolvePointsElk):
 * узлы без сохранённых координат кладёт ELK, сохранённые позиции перезаписывают.
 * Поэтому превью схематично отражает РЕАЛЬНУЮ раскладку (а не декоративный круг).
 * ELK асинхронный (ленивый чанк) — на время раскладки показываем каркас-заглушку.
 * Цвет блока — как на холсте корневого уровня (depth 0): внутренний синий, внешний серый.
 */

interface Props {
  preview: ProjectPreview;
}

const W = 280;
const H = 132;

// C4-палитра корневого уровня (depth 0) — синхронно с graph/colors.ts.
const INTERNAL = { fill: "#1168bd", stroke: "#0d5196" };
const EXTERNAL = { fill: "#7b8794", stroke: "#5a6573" };
const EDGE_STROKE = "#bcd0ee";

interface Placed {
  id: string;
  isExternal: boolean;
  cx: number;
  cy: number;
}

type LayoutResult = { nodes: Placed[]; edges: { source: string; target: string }[] } | null;

// Размер блока подбираем под число узлов, чтобы миниатюра не «забивалась».
function nodeSize(count: number): { w: number; h: number } {
  if (count <= 4) return { w: 46, h: 24 };
  if (count <= 8) return { w: 34, h: 18 };
  return { w: 26, h: 15 };
}

export default function SchemaPreview({ preview }: Props) {
  // undefined = раскладка ещё считается (ELK async), null = пустая схема.
  const [layout, setLayout] = useState<LayoutResult | undefined>(
    preview.nodes.length === 0 ? null : undefined,
  );

  useEffect(() => {
    let cancelled = false;
    void computeLayout(preview).then((r) => {
      if (!cancelled) setLayout(r);
    });
    return () => {
      cancelled = true;
    };
  }, [preview]);

  if (layout === null) {
    return (
      <div style={{ ...frame, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ color: "#94a3b8", fontSize: 12 }}>Пустая схема</span>
      </div>
    );
  }

  // Раскладка ещё считается — каркас-заглушка (фон в точку, без текста, чтобы не
  // мелькало «Пустая схема» на долю секунды до готовности ELK).
  if (layout === undefined) {
    return <div style={frame} />;
  }

  const { nodes, edges } = layout;
  const { w: NODE_W, h: NODE_H } = nodeSize(nodes.length);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  return (
    <div style={frame}>
      <svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        {edges.map((e, i) => {
          const a = byId.get(e.source);
          const b = byId.get(e.target);
          if (!a || !b) return null;
          const midX = (a.cx + b.cx) / 2;
          return (
            <path
              key={i}
              d={`M ${a.cx} ${a.cy} H ${midX} V ${b.cy} H ${b.cx}`}
              fill="none"
              stroke={EDGE_STROKE}
              strokeWidth={1.5}
            />
          );
        })}
        {nodes.map((n) => {
          const c = n.isExternal ? EXTERNAL : INTERNAL;
          return (
            <rect
              key={n.id}
              x={n.cx - NODE_W / 2}
              y={n.cy - NODE_H / 2}
              width={NODE_W}
              height={NODE_H}
              rx={5}
              fill={c.fill}
              stroke={c.stroke}
              strokeWidth={1}
            />
          );
        })}
      </svg>
    </div>
  );
}

// Считает центры узлов в координатах вьюпорта (или null для пустой схемы). Async:
// позиции берёт из ELK (resolvePointsElk), затем вписывает bbox во вьюпорт.
async function computeLayout(preview: ProjectPreview): Promise<LayoutResult> {
  const raw = preview.nodes;
  if (raw.length === 0) return null;

  const { w: NODE_W, h: NODE_H } = nodeSize(raw.length);
  const padX = NODE_W / 2 + 8;
  const padY = NODE_H / 2 + 8;

  // Базовые точки в координатном пространстве холста (ELK + сохранённые позиции).
  const pts = await resolvePointsElk(raw, preview.edges);

  // Вписываем bbox точек в безопасную область вьюпорта, сохраняя пропорции.
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const innerW = W - padX * 2;
  const innerH = H - padY * 2;
  const scale = Math.min(innerW / spanX, innerH / spanY);
  // Центрируем масштабированный bbox во вьюпорте.
  const offX = padX + (innerW - spanX * scale) / 2;
  const offY = padY + (innerH - spanY * scale) / 2;

  const nodes: Placed[] = raw.map((n, i) => ({
    id: n.id,
    isExternal: n.is_external,
    cx: offX + (pts[i].x - minX) * scale,
    cy: offY + (pts[i].y - minY) * scale,
  }));

  return { nodes, edges: preview.edges };
}

const frame: CSSProperties = {
  position: "relative",
  width: "100%",
  height: 132,
  borderRadius: 10,
  overflow: "hidden",
  background:
    "radial-gradient(circle, #d8e0ea 1px, transparent 1px) 0 0 / 16px 16px, #f8fafc",
  border: "1px solid #eef2f6",
};
