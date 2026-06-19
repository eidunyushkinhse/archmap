import type { CSSProperties } from "react";
import { useMemo } from "react";
import type { ProjectPreview } from "../../types";

/**
 * Мини-превью схемы для карточки проекта: РЕАЛЬНАЯ топология корневого уровня
 * (узлы-корни + связи между ними, спроецированные на корневых предков — как
 * ghost-проекция на холсте). Бэкенд отдаёт preview в ответе /projects.
 *
 * Раскладка: если у всех узлов есть сохранённые координаты холста — берём их
 * (вписываем bbox во вьюпорт). Иначе раскладываем сами по окружности (порядок
 * узлов детерминированный — бэкенд сортирует по связности). Цвет блока — как на
 * холсте корневого уровня (depth 0): внутренний синий, внешний серый.
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

// Размер блока подбираем под число узлов, чтобы миниатюра не «забивалась».
function nodeSize(count: number): { w: number; h: number } {
  if (count <= 4) return { w: 46, h: 24 };
  if (count <= 8) return { w: 34, h: 18 };
  return { w: 26, h: 15 };
}

export default function SchemaPreview({ preview }: Props) {
  const layout = useMemo(() => computeLayout(preview), [preview]);

  if (layout === null) {
    return (
      <div style={{ ...frame, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ color: "#94a3b8", fontSize: 12 }}>Пустая схема</span>
      </div>
    );
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

// Считает центры узлов в координатах вьюпорта (или null для пустой схемы).
function computeLayout(
  preview: ProjectPreview,
): { nodes: Placed[]; edges: { source: string; target: string }[] } | null {
  const raw = preview.nodes;
  if (raw.length === 0) return null;

  const { w: NODE_W, h: NODE_H } = nodeSize(raw.length);
  const padX = NODE_W / 2 + 8;
  const padY = NODE_H / 2 + 8;

  const allPositioned = raw.every((n) => n.x !== null && n.y !== null);
  // Базовые точки в произвольном пространстве: сохранённые координаты холста либо
  // окружность (детерминированный порядок — бэкенд уже отсортировал узлы).
  const pts = allPositioned
    ? raw.map((n) => ({ x: n.x as number, y: n.y as number }))
    : raw.map((_, i) => {
        if (raw.length === 1) return { x: 0, y: 0 };
        const a = (i / raw.length) * Math.PI * 2 - Math.PI / 2;
        return { x: Math.cos(a), y: Math.sin(a) };
      });

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
