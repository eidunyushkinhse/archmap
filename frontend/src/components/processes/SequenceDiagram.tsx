// UML sequence-диаграмма: участники = линии жизни (узлы C4), шаги = стрелки плеч
// задокументированных каналов (вызов/ответ/событие), полосы активации, фрагменты.
// Цвет = статус жизненного цикла узла (единообразно с C4), тип плеча = форма (линия +
// наконечник). Чистый презентационный компонент: раскладка выводится из пропсов и
// замеров. Редизайн, фаза 3а: промежутки по содержимому (подпись шага в одну строку,
// шире предела — перенос по словам), у шага только номер и подпись, привязанная схема
// логики — значок документа после подписи; шапки плоские, шрифт и серые — токены
// нового языка (ui/tokens.css), цвета статусов и янтарь — processes/tokens.ts.
import { Fragment, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { FragmentKind, NodeStatus } from "../../types";
import { getNodeColors, STATUS_META } from "../graph/colors";
import { viewShows, type SchemaView } from "../schemaView";
import { C4Glyph, IcoArrowR, IcoBrokenLink, IcoClose, IcoDoc, IcoPlus, IcoSelf } from "./icons";
import { legMeta } from "./legMeta";
import { arrayMove, strongestStatus } from "./sequence/layout";
import type { SeqActivation, SeqFragment, SeqMessage, SeqParticipant } from "./sequence/layout";
import { computeSeqGeometry, fitLabelCap, LABEL_GAP } from "./sequence/geometry";
import type { FragDragGesture, ReorderGesture, RowDragGesture } from "./sequence/geometry";
import { useSizes } from "./sequence/useSizes";
import { BPT, BROKEN, SQ, STATUS_LEG, withAlpha } from "./tokens";
import "./processes.css";

// Пустой список фрагментов по умолчанию — один объект: литерал в параметрах был бы
// новым массивом на каждый рендер и сбивал мемо геометрии.
const NO_FRAGMENTS: SeqFragment[] = [];
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
  // Просмотр: клик по шагу, к которому привязана схема логики, открывает её (id —
  // СООБЩЕНИЯ). Кликаются только шаги со схемой; в правке шаг открывает карточку
  // (onMessageClick), и этот колбэк не нужен.
  onOpenDoc?: (id: string) => void;
  // Удаление участника со схемы (крестик по ховеру на шапке). id — УЧАСТНИКА.
  // Передаётся только в режиме редактирования — в read-only окне крестика нет.
  onDeleteParticipant?: (participantId: string) => void;
  // Привязать непривязанного участника (nodeId == null) к узлу схемы. Кнопка живёт
  // на его шапке: расхождение и путь исправления должны быть в одном месте.
  onBindParticipant?: (participantId: string) => void;
  // Открыть страницу объекта, стоящего за линией жизни (id — УЗЛА). Зеркало перехода
  // «страница объекта → процесс» (NodePage, секция «Участвует в процессах»). У
  // непривязанного участника узла нет — перехода у него не будет.
  onOpenNode?: (nodeId: string) => void;
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
  // Вписывание в окно (чтение и правка): наибольшая ширина холста при масштабе 1.
  // Предел ширины подписи опускается, пока диаграмма не уместится, — подписи
  // переносятся ровно настолько, насколько нужно. Не задана — предел обычный
  // (SQ.LABEL_MAX).
  fitWidth?: number;
  // Ширина холста после раскладки: по ней холст процесса считает масштаб чтения.
  onLayout?: (width: number) => void;
  // Выбранный шаг (его панель открыта справа) — подпись подсвечена.
  selectedId?: string | null;
  // Клик по пустому месту диаграммы (не по шагу, шапке или ручке) — холст закрывает
  // панель шага.
  onBackgroundClick?: () => void;
}

