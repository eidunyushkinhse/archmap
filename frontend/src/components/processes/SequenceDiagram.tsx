// UML sequence-диаграмма: участники = линии жизни (узлы C4), сообщения = стрелки
// плеч задокументированных каналов (вызов/ответ/событие), полосы активации, фрагмент
// alt. Портировано 1:1 из дизайн-референса (bp-parts.jsx SequenceDiagram) на TS.
// Чистый презентационный компонент: раскладка выводится из пропсов, ничего не грузит.
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { C4Glyph, IcoPlus } from "./icons";
import { legMeta } from "./legMeta";
import type { SeqActivation, SeqFragment, SeqMessage, SeqParticipant } from "./sequence/layout";
import { BPT, SQ } from "./tokens";

const DANGER = "#dc2626"; // повисшее сообщение (связь удалена из схемы)
const DEFAULT_LH = 18; // высота однострочной подписи до замера
const LABEL_GAP = 10; // зазор между низом подписи и стрелкой
const LABEL_PAD = 26; // запас в шаге строки сверх высоты подписи (одна строка → шаг ROW_GAP)

interface Props {
  participants: SeqParticipant[];
  messages: SeqMessage[];
  activations?: SeqActivation[];
  fragment?: SeqFragment | null;
  ghost?: boolean;
  // Пользователь протянул стрелку из кружка одного участника к другому: создаём
  // сообщение между ними (id = node_id). Источник = откуда тянули, цель = куда отпустили.
  onConnect?: (fromId: string, toId: string) => void;
  onMessageClick?: (id: string) => void;
}

