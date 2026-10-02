// Превью холста на странице входа: маленькая SVG-сцена, где контейнер «Сервис заказов»
// раз в 3 секунды раскрывается в рамку с детьми и сворачивается обратно. Кадр
// считает чистая sceneFrame(t) (loginScene.ts), здесь — только отрисовка и цикл
// requestAnimationFrame, который останавливается при размонтировании. При
// prefers-reduced-motion: reduce цикла нет — статичный раскрытый кадр.
import { useEffect, useId, useState } from "react";
import {
  roundedPath, sceneFrame, sceneTAt, SCENE_EDGE_COLOR, SCENE_NODE_H, SCENE_NODE_W, SCENE_VIEWBOX,
} from "./loginScene";
import type { SceneContainer, SceneEdge, SceneFrameBox, SceneService } from "./loginScene";

const FONT = "system-ui, 'Segoe UI', Roboto, sans-serif";
// Цвета обвязки — как у рамки раскрытого контейнера и плашек подписей на холсте
// (graph/nodes.tsx, graph/edges.tsx): там они заданы по месту, общей константы нет.
const FRAME_STROKE = "#9ca3af";
const PILL_STROKE = "#e5e7eb";
const FRAME_TITLE = "#64748b";
const LABEL_TEXT = "#334155";

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function LoginScenePreview() {
  // Настройку читаем один раз при монтировании: страница входа живёт недолго.
  const [reduced] = useState(prefersReducedMotion);
  const [t, setT] = useState(0);
  // Свои id для маркера и тени: два экземпляра на странице не делят defs.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const arrowId = `${uid}-arrow`;
  const shadowId = `${uid}-shadow`;

  useEffect(() => {
    if (reduced) return;
    let raf = 0;
    let start: number | null = null;
    const tick = (now: number) => {
      if (start === null) start = now;
      // В паузах между переходами t не меняется — React пропускает такой setState.
      setT(sceneTAt(now - start));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced]);

  const f = sceneFrame(reduced ? 1 : t);
  const shadow = `url(#${shadowId})`;

  return (
    <svg
      viewBox={SCENE_VIEWBOX}
      role="img"
      aria-label="Схема маркетплейса «Ярмарка»: контейнер «Сервис заказов» раскрывается и сворачивается"
      fontFamily={FONT}
    >
      <defs>
        <marker id={arrowId} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7}
          orient="auto-start-reverse">
          <path d="M0,1 L9,5 L0,9 z" fill={SCENE_EDGE_COLOR} />
        </marker>
        <filter id={shadowId} x="-10%" y="-10%" width="120%" height="140%">
          <feDropShadow dx={0} dy={1} stdDeviation={1.2} floodOpacity={0.14} />
        </filter>
      </defs>
      {f.edges.map((e) => <EdgeView key={e.id} edge={e} marker={`url(#${arrowId})`} />)}
      {f.services.map((s) => <ServiceView key={s.name} service={s} shadow={shadow} />)}
      {f.frame && <FrameView frame={f.frame} />}
      {f.container && <ContainerView container={f.container} shadow={shadow} />}
      {f.children.map((c) => <ContainerView key={c.name} container={c} shadow={shadow} />)}
    </svg>
  );
}

// Узел-сервис: заливка, имя, плашка технологии.
function ServiceView({ service: s, shadow }: { service: SceneService; shadow: string }) {
  const tagW = s.tag.length * 5.2 + 14;
  return (
    <g transform={`translate(${s.x},${s.y})`}>
      <rect x={0.5} y={0.5} width={SCENE_NODE_W - 1} height={SCENE_NODE_H - 1} rx={8}
        fill={s.colors.bg} stroke={s.colors.border} strokeWidth={1.5} filter={shadow} />
      <text x={12} y={23} fontSize={12.5} fontWeight={700} fill={s.colors.text}>{s.name}</text>
      <rect x={11} y={33} width={tagW} height={17} rx={8.5} fill="rgba(255,255,255,0.22)" />
      <text x={18} y={45} fontSize={9} fill={s.colors.text}>{s.tag}</text>
    </g>
  );
}

// Свёрнутый контейнер: пунктир, «контейнер», имя, кнопка-лупа.
function ContainerView({ container: c, shadow }: { container: SceneContainer; shadow: string }) {
  const { x, y, w, h } = c.box;
  const ink = c.colors.text;
  const lx = x + w - 24;
  const ly = y + 8;
  return (
    <g opacity={c.alpha}>
      <rect x={x + 0.5} y={y + 0.5} width={w - 1} height={h - 1} rx={8} fill={c.colors.bg}
        stroke={c.colors.border} strokeWidth={1.5} strokeDasharray="5 3" filter={shadow} />
      <text x={x + 12} y={y + 20} fontSize={8.5} fill={ink} opacity={0.85}>контейнер</text>
      <text x={x + 12} y={y + 36} fontSize={12.5} fontWeight={700} fill={ink}>{c.name}</text>
      <rect x={lx} y={ly} width={16} height={14} rx={3}
        fill="rgba(255,255,255,0.18)" stroke="rgba(255,255,255,0.3)" />
      <circle cx={lx + 7} cy={ly + 6.5} r={3} fill="none" stroke={ink} strokeWidth={1.2} />
      <path d={`M${lx + 9.3},${ly + 8.8} l2.6,2.6`} stroke={ink} strokeWidth={1.2} strokeLinecap="round" />
    </g>
  );
}

// Рамка раскрытого контейнера: серый пунктир и плашка с именем внизу слева.
function FrameView({ frame: f }: { frame: SceneFrameBox }) {
  const { x, y, w, h } = f.box;
  const titleW = f.name.length * 6.4 + 16;
  return (
    <g opacity={f.alpha}>
      <rect x={x} y={y} width={w} height={h} rx={12} fill="none" stroke={FRAME_STROKE} strokeDasharray="4 3" />
      <rect x={x + 10} y={y + h - 28} width={titleW} height={20} rx={5} fill="#fff" stroke={PILL_STROKE} />
      <text x={x + 18} y={y + h - 14} fontSize={10.5} fontWeight={600} fill={FRAME_TITLE}>{f.name}</text>
    </g>
  );
}

// Ортогональная связь со скруглёнными изломами и подписью на белой плашке.
function EdgeView({ edge: e, marker }: { edge: SceneEdge; marker: string }) {
  const w = Math.max(...e.label.map((s) => s.length)) * 5 + 12;
  const h = e.label.length * 11 + 6;
  const [ax, ay] = e.at;
  return (
    <g opacity={e.alpha}>
      <path d={roundedPath(e.points)} fill="none" stroke={SCENE_EDGE_COLOR} strokeWidth={1.3} markerEnd={marker} />
      <rect x={ax - w / 2} y={ay - h / 2} width={w} height={h} rx={3} fill="#fff" stroke={PILL_STROKE} />
      {e.label.map((s, i) => (
        <text key={s} x={ax} y={ay - h / 2 + 13 + i * 11} fontSize={8.8} fill={LABEL_TEXT} textAnchor="middle">
          {s}
        </text>
      ))}
    </g>
  );
}
