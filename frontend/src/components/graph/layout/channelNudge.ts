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
//   к хэндлам. Пришпиленный участник канала фиксирует свою ось, остальные распределяются
//   вокруг него;
// - КЛИРЕНС ОТ УЗЛОВ (фикс регрессии T2, 2026-07-15): цель сдвига не подходит к грани узла
//   ближе NUDGE_CLEAR при совместном пробеге. Раньше защитой была только bbox-пенетрация
//   с 2px-запасом — жёсткая шкала слотов выталкивала крайнее плечо тесного коридора на
//   грань и даже внутрь тела (репро: «Инициация оплаты» в теле «Сервиса пользователей»);
// - ЦЕЛИ КАНАЛА — ЕДИНЫМ VPSC (там же): пины (концевые) держат оси весом ∞, клиренс-границы
//   узлов по пробегу КАЖДОЙ группы — стенки-псевдопины, соседи ≥ gap. Тесно — gap деградирует
//   14→12→10→8 (ниже нельзя: дуги мостиков JUMP_RADIUS=6 сольются); совсем никак — канал
//   не трогаем (лучше остаточное наложение, чем ложь о теле узла). Прежние ветки «жёсткая
//   шкала center+j·gap», «лесенка сдвига шкалы» и отдельный многопиновый путь — частные
//   случаи этого решения и удалены;
// - сдвиг не должен «переломить» соседние перпендикулярные сегменты (знак их направления
//   сохраняется) — иначе сдвиг этого ребра отменяется;
// - детерминизм: кластеры и группы обходятся в отсортированном порядке.
import type { EdgePoint } from "../../../types";
import { cleanup, type SegOrient } from "../edgePath";
import { solveSeparation, type SepConstraint } from "./vpsc";

const EPS = 0.75;      // допуск «одна линия»
const OVERLAP_MIN = 3; // перекрытие > 3px считаем наложением (касание концами игнорируем)
// idealNudgingDistance — зазор между соседними плечами канала. 14 (было 12): воздух
// под мостики — две дуги JUMP_RADIUS=6 на соседних плечах канала (2·6=12) при 12
// смыкались впритык; 14 даёт видимый просвет («дуга всегда», 2026-07-09).
const GAP = 14;
// Почти-параллельные сегменты (T2 «читаемые пучки»): линии ближе 1.5×gap с существенным
// совместным пробегом — тоже канал (раньше — только точные наложения, и коридор из линий
// на 8px друг от друга оставался «плетёнкой»). Порог пробега выше, чем у точных: короткое
// соседство стабов у доков — не коридор.
const NEAR_OVERLAP_MIN = 24;
// Клиренс плеч от тел узлов (= JOG_CLEAR спрямления джогов в routeAll — единый зазор
// пост-обработки; роутер держит 12, но его линии по margin легальны и трогаются каналом).
const NUDGE_CLEAR = 8;
// Плечо, уже лежащее в клиренс-полосе узла (роутер прижал в вынужденной тесноте либо канал
// исторически лёг на грань), выталкивается в ближайший свободный зазор, только если тот
// не дальше MAX_EVICT×gap — дальний увод растягивал бы маршрут (это уже пере-роутинг,
// не нуджинг); иначе пин на месте: не делаем хуже.
const MAX_EVICT = 2;

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

