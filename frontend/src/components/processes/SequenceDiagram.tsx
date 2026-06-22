// UML sequence-диаграмма: участники = линии жизни (узлы C4), сообщения = стрелки
// плеч задокументированных каналов (вызов/ответ/событие), полосы активации, фрагмент
// alt. Цвет = статус жизненного цикла узла (единообразно с C4), тип плеча = форма
// (линия + наконечник). Чистый презентационный компонент: раскладка выводится из пропсов.
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { FragmentKind, NodeStatus } from "../../types";
import { getNodeColors, STATUS_META } from "../graph/colors";
import { viewShows, type SchemaView } from "../schemaView";
import { C4Glyph, IcoBrokenLink, IcoClose, IcoPlus } from "./icons";
import { legMeta } from "./legMeta";
import { strongestStatus } from "./sequence/layout";
import type { SeqActivation, SeqFragment, SeqMessage, SeqParticipant } from "./sequence/layout";
import { BPT, BROKEN, SQ, STATUS_LEG, withAlpha } from "./tokens";

const DEFAULT_LH = 18; // высота однострочной подписи до замера
const LABEL_GAP = 10; // зазор между низом подписи и стрелкой
const LABEL_PAD = 26; // запас в шаге строки сверх высоты подписи (одна строка → шаг ROW_GAP)
const STATUSES: NodeStatus[] = ["existing", "planned", "deprecated"];

interface Props {
  participants: SeqParticipant[];
  messages: SeqMessage[];
  activations?: SeqActivation[];
  fragments?: SeqFragment[];
  ghost?: boolean;
  // Вид схемы: участники/сообщения вне вида приглушаются (opacity), но не удаляются.
  view?: SchemaView;
  // Пользователь протянул стрелку из кружка одного участника к другому: создаём
  // сообщение между ними (id = node_id). Источник = откуда тянули, цель = куда отпустили.
  onConnect?: (fromId: string, toId: string) => void;
  // Протягивание из кружка участника обратно НА СЕБЯ — самосообщение (внутр. операция).
  onSelfConnect?: (id: string) => void;
  onMessageClick?: (id: string) => void;
  // Удаление участника со схемы (крестик по ховеру на шапке). id = node_id.
  // Передаётся только в режиме редактирования — в read-only окне крестика нет.
  onDeleteParticipant?: (nodeId: string) => void;
  // Режим выбора диапазона под новый фрагмент: курсором протягиваем по строкам
  // сообщений, на отпускании отдаём [fromRow, toRow]. null — обычный режим.
  selectMode?: FragmentKind | null;
  onSelectRange?: (fromRow: number, toRow: number) => void;
  // Клик по шапке фрагмента (kind+условие) — запрос на удаление фрагмента.
  onFragmentClick?: (id: string) => void;
}