export default function SequenceDiagram({
  participants,
  messages,
  activations = [],
  fragments = NO_FRAGMENTS,
  ghost,
  view = "all",
  onConnect,
  canConnect,
  onSelfConnect,
  onMessageClick,
  onOpenDoc,
  onDeleteParticipant,
  onBindParticipant,
  onOpenNode,
  onReorderParticipants,
  onReorderMessages,
  onResizeFragment,
  onMoveBranch,
  onEditBranch,
  selectMode = null,
  onSelectRange,
  onFragmentClick,
  fitWidth,
  onLayout,
  selectedId = null,
  onBackgroundClick,
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
  const [reorder, setReorder] = useState<ReorderGesture | null>(null);
  // Живой reorder ШАГОВ: fromR — исходная строка тянущейся подписи, py — текущий y
  // курсора. moved — курсор ушёл дальше порога: до него жест считаем кликом (подпись
  // открывает правку сообщения, и драг не должен её отбирать).
  const [rowDrag, setRowDrag] = useState<RowDragGesture | null>(null);
  // Протягивание границы фрагмента: какой фрагмент, какая грань и на какую строку
  // она сейчас метит. bi — номер ветви (значим только при edge === "branch").
  // moved — порог пройден (иначе это клик по шапке/рамке).
  const [fragDrag, setFragDrag] = useState<FragDragGesture | null>(null);
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

  // Замеры (sequence/useSizes): высота подписи на холсте (подпись шире предела
  // переносится, высота строки растёт под неё), естественная ширина подписи в одну
  // строку и естественная ширина шапки участника — по невидимым копиям. Копии живут вне
  // диаграммы (портал в body), то есть вне масштаба режима чтения: под CSS zoom ширина
  // текста гуляет на проценты (кегль меняется, метрики глифов округляются), и замер
  // внутри масштаба замкнул бы петлю «ширина → масштаб → ширина». Снаружи ни одна из
  // ширин от геометрии и масштаба не зависит.
  // Наименьшие ширины подписи и шапки (самое длинное слово) — по копиям шириной
  // min-content: уже них предел не сжимает, слово не рвётся.
  const { bind: bindLabel, sizes: labelH } = useSizes("height", "mid", messages);
  const { bind: bindNatural, sizes: labelW } = useSizes("width", "mw", messages);
  const { bind: bindLabelMin, sizes: labelMinW } = useSizes("width", "mn", messages);
  const { bind: bindHead, sizes: headW } = useSizes("width", "hw", participants);
  const { bind: bindHeadMin, sizes: headMinW } = useSizes("width", "hm", participants);

  // Предел ширины подписи: обычный либо подобранный под окно (вписывание).
  const labelCap = useMemo(
    () => (fitWidth != null
      ? fitLabelCap({ participants, messages, labelW, labelMinW, headW, headMinW }, fitWidth)
      : SQ.LABEL_MAX),
    [participants, messages, labelW, labelMinW, headW, headMinW, fitWidth],
  );

  // Геометрия — чистая функция данных, замеров подписей и живых жестов: мемо держит её
  // от пересчёта на событиях, которые раскладку не меняют (протяжка связи, наведение,
  // выделение диапазона), — раньше она считалась на каждом pointermove.
  const geo = useMemo(
    () => computeSeqGeometry({
      participants, messages, fragments, labelW, labelMinW, headW, headMinW, labelCap, labelH,
      reorder, rowDrag, fragDrag, ghost: !!ghost,
    }),
    [participants, messages, fragments, labelW, labelMinW, headW, headMinW, labelCap, labelH, reorder, rowDrag, fragDrag, ghost],
  );
  const {
    idx, pById, PX, colHalf, reorderToK, lifeTop, colX, isDraggedK, lhOf, headWOf, labelCapOf,
    fragRows, fragBranches, rowY, rowFromY, shownRow, msgY, ghostY, W, H, fragBoxes,
  } = geo;
  // Крайние колонки: от них считаются полоса-призрак и рамка выделения диапазона.
  const xFirst = PX(0);
  const xLast = PX(Math.max(0, participants.length - 1));

  // Ширина холста — наружу, до отрисовки: холст процесса ставит по ней масштаб, и
  // кадр в прежнем масштабе не мелькает.
  const reportLayout = useEffectEvent((width: number) => onLayout?.(width));
  useLayoutEffect(() => { reportLayout(W); }, [W]);

  // Приглушение по виду схемы: участник со статусом вне вида гаснет (см. ТЗ статусов).
  // ⚠️ Гашение — ТОЛЬКО визуальный слой: управление оно не отбирает (на C4-холсте
  // приглушённый узел ещё и глухой к мыши — node.md N11, но там до объекта есть
  // другие дороги; в процессе шаг — единственное место, где живут его подпись, канал
  // и починка, и глухой шаг делал бы процесс нередактируемым без единого объяснения,
  // П4 челленджа 2026-08-16).
  const statusOf = (id: string): NodeStatus => pById[id]?.status ?? "existing";
  const dimP = (id: string) => !viewShows(view, statusOf(id));
  const dimMsg = (m: SeqMessage) => dimP(m.from) || dimP(m.to);

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
  // Приглушение видом управление НЕ отбирает (см. dimP выше): шаг остаётся на месте
  // и его по-прежнему можно открыть и перетащить — поэтому от самого сообщения
  // признак больше не зависит.
  // Клик по шагу (стрелка или подпись): в правке — карточка шага; в просмотре —
  // привязанная к шагу схема логики, и только у шагов со схемой.
  const clickOf = (m: SeqMessage): (() => void) | undefined => {
    if (onMessageClick) return () => onMessageClick(m.id);
    if (onOpenDoc && m.doc != null) return () => onOpenDoc(m.id);
    return undefined;
  };
  // Перетаскивание завершилось сдвигом — click, который браузер шлёт следом, шаг не
  // открывает (одна защита для стрелки и подписи).
  const clickGuarded = (click: () => void) => () => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    click();
  };
  const grabbableFor = (m: SeqMessage) => (!!onReorderMessages || !!clickOf(m)) && !selectMode;
  const grabProps = (m: SeqMessage) => {
    const click = clickOf(m);
    return {
      fill: "none" as const,
      stroke: "transparent",
      strokeWidth: GRAB_W,
      strokeLinecap: "round" as const,
      style: {
        pointerEvents: "stroke" as const,
        cursor: onReorderMessages ? "grab" : click ? "pointer" : "default",
      },
      onPointerDown: onReorderMessages
        ? (e: ReactPointerEvent<SVGElement>) => onLabelDown(e, m.r)
        : undefined,
      onClick: click ? clickGuarded(click) : undefined,
    };
  };

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
    let bestK = 0;
    participants.forEach((p, k) => {
      if (p.id === drag.from) return; // источник — не цель колонок (для себя есть хэндл «себе»)
      const d = Math.abs(x - PX(k));
      if (d < bestD) { bestD = d; best = p.id; bestK = k; }
    });
    // Радиус попадания — половина соседнего промежутка: промежутки разной ширины.
    setHover(bestD <= colHalf(bestK) ? best : null);
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
      // Цель — ближайший центр колонки (та же, что показана на экране во время жеста).
      const to = reorderToK;
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

  // Копия подписи для замера ширины: те же части и классы, что у подписи на холсте
  // (labelBody; правишь одну — правь и другую, замер обязан видеть ровно нарисованное),
  // но текст — в CSS-псевдоэлементе (data-t): по ширине то же самое, а поиску по тексту
  // и чтению с экрана копии не видны.
  // Хвост держится за последнее слово так же, как на холсте (labelBody): копия
  // шириной min-content меряет по нему самое длинное неразрывное место подписи.
  function measureBody(m: SeqMessage): ReactNode {
    const label = m.label ?? "";
    const hasTail = !m.valid || m.doc != null;
    const cut = hasTail ? label.lastIndexOf(" ") + 1 : label.length;
    return (
      <>
        <span className="seq-num">
          {m.valid ? <span className="seq-t" data-t={String(m.n)} /> : <IcoBrokenLink s={11} />}
        </span>
        <span className="seq-text">
          {cut > 0 && <span className="seq-t" data-t={label.slice(0, cut)} />}
          {hasTail && (
            <span className="seq-tail">
              <span className="seq-t" data-t={label.slice(cut)} />
              {!m.valid && <span className="seq-broken seq-t" data-t={m.invalidReason === "leg_gone" ? "связь без ответа" : "связь удалена"} />}
              {m.doc != null && <span className="seq-doc"><IcoDoc s={11} /></span>}
            </span>
          )}
        </span>
      </>
    );
  }

  // Содержимое подписи шага на холсте. Сломанный шаг заметен янтарём (это сигнал):
  // вместо номера знак разрыва, подпись зачёркнута, рядом причина словами.
  function labelBody(m: SeqMessage): ReactNode {
    const docTitle = m.doc != null ? `Схема логики: ${m.doc || "без имени"}` : undefined;
    const textStyle: CSSProperties | undefined = m.valid ? undefined : { color: BROKEN.ink, textDecoration: "line-through" };
    // Хвост подписи: причина поломки и значок схемы. Он держится за последнее слово —
    // при переносе значок не уезжает на строку один.
    const tail = (
      <>
        {!m.valid && (
          <span className="seq-broken" style={{ color: BROKEN.ink, background: BROKEN.soft, borderColor: BROKEN.border }}>
            {m.invalidReason === "leg_gone" ? "связь без ответа" : "связь удалена"}
          </span>
        )}
        {/* Привязанная схема логики — значок документа после подписи; кликом
            открывается сама схема. */}
        {docTitle && (onOpenDoc ? (
          <button
            type="button"
            className="seq-doc"
            title={docTitle}
            aria-label={docTitle}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onOpenDoc(m.id); }}
          >
            <IcoDoc s={11} />
          </button>
        ) : (
          <span className="seq-doc" title={docTitle}><IcoDoc s={11} /></span>
        ))}
      </>
    );
    const hasTail = !m.valid || !!docTitle;
    const label = m.label ?? "";
    const cut = hasTail ? label.lastIndexOf(" ") + 1 : label.length;
    return (
      <>
        <span className="seq-num" style={m.valid ? undefined : { color: BROKEN.ink }}>
          {m.valid ? m.n : <IcoBrokenLink s={11} />}
        </span>
        <span className="seq-text">
          {cut > 0 && <span style={textStyle}>{label.slice(0, cut)}</span>}
          {hasTail && (
            <span className="seq-tail">
              <span style={textStyle}>{label.slice(cut)}</span>
              {tail}
            </span>
          )}
        </span>
      </>
    );
  }

  return (
    <div
      ref={rootRef}
      data-seq-bg=""
      onPointerMove={ghost ? onRootMove : undefined}
      onPointerUp={ghost ? onRootUp : undefined}
      // Пустое место — сам корень или фон полосы шапок (data-seq-bg): шаги, шапки и
      // ручки лежат поверх и ловят клик сами.
      onClick={onBackgroundClick
        ? (e) => { if ((e.target as Element).hasAttribute("data-seq-bg")) onBackgroundClick(); }
        : undefined}
      style={{ position: "relative", width: W, height: H, fontFamily: "var(--font-ui)" }}
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
            {/* Шапка: вид фрагмента ярлыком и условие плашкой. Обе лежат поверх линий
                жизни и полос активации (zIndex выше, чем у SVG), и у условия свой фон:
                без него полоса активации проступала сквозь буквы. Плашка условия заходит
                под ярлык (ярлык со срезанным углом рисуется поверх неё: clip-path даёт
                ему свой слой), чтобы ни в зазоре, ни в срезе полоса не показывалась. */}
            <div
              onClick={onFragmentClick ? () => onFragmentClick(f.id) : undefined}
              title={onFragmentClick ? "Удалить фрагмент" : undefined}
              style={{
                position: "absolute",
                left: box.left,
                top: box.top,
                display: "flex",
                alignItems: "center",
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
              {f.guard && (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: BPT.amber,
                    background: BPT.amberBg,
                    marginLeft: -12,
                    padding: "1px 6px 1px 20px",
                    borderRadius: "0 4px 4px 0",
                  }}
                >
                  {f.guard}
                </span>
              )}
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
            {/* Разделители ветвей — по одному на ветвь, каждый со своей ручкой. Плашка
                условия — отдельным слоем над SVG: внутри разделителя (zIndex 2, тот же,
                что у SVG, и раньше по разметке) она уходила под полосы активации.
                Пунктир и ручка остаются под SVG, как были: ручки стрелок в правке
                ловят указатель первыми. */}
            {box.branches.map((b, bi) => (
              <Fragment key={bi}>
                <div
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
                </div>
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
                    left: box.left + 10,
                    top: b.y - 10,
                    // Движется вместе со своим разделителем: та же анимация вершины.
                    transition: fragDrag?.id === f.id ? undefined : "top .15s ease",
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
              </Fragment>
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
            : st === "existing" ? "var(--c-fg-faint)" : STATUS_LEG[st];
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
              <g key={m.id} data-arrow={m.id}>
                <path
                  d={d}
                  fill="none"
                  stroke={color}
                  strokeWidth="1.7"
                  strokeDasharray={dash === "none" ? undefined : dash}
                  markerEnd={marker}
                  opacity={dimMsg(m) ? 0.12 : 1}
                />
                {grabbableFor(m) && (
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
          // data-arrow: по нему холст процесса доводит выбранный шаг до видимости целиком.
          return (
            <g key={m.id} data-arrow={m.id}>
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
            {grabbableFor(m) && (
              <line x1={x1} y1={y} x2={x2} y2={y} {...grabProps(m)} />
            )}
            </g>
          );
        })}
      </svg>

      {/* Подписи шагов (над стрелкой): номер тихим текстом и подпись. Ширина подписи —
          естественная, но не шире предела (шире — перенос по словам); центр — над
          серединой стрелки, у шага внутри участника — справа от петли. Невидимые копии
          в одну строку ниже меряют естественную ширину (от неё считаются промежутки). */}
      {messages.map((m) => {
        const xa = colX(m.from);
        const xb = colX(m.to);
        const isSelf = m.from === m.to;
        const dragged = isDraggedK(idx[m.from]) || isDraggedK(idx[m.to]);
        const click = clickOf(m);
        // Помещается в предел — одной строкой без права переноса: под масштабом ширина
        // текста чуть другая, чем у замера, и лишний перенос был бы случайным.
        const natural = labelW[m.id];
        const cap = labelCapOf(m.id);
        const oneLine = natural === undefined || natural <= cap;
        return (
          <div
            key={"l" + m.id}
            data-mid={m.id}
            ref={bindLabel}
            className={"seq-label" + (click ? " is-click" : "") + (m.id === selectedId ? " is-selected" : "")}
            onPointerDown={onReorderMessages ? (e) => onLabelDown(e, m.r) : undefined}
            onClick={click ? clickGuarded(click) : undefined}
            style={{
              position: "absolute",
              left: isSelf ? xa + SQ.SELF_OFF : (xa + xb) / 2,
              transform: isSelf ? undefined : "translateX(-50%)",
              // подпись висит над стрелкой: её низ — на LABEL_GAP выше линии
              top: msgY(m.r) - lhOf(m.id) - LABEL_GAP,
              maxWidth: cap,
              whiteSpace: oneLine ? "nowrap" : undefined,
              zIndex: 3,
              opacity: dimMsg(m) ? 0.12 : 1,
              pointerEvents: click ? "auto" : "none",
              cursor: click ? "pointer" : "default",
              transition:
                dragged || rowDrag ? undefined : "left .15s ease, top .15s ease",
              // Тянущаяся подпись поверх остальных, чтобы не ныряла под соседние.
              ...(rowDrag?.fromR === m.r && rowDrag.moved
                ? { zIndex: 6, cursor: "grabbing" }
                : onReorderMessages
                  ? { cursor: "grab" }
                  : null),
              userSelect: onReorderMessages ? "none" : undefined,
            }}
          >
            {labelBody(m)}
          </div>
        );
      })}
      {createPortal(
        <div aria-hidden="true" className="seq-measure">
          {messages.map((m) => (
            <Fragment key={m.id}>
              <div data-mw={m.id} ref={bindNatural} className="seq-label seq-label--measure">
                {measureBody(m)}
              </div>
              <div data-mn={m.id} ref={bindLabelMin} className="seq-label seq-label--measure seq-measure-min">
                {measureBody(m)}
              </div>
            </Fragment>
          ))}
          {participants.map((p) => {
            // Над шапкой бывает пометка (статус, «привязать»): шапка не уже её.
            const marked = p.nodeId === null || !!STATUS_META[statusOf(p.id)].badge;
            const minWidth = marked ? SQ.HEAD_MARKED_MIN : undefined;
            return (
              <Fragment key={p.id}>
                <div data-hw={p.id} ref={bindHead} className="seq-head-measure" style={{ minWidth }}>
                  <span className="seq-head-glyph" />
                  <span className="seq-t" data-t={p.name} />
                </div>
                <div data-hm={p.id} ref={bindHeadMin} className="seq-head-measure seq-measure-min">
                  <span className="seq-head-glyph" />
                  <span className="seq-t" data-t={p.name} />
                </div>
              </Fragment>
            );
          })}
        </div>,
        document.body,
      )}

      {/* Шапки участников (линии жизни) — «липкая» полоса: при вертикальном скролле
          длинной диаграммы остаются на виду (position: sticky), диаграмма
          прокручивается под сплошным фоном полосы и не просвечивает. Горизонтально
          полоса скроллится вместе с диаграммой (единая ширина W), поэтому шапки
          всегда стоят над своими колонками. Масштаб режима чтения — CSS zoom обёртки:
          он меняет раскладку, и sticky работает (под transform: scale шапки отставали
          бы от прокрутки). */}
      {/* sentinel: невидимая точка на верху диаграммы — индикатор прилипания шапок
          (IntersectionObserver в stuck). Вне потока, на раскладку не влияет. */}
      <div ref={sentinelRef} style={{ position: "absolute", top: 0, left: 0, width: 1, height: 1, pointerEvents: "none" }} />
      <div
        data-seq-bg=""
        // seq-heads: по высоте полосы холст процесса знает, сколько сверху закрыто
        // шапками, когда доводит выбранный шаг до видимости.
        className="seq-heads"
        style={{
          position: "sticky",
          top: 0,
          height: SQ.TOP + SQ.PHEAD_H,
          background: "var(--c-bg)",
          // Грань видна только когда шапки прилипли (диаграмма прокручена); в самом
          // верху она растворена — шапки сливаются с холстом. Проявляется плавно.
          borderBottom: "1px solid " + (stuck ? "var(--c-line)" : "transparent"),
          transition: "border-color .15s ease",
          zIndex: 7,
        }}
      >
      {participants.map((p, k) => {
        // Непривязанный участник: узла в схеме нет, значит нет ни статуса, ни формы.
        // Шапка красится «сломанным» янтарным — тем же, что повисшая стрелка.
        // nodeId держим отдельной константой: узкий тип должен дожить до колбэка.
        const nodeId = p.nodeId;
        const unbound = nodeId === null;
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
            // Роль и признак «внешний» из шапки ушли в подсказку (2026-10-28): строка
            // роли под именем съедала высоту, а имя резалось на шести знаках.
            title={[p.name, unbound ? "нет объекта на схеме" : p.role, p.external ? "внешний объект" : ""].filter(Boolean).join(", ")}
            onPointerDown={(e) => onHeaderDown(e, k)}
            style={{
              position: "absolute",
              // Шапка по ширине имени (в пределах HEAD_MIN…HEAD_MAX, длиннее — две
              // строки) и по центру своей колонки; ширину считает геометрия по замеру.
              left: colX(p.id) - headWOf(p.id) / 2,
              top: SQ.TOP,
              width: headWOf(p.id),
              height: SQ.PHEAD_H,
              // Плоская: рамка 1 px, радиус 6, белый фон. Тень — только у тянущейся.
              background: unbound ? BROKEN.soft : "var(--c-bg)",
              border: "1px solid " + (unbound ? BROKEN.border : isStatus ? sc.border : p.external ? "var(--c-line)" : "var(--c-line-strong)"),
              borderRadius: "var(--radius)",
              boxShadow: isDragged ? "0 6px 18px color-mix(in srgb, var(--c-fg) 22%, transparent)" : undefined,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              padding: "0 10px",
              boxSizing: "border-box",
              zIndex: isDragged ? 7 : 4,
              opacity: dimmed ? 0.12 : 1,
              // Тянемая шапка следует за курсором без задержки; остальные плавно
              // разъезжаются (transition left), освобождая целевую колонку.
              transition: isDragged ? undefined : "left .15s ease",
              cursor: onReorderParticipants && !selectMode ? (isDragged ? "grabbing" : "grab") : undefined,
            }}
          >
            {/* статус «новый»/«выводится» над шапкой — сигнал вида схемы, как у C4-узла */}
            {badge && (
              <span
                style={{
                  position: "absolute",
                  top: -9,
                  left: 8,
                  height: 18,
                  display: "inline-flex",
                  alignItems: "center",
                  fontSize: "var(--fs-caption)",
                  fontWeight: 500,
                  lineHeight: 1,
                  padding: "0 6px",
                  borderRadius: "var(--radius)",
                  color: "#fff",
                  background: sc.border,
                  whiteSpace: "nowrap",
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
                title={`Привязать «${p.name}» к объекту схемы`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onBindParticipant(p.id); }}
                style={{
                  position: "absolute",
                  left: 6,
                  top: -10,
                  height: 20,
                  padding: "0 6px",
                  background: BROKEN.soft,
                  border: "1px solid " + BROKEN.border,
                  borderRadius: "var(--radius)",
                  color: BROKEN.ink,
                  fontFamily: "inherit",
                  fontSize: "var(--fs-caption)",
                  fontWeight: 500,
                  cursor: "pointer",
                  zIndex: 6,
                }}
              >
                привязать
              </button>
            )}
            {/* Значок формы; у непривязанного формы нет — знак разрыва, как у повисшей
                стрелки. */}
            <span
              style={{
                color: unbound ? BROKEN.ink : isStatus ? sc.border : p.external ? "var(--c-fg-faint)" : "var(--c-fg-muted)",
                display: "inline-flex",
                flex: "none",
              }}
            >
              {p.shape ? <C4Glyph shape={p.shape} s={14} /> : <IcoBrokenLink s={13} />}
            </span>
            <div style={{ minWidth: 0 }}>
              {/* Имя — до двух строк, перенос по словам; у непривязанного одна строка:
                  вторую занимает причина. Форму показывает значок, роль — подсказка. */}
              <div
                style={{
                  fontSize: "var(--fs-ui)",
                  fontWeight: 500,
                  lineHeight: "var(--lh-tight)",
                  color: "var(--c-fg)",
                  display: "-webkit-box",
                  WebkitLineClamp: unbound ? 1 : 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                  overflowWrap: "break-word",
                  // Имя, которое помещается в шапку, — одной строкой: под масштабом
                  // ширина текста чуть другая, чем у замера, и перенос был бы случайным.
                  whiteSpace: (headW[p.id] ?? 0) <= headWOf(p.id) ? "nowrap" : undefined,
                }}
              >
                {p.name}
              </div>
              {unbound && (
                <div style={{ fontSize: "var(--fs-caption)", color: "var(--c-fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  нет объекта на схеме
                </div>
              )}
            </div>
            {/* Переход на страницу объекта — зеркало «страница объекта → процесс».
                Проявляется по ховеру, как и крестик удаления. У непривязанного
                участника узла нет, значит и открывать нечего. */}
            {nodeId && onOpenNode && (
              <button
                type="button"
                className="bp-phead-open"
                title={`Открыть страницу «${p.name}»`}
                aria-label={`Открыть страницу «${p.name}»`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onOpenNode(nodeId); }}
                style={pheadOpen}
              >
                <IcoArrowR s={13} />
              </button>
            )}
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
              left: xFirst - 40,
              top: ghostY,
              width: xLast - xFirst + 80,
              borderTop: "1.5px dashed color-mix(in srgb, var(--c-accent) 30%, var(--c-bg))",
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
                stroke="var(--c-accent)"
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
                title={drag ? `Связь с «${p.name}»` : `Шаг от «${p.name}»`}
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
                  ...(isSource || isHover
                    ? circleFilled
                    : isTarget
                      ? { background: "var(--c-accent-soft)" }
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
                  background: `color-mix(in srgb, var(${ok ? "--c-ok" : "--c-danger"}) 15%, var(--c-bg))`,
                  border: `2px solid var(${ok ? "--c-ok" : "--c-danger"})`,
                  boxShadow: isHover ? `0 0 0 4px color-mix(in srgb, var(${ok ? "--c-ok" : "--c-danger"}) ${ok ? 18 : 16}%, transparent)` : undefined,
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
                  borderLeft: "2px dashed var(--c-accent)",
                  opacity: 0.5,
                  pointerEvents: "none",
                  zIndex: 5,
                }}
              />
              <button
                tabIndex={-1}
                title="Шаг внутри участника"
                style={{
                  ...circleBase,
                  left: colX(drag.from),
                  top: ghostY + SELF_OFF,
                  pointerEvents: "none",
                  transform: selfHover ? "translate(-50%,-50%) scale(1.12)" : "translate(-50%,-50%)",
                  ...(selfHover ? circleFilled : null),
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
                left: xFirst - 56,
                top: rowY(Math.min(selRange.a, selRange.b)) - 16,
                width: xLast - xFirst + 112,
                height: rowY(Math.max(selRange.a, selRange.b)) - rowY(Math.min(selRange.a, selRange.b)) + 32,
                background: "color-mix(in srgb, var(--c-accent) 10%, transparent)",
                border: "1.5px dashed var(--c-accent)",
                borderRadius: 8,
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// Крестик удаления участника в правом верхнем углу шапки. Рамка, фон, цвет, видимость по
// ховеру и вид под курсором — в CSS (.bp-phead-del, processes.css): инлайн-цвет перебивал
// правило наведения.
const pheadDel: CSSProperties = {
  position: "absolute",
  top: -8,
  right: -8,
  width: 20,
  height: 20,
  borderRadius: "50%",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  cursor: "pointer",
  zIndex: 5,
};
// Стрелка «на страницу объекта» — кружок на правом нижнем углу шапки, зеркало
// крестика удаления на правом верхнем. Рамка, цвет, проявление по ховеру и вид под
// курсором — в bp-phead-open (processes.css). Раньше стояла в потоке у правого края и
// даже невидимой отъедала у имени 27 px — «Покупатель» ломался посреди слова.
const pheadOpen: CSSProperties = {
  position: "absolute",
  right: -8,
  bottom: -8,
  width: 20,
  height: 20,
  borderRadius: "50%",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  cursor: "pointer",
  zIndex: 5,
};

// Кружок «+» под участником — источник/цель drag-to-connect. Плоский: рамка и значок
// акцентом, без тени.
const circleBase: CSSProperties = {
  position: "absolute",
  width: 34,
  height: 34,
  borderRadius: "50%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  background: "var(--c-bg)",
  border: "1.5px solid var(--c-accent)",
  color: "var(--c-accent)",
  touchAction: "none",
  zIndex: 6,
  transition: "background .12s, transform .08s",
};
// Залитый кружок: источник протягивания, цель под курсором, хэндл «себе» под курсором.
const circleFilled: CSSProperties = { background: "var(--c-accent)", color: "var(--c-bg)" };
