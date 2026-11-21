// Геометрия sequence-диаграммы: колонки участников, строки шагов, рамки фрагментов и
// размеры холста. Чистая функция данных, замеров подписей и шапок и трёх живых жестов
// (перестановка колонок, перенос шага, грань фрагмента) — вынесена из SequenceDiagram
// (аудит F-4): там она пересчитывалась на каждом рендере, то есть и на каждом
// pointermove протяжки связи, и проверялась только DOM-селекторами.
//
// Промежутки между колонками — по содержимому, как в Mermaid (редизайн, фаза 3а):
// соседние участники стоят не ближе, чем нужно самой длинной подписи шага между ними
// плюс поля; шаг через несколько колонок раскладывает недостачу поровну на свои
// промежутки; наименьший промежуток задают шапки самих участников. Ширины подписей и
// шапок приходят входом — их замеряет диаграмма; без замера берётся значение по
// умолчанию (в jsdom замеров нет, тесты подают ширины руками).
import type { SeqBranch, SeqFragment, SeqMessage, SeqParticipant } from "./layout";
import { SQ } from "../tokens";

const DEFAULT_LH = 18; // высота однострочной подписи до замера
export const LABEL_GAP = 10; // зазор между низом подписи и стрелкой
const LABEL_PAD = 26; // запас в шаге строки сверх высоты подписи (одна строка → шаг ROW_GAP)
// Горизонтальный отступ вложенной рамки фрагмента на каждый уровень вложенности.
const NEST_INSET = 10;
// Поле между краем крайней шапки и краем холста.
const EDGE_PAD = 16;
// Шаг, которым вписывание опускает предел ширины подписи.
const CAP_STEP = 10;

// Живые жесты диаграммы (их состояние ведёт SequenceDiagram).
// Перестановка участников: fromK — исходная колонка тянущейся шапки, px — x курсора.
export interface ReorderGesture { fromK: number; px: number }
// Перенос шага: fromR — исходная строка, py — y курсора; moved — порог пройден.
export interface RowDragGesture { fromR: number; py: number; y0: number; moved: boolean }
// Протягивание грани фрагмента: какой фрагмент, какая грань, на какую строку метит;
// bi — номер ветви (значим только при edge === "branch").
export interface FragDragGesture {
  id: string;
  edge: "top" | "bottom" | "branch";
  bi: number;
  row: number;
  y0: number;
  moved: boolean;
}

// Что нужно раскладке колонок: участники, шаги и замеры.
export interface SeqColumnsInput {
  participants: SeqParticipant[];
  messages: SeqMessage[];
  // Естественная ширина подписи шага в одну строку (номер, текст, значок схемы) по id
  // шага; нет — подпись считается пустой.
  labelW?: Record<string, number>;
  // Ширина шапки участника по id участника; нет — наименьшая (SQ.HEAD_MIN).
  headW?: Record<string, number>;
  // Предел ширины подписи: шире — переносится. По умолчанию SQ.LABEL_MAX.
  labelCap?: number;
}

export interface SeqGeometryInput extends SeqColumnsInput {
  fragments: SeqFragment[];
  // Замеренные высоты подписей шагов по id (ResizeObserver); нет — однострочная.
  labelH: Record<string, number>;
  reorder: ReorderGesture | null;
  rowDrag: RowDragGesture | null;
  fragDrag: FragDragGesture | null;
  // Строка-призрак под последним шагом (протяжка новой связи).
  ghost: boolean;
}

/**
 * Колонки: x центра каждого участника по порядку и ширина холста. Подпись шага между
 * соседями (ширина не больше предела) задаёт промежуток между ними; подпись шага через
 * несколько колонок требует того же от суммы промежутков и, если её не хватает,
 * докладывает недостачу поровну в каждый. Узкие шаги идут первыми: их требование
 * точное, а широкий шаг часто уже накрыт промежутками, которые раздвинули они.
 */
export function computeColumns({ participants, messages, labelW = {}, headW = {}, labelCap = SQ.LABEL_MAX }: SeqColumnsInput) {
  const n = participants.length;
  const idx: Record<string, number> = {};
  participants.forEach((p, k) => { idx[p.id] = k; });
  const hw = (k: number) => Math.min(SQ.HEAD_MAX, Math.max(SQ.HEAD_MIN, headW[participants[k].id] ?? SQ.HEAD_MIN));
  // Ширина подписи на холсте: естественная, но не шире предела (шире — перенос).
  const lw = (id: string) => Math.min(labelCap, Math.max(0, labelW[id] ?? 0));

  // Наименьший промежуток — шапки соседей не сходятся ближе HEAD_GAP.
  const gaps = Array.from({ length: Math.max(0, n - 1) }, (_, k) => (hw(k) + hw(k + 1)) / 2 + SQ.HEAD_GAP);
  // Подпись шага внутри участника стоит справа от петли: у последней колонки она
  // уходит в правое поле.
  let selfRight = 0;
  const spans: { a: number; b: number; need: number }[] = [];
  for (const m of messages) {
    const ka = idx[m.from];
    const kb = idx[m.to];
    if (ka === undefined || kb === undefined) continue;
    if (ka === kb) {
      const need = SQ.SELF_OFF + lw(m.id) + SQ.LABEL_SIDE / 2;
      if (ka < n - 1) gaps[ka] = Math.max(gaps[ka], need);
      else selfRight = Math.max(selfRight, need);
      continue;
    }
    spans.push({ a: Math.min(ka, kb), b: Math.max(ka, kb), need: lw(m.id) + SQ.LABEL_SIDE });
  }
  spans.sort((x, y) => (x.b - x.a) - (y.b - y.a));
  for (const s of spans) {
    let sum = 0;
    for (let k = s.a; k < s.b; k++) sum += gaps[k];
    if (sum >= s.need) continue;
    const add = (s.need - sum) / (s.b - s.a);
    for (let k = s.a; k < s.b; k++) gaps[k] += add;
  }

  const marginL = n ? Math.max(SQ.SIDE, hw(0) / 2 + EDGE_PAD) : SQ.SIDE;
  const marginR = n ? Math.max(SQ.SIDE, hw(n - 1) / 2 + EDGE_PAD, selfRight) : SQ.SIDE;
  const xs: number[] = [];
  let x = marginL;
  for (let k = 0; k < n; k++) {
    xs.push(x);
    if (k < n - 1) x += gaps[k];
  }
  const W = n ? xs[n - 1] + marginR : marginL + marginR;
  return { idx, xs, gaps, W, lw, hw };
}

