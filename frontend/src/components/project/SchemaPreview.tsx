import type { CSSProperties } from "react";

/**
 * Мини-превью схемы для карточки проекта: синие узлы-блоки на точечном фоне с
 * ортогональными связями — «как на холсте». Раскладка детерминированная (seed —
 * id проекта), число блоков выводится из object_count. Это репрезентативная
 * миниатюра, не реальная топология (реальную тянуть по каждой карточке = N
 * graph-запросов; отложено до отдельной задачи).
 */

interface Props {
  seed: string;
  objectCount: number;
  edgeCount: number;
}

const W = 280;
const H = 132;
const NODE_W = 46;
const NODE_H = 24;

// Детерминированный PRNG (mulberry32) от строкового seed — одна и та же карточка
// всегда раскладывается одинаково.
function makeRng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default function SchemaPreview({ seed, objectCount, edgeCount }: Props) {
  if (objectCount === 0) {
    return (
      <div style={{ ...frame, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ color: "#94a3b8", fontSize: 12 }}>Пустая схема</span>
      </div>
    );
  }

  const rng = makeRng(seed);
  const count = Math.min(objectCount, 6);
  // Раскладываем блоки по сетке-джиттеру внутри безопасных полей.
  const cols = count <= 2 ? count : count <= 4 ? 2 : 3;
  const rows = Math.ceil(count / cols);
  const padX = 14;
  const padY = 14;
  const cellW = (W - padX * 2) / cols;
  const cellH = (H - padY * 2) / rows;
  const blocks = Array.from({ length: count }, (_, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const jx = (rng() - 0.5) * (cellW - NODE_W - 6);
    const jy = (rng() - 0.5) * (cellH - NODE_H - 6);
    const x = padX + c * cellW + (cellW - NODE_W) / 2 + jx;
    const y = padY + r * cellH + (cellH - NODE_H) / 2 + jy;
    return { x, y, cx: x + NODE_W / 2, cy: y + NODE_H / 2 };
  });

  // Ортогональные связи между последовательными блоками (ограничиваем edgeCount).
  const links = Math.min(edgeCount, count - 1, 5);
  const paths: string[] = [];
  for (let i = 0; i < links; i++) {
    const a = blocks[i];
    const b = blocks[i + 1];
    const midX = (a.cx + b.cx) / 2;
    paths.push(`M ${a.cx} ${a.cy} H ${midX} V ${b.cy} H ${b.cx}`);
  }

  return (
    <div style={frame}>
      <svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
        {paths.map((d, i) => (
          <path key={i} d={d} fill="none" stroke="#bcd0ee" strokeWidth={1.5} />
        ))}
        {blocks.map((b, i) => (
          <rect
            key={i}
            x={b.x}
            y={b.y}
            width={NODE_W}
            height={NODE_H}
            rx={5}
            fill="#2f80ed"
            opacity={0.92}
          />
        ))}
      </svg>
    </div>
  );
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