export default function SequenceDiagram({
  participants,
  messages,
  activations = [],
  fragment,
  ghost,
  onConnect,
  onMessageClick,
}: Props) {
  // Состояние drag-to-connect: откуда тянем и текущая точка курсора (в координатах
  // контейнера); hover — ближайший участник-цель под курсором.
  const rootRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: string; px: number; py: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  // Подписи сообщений переносятся по словам, поэтому их высота заранее неизвестна.
  // Замеряем реальную высоту каждой подписи (ResizeObserver — переживает и смену
  // ширины при перестановке колонок) и раздвигаем строки под самую высокую подпись,
  // чтобы текст влезал целиком и не наезжал на соседнюю стрелку/шапки.
  const labelEls = useRef<Map<string, HTMLElement>>(new Map());
  const [labelH, setLabelH] = useState<Record<string, number>>({});
  const bindLabel = useCallback((el: HTMLDivElement | null) => {
    if (el?.dataset.mid) labelEls.current.set(el.dataset.mid, el);
  }, []);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => {
      const next: Record<string, number> = {};
      for (const m of messages) {
        const el = labelEls.current.get(m.id);
        if (el) next[m.id] = el.offsetHeight;
      }
      setLabelH((prev) => {
        const keys = Object.keys(next);
        if (keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k])) return prev;
        return next;
      });
    });
    for (const m of messages) {
      const el = labelEls.current.get(m.id);
      if (el) ro.observe(el);
    }
    return () => ro.disconnect();
  }, [messages]);

  const idx: Record<string, number> = {};
  participants.forEach((p, k) => (idx[p.id] = k));
  const n = participants.length;
  const PX = (k: number) => SQ.MARGIN + k * SQ.COL_W;
  const lifeTop = SQ.TOP + SQ.PHEAD_H;

  const R = messages.length ? Math.max(...messages.map((m) => m.r)) + 1 : 0;
  const lhOf = (id: string) => labelH[id] ?? DEFAULT_LH;
  // Высота подписи по строке = высота её сообщения (одно сообщение на строку).
  const rowLabelH: number[] = new Array(R).fill(DEFAULT_LH);
  for (const m of messages) rowLabelH[m.r] = lhOf(m.id);
  // Накопленные вертикальные смещения строк: зазор перед строкой r вмещает её подпись.
  const rowOff: number[] = new Array(R + 1).fill(0);
  rowOff[0] = R > 0 ? Math.max(SQ.ROW0, rowLabelH[0] + LABEL_GAP + 6) : SQ.ROW0;
  for (let r = 1; r <= R; r++) {
    const lh = r < R ? rowLabelH[r] : DEFAULT_LH;
    rowOff[r] = rowOff[r - 1] + Math.max(SQ.ROW_GAP, lh + LABEL_PAD);
  }
  const rowY = (r: number) =>
    lifeTop +
    rowOff[r] +
    (fragment && r >= fragment.fromRow ? SQ.FRAG_HEAD : 0) +
    (fragment && fragment.elseRow != null && r >= fragment.elseRow ? SQ.ELSE_GAP : 0);

  const ghostY = ghost ? rowY(R) - 6 : 0;
  const W = SQ.MARGIN * 2 + Math.max(0, n - 1) * SQ.COL_W;
  const contentBottom = R > 0 ? rowY(R - 1) : lifeTop + SQ.ROW0;
  const H = ghost ? ghostY + 44 : contentBottom + 54;

  // Границы alt-рамки
  let frag: { left: number; right: number; top: number; bottom: number; elseY: number | null } | null = null;
  if (fragment) {
    const inner = messages.filter((m) => m.r >= fragment.fromRow && m.r <= fragment.toRow);
    if (inner.length) {
      const ks = inner.flatMap((m) => [idx[m.from], idx[m.to]]);
      const left = PX(Math.min(...ks)) - 38;
      const right = PX(Math.max(...ks)) + 38;
      frag = {
        left,
        right,
        top: rowY(fragment.fromRow) - 26,
        bottom: rowY(fragment.toRow) + 18,
        elseY: fragment.elseRow != null ? rowY(fragment.elseRow) - 16 : null,
      };
    }
  }

  // Начало драга из кружка участника k: захватываем указатель (чтобы движения шли
  // даже за пределами кружка) и фиксируем источник.
  function onCircleDown(e: ReactPointerEvent<HTMLButtonElement>, id: string, k: number) {
    if (!onConnect) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ from: id, px: PX(k), py: ghostY });
  }
  // Движение во время драга: тянем резиновую стрелку и подсвечиваем ближайший
  // участник-цель (в пределах половины колонки, не сам источник).
  function onRootMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag || !rootRef.current) return;
    const r = rootRef.current.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best: string | null = null;
    let bestD = Infinity;
    participants.forEach((p, k) => {
      if (p.id === drag.from) return;
      const d = Math.abs(x - PX(k));
      if (d < bestD) { bestD = d; best = p.id; }
    });
    setHover(bestD <= SQ.COL_W / 2 ? best : null);
    setDrag((d) => (d ? { ...d, px: x, py: y } : d));
  }
  // Отпускание: если над валидной целью — создаём связь источник→цель.
  function onRootUp() {
    if (drag && hover && hover !== drag.from) onConnect?.(drag.from, hover);
    setDrag(null);
    setHover(null);
  }

  return (
    <div
      ref={rootRef}
      onPointerMove={ghost ? onRootMove : undefined}
      onPointerUp={ghost ? onRootUp : undefined}
      style={{ position: "relative", width: W, height: H, fontFamily: "system-ui, sans-serif" }}
    >
      {/* alt-фрагмент (под сообщениями) */}
      {frag && fragment && (
        <>
          <div
            style={{
              position: "absolute",
              left: frag.left,
              top: frag.top,
              width: frag.right - frag.left,
              height: frag.bottom - frag.top,
              border: "1.5px solid " + BPT.amberLine,
              borderRadius: 8,
              background: "rgba(255,251,235,.45)",
              zIndex: 1,
            }}
          />
          <div style={{ position: "absolute", left: frag.left, top: frag.top, display: "flex", alignItems: "center", gap: 8, zIndex: 3 }}>
            <span
              style={{
                background: BPT.amberBg,
                border: "1.5px solid " + BPT.amberLine,
                borderRight: "none",
                color: BPT.amber,
                fontSize: 10.5,
                fontWeight: 800,
                letterSpacing: ".04em",
                padding: "2px 12px 2px 8px",
                borderRadius: "8px 0 10px 0",
                clipPath: "polygon(0 0, 100% 0, 78% 100%, 0 100%)",
              }}
            >
              {fragment.kind}
            </span>
            <span style={{ fontSize: 11, fontWeight: 600, color: BPT.amber }}>{fragment.guard}</span>
          </div>
          {frag.elseY != null && (
            <div
              style={{
                position: "absolute",
                left: frag.left,
                top: frag.elseY,
                width: frag.right - frag.left,
                borderTop: "1.5px dashed " + BPT.amberLine,
                zIndex: 2,
              }}
            >
              <span
                style={{
                  position: "absolute",
                  left: 10,
                  top: -10,
                  background: BPT.amberBg,
                  border: "1px solid " + BPT.amberLine,
                  color: BPT.amber,
                  fontSize: 10.5,
                  fontWeight: 700,
                  padding: "1px 8px",
                  borderRadius: 5,
                }}
              >
                {fragment.elseGuard}
              </span>
            </div>
          )}
        </>
      )}

      {/* SVG: линии жизни, активации, стрелки */}
      <svg style={{ position: "absolute", inset: 0, width: W, height: H, pointerEvents: "none", overflow: "visible", zIndex: 2 }}>
        <defs>
          <marker id="sq-call" markerWidth="10" markerHeight="10" refX="7" refY="4.5" orient="auto">
            <path d="M0 0 L8 4.5 L0 9 z" fill={BPT.accent} />
          </marker>
          <marker id="sq-ret" markerWidth="11" markerHeight="11" refX="7.5" refY="5" orient="auto">
            <path d="M1 1 L8 5 L1 9" fill="none" stroke={BPT.retInk} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
          <marker id="sq-async" markerWidth="11" markerHeight="11" refX="7.5" refY="5" orient="auto">
            <path d="M1 1 L8 5 L1 9" fill="none" stroke={BPT.asyncInk} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
          <marker id="sq-bad" markerWidth="10" markerHeight="10" refX="7" refY="4.5" orient="auto">
            <path d="M0 0 L8 4.5 L0 9 z" fill={DANGER} />
          </marker>
        </defs>
        {/* линии жизни */}
        {participants.map((p, k) => (
          <line key={p.id} x1={PX(k)} y1={lifeTop} x2={PX(k)} y2={H - 16} stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="5 5" />
        ))}
        {/* полосы активации */}
        {activations.map((a, i) => (
          <rect
            key={i}
            x={PX(idx[a.lane]) - SQ.ACT_W / 2}
            y={rowY(a.from) - 7}
            width={SQ.ACT_W}
            height={rowY(a.to) - rowY(a.from) + 14}
            rx="2"
            fill={BPT.actFill}
            stroke={BPT.actLine}
            strokeWidth="1"
          />
        ))}
        {/* стрелки сообщений */}
        {messages.map((m) => {
          const k1 = idx[m.from];
          const k2 = idx[m.to];
          const dir = k2 > k1 ? 1 : -1;
          const x1 = PX(k1) + dir * (SQ.ACT_W / 2);
          const x2 = PX(k2) - dir * (SQ.ACT_W / 2);
          const y = rowY(m.r);
          const meta = legMeta(m.kind);
          const dash = m.kind === "return" || m.kind === "async" ? "6 4" : "none";
          const head = !m.valid
            ? "url(#sq-bad)"
            : m.kind === "return"
              ? "url(#sq-ret)"
              : m.kind === "async"
                ? "url(#sq-async)"
                : "url(#sq-call)";
          return (
            <line
              key={m.id}
              x1={x1}
              y1={y}
              x2={x2}
              y2={y}
              stroke={m.valid ? meta.ink : DANGER}
              strokeWidth="1.7"
              strokeDasharray={dash}
              markerEnd={head}
            />
          );
        })}
      </svg>

      {/* подписи сообщений (над стрелкой) */}
      {messages.map((m) => {
        const k1 = idx[m.from];
        const k2 = idx[m.to];
        const xa = PX(k1);
        const xb = PX(k2);
        const left = Math.min(xa, xb);
        const w = Math.abs(xb - xa);
        const meta = legMeta(m.kind);
        return (
          <div
            key={"l" + m.id}
            data-mid={m.id}
            ref={bindLabel}
            onClick={onMessageClick ? () => onMessageClick(m.id) : undefined}
            style={{
              position: "absolute",
              left: left + 8,
              // подпись висит над стрелкой: её низ — на LABEL_GAP выше линии
              top: rowY(m.r) - lhOf(m.id) - LABEL_GAP,
              width: w - 16,
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "center",
              gap: 5,
              zIndex: 3,
              pointerEvents: onMessageClick ? "auto" : "none",
              cursor: onMessageClick ? "pointer" : "default",
            }}
          >
            <span
              style={{
                width: 15,
                height: 15,
                borderRadius: 5,
                background: m.valid ? meta.bg : "#fef2f2",
                color: m.valid ? meta.ink : DANGER,
                border: "1px solid " + (m.valid ? meta.line : "#fecaca"),
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 9,
                fontWeight: 800,
                flex: "none",
              }}
            >
              {m.n}
            </span>
            <span
              style={{
                fontSize: 11.5,
                fontWeight: 500,
                color: m.valid ? BPT.head : DANGER,
                // переносим по словам (и рвём слишком длинные слова), чтобы текст влезал
                whiteSpace: "normal",
                overflowWrap: "anywhere",
                textAlign: "center",
                lineHeight: 1.35,
                flex: "0 1 auto",
                minWidth: 0,
              }}
            >
              {m.label}
              {!m.valid && " · связь удалена из схемы"}
            </span>
            {m.valid && m.tech && (
              <span style={{ flex: "none" }}>
                <span
                  style={{
                    fontSize: 9.5,
                    fontWeight: 600,
                    letterSpacing: ".02em",
                    color: BPT.micro,
                    background: "#f1f5f9",
                    border: "1px solid " + BPT.line,
                    borderRadius: 4,
                    padding: "1px 5px",
                    whiteSpace: "nowrap",
                  }}
                >
                  {m.tech}
                </span>
              </span>
            )}
          </div>
        );
      })}

      {/* шапки участников (линии жизни) */}
      {participants.map((p, k) => (
        <div
          key={p.id}
          style={{
            position: "absolute",
            left: PX(k) - 78,
            top: SQ.TOP,
            width: 156,
            height: SQ.PHEAD_H,
            background: "#fff",
            border: "1px solid " + (p.external ? BPT.line : "#d6dee8"),
            borderRadius: 9,
            boxShadow: "0 1px 3px rgba(15,23,42,.06)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 11px",
            boxSizing: "border-box",
            zIndex: 4,
          }}
        >
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              background: p.external ? "#f8fafc" : BPT.wash,
              color: p.external ? BPT.mut : BPT.accent,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flex: "none",
            }}
          >
            <C4Glyph shape={p.shape} s={17} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: BPT.head, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {p.name}
            </div>
            <div style={{ fontSize: 9.5, color: BPT.mut, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {p.role}
              {p.external ? " · внеш." : ""}
            </div>
          </div>
        </div>
      ))}

      {/* Уровень создания сообщения (режим редактирования): кружок «+» под каждым
          участником. Из кружка тянут стрелку к нужному участнику — при драге кружки
          становятся хэндлами-целями. */}
      {ghost && (
        <>
          <div
            style={{
              position: "absolute",
              left: SQ.MARGIN - 40,
              top: ghostY,
              width: W - (SQ.MARGIN - 40) * 2,
              borderTop: "1.5px dashed #bcd2fb",
              zIndex: 2,
            }}
          />
          {/* резиновая стрелка от источника к курсору */}
          {drag && (
            <svg style={{ position: "absolute", inset: 0, width: W, height: H, pointerEvents: "none", overflow: "visible", zIndex: 5 }}>
              <line
                x1={PX(idx[drag.from])}
                y1={ghostY}
                x2={drag.px}
                y2={drag.py}
                stroke={BPT.accent}
                strokeWidth="2"
                strokeDasharray="5 4"
                markerEnd="url(#sq-call)"
              />
            </svg>
          )}
          {participants.map((p, k) => {
            const isSource = drag?.from === p.id;
            const isTarget = !!drag && !isSource;
            const isHover = hover === p.id;
            return (
              <button
                key={"g" + p.id}
                title={drag ? `Связь с «${p.name}»` : `Сообщение от «${p.name}»`}
                onPointerDown={(e) => onCircleDown(e, p.id, k)}
                style={{
                  ...circleBase,
                  left: PX(k),
                  top: ghostY,
                  transform: isHover ? "translate(-50%,-50%) scale(1.12)" : "translate(-50%,-50%)",
                  cursor: drag ? "grabbing" : "grab",
                  ...(isSource
                    ? { background: BPT.accent, color: "#fff", borderColor: BPT.accent }
                    : isHover
                      ? { background: BPT.accent, color: "#fff", borderColor: BPT.accent }
                      : isTarget
                        ? { background: BPT.wash }
                        : null),
                }}
              >
                <IcoPlus s={15} />
              </button>
            );
          })}
        </>
      )}
    </div>
  );
}

// Кружок «+» под участником — источник/цель drag-to-connect.
const circleBase: CSSProperties = {
  position: "absolute",
  width: 34,
  height: 34,
  borderRadius: "50%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  background: "#fff",
  border: "1.5px solid " + BPT.accent,
  color: BPT.accent,
  boxShadow: "0 1px 3px rgba(15,23,42,.12)",
  touchAction: "none",
  zIndex: 6,
  transition: "background .12s, transform .08s",
};
