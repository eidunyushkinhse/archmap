// КАНАЛЬНЫЙ NUDGING (эпик стрелок V2.3, канон GD'09/libavoid «ordered nudging»).
//
// Обобщение точечного A13: вместо «сдвинуть короткий джог одного нарушителя» — собрать ВСЕ
// коллинеарно наложенные плечи в «канал», упорядочить связи внутри канала (по тому, откуда
// приходят и куда уходят их маршруты — меньше самопересечений на входах в канал) и развести
// их РАВНЫМИ зазорами (idealNudgingDistance) вокруг исходной линии. Так пучок из N стрелок
// в одном коридоре превращается в N параллельных читаемых линий, а не в кашу.
//
// Правило Т4 (архитектор): наложение плеч допустимо ТОЛЬКО из одного хэндла — родственные
// стрелки общего хэндла остаются слитым стволом (одна группа канала, один общий офсет).
//
// Ограничения по построению:
// - двигаем только ИНТЕРЬЕРНЫЕ сегменты (оба конца — не концы ломаной): концевые пришпилены
//   к хэндлам. Пришпиленный участник канала фиксирует свой офсет 0, остальные распределяются
//   вокруг него;
// - сдвиг не должен загнать плечо в тело узла (bbox-пенетрация) и не должен «переломить»
//   соседние перпендикулярные сегменты (знак их направления сохраняется) — иначе сдвиг
//   этого ребра отменяется;
// - детерминизм: кластеры и группы обходятся в отсортированном порядке.
import type { EdgePoint } from "../../../types";
import { cleanup, type SegOrient } from "../edgePath";

const EPS = 0.75;      // допуск «одна линия»
const OVERLAP_MIN = 3; // перекрытие > 3px считаем наложением (касание концами игнорируем)
// idealNudgingDistance — зазор между соседними плечами канала. 14 (было 12): воздух
// под мостики — две дуги JUMP_RADIUS=6 на соседних плечах канала (2·6=12) при 12
// смыкались впритык; 14 даёт видимый просвет («дуга всегда», 2026-07-09).
const GAP = 14;

export interface ChannelNudgeResult {
  routes: Map<string, EdgePoint[]>;
  nudged: Set<string>;
}

interface Seg {
  edgeId: string;
  i: number;            // индекс начала сегмента в ломаной (i → i+1)
  orient: SegOrient;
  axis: number;         // постоянная координата (y для «h», x для «v»)
  lo: number;
  hi: number;
  movable: boolean;     // интерьерный (не примыкает к концам ломаной)
  refPerp: number;      // «откуда/куда» — средняя перп-координата соседних вершин (порядок в канале)
}

interface Rect { x: number; y: number; w: number; h: number }

function segsOf(edgeId: string, pts: EdgePoint[]): Seg[] {
  const out: Seg[] = [];
  const last = pts.length - 1;
  for (let i = 0; i < last; i++) {
    const p = pts[i], q = pts[i + 1];
    const dx = q.x - p.x, dy = q.y - p.y;
    if (Math.abs(dx) <= EPS && Math.abs(dy) <= EPS) continue;
    const orient: SegOrient = Math.abs(dy) <= Math.abs(dx) ? "h" : "v";
    const axis = orient === "h" ? p.y : p.x;
    const perpOf = (t: EdgePoint): number => (orient === "h" ? t.y : t.x);
    // соседние вершины (за пределами сегмента) говорят, с какой стороны маршрут приходит
    // и куда уходит — по ним канал упорядочивается; у концевых берём саму линию
    const before = i > 0 ? perpOf(pts[i - 1]) : axis;
    const after = i + 2 <= last ? perpOf(pts[i + 2]) : axis;
    out.push({
      edgeId, i, orient, axis,
      lo: orient === "h" ? Math.min(p.x, q.x) : Math.min(p.y, q.y),
      hi: orient === "h" ? Math.max(p.x, q.x) : Math.max(p.y, q.y),
      movable: i > 0 && i + 1 < last,
      refPerp: (before + after) / 2,
    });
  }
  return out;
}

const overlap = (a: Seg, b: Seg): number => Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo);

