// Плашка подписи рамки — один компонент на оба рода рамок: «🔍 имя ✕» раскрытого
// контейнера и «иконка · имя» площадки (FrameNode, nodes.tsx), имя нативной рамки
// уровня (LevelBoundary, boundaries.tsx). Рисуется НЕ внутри рамки, а в слое плашек
// подписей RF (EdgeLabelRenderer → .react-flow__edgelabel-renderer, canvas.md CV33):
// рамка лежит под линиями стрелок, и плашка внутри неё была под ними же; с 2026-10-27
// плашка для роутера не препятствие (edge.md E21) — линия проходит под ней, а не
// огибает, и текст обязан оставаться читаемым поверх линии. Координаты — графа (слой
// живёт во вьюпорте): левый-нижний угол рамки, отступы 10 слева и 8 снизу — как
// прежде внутри рамки. В окне анимации раскрытия плашка едет за рамкой тем же
// transition (LevelGraph.css, .lg-canvas--anim .lg-frame-plaque). data-frame-plaque —
// адрес для ореола контейнера, открытого в панели (useLevelSelection, lg-linked-plaque).
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { EdgeLabelRenderer } from "@xyflow/react";
import { SiteKindIcon } from "../../ui/icons";
import type { FrameDecor } from "./types";

// Отступы и вид плашки — одни у плашки рамки и у её отражения на оверлее драга
// (useFrameFollowOverlay): на время жеста оверлей подменяет и рамку, и плашку, и обязан
// выглядеть так же (container.md C17).
export const PLAQUE_INSET_X = 10;      // отступ от левой грани рамки
export const PLAQUE_INSET_BOTTOM = 8;  // отступ от нижней грани рамки

export const PLAQUE_STYLE: CSSProperties = {
  position: "absolute", fontSize: 12, fontWeight: 600,
  color: "#64748b", background: "#fff", padding: "2px 8px", borderRadius: 5,
  border: "1px solid #e5e7eb", whiteSpace: "nowrap",
  display: "inline-flex", alignItems: "center", gap: 6,
};
// Крестик сворачивания: кнопка на плашке рамки (FrameNode) и его неживое отражение на
// оверлее драга.
export const COLLAPSE_MARK_STYLE: CSSProperties = {
  fontSize: 12, lineHeight: 1, color: "#64748b", fontWeight: 700,
};

interface Props {
  frameId: string;
  // левый-нижний угол рамки в координатах графа
  x: number;
  bottom: number;
  // Интерактивная плашка (compound-рамка: свёртка, выбор площадки) ловит мышь, и клик по
  // ней дальше не идёт — ни узлу, ни холсту. У нативной рамки уровня плашка прозрачна
  // для мыши, как и сама рамка.
  interactive: boolean;
  title?: string;
  onClick?: () => void;
  // Скрыта на время драга ребёнка рамки (FrameData.dragHidden): плашка живёт в слое подписей,
  // а не внутри рамки, и прозрачность скрытой рамки её не касается — отражение рисует
  // оверлей (container.md C17).
  hidden?: boolean;
  children: ReactNode;
}

// Текст плашки рамки по декору: без декора — «🔍 имя» (рамка раскрытия), площадка —
// иконка вида и имя, группа — только имя. Один на рамку (FrameNode) и оверлей драга
// (useFrameFollowOverlay), который на время жеста подменяет рамку (frameStyle.ts).
export function FrameLabel({ decor, name }: { decor?: FrameDecor; name: string }) {
  if (!decor) return <span>🔍 {name}</span>;
  return (
    <>
      {decor.kind === "site" && <SiteKindIcon kind={decor.icon ?? "other"} size={14} />}
      <span>{name}</span>
    </>
  );
}

export default function FramePlaque({ frameId, x, bottom, interactive, title, onClick, hidden, children }: Props) {
  const click = interactive
    ? (e: ReactMouseEvent<HTMLDivElement>) => { e.stopPropagation(); onClick?.(); }
    : undefined;
  return (
    <EdgeLabelRenderer>
      <div
        className="lg-frame-plaque nopan"
        data-frame-plaque={frameId}
        onClick={click}
        title={title}
        style={{
          ...PLAQUE_STYLE,
          transform: `translate(${x + PLAQUE_INSET_X}px, ${bottom - PLAQUE_INSET_BOTTOM}px) translateY(-100%)`,
          // контейнер слоя глушит мышь (pointer-events: none) — интерактивной плашке
          // возвращаем её явно
          pointerEvents: interactive ? "all" : "none",
          cursor: onClick ? "pointer" : "default",
          visibility: hidden ? "hidden" : undefined,
        }}
      >
        {children}
      </div>
    </EdgeLabelRenderer>
  );
}