// Кластеризация сегментов одной ориентации в каналы (union-find по парам). Точное
// наложение (|Δaxis| ≤ EPS, пробег > OVERLAP_MIN) — как раньше; T2: почти-параллельные
// РАЗНЫХ рёбер (|Δaxis| ≤ nearTol, существенный совместный пробег) — тоже один канал:
// коридор разводится равными зазорами целиком, а не остаётся «плетёнкой» линий на
// пиксельных отступах. Пары одного ребра в near-режиме не склеиваем (S-образный маршрут
// сам себе не коридор).
function clusterChannels(segs: Seg[], nearTol: number): Seg[][] {
  const parent = segs.map((_, k) => k);
  const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k])));
  for (let a = 0; a < segs.length; a++) {
    for (let b = a + 1; b < segs.length; b++) {
      if (segs[a].orient !== segs[b].orient) continue;
      const dAxis = Math.abs(segs[a].axis - segs[b].axis);
      if (dAxis <= EPS) {
        if (overlap(segs[a], segs[b]) <= OVERLAP_MIN) continue;
      } else {
        if (dAxis > nearTol) continue;
        if (segs[a].edgeId === segs[b].edgeId) continue;
        if (overlap(segs[a], segs[b]) <= NEAR_OVERLAP_MIN) continue;
      }
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

// Ось в клиренс-полосе узла [грань−clear, грань+clear] при совместном пробеге (осевые
// сегменты — точен). Люфт 0.25 согласован со стенками corridorOf: цель РОВНО на краю
// полосы (стенке) легальна и не дрожит от float-шума VPSC.
const inClearance = (
  orient: SegOrient, axis: number, lo: number, hi: number, r: Rect, clear: number,
): boolean => {
  const spanOverlap = orient === "h"
    ? lo < r.x + r.w - 2 && hi > r.x + 2
    : lo < r.y + r.h - 2 && hi > r.y + 2;
  if (!spanOverlap) return false;
  const a = (orient === "h" ? r.y : r.x) - clear;
  const b = (orient === "h" ? r.y + r.h : r.x + r.w) + clear;
  return axis > a + 0.25 && axis < b - 0.25;
};

// Допустимый интервал осей группы: свободный зазор между клиренс-полосами узлов,
// перекрывающих пробег её сегментов. Ось внутри полосы → выталкивание в ближний зазор
// (тай-брейк — вниз/вправо), если он не дальше MAX_EVICT×gap; иначе {axis, axis} — пин.
const corridorOf = (
  segs: Seg[], axis: number, obstacles: Rect[], gap: number,
): { lo: number; hi: number } => {
  const bands: Array<[number, number]> = [];
  for (const s of segs) {
    for (const r of obstacles) {
      const spanOverlap = s.orient === "h"
        ? s.lo < r.x + r.w - 2 && s.hi > r.x + 2
        : s.lo < r.y + r.h - 2 && s.hi > r.y + 2;
      if (!spanOverlap) continue;
      const a = (s.orient === "h" ? r.y : r.x) - NUDGE_CLEAR;
      bands.push([a, a + (s.orient === "h" ? r.h : r.w) + 2 * NUDGE_CLEAR]);
    }
  }
  if (bands.length === 0) return { lo: -Infinity, hi: Infinity };
  bands.sort((p, q) => p[0] - q[0]);
  const merged: Array<[number, number]> = [];
  for (const b of bands) {
    const last = merged[merged.length - 1];
    if (last && b[0] <= last[1] + 0.25) last[1] = Math.max(last[1], b[1]);
    else merged.push([b[0], b[1]]);
  }
  let below = -Infinity, above = Infinity, insideIdx = -1;
  merged.forEach(([a, b], k) => {
    if (axis > a + 0.25 && axis < b - 0.25) insideIdx = k;
    if (b <= axis + 0.25 && b > below) below = b;
    if (a >= axis - 0.25 && a < above) above = a;
  });
  if (insideIdx < 0) return { lo: below, hi: above };
  const [a, b] = merged[insideIdx];
  if (Math.min(axis - a, b - axis) > MAX_EVICT * gap) return { lo: axis, hi: axis };
  if (b - axis <= axis - a) return { lo: b, hi: merged[insideIdx + 1]?.[0] ?? Infinity };
  return { lo: merged[insideIdx - 1]?.[1] ?? -Infinity, hi: a };
};

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
  const channels = clusterChannels(allSegs, gap * 1.5).sort(
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
    // Бакет по оси (T2): ствол — это сегменты трунк-родственников НА ОДНОЙ ЛИНИИ.
    // Без бакета сегмент того же ребра на ДРУГОЙ оси (near-кластеризация) наследовал
    // группу ствола вместе с его пришпиленностью — и переставал разводиться.
    const groups = new Map<string, Seg[]>();
    for (const s of channel) {
      const k = `${groupOf.get(s.edgeId)!}@${Math.round(s.axis)}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(s);
    }
    if (groups.size < 2) continue; // весь канал — один ствол, наложение легитимно

    // Группы канала с допустимыми интервалами осей (клиренс-стенки коридора по пробегу
    // КАЖДОЙ группы, не канала целиком — узел, мешающий одной группе, не сжимает
    // остальных). desired — ось, клампнутая в свой зазор (выталкивание с грани/из тела).
    // Порядок — по desired (уже разъехавшиеся линии сохраняют пространственный порядок —
    // идемпотентность повторных прогонов), при совпадении — по среднему refPerp (откуда
    // приходят/куда уходят маршруты): соседние по подходам линии — соседние слоты,
    // меньше крестов на входах.
    const ordered = [...groups.entries()]
      .map(([k, ss]) => {
        const axis = ss.reduce((sum, s) => sum + s.axis, 0) / ss.length;
        const fixed = ss.some((s) => !s.movable);
        const corridor = fixed ? { lo: axis, hi: axis } : corridorOf(ss, axis, obstacles, gap);
        return {
          key: k, segs: ss, axis, fixed, corridor,
          ref: ss.reduce((sum, s) => sum + s.refPerp, 0) / ss.length,
          desired: Math.min(Math.max(axis, corridor.lo), corridor.hi),
        };
      })
      .sort((a, b) =>
        (Math.abs(a.desired - b.desired) > EPS ? a.desired - b.desired : 0) ||
        a.ref - b.ref || a.key.localeCompare(b.key));
    const n = ordered.length;

    // Применим ли сдвиг сегмента на офсет off: соседние перпендикулярные сегменты не
    // переламываются (знак направления сохраняется), цель вне клиренс-полос узлов —
    // страховка применения на случай несовершенства модели стенок.
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
      const hitsClearance = obstacles.some((r) =>
        inClearance(s.orient, newAxis, s.lo, s.hi, r, NUDGE_CLEAR));
      return beforeOk && afterOk && !hitsClearance;
    };

    // Цели канала при зазоре sepGap — VPSC: пины (fixed и «замурованные» с пустым
    // зазором) держат оси весом ∞; конечные стенки коридора — псевдопеременные весом ∞
    // с нулевым зазором к своей группе; соседние группы ≥ sepGap. Невыполнимость
    // (какой-то ∞ съехал с desired при merge-склейке) → null.
    const solveAt = (sepGap: number): number[] | null => {
      const desired: number[] = ordered.map((g) => g.desired);
      const weights: number[] = ordered.map((g) => (g.corridor.lo === g.corridor.hi ? Infinity : 1));
      const cons: SepConstraint[] = [];
      for (let j = 1; j < n; j++) cons.push({ left: j - 1, right: j, gap: sepGap });
      ordered.forEach((g, j) => {
        if (weights[j] === Infinity) return;
        if (g.corridor.lo > -Infinity) {
          cons.push({ left: desired.length, right: j, gap: 0 });
          desired.push(g.corridor.lo); weights.push(Infinity);
        }
        if (g.corridor.hi < Infinity) {
          cons.push({ left: j, right: desired.length, gap: 0 });
          desired.push(g.corridor.hi); weights.push(Infinity);
        }
      });
      const targets = solveSeparation(desired, weights, cons);
      // Порог строгий (0.25, не 0.5): нехватка места размазывается merge-блоком
      // ПОРОВНУ на обе стенки — по 0.5 при дефиците в 1px — и щедрый порог
      // признал бы решение, которое canApply потом честно ветирует.
      for (let k = 0; k < desired.length; k++) {
        if (weights[k] === Infinity && Math.abs(targets[k] - desired[k]) > 0.25) return null;
      }
      return targets.slice(0, n);
    };

    // Деградация зазора в тесном коридоре: gap → 12 → 10 → 8 (ниже нельзя — дуги
    // мостиков JUMP_RADIUS=6 соседних плеч сольются совсем). Ни одна ступень не
    // влезла → канал не трогаем: лучше остаточное наложение, чем плечо на грани
    // или в теле узла.
    let targets: number[] | null = null;
    for (const sepGap of [...new Set([gap, 12, 10, 8])].filter((v) => v <= gap)) {
      targets = solveAt(sepGap);
      if (targets) break;
    }
    if (!targets) continue;

    for (let j = 0; j < n; j++) {
      const g = ordered[j];
      if (g.fixed) continue;
      // сдвиг применяется по-сегментно к целевой линии: члены группы с чуть разными
      // осями (near-параллельный коридор) сходятся на одну линию
      for (const s of g.segs) {
        const off = targets[j] - s.axis;
        if (Math.abs(off) < 0.5) continue;
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
