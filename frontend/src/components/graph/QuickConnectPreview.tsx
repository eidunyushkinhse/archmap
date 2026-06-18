// Превью «быстрой связи»: полупрозрачная чёрная стрелка с дефолтными изломами от хэндла
// источника к автоопределённой цели. Рендерится в ViewportPortal (координаты графа), поэтому
// масштабируется вместе с холстом. pointer-events:none — превью не перехватывает курсор,
// клик ловит сама стрелка-кнопка у хэндла (см. nodes.tsx / LevelGraph).
//
// SVG позиционируем по bounding box пути (с запасом под наконечник/обводку) и рисуем путь в
// ЛОКАЛЬНЫХ координатах бокса: SVG нулевого размера с overflow:visible красит overflow не во
// всех браузерах надёжно, а бокс по контенту — кросс-браузерно.
import type { EdgePoint } from "../../types";

const COLOR = "rgba(15, 23, 42, 0.45)"; // полупрозрачный «почти чёрный» (slate-900)
const PAD = 16; // запас под наконечник и толщину линии

export default function QuickConnectPreview({ points }: { points: EdgePoint[] }) {
  if (points.length < 2) return null;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const maxX = Math.max(...xs), maxY = Math.max(...ys);
  const w = maxX - minX + PAD * 2, h = maxY - minY + PAD * 2;
  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x - minX + PAD} ${p.y - minY + PAD}`)
    .join(" ");
  return (
    <svg
      width={w}
      height={h}
      style={{
        position: "absolute", left: minX - PAD, top: minY - PAD,
        overflow: "visible", pointerEvents: "none", zIndex: 4,
      }}
    >
      <defs>
        <marker
          id="lg-qc-arrow"
          markerWidth="12.5"
          markerHeight="12.5"
          viewBox="-10 -10 20 20"
          refX="0"
          refY="0"
          orient="auto-start-reverse"
          markerUnits="strokeWidth"
        >
          <polyline
            points="-5,-4 0,0 -5,4 -5,-4"
            stroke={COLOR}
            fill={COLOR}
            strokeWidth="1"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </marker>
      </defs>
      <path
        d={d}
        fill="none"
        stroke={COLOR}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="6 4"
        markerEnd="url(#lg-qc-arrow)"
      />
    </svg>
  );
}