// Кластеризация сегментов одной ориентации в каналы: близкая линия (|Δaxis| ≤ EPS·2 —
// уже разведённые на GAP не трогаем) и перекрытие по протяжённости. Union-find по парам.
function clusterChannels(segs: Seg[]): Seg[][] {
  const parent = segs.map((_, k) => k);
  const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k])));
  for (let a = 0; a < segs.length; a++) {
    for (let b = a + 1; b < segs.length; b++) {
      if (segs[a].orient !== segs[b].orient) continue;
      if (Math.abs(segs[a].axis - segs[b].axis) > EPS) continue;
      if (overlap(segs[a], segs[b]) <= OVERLAP_MIN) continue;
      parent[find(a)] = find(b);
    }
  }
  const byRoot = new Map<number, Seg[]>();
  segs.forEach((s, k) => {
    const r = find(k);
    (byRoot.get(r) ?? byRoot.set(r, []).get(r)!).push(s);
  });
  return [...byRoot.values()].filter((c) => c.length > 1);
}

// Пенетрация bbox сегмента в тело (осевые сегменты — точен).
const cutsBody = (orient: SegOrient, axis: number, lo: number, hi: number, r: Rect): boolean =>
  orient === "h"
    ? axis > r.y + 2 && axis < r.y + r.h - 2 && lo < r.x + r.w - 2 && hi > r.x + 2
    : axis > r.x + 2 && axis < r.x + r.w - 2 && lo < r.y + r.h - 2 && hi > r.y + 2;

