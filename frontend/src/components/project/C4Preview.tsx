import { useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { NODE_W, NODE_H } from "../graph/constants";
import { NodeShapeSvg, contentPadding } from "../graph/shapes";
import { getNodeColors, STATUS_META } from "../graph/colors";
import type { TemplateOut, TemplateNode } from "../../types";

/**
 * Достоверный мини-рендер схемы стартового шаблона для витрины создания проекта:
 * HTML-узлы реального размера (190×100) в «сцене», вписанной в бокс через
 * transform: scale. Формы (NodeShapeSvg/contentPadding) и палитра (getNodeColors)
 * переиспользуются с холста — узел выглядит 1:1 как на канве, а координаты
 * каталога совпадают с сидом, поэтому превью = будущая раскладка проекта.
 */

const EDGE = STATUS_META.existing.edge; // #94a3b8

type Placed = TemplateNode & { _x: number; _y: number };

function PreviewNode({ node }: { node: Placed }) {
  const c = getNodeColors(node.is_external, 0);
  const label =
    node.role && node.technology ? `${node.role}: ${node.technology}` : node.role || node.technology || "";
  return (
    <div style={{ position: "absolute", left: node._x, top: node._y, width: NODE_W, height: NODE_H, color: c.text }}>
      <NodeShapeSvg shape={node.shape} bg={c.bg} stroke={c.border} />
      <div style={{ position: "relative", zIndex: 1, height: "100%", boxSizing: "border-box", overflow: "hidden", ...contentPadding(node.shape, false) }}>
        <div style={{ fontWeight: 600, fontSize: 14.5, lineHeight: 1.2, marginBottom: 6,
          display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden" }}>
          {node.name}
        </div>
        {label && (
          <span style={{ display: "inline-block", padding: "1.5px 8px", borderRadius: 10, fontSize: 12,
            background: "rgba(255,255,255,0.22)", color: c.text, whiteSpace: "nowrap",
            maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}>
            {label}
          </span>
        )}
      </div>
    </div>
  );
}

// Ортогональная трасса ребра между центрами узлов: доминирующая ось решает,
// с какой стороны выйти/войти; излом — посередине свободного пролёта.
type Dir = "right" | "left" | "down" | "up";
function routeEdge(s: Placed, t: Placed) {
  const hw = NODE_W / 2, hh = NODE_H / 2;
  const sx = s._x + hw, sy = s._y + hh, tx = t._x + hw, ty = t._y + hh;
  const dx = tx - sx, dy = ty - sy;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const sgn = dx >= 0 ? 1 : -1;
    const sx0 = sx + sgn * hw, tx0 = tx - sgn * hw, mx = (sx0 + tx0) / 2;
    return { d: `M ${sx0} ${sy} H ${mx} V ${ty} H ${tx0}`,
      arrow: { x: tx0, y: ty, dir: (sgn > 0 ? "right" : "left") as Dir }, mid: { x: mx, y: (sy + ty) / 2 } };
  }
  const sgn = dy >= 0 ? 1 : -1;
  const sy0 = sy + sgn * hh, ty0 = ty - sgn * hh, my = (sy0 + ty0) / 2;
  return { d: `M ${sx} ${sy0} V ${my} H ${tx} V ${ty0}`,
    arrow: { x: tx, y: ty0, dir: (sgn > 0 ? "down" : "up") as Dir }, mid: { x: (sx + tx) / 2, y: my } };
}
function arrowPoints({ x, y, dir }: { x: number; y: number; dir: Dir }) {
  const a = 8, b = 4.2;
  if (dir === "right") return `${x},${y} ${x - a},${y - b} ${x - a},${y + b}`;
  if (dir === "left") return `${x},${y} ${x + a},${y - b} ${x + a},${y + b}`;
  if (dir === "down") return `${x},${y} ${x - b},${y - a} ${x + b},${y - a}`;
  return `${x},${y} ${x - b},${y + a} ${x + b},${y + a}`;
}

interface Props {
  template: TemplateOut;
  height: number;
  width?: number; // если не задан — меряем контейнер (ResizeObserver)
  showLabels?: boolean;
  pad?: number;
}

export default function C4Preview({ template, height, width, showLabels = false, pad = 22 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Замер ширины контейнера нужен только при width=auto; заданный width не
  // зеркалим в стейт (производное — в рендере), а первичный замер отдаёт сам
  // ResizeObserver: по спеке колбэк стреляет при observe() ещё до paint.
  const [measW, setMeasW] = useState(0);
  useLayoutEffect(() => {
    if (typeof width === "number") return;
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setMeasW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  const ns = template.nodes;
  const minX = Math.min(...ns.map((n) => n.x));
  const minY = Math.min(...ns.map((n) => n.y));
  const spanX = Math.max(...ns.map((n) => n.x + NODE_W)) - minX;
  const spanY = Math.max(...ns.map((n) => n.y + NODE_H)) - minY;
  const W = typeof width === "number" ? width : measW;
  const scale = W > 0 ? Math.min((W - pad * 2) / spanX, (height - pad * 2) / spanY) : 0;
  const offX = (W - spanX * scale) / 2;
  const offY = (height - spanY * scale) / 2;

  const placed: Placed[] = ns.map((n) => ({ ...n, _x: n.x - minX, _y: n.y - minY }));
  const byKey = Object.fromEntries(placed.map((n) => [n.key, n]));
  const routes = template.edges.map((e) => ({ e, r: routeEdge(byKey[e.source], byKey[e.target]) }));

  return (
    <div ref={ref} style={{ ...frame, width: width ?? "100%", height }}>
      {scale > 0 && (
        <div style={{ position: "absolute", left: offX, top: offY, width: spanX, height: spanY,
          transform: `scale(${scale})`, transformOrigin: "top left" }}>
          {/* стрелки первыми — узлы рисуются ПОВЕРХ, наконечник подходит к границе */}
          <svg width={spanX} height={spanY} style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }}>
            {routes.map(({ r }, i) => (
              <g key={i}>
                <path d={r.d} fill="none" stroke={EDGE} strokeWidth={1.6} />
                <polygon points={arrowPoints(r.arrow)} fill={EDGE} />
              </g>
            ))}
          </svg>
          {showLabels && routes.map(({ e, r }, i) => e.label && (
            <div key={i} style={{ position: "absolute", left: r.mid.x, top: r.mid.y, transform: "translate(-50%,-50%)",
              background: "#fff", border: "1px solid #e2e8f0", borderRadius: 5, padding: "1px 6px",
              fontSize: 11.5, lineHeight: 1.35, color: "#475569", whiteSpace: "nowrap",
              boxShadow: "0 1px 2px rgba(15,23,42,.05)" }}>
              {e.label}
            </div>
          ))}
          {placed.map((n) => <PreviewNode key={n.key} node={n} />)}
        </div>
      )}
    </div>
  );
}

const frame: CSSProperties = {
  position: "relative", borderRadius: 10, overflow: "hidden",
  background: "radial-gradient(circle, #d8e0ea 1px, transparent 1px) 0 0 / 16px 16px, #f8fafc",
  border: "1px solid #eef2f6",
};