export default function SequenceDiagram({
  participants,
  messages,
  activations = [],
  fragments = [],
  ghost,
  view = "all",
  onConnect,
  onSelfConnect,
  onMessageClick,
  onDeleteParticipant,
  selectMode = null,
  onSelectRange,
  onFragmentClick,
}: Props) {
  // Состояние drag-to-connect: откуда тянем и текущая точка курсора (в координатах
  // контейнера); hover — ближайший участник-цель под курсором.
  const rootRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: string; px: number; py: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  // Сдвигался ли курсор за порог во время драга — чтобы клик без движения по кружку
  // не считался самосообщением (источник становится self-целью только после движения).
  const movedRef = useRef(false);
  // Диапазон строк, выделяемый протягиванием в режиме selectMode (a — якорь, b — текущий).
  const [selRange, setSelRange] = useState<{ a: number; b: number } | null>(null);

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
  const pById: Record<string, SeqParticipant> = {};
  participants.forEach((p, k) => { idx[p.id] = k; pById[p.id] = p; });
  const n = participants.length;
  const PX = (k: number) => SQ.MARGIN + k * SQ.COL_W;
  const lifeTop = SQ.TOP + SQ.PHEAD_H;

  // Приглушение по виду схемы: участник со статусом вне вида гаснет (см. ТЗ статусов).
  const statusOf = (id: string): NodeStatus => pById[id]?.status ?? "existing";
  const dimP = (id: string) => !viewShows(view, statusOf(id));
  const dimMsg = (m: SeqMessage) => dimP(m.from) || dimP(m.to);

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
  // Каждый фрагмент, начавшийся на/до строки r, добавляет высоту своей шапки (а ветка
  // else — свой зазор). Так несколько/вложенные фрагменты раздвигают строки корректно.
  const fragHeadOff = (r: number) => {
    let off = 0;
    for (const f of fragments) {
      if (r >= f.fromRow) off += SQ.FRAG_HEAD;
      if (f.elseRow != null && r >= f.elseRow) off += SQ.ELSE_GAP;
    }
    return off;
  };
  const rowY = (r: number) => lifeTop + rowOff[r] + fragHeadOff(r);
  // Ближайшая строка к вертикальной координате y (для выбора диапазона протягиванием).
  const rowFromY = (y: number) => {
    let best = 0;
    let bestD = Infinity;
    for (let r = 0; r < R; r++) {
      const d = Math.abs(y - rowY(r));
      if (d < bestD) { bestD = d; best = r; }
    }
    return best;
  };

  const ghostY = ghost ? rowY(R) - 6 : 0;
  const W = SQ.MARGIN * 2 + Math.max(0, n - 1) * SQ.COL_W;
  const contentBottom = R > 0 ? rowY(R - 1) : lifeTop + SQ.ROW0;
  const H = ghost ? ghostY + 44 : contentBottom + 54;

  // Прямоугольники фрагментов (с горизонтальным вложением по depth).
  const NEST_INSET = 10;
  const fragBoxes = fragments
    .map((f) => {
      const inner = messages.filter((m) => m.r >= f.fromRow && m.r <= f.toRow);
      if (!inner.length) return null;
      const ks = inner.flatMap((m) => [idx[m.from], idx[m.to]]);
      // depth = сколько ДРУГИХ фрагментов строго охватывают диапазон этого (вложенность).
      const span = f.toRow - f.fromRow;
      const depth = fragments.filter(
        (g) => g !== f && g.fromRow <= f.fromRow && g.toRow >= f.toRow && g.toRow - g.fromRow > span,
      ).length;
      const inset = depth * NEST_INSET;
      return {
        f,
        left: PX(Math.min(...ks)) - 38 + inset,
        right: PX(Math.max(...ks)) + 38 - inset,
        top: rowY(f.fromRow) - 26,
        bottom: rowY(f.toRow) + 18,
        elseY: f.elseRow != null ? rowY(f.elseRow) - 16 : null,
      };
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);

  // Начало драга из кружка участника k: захватываем указатель (чтобы движения шли
  // даже за пределами кружка) и фиксируем источник.
  function onCircleDown(e: ReactPointerEvent<HTMLButtonElement>, id: string, k: number) {
    if (!onConnect) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    movedRef.current = false;
    setDrag({ from: id, px: PX(k), py: ghostY });
  }
  // Движение во время драга: тянем резиновую стрелку и подсвечиваем ближайший участник
  // (в пределах половины колонки). Источник годится как self-цель только после движения.
  function onRootMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag || !rootRef.current) return;
    const r = rootRef.current.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (Math.hypot(x - PX(idx[drag.from]), y - ghostY) > 10) movedRef.current = true;
    let best: string | null = null;
    let bestD = Infinity;
    participants.forEach((p, k) => {
      const d = Math.abs(x - PX(k));
      if (d < bestD) { bestD = d; best = p.id; }
    });
    // Источник как цель = self, но только если уже двигались (иначе клик-без-движения).
    if (best === drag.from && (!movedRef.current || !onSelfConnect)) best = null;
    setHover(bestD <= SQ.COL_W / 2 ? best : null);
    setDrag((d) => (d ? { ...d, px: x, py: y } : d));
  }
  // Отпускание: над собой — самосообщение, над другим участником — связь источник→цель.
  function onRootUp() {
    if (drag && hover) {
      if (hover === drag.from) onSelfConnect?.(drag.from);
      else onConnect?.(drag.from, hover);
    }
    setDrag(null);
    setHover(null);
    movedRef.current = false;
  }

  return (
    <div
      ref={rootRef}
      onPointerMove={ghost ? onRootMove : undefined}
      onPointerUp={ghost ? onRootUp : undefined}
      style={{ position: "relative", width: W, height: H, fontFamily: "system-ui, sans-serif" }}
    >
      {/* Фрагменты (под сообщениями): рамка + кликабельная шапка (kind+условие) + ветка else */}
      {fragBoxes.map((box) => {
        const f = box.f;
        return (
          <div key={f.id}>
            <div
              style={{
                position: "absolute",
                left: box.left,
                top: box.top,
                width: box.right - box.left,
                height: box.bottom - box.top,
                border: "1.5px solid " + BPT.amberLine,
                borderRadius: 8,
                background: "rgba(255,251,235,.45)",
                zIndex: 1,
              }}
            />
            <div
              onClick={onFragmentClick ? () => onFragmentClick(f.id) : undefined}
              title={onFragmentClick ? "Удалить фрагмент" : undefined}
              style={{
                position: "absolute",
                left: box.left,
                top: box.top,
                display: "flex",
                alignItems: "center",
                gap: 8,
                zIndex: 3,
                cursor: onFragmentClick ? "pointer" : "default",
                pointerEvents: onFragmentClick ? "auto" : "none",
              }}
            >
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
                {f.kind}
              </span>
              {f.guard && <span style={{ fontSize: 11, fontWeight: 600, color: BPT.amber }}>{f.guard}</span>}
            </div>
            {box.elseY != null && (
              <div
                style={{
                  position: "absolute",
                  left: box.left,
                  top: box.elseY,
                  width: box.right - box.left,
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
                  {f.elseGuard}
                </span>
              </div>
            )}
          </div>
        );
      })}

      {/* SVG: линии жизни, активации, стрелки */}
      <svg style={{ position: "absolute", inset: 0, width: W, height: H, pointerEvents: "none", overflow: "visible", zIndex: 2 }}>
        <defs>
          {/* Наконечники по статусам × форме (markers нельзя красить через currentColor —
              генерируем по одному на каждый цвет). fill — закрашенный треугольник (вызов),
              open — открытая «галка» (ответ/событие). Плюс открытый янтарный для повисшего. */}
          {STATUSES.map((st) => (
            <marker key={"f" + st} id={`sqcap-fill-${st}`} markerWidth="10" markerHeight="10" refX="7" refY="4.5" orient="auto">
              <path d="M0 0 L8 4.5 L0 9 z" fill={STATUS_LEG[st]} />
            </marker>
          ))}
          {STATUSES.map((st) => (
            <marker key={"o" + st} id={`sqcap-open-${st}`} markerWidth="11" markerHeight="11" refX="7.5" refY="5" orient="auto">
              <path d="M1 1 L8 5 L1 9" fill="none" stroke={STATUS_LEG[st]} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </marker>
          ))}
          <marker id="sqcap-open-broken" markerWidth="11" markerHeight="11" refX="7.5" refY="5" orient="auto">
            <path d="M1 1 L8 5 L1 9" fill="none" stroke={BROKEN.ln} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
        </defs>
        {/* линии жизни — цвет/прозрачность по статусу участника */}
        {participants.map((p, k) => {
          const st = p.status;
          const dimmed = dimP(p.id);
          const stroke = st === "existing" ? "#94a3b8" : STATUS_LEG[st];
          const op = dimmed ? 0.12 : st === "existing" ? 0.85 : 0.7;
          return (
            <line key={p.id} x1={PX(k)} y1={lifeTop} x2={PX(k)} y2={H - 16} stroke={stroke} strokeWidth="1.5" strokeDasharray="5 5" opacity={op} />
          );
        })}
        {/* полосы активации — тинт по статусу дорожки */}
        {activations.map((a, i) => {
          const st = statusOf(a.lane);
          const sc = getNodeColors(false, 0, st);
          const fill = st === "existing" ? BPT.actFill : withAlpha(sc.bg, 0.16);
          const stroke = st === "existing" ? BPT.actLine : sc.border;
          return (
            <rect
              key={i}
              x={PX(idx[a.lane]) - SQ.ACT_W / 2}
              y={rowY(a.from) - 7}
              width={SQ.ACT_W}
              height={rowY(a.to) - rowY(a.from) + 14}
              rx="2"
              fill={fill}
              stroke={stroke}
              strokeWidth="1"
              opacity={dimP(a.lane) ? 0.12 : 1}
            />
          );
        })}
        {/* стрелки сообщений — цвет по «сильнейшему» статусу концов, форма по типу плеча */}
        {messages.map((m) => {
          const k1 = idx[m.from];
          const k2 = idx[m.to];
          const y = rowY(m.r);
          const shape = legMeta(m.kind);
          const st = strongestStatus(statusOf(m.from), statusOf(m.to));
          const color = m.valid ? STATUS_LEG[st] : BROKEN.ln;
          const dash = m.valid ? shape.dash : "2 5";
          const marker = m.valid ? `url(#sqcap-${shape.cap}-${st})` : "url(#sqcap-open-broken)";
          // Самосообщение (from==to): петля сбоку линии жизни вместо стрелки нулевой длины.
          if (m.from === m.to) {
            const x = PX(k1) + SQ.ACT_W / 2;
            const loopW = 30;
            const loopH = 15;
            const d = `M ${x} ${y - loopH / 2} h ${loopW} v ${loopH} h ${-loopW}`;
            return (
              <path
                key={m.id}
                d={d}
                fill="none"
                stroke={color}
                strokeWidth="1.7"
                strokeDasharray={dash === "none" ? undefined : dash}
                markerEnd={marker}
                opacity={dimMsg(m) ? 0.12 : 1}
              />
            );
          }
          const dir = k2 > k1 ? 1 : -1;
          const x1 = PX(k1) + dir * (SQ.ACT_W / 2);
          const x2 = PX(k2) - dir * (SQ.ACT_W / 2);
          return (
            <line
              key={m.id}
              x1={x1}
              y1={y}
              x2={x2}
              y2={y}
              stroke={color}
              strokeWidth="1.7"
              strokeDasharray={dash}
              markerEnd={marker}
              opacity={dimMsg(m) ? 0.12 : 1}
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
        // Самосообщение: подпись справа от петли (стрелка нулевой ширины не годится).
        const isSelf = m.from === m.to;
        const left = isSelf ? PX(k1) + SQ.ACT_W / 2 + 34 : Math.min(xa, xb);
        const w = isSelf ? 168 : Math.abs(xb - xa);
        const shape = legMeta(m.kind);
        const st = strongestStatus(statusOf(m.from), statusOf(m.to));
        const sc = getNodeColors(false, 0, st);
        const badgeBg = m.valid ? withAlpha(sc.bg, 0.14) : BROKEN.soft;
        const badgeBorder = m.valid ? sc.border : BROKEN.border;
        const badgeInk = m.valid ? STATUS_LEG[st] : BROKEN.ink;
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
              opacity: dimMsg(m) ? 0.12 : 1,
              pointerEvents: dimMsg(m) ? "none" : onMessageClick ? "auto" : "none",
              cursor: onMessageClick ? "pointer" : "default",
            }}
          >
            <span
              style={{
                width: 16,
                height: 15,
                borderRadius: 5,
                background: badgeBg,
                color: badgeInk,
                border: "1px solid " + badgeBorder,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 9,
                fontWeight: 800,
                flex: "none",
              }}
            >
              {m.valid ? m.n : <IcoBrokenLink s={11} />}
            </span>
            {/* маленький type-глиф рядом с цифрой — тип читается даже в ч/б */}
            {m.valid && (
              <span style={{ color: badgeInk, display: "inline-flex", flex: "none", marginTop: 1 }}>
                <shape.Icon s={12} />
              </span>
            )}
            <span
              style={{
                fontSize: 11.5,
                fontWeight: 500,
                color: m.valid ? BPT.head : BROKEN.ink,
                textDecoration: m.valid ? "none" : "line-through",
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
            </span>
            {!m.valid && (
              <span
                style={{
                  flex: "none",
                  fontSize: 9.5,
                  fontWeight: 700,
                  color: BROKEN.ink,
                  background: BROKEN.soft,
                  border: "1px solid " + BROKEN.border,
                  borderRadius: 4,
                  padding: "1px 5px",
                  whiteSpace: "nowrap",
                }}
              >
                связь удалена
              </span>
            )}
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
      {participants.map((p, k) => {
        const st = p.status;
        const isStatus = st !== "existing";
        const sc = getNodeColors(false, 0, st);
        const badge = STATUS_META[st].badge;
        const dimmed = dimP(p.id);
        return (
          <div
            key={p.id}
            className="bp-phead"
            style={{
              position: "absolute",
              left: PX(k) - 78,
              top: SQ.TOP,
              width: 156,
              height: SQ.PHEAD_H,
              background: isStatus ? withAlpha(sc.bg, 0.1) : "#fff",
              border: "1px solid " + (isStatus ? sc.border : p.external ? BPT.line : "#d6dee8"),
              borderRadius: 9,
              boxShadow: "0 1px 3px rgba(15,23,42,.06)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "0 11px",
              boxSizing: "border-box",
              zIndex: 4,
              opacity: dimmed ? 0.12 : 1,
              pointerEvents: dimmed ? "none" : undefined,
            }}
          >
            {/* плавающий статус-бейдж «новый»/«выводится» (как на C4-узле) */}
            {badge && (
              <span
                style={{
                  position: "absolute",
                  top: -8,
                  left: 10,
                  height: 16,
                  display: "inline-flex",
                  alignItems: "center",
                  fontSize: 9.5,
                  fontWeight: 700,
                  letterSpacing: ".03em",
                  lineHeight: 1,
                  padding: "0 7px",
                  borderRadius: 20,
                  color: "#fff",
                  background: sc.border,
                  whiteSpace: "nowrap",
                  boxShadow: "0 1px 3px rgba(0,0,0,.18)",
                  pointerEvents: "none",
                  zIndex: 5,
                }}
              >
                {badge}
              </span>
            )}
            {/* Крестик удаления участника — проявляется по ховеру на шапке. */}
            {onDeleteParticipant && (
              <button
                className="bp-phead-del"
                title={`Удалить «${p.name}» из процесса`}
                onClick={(e) => { e.stopPropagation(); onDeleteParticipant(p.id); }}
                style={pheadDel}
              >
                <IcoClose s={11} />
              </button>
            )}
            <span
              style={{
                width: 28,
                height: 28,
                borderRadius: 7,
                background: isStatus ? sc.bg : p.external ? "#f8fafc" : BPT.wash,
                color: isStatus ? "#fff" : p.external ? BPT.mut : BPT.accent,
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
        );
      })}

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
                markerEnd="url(#sqcap-fill-existing)"
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

      {/* Слой выбора диапазона под новый фрагмент: перекрывает весь холст, гасит обычные
          взаимодействия и переводит протягивание курсора в выделение строк сообщений. */}
      {selectMode && (
        <div
          style={{ position: "absolute", inset: 0, zIndex: 8, cursor: "crosshair" }}
          onPointerDown={(e) => {
            const rect = rootRef.current?.getBoundingClientRect();
            if (!rect) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            const r = rowFromY(e.clientY - rect.top);
            setSelRange({ a: r, b: r });
          }}
          onPointerMove={(e) => {
            if (!selRange) return;
            const rect = rootRef.current?.getBoundingClientRect();
            if (!rect) return;
            setSelRange({ a: selRange.a, b: rowFromY(e.clientY - rect.top) });
          }}
          onPointerUp={() => {
            if (selRange) onSelectRange?.(Math.min(selRange.a, selRange.b), Math.max(selRange.a, selRange.b));
            setSelRange(null);
          }}
        >
          {selRange && (
            <div
              style={{
                position: "absolute",
                left: SQ.MARGIN - 56,
                top: rowY(Math.min(selRange.a, selRange.b)) - 16,
                width: W - (SQ.MARGIN - 56) * 2,
                height: rowY(Math.max(selRange.a, selRange.b)) - rowY(Math.min(selRange.a, selRange.b)) + 32,
                background: "rgba(37,99,235,.10)",
                border: "1.5px dashed #2563eb",
                borderRadius: 8,
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// Крестик удаления участника в правом верхнем углу шапки (видимость — по ховеру,
// через CSS .bp-phead:hover .bp-phead-del).
const pheadDel: CSSProperties = {
  position: "absolute",
  top: -8,
  right: -8,
  width: 20,
  height: 20,
  borderRadius: "50%",
  border: "1px solid #fecaca",
  background: "#fff",
  color: "#dc2626",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  cursor: "pointer",
  boxShadow: "0 1px 3px rgba(15,23,42,.12)",
  zIndex: 5,
};

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