export function nudgeChannels(params: {
  routes: Map<string, EdgePoint[]>;
  handles: ReadonlyMap<string, { sourceHandle: string; targetHandle: string }>;
  obstacles: Rect[];
  gap?: number;
}): ChannelNudgeResult {
  const { routes, handles, obstacles } = params;
  const gap = params.gap ?? GAP;

  // рабочие копии ломаных — сдвиги мутируют их на месте
  const work = new Map<string, EdgePoint[]>();
  for (const [id, pts] of routes) work.set(id, pts.map((p) => ({ x: p.x, y: p.y })));

  const allSegs: Seg[] = [];
  const ids = [...work.keys()].sort();
  for (const id of ids) allSegs.push(...segsOf(id, work.get(id)!));

  const nudged = new Set<string>();
  const channels = clusterChannels(allSegs).sort(
    (a, b) => a[0].orient.localeCompare(b[0].orient) || a[0].axis - b[0].axis || a[0].lo - b[0].lo,
  );

  for (const channel of channels) {
    // Группы канала: рёбра, делящие хэндл, — легитимный общий ствол (Т4), один офсет.
    // Ключ группы — общий хэндл, если он есть у пары; иначе своё ребро.
    const groupOf = new Map<string, string>(); // edgeId → groupKey
    const edgeIds = [...new Set(channel.map((s) => s.edgeId))].sort();
    for (const id of edgeIds) {
      const h = handles.get(id);
      const hs = h ? [h.sourceHandle, h.targetHandle] : [];
      let key = id;
      for (const other of edgeIds) {
        if (other === id) continue;
        const oh = handles.get(other);
        if (!oh) continue;
        const shared = hs.find((x) => x === oh.sourceHandle || x === oh.targetHandle);
        if (shared) { key = `trunk:${shared}`; break; }
      }
      groupOf.set(id, key);
    }
    const groups = new Map<string, Seg[]>();
    for (const s of channel) {
      const k = groupOf.get(s.edgeId)!;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(s);
    }
    if (groups.size < 2) continue; // весь канал — один ствол, наложение легитимно

    // Порядок групп: по среднему refPerp (откуда приходят/куда уходят маршруты) — соседние
    // по подходам линии становятся соседними слотами, меньше пересечений на входах в канал.
    const ordered = [...groups.entries()]
      .map(([k, ss]) => ({
        key: k, segs: ss,
        ref: ss.reduce((sum, s) => sum + s.refPerp, 0) / ss.length,
        fixed: ss.some((s) => !s.movable),
      }))
      .sort((a, b) => a.ref - b.ref || a.key.localeCompare(b.key));

    // Слоты вокруг исходной линии: (j - (n-1)/2)·gap. Группа с пришпиленным (концевым)
    // сегментом двигаться не может — сдвигаем шкалу так, чтобы её слот стал нулевым.
    // Двух разных пришпиленных групп шкала примирить не может — канал пропускаем.
    const fixedIdx = ordered.map((g, j) => (g.fixed ? j : -1)).filter((j) => j >= 0);
    if (fixedIdx.length > 1) continue;
    const n = ordered.length;
    const base = (j: number): number => (j - (n - 1) / 2) * gap;
    let shift = fixedIdx.length === 1 ? -base(fixedIdx[0]) : 0;

    // Применим ли сдвиг сегмента на офсет off: соседние перпендикулярные сегменты не
    // переламываются (знак направления сохраняется), плечо не заезжает в тело узла.
    const canApply = (s: Seg, off: number): boolean => {
      if (Math.abs(off) < 0.5) return true; // нулевой сдвиг всегда легален
      const pts = work.get(s.edgeId)!;
      const p = pts[s.i], q = pts[s.i + 1];
      const newAxis = s.axis + off;
      const perpOf = (t: EdgePoint): number => (s.orient === "h" ? t.y : t.x);
      const beforeOk =
        s.i === 0 ||
        Math.sign(perpOf(p) - perpOf(pts[s.i - 1])) === 0 ||
        Math.sign(newAxis - perpOf(pts[s.i - 1])) === Math.sign(perpOf(p) - perpOf(pts[s.i - 1]));
      const afterOk =
        s.i + 2 >= pts.length ||
        Math.sign(perpOf(q) - perpOf(pts[s.i + 2])) === 0 ||
        Math.sign(newAxis - perpOf(pts[s.i + 2])) === Math.sign(perpOf(q) - perpOf(pts[s.i + 2]));
      const hitsBody = obstacles.some((r) => cutsBody(s.orient, newAxis, s.lo, s.hi, r));
      return beforeOk && afterOk && !hitsBody;
    };

    // ЛЕСЕНКА В ОДНУ СТОРОНУ (2026-07-09): симметричные слоты вокруг исходной линии
    // упираются в тело узла (канал в тесном проходе — встречная пара в 24px щели под
    // «Базами данных») → по-сегментное вето молча оставляло канал НЕразведённым
    // (коллинеарное наложение переживало nudge). Если дефолтная шкала не проходит
    // целиком, пробуем сдвинуть ВСЮ шкалу дискретными шагами gap/2 (ближние первыми,
    // детерминированно) — канал уезжает лесенкой в свободную сторону коридора.
    // Пришпиленная группа пинит шкалу — кандидаты её бы сдвинули, их отфильтрует
    // evalShift. Ни один кандидат не прошёл — прежнее поведение (применяем что можно).
    const evalShift = (cand: number): boolean =>
      ordered.every((g, j) => {
        const off = base(j) + cand;
        if (g.fixed) return Math.abs(off) < 0.5;
        return g.segs.every((s) => canApply(s, off));
      });
    if (!evalShift(shift)) {
      const cands: number[] = [];
      for (let k = 1; k <= 4; k++) cands.push(shift + (k * gap) / 2, shift - (k * gap) / 2);
      const ok = cands.find(evalShift);
      if (ok !== undefined) shift = ok;
    }

    for (let j = 0; j < n; j++) {
      const off = base(j) + shift;
      if (Math.abs(off) < 0.5) continue;
      const g = ordered[j];
      if (g.fixed) continue;
      // сдвиг применяется по-рёберно: каждый сегмент группы этого ребра — на общий офсет
      for (const s of g.segs) {
        if (!canApply(s, off)) continue;
        const pts = work.get(s.edgeId)!;
        const p = pts[s.i], q = pts[s.i + 1];
        const newAxis = s.axis + off;
        if (s.orient === "h") { p.y = newAxis; q.y = newAxis; }
        else { p.x = newAxis; q.x = newAxis; }
        nudged.add(s.edgeId);
      }
    }
  }

  const out = new Map<string, EdgePoint[]>();
  for (const [id, pts] of work) out.set(id, nudged.has(id) ? cleanup(pts) : routes.get(id)!);
  return { routes: out, nudged };
}