/**
 * Предел ширины подписи для вписывания в окно: наибольший (до SQ.LABEL_MAX), при
 * котором холст не шире maxW. Подписи переносятся ровно настолько, насколько это
 * нужно, чтобы процесс уместился; не уместился и на SQ.LABEL_MIN — остаётся он.
 */
export function fitLabelCap(input: Omit<SeqColumnsInput, "labelCap">, maxW: number): number {
  for (let cap = SQ.LABEL_MAX; cap > SQ.LABEL_MIN; cap -= CAP_STEP) {
    if (computeColumns({ ...input, labelCap: cap }).W <= maxW) return cap;
  }
  return SQ.LABEL_MIN;
}

export function computeSeqGeometry({
  participants, messages, fragments, labelW, headW, labelCap, labelH, reorder, rowDrag, fragDrag, ghost,
}: SeqGeometryInput) {
  const { idx, xs, gaps, W, lw } = computeColumns({ participants, messages, labelW, headW, labelCap });
  const pById: Record<string, SeqParticipant> = {};
  participants.forEach((p) => { pById[p.id] = p; });
  const n = participants.length;
  // x центра колонки (слота) по её номеру — по порядку участников до жеста.
  const PX = (k: number) => xs[k] ?? SQ.SIDE;
  const lifeTop = SQ.TOP + SQ.PHEAD_H;
  // Колонка под точкой x: ближайший центр колонки. Промежутки разные, поэтому деление
  // на постоянную ширину колонки больше не годится.
  const slotAt = (x: number): number => {
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < n; k++) {
      const d = Math.abs(x - xs[k]);
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  };
  // Радиус «попадания» в колонку: половина большего из соседних промежутков.
  const colHalf = (k: number): number =>
    Math.max(gaps[k - 1] ?? 0, gaps[k] ?? 0, SQ.HEAD_MIN) / 2;

  // Живой reorder: целевая колонка — ближайшая к курсору.
  const reorderToK = reorder ? slotAt(reorder.px) : -1;
  // Дисплейный x центра колонки участника с учётом живого reorder — ЕДИНЫЙ источник x
  // для шапок, линий жизни, стрелок, активаций и рамок: вся диаграмма перестраивается
  // синхронно во время драга (стрелки динамически меняют положение и направление).
  // Тянущийся участник следует за курсором (непрерывно); участники между исходной и
  // целевой колонкой сдвигаются в соседний слот. Без reorder — обычный PX по индексу.
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

  const R = messages.length ? Math.max(...messages.map((m) => m.r)) + 1 : 0;
  const lhOf = (id: string) => labelH[id] ?? DEFAULT_LH;
  // Высота подписи по строке = высота её шага (один шаг на строку).
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
  // Y строки шага с учётом жеста: тянущаяся идёт за курсором, прочие — по своей
  // новой строке.
  const msgY = (r: number): number =>
    rowDrag && rowDrag.moved && r === rowDrag.fromR ? rowDrag.py : rowY(shownRow(r));

  const ghostY = ghost ? rowY(R) - 6 : 0;
  const contentBottom = R > 0 ? rowY(R - 1) : lifeTop + SQ.ROW0;
  const H = ghost ? ghostY + 44 : contentBottom + 54;

  // Прямоугольники фрагментов (с горизонтальным вложением по depth).
  const fragBoxes = fragments
    .map((f) => {
      const rows = fragRows(f);
      // Ширина рамки выводится из охвата: берём крайние колонки шагов внутри.
      // Поэтому при протягивании грани она подстраивается под самую широкую стрелку
      // нового охвата сама — отдельного пересчёта не нужно.
      const inner = messages.filter((m) => m.r >= rows.from && m.r <= rows.to);
      if (!inner.length) return null;
      const xs2 = inner.flatMap((m) => [colX(m.from), colX(m.to)]);
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
        left: Math.min(...xs2) - 38 + inset,
        right: Math.max(...xs2) + 38 - inset,
        top: rowY(rows.from) - 26,
        bottom: rowY(rows.to) + 18,
        branches: fragBranches(f).map((b) => ({ ...b, y: rowY(b.row) - 16 })),
      };
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);

  return {
    idx, pById, n, PX, slotAt, colHalf, reorderToK, lifeTop, colX, isDraggedK, lhOf, labelWOf: lw,
    fragRows, fragBranches, rowY, rowFromY, shownRow, msgY, ghostY, W, H, fragBoxes,
  };
}
