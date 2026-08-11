// UML sequence-диаграмма: участники = линии жизни (узлы C4), сообщения = стрелки
// плеч задокументированных каналов (вызов/ответ/событие), полосы активации, фрагмент
// alt. Цвет = статус жизненного цикла узла (единообразно с C4), тип плеча = форма
// (линия + наконечник). Чистый презентационный компонент: раскладка выводится из пропсов.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { FragmentKind, NodeStatus } from "../../types";
import { getNodeColors, STATUS_META } from "../graph/colors";
import { viewShows, type SchemaView } from "../schemaView";
import { C4Glyph, IcoBrokenLink, IcoClose, IcoPlus, IcoSelf } from "./icons";
import { legMeta } from "./legMeta";
import { arrayMove, strongestStatus } from "./sequence/layout";
import type { SeqActivation, SeqBranch, SeqFragment, SeqMessage, SeqParticipant } from "./sequence/layout";
import { BPT, BROKEN, SQ, STATUS_LEG, withAlpha } from "./tokens";

const DEFAULT_LH = 18; // высота однострочной подписи до замера
const LABEL_GAP = 10; // зазор между низом подписи и стрелкой
const LABEL_PAD = 26; // запас в шаге строки сверх высоты подписи (одна строка → шаг ROW_GAP)
const SELF_OFF = 46; // вертикальный сдвиг хэндла «себе» под кружком-источником
const SELF_HIT = 22; // радиус попадания курсора по хэндлу «себе»
// Ручка грани фрагмента: полоса поверх ребра рамки. Само ребро 1.5px — курсором
// в него не попасть, поэтому зона захвата толще и центрирована по ребру.
const FRAG_EDGE_H = 11;
const fragEdgeStyle = (left: number, y: number, width: number): CSSProperties => ({
  position: "absolute",
  left,
  top: y - FRAG_EDGE_H / 2,
  width,
  height: FRAG_EDGE_H,
  zIndex: 2,
  cursor: "ns-resize",
});

