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
import { solveSeparation } from "./vpsc";

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

    // Порядок групп (T2): первично — по ТЕКУЩЕЙ оси (уже разъехавшиеся линии сохраняют
    // пространственный порядок — идемпотентность повторных прогонов), при точном
    // совпадении осей (свежий пучок) — по среднему refPerp (откуда приходят/куда уходят
    // маршруты): соседние по подходам линии — соседние слоты, меньше крестов на входах.
    const ordered = [...groups.entries()]
      .map(([k, ss]) => ({
        key: k, segs: ss,
        axis: ss.reduce((sum, s) => sum + s.axis, 0) / ss.length,
        ref: ss.reduce((sum, s) => sum + s.refPerp, 0) / ss.length,
        fixed: ss.some((s) => !s.movable),
      }))
      .sort((a, b) =>
        (Math.abs(a.axis - b.axis) > EPS ? a.axis - b.axis : 0) ||
        a.ref - b.ref || a.key.localeCompare(b.key));

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

    // Целевые линии: равные зазоры gap вокруг ЦЕНТРА канала (середина крайних осей;
    // для свежего пучка совпадает с исходной линией). Группа с пришпиленным (концевым)
    // сегментом двигаться не может — сдвигаем шкалу так, чтобы её цель совпала с её осью.
    const fixedIdx = ordered.map((g, j) => (g.fixed ? j : -1)).filter((j) => j >= 0);
    const n = ordered.length;
    // МНОГОПИНОВЫЙ канал (T2): раньше пропускался целиком, и подвижная линия между
    // двумя стволами-пинами оставалась в пикселях от соседа. Теперь пины держат свои
    // оси (вес ∞), подвижные распределяются между ними VPSC-цепочкой «соседи ≥ gap»
    // в порядке осей. Пины ближе gap друг к другу примирить нельзя — канал пропускаем.
    if (fixedIdx.length > 1) {
      let pinsConflict = false;
      for (let k = 1; k < fixedIdx.length && !pinsConflict; k++) {
        if (ordered[fixedIdx[k]].axis - ordered[fixedIdx[k - 1]].axis < gap - 0.5) pinsConflict = true;
      }
      if (pinsConflict) continue;
      const targets = solveSeparation(
        ordered.map((g) => g.axis),
        ordered.map((g) => (g.fixed ? Infinity : 1)),
        ordered.slice(1).map((_, k) => ({ left: k, right: k + 1, gap })),
      );
      // Невыполнимость (подвижным между пинами не хватает места, merge-блок сдвинул
      // пины с их осей) — канал не примирить, оставляем как есть.
      if (fixedIdx.some((j) => Math.abs(targets[j] - ordered[j].axis) > 0.5)) continue;
      for (let j = 0; j < n; j++) {
        const g = ordered[j];
        if (g.fixed) continue;
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
      continue;
    }
    const center = (Math.min(...ordered.map((g) => g.axis)) + Math.max(...ordered.map((g) => g.axis))) / 2;
    const target = (j: number, shift: number): number => center + (j - (n - 1) / 2) * gap + shift;
    let shift = 0;
    if (fixedIdx.length === 1) {
      const jf = fixedIdx[0];
      shift = ordered[jf].axis - target(jf, 0);
    }

    // ЛЕСЕНКА В ОДНУ СТОРОНУ (2026-07-09): симметричные слоты вокруг центра упираются
    // в тело узла (канал в тесном проходе) → по-сегментное вето молча оставляло канал
    // НЕразведённым. Если дефолтная шкала не проходит целиком, пробуем сдвинуть ВСЮ
    // шкалу дискретными шагами gap/2 (ближние первыми, детерминированно) — канал
    // уезжает лесенкой в свободную сторону коридора. Пришпиленная группа пинит шкалу.
    // Ни один кандидат не прошёл — прежнее поведение (применяем что можно).
    const evalShift = (cand: number): boolean =>
      ordered.every((g, j) => {
        const off = target(j, cand) - g.axis;
        if (g.fixed) return Math.abs(off) < 0.5;
        return g.segs.every((s) => canApply(s, target(j, cand) - s.axis));
      });
    if (!evalShift(shift)) {
      const cands: number[] = [];
      for (let k = 1; k <= 4; k++) cands.push(shift + (k * gap) / 2, shift - (k * gap) / 2);
      const ok = cands.find(evalShift);
      if (ok !== undefined) shift = ok;
    }

    for (let j = 0; j < n; j++) {
      const g = ordered[j];
      if (g.fixed) continue;
      // сдвиг применяется по-сегментно к ЦЕЛЕВОЙ линии слота: члены группы с чуть
      // разными осями (near-параллельный коридор) сходятся на одну линию
      for (const s of g.segs) {
        const off = target(j, shift) - s.axis;
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
