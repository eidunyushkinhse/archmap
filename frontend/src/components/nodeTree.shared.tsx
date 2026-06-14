// Общие ВИЗУАЛЬНЫЕ части дерева узлов (глиф формы, шеврон), переиспользуемые боковой
// панелью (NodeTreePanel) и справочной веткой детей в модалке узла (NodeModal) —
// чтобы рендер был ОДИН И ТОТ ЖЕ в обоих местах, без копий. Доменный отсев
// withoutPersons живёт в types (рядом с canHaveChildren/compareByRank).
import type { ReactNode } from "react";
import type { NodeShape } from "../types";

// Глиф формы узла в строке дерева (14×12, контурный, наследует цвет строки через
// currentColor — серый в покое, синий на hover). Контейнер (узел с детьми) рисуется
// «коробкой с крышкой» независимо от shape; листья — по своей форме.
export function ShapeGlyph({ container, shape }: { container: boolean; shape: NodeShape }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  let body: ReactNode;
  if (container) {
    body = (
      <>
        <rect x={1} y={3.5} width={12} height={7.5} rx={2} {...common} />
        <path d="M3.5 3.5 V2 a1 1 0 0 1 1-1 h5 a1 1 0 0 1 1 1 v1.5" {...common} />
      </>
    );
  } else if (shape === "database") {
    body = (
      <>
        <path d="M2 2 v6.2 a5 1.8 0 0 0 10 0 V2" {...common} />
        <ellipse cx={7} cy={2.2} rx={5} ry={1.7} {...common} />
      </>
    );
  } else if (shape === "broker") {
    body = (
      <>
        <path d="M4.5 1.5 h5 a3 4.5 0 0 1 0 9 h-5 a3 4.5 0 0 1 0-9 Z" {...common} />
        <path d="M4.5 1.5 a3 4.5 0 0 1 0 9" {...common} />
      </>
    );
  } else {
    body = <rect x={1.5} y={1.5} width={11} height={9} rx={2} {...common} />;
  }
  return (
    <span className="nt-glyph">
      <svg width={14} height={12} viewBox="0 0 14 12">{body}</svg>
    </span>
  );
}

// Шеврон-«галочка» раскрытия ветки: контурный ">" в свёрнутом состоянии; поворот
// на 90° (вниз) при раскрытии задаётся снаружи (transform на обёртке). Наследует
// цвет строки через currentColor (серый в покое, синий на hover зоны).
export function Chevron() {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }}>
      <path d="M9 6 L15 12 L9 18" />
    </svg>
  );
}