const DRAG_SLOP = 4; // порог сдвига, отделяющий перетаскивание шага от клика по подписи
const GRAB_W = 16; // толщина невидимой полосы захвата поверх стрелки (сама она 1.7px)
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
  // Можно ли завести сообщение из одного участника в другого — ответ БЭКА
  // (/processes/{id}/directions). Считать это на клиенте нельзя: проекция концов
  // связи через предков живёт на сервере, и вторая реализация разошлась бы с
  // валидатором. Не передан — индикации нет, поведение как раньше.
  canConnect?: (fromId: string, toId: string) => boolean;
  // Дроп на отдельный хэндл «себе» (появляется под источником при старте драга) —
  // рефлексивное сообщение (внутренняя операция участника).
  onSelfConnect?: (id: string) => void;
  onMessageClick?: (id: string) => void;
  // Удаление участника со схемы (крестик по ховеру на шапке). id — УЧАСТНИКА.
  // Передаётся только в режиме редактирования — в read-only окне крестика нет.
  onDeleteParticipant?: (participantId: string) => void;
  // Привязать непривязанного участника (nodeId == null) к узлу схемы. Кнопка живёт
  // на его шапке: расхождение и путь исправления должны быть в одном месте.
  onBindParticipant?: (participantId: string) => void;
  // Перестановка участников перетаскиванием шапки (живой reorder). nodeIds — новый
  // порядок линий жизни слева-направо (id = node_id). Только в режиме редактирования.
  onReorderParticipants?: (nodeIds: string[]) => void;
  // Перестановка ШАГОВ сценария перетаскиванием подписи вверх-вниз. ids — новый
  // порядок сообщений сверху вниз. Границы фрагментов при этом стоят на месте
  // (фрагмент = диапазон позиций, решение пользователя 2026-08-10): шаг, въехавший
  // в строки блока, оказывается внутри него — это видно прямо во время жеста.
  onReorderMessages?: (ids: string[]) => void;
  // Правка охвата существующего фрагмента протягиванием его верхней/нижней границы.
  // Отдаёт новые индексы строк; ширина рамки во время жеста пересчитывается сама —
  // она выводится из самой широкой стрелки внутри охвата.
  onResizeFragment?: (id: string, fromRow: number, toRow: number) => void;
  // Ветви «иначе» у alt: перенос границы ветви index на строку row.
  onMoveBranch?: (id: string, index: number, row: number) => void;
  // Завести НОВУЮ ветвь (index == null) либо открыть правку условия существующей.
  onEditBranch?: (id: string, index: number | null) => void;
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
  canConnect,
  onSelfConnect,
  onMessageClick,
  onDeleteParticipant,
  onBindParticipant,
  onReorderParticipants,
  onReorderMessages,
  onResizeFragment,
  onMoveBranch,
  onEditBranch,
  selectMode = null,
  onSelectRange,
  onFragmentClick,
}: Props) {
  // Состояние drag-to-connect: откуда тянем и текущая точка курсора (в координатах
  // контейнера); hover — ближайший участник-цель под курсором.
  const rootRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: string; px: number; py: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  // Курсор над хэндлом «себе» (под источником) — приоритетная цель: дроп даст
  // рефлексивное сообщение. Источник из колонок-целей исключён, поэтому пути не спорят.
  const [selfHover, setSelfHover] = useState(false);
  // Диапазон строк, выделяемый протягиванием в режиме selectMode (a — якорь, b — текущий).
  const [selRange, setSelRange] = useState<{ a: number; b: number } | null>(null);
  // Живой reorder участников: fromK — исходная колонка тянущейся шапки, px — текущий
  // x курсора (в координатах контейнера). Шапка следует за курсором, остальные
  // разъезжаются; отпускание фиксирует новый порядок (onReorderParticipants).
  const [reorder, setReorder] = useState<{ fromK: number; px: number } | null>(null);
  // Живой reorder ШАГОВ: fromR — исходная строка тянущейся подписи, py — текущий y
  // курсора. moved — курсор ушёл дальше порога: до него жест считаем кликом (подпись
  // открывает правку сообщения, и драг не должен её отбирать).
  const [rowDrag, setRowDrag] = useState<
    { fromR: number; py: number; y0: number; moved: boolean } | null
  >(null);
  // Протягивание границы фрагмента: какой фрагмент, какая грань и на какую строку
  // она сейчас метит. bi — номер ветви (значим только при edge === "branch").
  // moved — порог пройден (иначе это клик по шапке/рамке).
  const [fragDrag, setFragDrag] = useState<
    {
      id: string;
      edge: "top" | "bottom" | "branch";
      bi: number;
      row: number;
      y0: number;
      moved: boolean;
    } | null
  >(null);
  // «Липкость» шапок: в самом верху диаграммы разделительная грань скрыта, появляется
  // при прилипании. Следим за невидимой sentinel-точкой на верху диаграммы: как только
  // она заклиппилась скролл-контейнером (ушла из виду) — шапки прилипли к верху.
  // Перетаскивание завершилось сдвигом → гасим click, который браузер пошлёт следом
  // (иначе после каждой перестановки открывалась бы правка сообщения).
  const suppressClick = useRef(false);
  const [stuck, setStuck] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setStuck(!entry.isIntersecting),
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

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

  // Живой reorder: целевая колонка под курсором (обратное к PX: k=(x−MARGIN)/COL_W).
  const reorderToK = reorder
    ? Math.max(0, Math.min(n - 1, Math.round((reorder.px - SQ.MARGIN) / SQ.COL_W)))
    : -1;
  // Дисплейный x центра колонки участника с учётом живого reorder — ЕДИНЫЙ источник x
  // для шапок, линий жизни, стрелок, активаций и рамок: вся диаграмма перестраивается
  // синхронно во время драга (стрелки динамически меняют положение и направление).
  // Тянущийся участник следует за курсором (непрерывно); участники между исходной и
  // целевой колонкой сдвигаются на COL_W. Без reorder — обычный PX по индексу.
  const colX = (id: string): number => {
    const k = idx[id];
    if (!reorder) return PX(k);
    if (k === reorder.fromK) return reorder.px;
    const from = reorder.fromK;
    if (from < reorderToK && k > from && k <= reorderToK) return PX(k - 1);
    if (from > reorderToK && k >= reorderToK && k < from) return PX(k + 1);
    return PX(k);
  };
  // Затронут ли элемент тянущимся участником (тогда без transition — следует за
  // курсором); иначе плавный сдвиг на новую колонку.
  const isDraggedK = (k: number) => reorder?.fromK === k;

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
  // Действующие границы фрагмента: во время протягивания грани — живые, иначе свои.
  // Через них проходит ВСЯ геометрия (смещения строк, рамка, ширина), поэтому картина
  // во время жеста согласована: рамка едет, строки раздвигаются, ширина подстраивается
  // под самую широкую стрелку внутри нового охвата.
  const fragRows = (f: SeqFragment): { from: number; to: number } => {
    if (!fragDrag || !fragDrag.moved || fragDrag.id !== f.id) {
      return { from: f.fromRow, to: f.toRow };
    }
    if (fragDrag.edge === "branch") return { from: f.fromRow, to: f.toRow };
    // Грань не заходит за противоположную И не проглатывает НИ ОДНОЙ ветви: все они
    // обязаны остаться строго внутри охвата (бэк держит то же правило).
    const first = f.branches.length ? f.branches[0].row : null;
    const last = f.branches.length ? f.branches[f.branches.length - 1].row : null;
    const loEdge = first != null ? Math.min(first - 1, f.toRow) : f.toRow;
    const hiEdge = last != null ? Math.max(last, f.fromRow) : f.fromRow;
    return fragDrag.edge === "top"
      ? { from: Math.min(fragDrag.row, loEdge), to: f.toRow }
      : { from: f.fromRow, to: Math.max(fragDrag.row, hiEdge) };
  };
  // Действующие ветви: во время протягивания одной из границ — живые. Тянущаяся ветвь
  // зажата между соседями (перепрыгнуть их нельзя — порядок ветвей строг) и остаётся
  // внутри охвата: строка fromRow оставила бы ПЕРВУЮ ветвь пустой.
  const fragBranches = (f: SeqFragment): SeqBranch[] => {
    if (!fragDrag || !fragDrag.moved || fragDrag.id !== f.id || fragDrag.edge !== "branch") {
      return f.branches;
    }
    const i = fragDrag.bi;
    if (i < 0 || i >= f.branches.length) return f.branches;
    const lo = (i > 0 ? f.branches[i - 1].row : f.fromRow) + 1;
    const hi = i < f.branches.length - 1 ? f.branches[i + 1].row - 1 : f.toRow;
    const row = Math.min(Math.max(fragDrag.row, lo), hi);
    return f.branches.map((b, k) => (k === i ? { ...b, row } : b));
  };
  // Каждый фрагмент, начавшийся на/до строки r, добавляет высоту своей шапки, а КАЖДАЯ
  // его ветвь — свой зазор. Так несколько/вложенные фрагменты и цепочка ветвей
  // раздвигают строки корректно (иначе разделители наезжали бы на стрелки).
  const fragHeadOff = (r: number) => {
    let off = 0;
    for (const f of fragments) {
      if (r >= fragRows(f).from) off += SQ.FRAG_HEAD;
      for (const b of fragBranches(f)) if (r >= b.row) off += SQ.ELSE_GAP;
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

  // Куда встанет тянущийся шаг, если отпустить сейчас, и как из-за этого едут
  // остальные строки. Фрагменты СВОИ строки не меняют: они держат диапазон позиций,
  // поэтому во время жеста видно, как шаг въезжает в блок или покидает его.
  const dropRow = rowDrag && rowDrag.moved ? rowFromY(rowDrag.py) : null;
  const shownRow = (r: number): number => {
    if (dropRow === null || rowDrag === null) return r;
    const from = rowDrag.fromR;
    if (r === from) return dropRow;
    if (from < dropRow && r > from && r <= dropRow) return r - 1;
    if (from > dropRow && r >= dropRow && r < from) return r + 1;
    return r;
  };
  // Y строки сообщения с учётом жеста: тянущаяся идёт за курсором, прочие — по своей
  // новой строке.
  const msgY = (r: number): number =>
    rowDrag && rowDrag.moved && r === rowDrag.fromR ? rowDrag.py : rowY(shownRow(r));

  const ghostY = ghost ? rowY(R) - 6 : 0;
  const W = SQ.MARGIN * 2 + Math.max(0, n - 1) * SQ.COL_W;
  const contentBottom = R > 0 ? rowY(R - 1) : lifeTop + SQ.ROW0;
  const H = ghost ? ghostY + 44 : contentBottom + 54;

  // Прямоугольники фрагментов (с горизонтальным вложением по depth).
  const NEST_INSET = 10;
  const fragBoxes = fragments
    .map((f) => {
      const rows = fragRows(f);
      // Ширина рамки выводится из охвата: берём крайние колонки сообщений внутри.
      // Поэтому при протягивании грани она подстраивается под самую широкую стрелку
      // нового охвата сама — отдельного пересчёта не нужно.
      const inner = messages.filter((m) => m.r >= rows.from && m.r <= rows.to);
      if (!inner.length) return null;
      const xs = inner.flatMap((m) => [colX(m.from), colX(m.to)]);
      // depth = сколько ДРУГИХ фрагментов строго охватывают диапазон этого (вложенность).
      const span = rows.to - rows.from;
      const depth = fragments.filter((g) => {
        if (g === f) return false;
        const gr = fragRows(g);
        return gr.from <= rows.from && gr.to >= rows.to && gr.to - gr.from > span;
      }).length;
      const inset = depth * NEST_INSET;
      return {
        f,
        rows,
        left: Math.min(...xs) - 38 + inset,
        right: Math.max(...xs) + 38 - inset,
        top: rowY(rows.from) - 26,
        bottom: rowY(rows.to) + 18,
        branches: fragBranches(f).map((b) => ({ ...b, y: rowY(b.row) - 16 })),
      };
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);

  // Начало перетаскивания шапки участника (живой reorder): захват указателя, как у
  // drag-to-connect. Крестик удаления гасит свой pointerdown (stopPropagation), чтобы
  // клик по нему не начинал драг. В режиме выбора фрагмента reorder не стартует.
  function onHeaderDown(e: ReactPointerEvent<HTMLDivElement>, k: number) {
    if (!onReorderParticipants || selectMode) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setReorder({ fromK: k, px: PX(k) });
  }
  // Начало протягивания грани фрагмента. Порог тот же, что у шага: без него клик по
  // шапке (удаление фрагмента) иногда читался бы как микро-жест.
  function onFragEdgeDown(
    e: ReactPointerEvent<HTMLDivElement>,
    id: string,
    edge: "top" | "bottom" | "branch",
    row: number,
    bi = -1,
  ) {
    if (selectMode) return;
    if (edge === "branch" ? !onMoveBranch : !onResizeFragment) return;
    const root = rootRef.current;
    if (!root) return;
    e.stopPropagation(); // рамка лежит под шапкой — не даём жесту уйти в клик по ней
    e.currentTarget.setPointerCapture(e.pointerId);
    setFragDrag({
      id, edge, bi, row, y0: e.clientY - root.getBoundingClientRect().top, moved: false,
    });
  }

  // Стрелку тянут так же, как подпись: пользователь инстинктивно берётся за неё.
  // Тонкая линия (1.7px) курсором не ловится, поэтому поверх неё кладём невидимую
  // полосу той же геометрии с толстой обводкой — она и принимает жест.
  // pointerEvents="stroke": реагирует обводка, а не пустой прямоугольник вокруг.
  // Полоса нужна и под клик (он открывает карточку шага): раньше подпись отзывалась,
  // а стрелка не делала ничего — одна и та же сущность вела себя по-разному в
  // зависимости от того, куда попал курсор (выровнено 2026-08-10).
  const grabbable = (m: SeqMessage) =>
    (!!onReorderMessages || !!onMessageClick) && !selectMode && !dimMsg(m);
  const grabProps = (m: SeqMessage) => ({
    fill: "none" as const,
    stroke: "transparent",
    strokeWidth: GRAB_W,
    strokeLinecap: "round" as const,
    style: {
      pointerEvents: "stroke" as const,
      cursor: onReorderMessages ? "grab" : onMessageClick ? "pointer" : "default",
    },
    onPointerDown: onReorderMessages
      ? (e: ReactPointerEvent<SVGElement>) => onLabelDown(e, m.r)
      : undefined,
    onClick: onMessageClick
      ? () => {
          // Перетаскивание завершилось сдвигом — click, который браузер шлёт следом,
          // не должен открывать удаление (та же защита, что у подписи).
          if (suppressClick.current) { suppressClick.current = false; return; }
          onMessageClick(m.id);
        }
      : undefined,
  });

  // Начало перетаскивания ШАГА за его подпись. Порог сдвига (DRAG_SLOP) отделяет
  // драг от клика: подпись открывает правку сообщения, и жест не должен её отбирать.
  function onLabelDown(e: ReactPointerEvent<HTMLDivElement | SVGElement>, r: number) {
    if (!onReorderMessages || selectMode) return;
    const root = rootRef.current;
    if (!root) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const y = e.clientY - root.getBoundingClientRect().top;
    setRowDrag({ fromR: r, py: y, y0: y, moved: false });
  }
  // Начало драга из кружка участника k: захватываем указатель (чтобы движения шли
  // даже за пределами кружка) и фиксируем источник.
  function onCircleDown(e: ReactPointerEvent<HTMLButtonElement>, id: string, k: number) {
    if (!onConnect) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ from: id, px: PX(k), py: ghostY });
  }
  // Движение во время драга: тянем резиновую стрелку. Хэндл «себе» (под источником) —
  // приоритетная цель при попадании курсора; иначе подсвечиваем ближайший ДРУГОЙ участник
  // (источник из колонок-целей исключён — у него своя цель «себе»).
  function onRootMove(e: ReactPointerEvent<HTMLDivElement>) {
    // Протягивание грани фрагмента: грань метит в ближайшую строку сообщения.
    if (fragDrag && rootRef.current) {
      const y = e.clientY - rootRef.current.getBoundingClientRect().top;
      const row = rowFromY(y);
      setFragDrag((d) =>
        d ? { ...d, row, moved: d.moved || Math.abs(y - d.y0) > DRAG_SLOP } : d,
      );
      return;
    }
    // Живой reorder ШАГОВ: подпись идёт за курсором по вертикали.
    if (rowDrag && rootRef.current) {
      const y = e.clientY - rootRef.current.getBoundingClientRect().top;
      setRowDrag((d) => (d ? { ...d, py: y, moved: d.moved || Math.abs(y - d.y0) > DRAG_SLOP } : d));
      return;
    }
    // Живой reorder: шапка следует за курсором (целевая колонка — в onRootUp/colX).
    if (reorder && rootRef.current) {
      const r = rootRef.current.getBoundingClientRect();
      setReorder((d) => (d ? { ...d, px: e.clientX - r.left } : d));
      return;
    }
    if (!drag || !rootRef.current) return;
    const r = rootRef.current.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    // хэндл «себе»: ниже кружка-источника, в пределах радиуса попадания
    const overSelf =
      !!onSelfConnect && Math.hypot(x - colX(drag.from), y - (ghostY + SELF_OFF)) <= SELF_HIT;
    if (overSelf) {
      setSelfHover(true);
      setHover(null);
      setDrag((d) => (d ? { ...d, px: x, py: y } : d));
      return;
    }
    setSelfHover(false);
    let best: string | null = null;
    let bestD = Infinity;
    participants.forEach((p, k) => {
      if (p.id === drag.from) return; // источник — не цель колонок (для себя есть хэндл «себе»)
      const d = Math.abs(x - PX(k));
      if (d < bestD) { bestD = d; best = p.id; }
    });
    setHover(bestD <= SQ.COL_W / 2 ? best : null);
    setDrag((d) => (d ? { ...d, px: x, py: y } : d));
  }
  // Отпускание: reorder — фиксируем новый порядок, если шапка ушла в другую колонку;
  // drag-to-connect — на хэндле «себе» рефлексивное сообщение, над другим участником — связь.
  function onRootUp() {
    if (fragDrag) {
      const f = fragments.find((x) => x.id === fragDrag.id);
      if (f && fragDrag.moved && fragDrag.edge === "branch") {
        // Та же строка, что показана на экране (fragBranches уже зажал её соседями).
        const moved = fragBranches(f)[fragDrag.bi];
        if (moved && moved.row !== f.branches[fragDrag.bi]?.row) {
          suppressClick.current = true;
          onMoveBranch?.(f.id, fragDrag.bi, moved.row);
        }
        setFragDrag(null);
        return;
      }
      if (f && fragDrag.moved) {
        // Ровно те границы, что показаны на экране: fragRows уже держит и запрет
        // схлопывания, и запрет проглотить ветку «иначе». Считать их здесь заново
        // значит завести второй источник правды — он и разъехался бы с картинкой.
        const { from, to } = fragRows(f);
        if (from !== f.fromRow || to !== f.toRow) {
          suppressClick.current = true; // следом придёт click по рамке — гасим
          onResizeFragment?.(f.id, from, to);
        }
      }
      setFragDrag(null);
      return;
    }
    if (rowDrag) {
      // Порога не прошли — это был клик по подписи, порядок не трогаем.
      if (rowDrag.moved) {
        suppressClick.current = true;
        const to = rowFromY(rowDrag.py);
        if (to !== rowDrag.fromR) {
          onReorderMessages?.(arrayMove(messages.map((m) => m.id), rowDrag.fromR, to));
        }
      }
      setRowDrag(null);
      return;
    }
    if (reorder) {
      const to = Math.max(0, Math.min(n - 1, Math.round((reorder.px - SQ.MARGIN) / SQ.COL_W)));
      if (to !== reorder.fromK) {
        onReorderParticipants?.(arrayMove(participants.map((p) => p.id), reorder.fromK, to));
      }
      setReorder(null);
      return;
    }
    if (drag) {
      if (selfHover) onSelfConnect?.(drag.from);
      else if (hover) onConnect?.(drag.from, hover);
    }
    setDrag(null);
    setHover(null);
    setSelfHover(false);
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
                // Ширина рамки выводится из охвата, поэтому при переносе грани она
                // меняется скачком — анимируем, чтобы подстройка читалась как
                // движение, а не мигание. Тянущуюся грань (top/height) не
                // анимируем: она обязана идти за курсором без запаздывания.
                transition: fragDrag?.id === f.id
                  ? "left .12s ease, width .12s ease"
                  : "left .15s ease, width .15s ease, top .15s ease, height .15s ease",
              }}
            />
            {/* Ручки граней: тонкие полосы поверх верхнего и нижнего рёбер рамки. */}
            {onResizeFragment && !selectMode && (
              <>
                <div
                  onPointerDown={(e) => onFragEdgeDown(e, f.id, "top", box.rows.from)}
                  title="Потянуть верхнюю границу"
                  style={fragEdgeStyle(box.left, box.top, box.right - box.left)}
                />
                <div
                  onPointerDown={(e) => onFragEdgeDown(e, f.id, "bottom", box.rows.to)}
                  title="Потянуть нижнюю границу"
                  style={fragEdgeStyle(box.left, box.bottom, box.right - box.left)}
                />
              </>
            )}
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
            {/* «+ иначе» — только у alt и только пока под новую ветвь хватает шагов:
                каждая ветвь занимает свою строку, первая начинается с fromRow. Когда
                свободных строк не осталось, делить нечего. */}
            {onEditBranch && f.kind === "alt" &&
              box.branches.length < box.rows.to - box.rows.from && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onEditBranch(f.id, null); }}
                title="Добавить ветку «иначе»"
                style={{
                  position: "absolute",
                  left: box.right - 76,
                  top: box.top - 11,
                  height: 20,
                  padding: "0 8px",
                  zIndex: 4,
                  background: BPT.amberBg,
                  border: "1px solid " + BPT.amberLine,
                  borderRadius: 5,
                  color: BPT.amber,
                  fontSize: 10.5,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                + иначе
              </button>
            )}
            {/* Разделители ветвей — по одному на ветвь, каждый со своей ручкой. */}
            {box.branches.map((b, bi) => (
              <div
                key={bi}
                style={{
                  position: "absolute",
                  left: box.left,
                  top: b.y,
                  width: box.right - box.left,
                  borderTop: "1.5px dashed " + BPT.amberLine,
                  zIndex: 2,
                  transition: fragDrag?.id === f.id ? undefined : "top .15s ease, width .15s ease",
                }}
              >
                {onMoveBranch && !selectMode && (
                  <div
                    onPointerDown={(e) => onFragEdgeDown(e, f.id, "branch", b.row, bi)}
                    title="Потянуть границу ветки"
                    style={fragEdgeStyle(0, 0, box.right - box.left)}
                  />
                )}
                <span
                  onClick={
                    onEditBranch
                      ? (e) => {
                          e.stopPropagation();
                          if (suppressClick.current) { suppressClick.current = false; return; }
                          onEditBranch(f.id, bi);
                        }
                      : undefined
                  }
                  title={onEditBranch ? "Правка ветки «иначе»" : undefined}
                  style={{
                    cursor: onEditBranch ? "pointer" : "default",
                    zIndex: 3,
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
                  {b.guard || "иначе"}
                </span>
              </div>
            ))}
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
          const st = statusOf(p.id);
          const dimmed = dimP(p.id);
          // Непривязанный участник (узла в схеме нет) — тем же янтарным, что повисшая
          // стрелка: расхождение со схемой выглядит одинаково, где бы ни встретилось.
          const stroke = p.nodeId === null
            ? BROKEN.ln
            : st === "existing" ? "#94a3b8" : STATUS_LEG[st];
          const op = dimmed ? 0.12 : st === "existing" ? 0.85 : 0.7;
          const x = colX(p.id);
          return (
            <line
              key={p.id}
              x1={x} y1={lifeTop} x2={x} y2={H - 16}
              stroke={stroke} strokeWidth="1.5" strokeDasharray="5 5" opacity={op}
              style={{ transition: isDraggedK(k) ? undefined : "x1 .15s ease, x2 .15s ease" }}
            />
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
              x={colX(a.lane) - SQ.ACT_W / 2}
              y={rowY(shownRow(a.from)) - 7}
              width={SQ.ACT_W}
              height={rowY(shownRow(a.to)) - rowY(shownRow(a.from)) + 14}
              rx="2"
              fill={fill}
              stroke={stroke}
              strokeWidth="1"
              opacity={dimP(a.lane) ? 0.12 : 1}
              style={{ transition: isDraggedK(idx[a.lane]) ? undefined : "x .15s ease" }}
            />
          );
        })}
        {/* стрелки сообщений — цвет по «сильнейшему» статусу концов, форма по типу плеча */}
        {messages.map((m) => {
          const y = msgY(m.r);
          const shape = legMeta(m.kind);
          const st = strongestStatus(statusOf(m.from), statusOf(m.to));
          const color = m.valid ? STATUS_LEG[st] : BROKEN.ln;
          const dash = m.valid ? shape.dash : "2 5";
          const marker = m.valid ? `url(#sqcap-${shape.cap}-${st})` : "url(#sqcap-open-broken)";
          const xFrom = colX(m.from);
          const xTo = colX(m.to);
          // Стрелка затронута драгом, если тянущийся участник — один из её концов
          // (тогда без transition — следует за курсором; иначе плавный сдвиг).
          const dragged = isDraggedK(idx[m.from]) || isDraggedK(idx[m.to]);
          // Самосообщение (from==to): петля сбоку линии жизни вместо стрелки нулевой длины.
          if (m.from === m.to) {
            const x = xFrom + SQ.ACT_W / 2;
            const loopW = 30;
            const loopH = 15;
            const d = `M ${x} ${y - loopH / 2} h ${loopW} v ${loopH} h ${-loopW}`;
            return (
              <g key={m.id}>
                <path
                  d={d}
                  fill="none"
                  stroke={color}
                  strokeWidth="1.7"
                  strokeDasharray={dash === "none" ? undefined : dash}
                  markerEnd={marker}
                  opacity={dimMsg(m) ? 0.12 : 1}
                />
                {grabbable(m) && (
                  <path d={d} {...grabProps(m)} />
                )}
              </g>
            );
          }
          // Направление — по дисплейным колонкам: при перетаскивании конец может
          // пересечь начало, и стрелка динамически разворачивается.
          const dir = xTo > xFrom ? 1 : -1;
          const x1 = xFrom + dir * (SQ.ACT_W / 2);
          const x2 = xTo - dir * (SQ.ACT_W / 2);
          return (
            <g key={m.id}>
            <line
              x1={x1}
              y1={y}
              x2={x2}
              y2={y}
              stroke={color}
              strokeWidth="1.7"
              strokeDasharray={dash}
              markerEnd={marker}
              opacity={dimMsg(m) ? 0.12 : 1}
              style={{ transition: dragged ? undefined : "x1 .15s ease, x2 .15s ease" }}
            />
            {grabbable(m) && (
              <line x1={x1} y1={y} x2={x2} y2={y} {...grabProps(m)} />
            )}
            </g>
          );
        })}
      </svg>

      {/* подписи сообщений (над стрелкой) */}
      {messages.map((m) => {
        const xa = colX(m.from);
        const xb = colX(m.to);
        // Самосообщение: подпись справа от петли (стрелка нулевой ширины не годится).
        const isSelf = m.from === m.to;
        // Ширина плашки во время драга ЗАМОРОЖЕНА на базе исходных колонок (иначе
        // текст сжимается до буквы в строке на пограничных ширинах) — плашка лишь
        // центруется по живому центру стрелки; новая ширина (и переносы) применятся
        // только после отпускания, при пересчёте на reload.
        const baseSpan = Math.abs(PX(idx[m.to]) - PX(idx[m.from]));
        const w = isSelf ? 168 : baseSpan;
        const left = isSelf ? xa + SQ.ACT_W / 2 + 34 : (xa + xb) / 2 - (w - 16) / 2 - 8;
        const dragged = isDraggedK(idx[m.from]) || isDraggedK(idx[m.to]);
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
            onPointerDown={onReorderMessages ? (e) => onLabelDown(e, m.r) : undefined}
            onClick={
              onMessageClick
                ? () => {
                    if (suppressClick.current) { suppressClick.current = false; return; }
                    onMessageClick(m.id);
                  }
                : undefined
            }
            style={{
              position: "absolute",
              left: left + 8,
              // подпись висит над стрелкой: её низ — на LABEL_GAP выше линии
              top: msgY(m.r) - lhOf(m.id) - LABEL_GAP,
              width: w - 16,
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "center",
              gap: 5,
              zIndex: 3,
              opacity: dimMsg(m) ? 0.12 : 1,
              pointerEvents: dimMsg(m) ? "none" : onMessageClick ? "auto" : "none",
              cursor: onMessageClick ? "pointer" : "default",
              transition:
                dragged || rowDrag ? undefined : "left .15s ease, width .15s ease, top .15s ease",
              // Тянущаяся подпись поверх остальных, чтобы не ныряла под соседние.
              ...(rowDrag?.fromR === m.r && rowDrag.moved
                ? { zIndex: 6, cursor: "grabbing" }
                : onReorderMessages
                  ? { cursor: "grab" }
                  : null),
              userSelect: onReorderMessages ? "none" : undefined,
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
                {m.invalidReason === "leg_gone" ? "канал без ответа" : "связь удалена"}
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

      {/* Шапки участников (линии жизни) — «липкая» полоса: при вертикальном скролле
          длинной диаграммы остаются на виду (position: sticky), диаграмма
          прокручивается под сплошным фоном полосы и не просвечивает. Горизонтально
          полоса скроллится вместе с диаграммой (единая ширина W), поэтому шапки
          всегда стоят над своими колонками. */}
      {/* sentinel: невидимая точка на верху диаграммы — индикатор прилипания шапок
          (IntersectionObserver в stuck). Вне потока, на раскладку не влияет. */}
      <div ref={sentinelRef} style={{ position: "absolute", top: 0, left: 0, width: 1, height: 1, pointerEvents: "none" }} />
      <div
        style={{
          position: "sticky",
          top: 0,
          height: SQ.TOP + SQ.PHEAD_H,
          background: BPT.canvas,
          // Грань видна только когда шапки прилипли (диаграмма прокручена); в самом
          // верху она растворена — шапки сливаются с холстом. Проявляется плавно.
          borderBottom: "1px solid " + (stuck ? BPT.line : "transparent"),
          transition: "border-color .15s ease",
          zIndex: 7,
        }}
      >
      {participants.map((p, k) => {
        // Непривязанный участник: узла в схеме нет, значит нет ни статуса, ни формы.
        // Шапка красится «сломанным» янтарным — тем же, что повисшая стрелка.
        const unbound = p.nodeId === null;
        const st = statusOf(p.id);
        const isStatus = !unbound && st !== "existing";
        const sc = getNodeColors(false, 0, st);
        const badge = STATUS_META[st].badge;
        const dimmed = dimP(p.id);
        const isDragged = reorder?.fromK === k;
        return (
          <div
            key={p.id}
            className="bp-phead"
            onPointerDown={(e) => onHeaderDown(e, k)}
            style={{
              position: "absolute",
              left: colX(p.id) - 78,
              top: SQ.TOP,
              width: 156,
              height: SQ.PHEAD_H,
              background: unbound ? BROKEN.soft : isStatus ? withAlpha(sc.bg, 0.1) : "#fff",
              border: "1px solid " + (unbound ? BROKEN.border : isStatus ? sc.border : p.external ? BPT.line : "#d6dee8"),
              borderRadius: 9,
              boxShadow: isDragged ? "0 6px 18px rgba(15,23,42,.22)" : "0 1px 3px rgba(15,23,42,.06)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "0 11px",
              boxSizing: "border-box",
              zIndex: isDragged ? 7 : 4,
              opacity: dimmed ? 0.12 : 1,
              pointerEvents: dimmed ? "none" : undefined,
              // Тянемая шапка следует за курсором без задержки; остальные плавно
              // разъезжаются (transition left), освобождая целевую колонку.
              transition: isDragged ? undefined : "left .15s ease",
              cursor: onReorderParticipants && !selectMode ? (isDragged ? "grabbing" : "grab") : undefined,
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
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onDeleteParticipant(p.id); }}
                style={pheadDel}
              >
                <IcoClose s={11} />
              </button>
            )}
            {/* Непривязанному — путь исправления прямо на месте: алерт без него был
                бы тупиком («вижу расхождение, сделать ничего не могу»). */}
            {unbound && onBindParticipant && (
              <button
                type="button"
                title={`Привязать «${p.name}» к узлу схемы`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onBindParticipant(p.id); }}
                style={{
                  position: "absolute",
                  left: 6,
                  top: -9,
                  height: 18,
                  padding: "0 7px",
                  background: BROKEN.soft,
                  border: "1px solid " + BROKEN.border,
                  borderRadius: 5,
                  color: BROKEN.ink,
                  fontSize: 10,
                  fontWeight: 700,
                  cursor: "pointer",
                  zIndex: 6,
                }}
              >
                привязать
              </button>
            )}
            <span
              style={{
                width: 28,
                height: 28,
                borderRadius: 7,
                background: unbound ? BROKEN.soft : isStatus ? sc.bg : p.external ? "#f8fafc" : BPT.wash,
                color: unbound ? BROKEN.ink : isStatus ? "#fff" : p.external ? BPT.mut : BPT.accent,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                flex: "none",
              }}
            >
              {/* Формы у непривязанного нет — вместо неё знак разрыва, как у
                  повисшей стрелки. */}
              {p.shape ? <C4Glyph shape={p.shape} s={17} /> : <IcoBrokenLink s={15} />}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: BPT.head, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {p.name}
              </div>
              <div style={{ fontSize: 9.5, color: BPT.mut, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {unbound ? "нет узла в схеме" : p.role}
                {p.external ? " · внеш." : ""}
              </div>
            </div>
          </div>
        );
      })}
      </div>

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
                x1={colX(drag.from)}
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
                  left: colX(p.id),
                  transition: isDraggedK(k)
                    ? "background .12s, transform .08s"
                    : "left .15s ease, background .12s, transform .08s",
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
          {/* Маркеры-цели: на время драга под КАЖДЫМ участником загорается кружок —
              зелёный, если связь между парой в эту сторону задокументирована, серо-
              красный, если нет. Красный НЕ блокирует: отпустить можно куда угодно,
              композитор объяснит, чего не хватает (находка проверки 2026-08-08). */}
          {drag && canConnect && participants.map((p, k) => {
            if (p.id === drag.from) return null; // у источника своя цель «себе»
            const ok = canConnect(drag.from, p.id);
            const isHover = hover === p.id;
            return (
              <span
                key={`aim-${p.id}`}
                aria-hidden
                style={{
                  position: "absolute",
                  left: PX(k),
                  top: ghostY + SELF_OFF,
                  width: isHover ? 15 : 11,
                  height: isHover ? 15 : 11,
                  borderRadius: "50%",
                  transform: "translate(-50%,-50%)",
                  background: ok ? BPT.okBg : BPT.badBg,
                  border: "2px solid " + (ok ? BPT.okLine : BPT.badLine),
                  boxShadow: isHover ? "0 0 0 4px " + (ok ? BPT.okWash : BPT.badWash) : undefined,
                  transition: "width .1s, height .1s, box-shadow .1s",
                  pointerEvents: "none",
                  zIndex: 6,
                }}
              />
            );
          })}
          {/* Хэндл «себе» — выезжает под кружок-источник на время драга; дроп на него
              создаёт рефлексивное сообщение (внутреннюю операцию участника). */}
          {drag && onSelfConnect && (
            <>
              <div
                style={{
                  position: "absolute",
                  left: colX(drag.from) - 1,
                  top: ghostY + 16,
                  width: 2,
                  height: SELF_OFF - 32,
                  borderLeft: "2px dashed " + BPT.accent,
                  opacity: 0.5,
                  pointerEvents: "none",
                  zIndex: 5,
                }}
              />
              <button
                tabIndex={-1}
                title="Рефлексивное сообщение (себе)"
                style={{
                  ...circleBase,
                  left: colX(drag.from),
                  top: ghostY + SELF_OFF,
                  pointerEvents: "none",
                  transform: selfHover ? "translate(-50%,-50%) scale(1.12)" : "translate(-50%,-50%)",
                  ...(selfHover ? { background: BPT.accent, color: "#fff", borderColor: BPT.accent } : null),
                }}
              >
                <IcoSelf s={16} />
              </button>
            </>
          )}
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
