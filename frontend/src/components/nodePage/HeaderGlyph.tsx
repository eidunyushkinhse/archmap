// Глиф объекта в шапке страницы (аудит F-5: вынесен из NodePage).
import type { NodeShape, TreeNesting } from "../../types";

// Глиф для шапки страницы (20×20, белый на цветном фоне) — тот же словарь, что в строке
// дерева (nodeTree.shared.ShapeGlyph): система и составной компонент — пунктирный
// прямоугольник, контейнер с компонентами — «коробка с крышкой», остальное — форма.
export default function HeaderGlyph({ shape, nesting }: { shape: NodeShape; nesting: TreeNesting }) {
  const c = {
    fill: "none",
    stroke: "#fff",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  let body: React.ReactNode;
  if (nesting === "system" || nesting === "component") {
    body = <rect x={2.5} y={3} width={15} height={14} rx={3} strokeDasharray="3 2.2" {...c} />;
  } else if (nesting === "container") {
    body = (
      <>
        <rect x={2} y={5} width={16} height={10} rx={2.5} {...c} />
        <path d="M5 5 V3.5 a1.5 1.5 0 0 1 1.5-1.5 h7 A1.5 1.5 0 0 1 15 3.5 V5" {...c} />
      </>
    );
  } else if (shape === "database") {
    body = (
      <>
        <path d="M3 4 v9 a7 2.5 0 0 0 14 0 V4" {...c} />
        <ellipse cx={10} cy={4.2} rx={7} ry={2.4} {...c} />
      </>
    );
  } else if (shape === "broker") {
    body = (
      <>
        <path d="M6 3 h8 a4 7 0 0 1 0 14 h-8 a4 7 0 0 1 0-14 Z" {...c} />
        <path d="M6 3 a4 7 0 0 1 0 14" {...c} />
      </>
    );
  } else if (shape === "person") {
    body = (
      <>
        <circle cx={10} cy={6.5} r={3.2} {...c} />
        <path d="M3.5 17 a 6.5 5.5 0 0 1 13 0" {...c} />
      </>
    );
  } else {
    body = <rect x={2.5} y={3} width={15} height={14} rx={3} {...c} />;
  }
  return <svg width={20} height={20} viewBox="0 0 20 20" data-nesting={nesting}>{body}</svg>;
}
