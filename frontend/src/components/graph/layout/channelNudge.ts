// КАНАЛЬНЫЙ NUDGING (эпик стрелок V2.3, канон GD'09/libavoid «ordered nudging»).
//
// Обобщение точечного A13: вместо «сдвинуть короткий джог одного нарушителя» — собрать ВСЕ
// коллинеарно наложенные плечи в «канал», упорядочить связи внутри канала (по тому, откуда
// приходят и куда уходят их маршруты — меньше самопересечений на входах в канал) и развести
// их РАВНЫМИ зазорами (idealNudgingDistance) вокруг исходной линии. Так пучок из N стрелок
// в одном коридоре превращается в N параллельных читаемых линий, а не в кашу.
//
// Правило Т4 v2 (E25/E30, эпик arrow-trunks Ф4): наложение плеч допустимо только в
// ЛЕГАЛЬНОМ КУСКЕ пары — общем префиксе (исходящий веер) или суффиксе (входящий) от
// общего порта одной роли. Такие сегменты остаются слитым стволом (одна группа канала,
// один общий офсет); всё прочее — включая повторные схождения разошедшихся членов веера
// и встречные плечи — разные группы, разводятся зазором.
//
// Ограничения по построению:
// - двигаем только ИНТЕРЬЕРНЫЕ сегменты (оба конца — не концы ломаной): концевые пришпилены
//   к хэндлам. Пришпиленный участник канала фиксирует свою ось, остальные распределяются
//   вокруг него;
// - КЛИРЕНС ОТ УЗЛОВ (фикс регрессии T2, 2026-07-15): цель сдвига не подходит к грани узла
//   ближе NUDGE_CLEAR при совместном пробеге. СОВМЕСТНЫЙ ПРОБЕГ СЧИТАЕТСЯ ПО ЖИВОЙ
//   ГЕОМЕТРИИ (Ф4-I, см. canApply): по снимку два хода из разных каналов вместе снимали
//   угол тела, каждый «не видя» его на своём пробеге. Раньше защитой была только bbox-пенетрация
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
import { cleanup, segments, type SegOrient } from "../edgePath";
import { solveSeparation, type SepConstraint } from "./vpsc";
import { trunkPieces } from "./trunks";

export const EPS = 0.75;      // допуск «одна линия»
export const OVERLAP_MIN = 3; // перекрытие > 3px считаем наложением (касание концами игнорируем)
// idealNudgingDistance — зазор между соседними плечами канала. 14 (было 12): воздух
// под мостики — две дуги JUMP_RADIUS=6 на соседних плечах канала (2·6=12) при 12
// смыкались впритык; 14 даёт видимый просвет («дуга всегда», 2026-07-09).
// Экспорт: раскладка (flowGaps) резервирует вертикальные коридоры под спрос канала.
export const NUDGE_GAP = 14;
// Почти-параллельные сегменты (T2 «читаемые пучки»): линии ближе 1.5×gap с существенным
// совместным пробегом — тоже канал (раньше — только точные наложения, и коридор из линий
// на 8px друг от друга оставался «плетёнкой»). Порог пробега выше, чем у точных: короткое
// соседство стабов у доков — не коридор.
export const NEAR_OVERLAP_MIN = 24;
// Клиренс плеч от тел узлов (= JOG_CLEAR спрямления джогов в routeAll — единый зазор
// пост-обработки; роутер держит 12, но его линии по margin легальны и трогаются каналом).
export const NUDGE_CLEAR = 8;
// ЛЕСТНИЦА ДЕГРАДАЦИИ ЗАЗОРА в тесном коридоре (см. solveAt ниже): целевой gap →
// 12 → 10 → 8. Ниже нельзя — дуги мостиков JUMP_RADIUS=6 соседних плеч сольются.
// Вынесена в именованную константу (Ф2 эпика router-opt): геометрия каналов входит
// в реестр ROUTER_VERSION — сторож протухания кэша маршрутов вида.
export const NUDGE_GAP_LADDER: readonly number[] = [12, 10, 8];
// Плечо, уже лежащее в клиренс-полосе узла (роутер прижал в вынужденной тесноте либо канал
// исторически лёг на грань), выталкивается в ближайший свободный зазор, только если тот
// не дальше MAX_EVICT×gap — дальний увод растягивал бы маршрут (это уже пере-роутинг,
// не нуджинг); иначе пин на месте: не делаем хуже.
export const MAX_EVICT = 2;

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
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- set() выше гарантировал наличие ключа
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
  obstacles: Rect[];
  gap?: number;
}): ChannelNudgeResult {
  const { routes, obstacles } = params;
  const gap = params.gap ?? NUDGE_GAP;

  // рабочие копии ломаных — сдвиги мутируют их на месте
  const work = new Map<string, EdgePoint[]>();
  for (const [id, pts] of routes) work.set(id, pts.map((p) => ({ x: p.x, y: p.y })));

  const allSegs: Seg[] = [];
  const ids = [...work.keys()].sort();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- ids из work.keys(), ключ заведомо есть
  for (const id of ids) allSegs.push(...segsOf(id, work.get(id)!));

  const nudged = new Set<string>();
  const channels = clusterChannels(allSegs, gap * 1.5).sort(
    (a, b) => a[0].orient.localeCompare(b[0].orient) || a[0].axis - b[0].axis || a[0].lo - b[0].lo,
  );

  // ЛЕГАЛЬНЫЕ СТВОЛЫ (E30 v2, Ф4): куски общих префиксов/суффиксов по фактическим
  // концам маршрутов (E25 v2, trunks.ts) — единственное основание держать плечи
  // РАЗНЫХ рёбер слитыми. Прежний ключ «делят хэндл» склеивал и разошедшиеся члены
  // веера (повторное схождение не разводилось), и был слеп к ролям (встречная пара
  // в одной точке стыковки считалась стволом). Сегменты кусков — по парам рёбер.
  const pieceSegs = new Map<string, Array<{ h: boolean; c: number; lo: number; hi: number }>>();
  for (const [id, list] of trunkPieces(routes)) {
    for (const p of list) {
      const key = id < p.mateId ? `${id}|${p.mateId}` : `${p.mateId}|${id}`;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- set() выше гарантировал наличие ключа
      const arr = pieceSegs.get(key) ?? pieceSegs.set(key, []).get(key)!;
      // записи симметричны (кусок кладётся от обоих концов пары) — поиск терпит дубли
      for (const s of segments(p.pts)) {
        const h = s.orient === "h";
        arr.push({
          h,
          c: h ? s.y1 : s.x1,
          lo: h ? Math.min(s.x1, s.x2) : Math.min(s.y1, s.y2),
          hi: h ? Math.max(s.x1, s.x2) : Math.max(s.y1, s.y2),
        });
      }
    }
  }
  // Пара сегментов канала слита ЛЕГАЛЬНО: точное совпадение осей и перекрытие,
  // лежащее внутри сегмента легального куска этой пары (допуски — дрейф walk-а).
  const legallyMerged = (a: Seg, b: Seg): boolean => {
    if (Math.abs(a.axis - b.axis) > EPS) return false;
    const lo = Math.max(a.lo, b.lo), hi = Math.min(a.hi, b.hi);
    if (hi - lo <= OVERLAP_MIN) return false;
    const key = a.edgeId < b.edgeId ? `${a.edgeId}|${b.edgeId}` : `${b.edgeId}|${a.edgeId}`;
    const list = pieceSegs.get(key);
    if (!list) return false;
    const horiz = a.orient === "h";
    for (const ps of list) {
      if (ps.h !== horiz || Math.abs(ps.c - a.axis) > 1) continue;
      if (lo >= ps.lo - 1 && hi <= ps.hi + 1) return true;
    }
    return false;
  };

  for (const channel of channels) {
    // ГРУППЫ КАНАЛА (E30 v2): union-find по парам сегментов — слиты только легальные
    // куски (сваренный веер остаётся одним стволом с одним офсетом); сегменты ОДНОГО
    // ребра на одной линии двигаются вместе (прежний бакет по оси). Разошедшиеся и
    // встречные плечи попадают в разные группы и разводятся зазором.
    const parent = channel.map((_, k) => k);
    const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k])));
    for (let x = 0; x < channel.length; x++) {
      for (let y = x + 1; y < channel.length; y++) {
        const a = channel[x], b = channel[y];
        const sameEdgeLine = a.edgeId === b.edgeId && Math.abs(a.axis - b.axis) <= EPS;
        if (sameEdgeLine || (a.edgeId !== b.edgeId && legallyMerged(a, b))) {
          parent[find(x)] = find(y);
        }
      }
    }
    const groups = new Map<string, Seg[]>();
    channel.forEach((s, k) => {
      const key = `g${String(find(k)).padStart(3, "0")}`;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- set() выше гарантировал наличие ключа
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
    });
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
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- edgeId из сегментов, построенных по work
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
      // ЖИВОЙ СПАН, А НЕ СНИМОК (Ф4-I эпика «глубокая оптимизация роутера», 2026-08-21).
      // s.lo/s.hi сняты ОДИН РАЗ до цикла по каналам, а фактическая длина сегмента
      // вдоль своей оси задана его ПЕРПЕНДИКУЛЯРНЫМИ соседями — а они получают
      // собственные офсеты. По снимку вето (E33) слепо к паре ходов, съедающей УГОЛ
      // тела двумя каналами. Репро (Zabbix-корень, ребро f36d0019…, тело {234, 702,
      // 190×100}; маршрут легально обнимал угол: y = дно+12 = DEFAULT_MARGIN,
      // x = ровно правая грань):
      //   сег h: y 814.3→796.3, спан-снимок x∈[424.0, 450.5] — начинался НА грани,
      //           `lo < r.x+r.w−2` → 424 < 422 = false → тела «нет на пробеге»;
      //   сег v: x 424.0→414.5, спан-снимок y∈[814.3, 826.3] — целиком НИЖЕ дна,
      //           `lo < r.y+r.h−2` → 814.3 < 800.3 = false → тела «нет на пробеге».
      // Поодиночке легальны, вместе — врез 8px в тело (нарушение E19, абсолютного).
      // По живому спану второй ход ветируется: к его моменту первый уже поднял общий
      // угол, и клиренс-полоса (E32, NUDGE_CLEAR=8 — заметим, ЖЁСТЧЕ margin роутера
      // не бывает: 8 < 12, у прижатого к углу маршрута запаса нет) честно видна.
      // ЧЕСТНАЯ ОГОВОРКА: остаётся ПОРЯДКОВАЯ зависимость — сегмент, легальный в
      // момент своего хода, может быть удлинён в тело ходом соседа ПОЗЖЕ (каналы
      // идут «h», потом «v»). Полной гарантии это не даёт; страховка «пост-проверка
      // с откатом ребра» осознанно не делалась (план эпика, опция на случай, если
      // класс стрельнет на полигоне или эталонах).
      const liveLo = s.orient === "h" ? Math.min(p.x, q.x) : Math.min(p.y, q.y);
      const liveHi = s.orient === "h" ? Math.max(p.x, q.x) : Math.max(p.y, q.y);
      const hitsClearance = obstacles.some((r) =>
        inClearance(s.orient, newAxis, liveLo, liveHi, r, NUDGE_CLEAR));
      return beforeOk && afterOk && !hitsClearance;
    };

    // Цели канала при зазоре sepGap — VPSC: пины (fixed и «замурованные» с пустым
    // зазором) держат оси весом ∞; конечные стенки коридора — псевдопеременные весом ∞
    // с нулевым зазором к своей группе; соседние группы ≥ sepGap. Невыполнимость
    // (какой-то ∞ съехал с desired при merge-склейке) → null.
    //
    // ПИН-ОСОЗНАННОСТЬ (фикс 2026-08-19, репро «Статус оплаты × Создание отправления»):
    // два дополнения против ЛОЖНОЙ невыполнимости, из-за которой канал бросался целиком.
    // 1) МУЛЬТИ-ПИНОВЫЙ КЛАСТЕР (два+ пина теснее 2·sepGap — например длинный прогон
    //    ребра и его стыковочный стаб в паре пикселей): подвижной группе, чья ось легла
    //    в ПРОЛЁТ кластера, места между пинами нет ПО ПОСТРОЕНИЮ, а жёсткий порядок
    //    VPSC не умеет переставить её через пин — прежняя сортировка (тай-брейк по
    //    подходам) запирала её внутри, и канал бросался целиком. Такая группа
    //    ВЫПРЫГИВАЕТ к ближайшему краю кластера ДО решения; прыжок ограничен
    //    MAX_EVICT·sepGap и коридором группы (философия выталкивания из клиренса).
    //    ОДИНОЧНЫЙ пин не трогаем: там цепочка решает сама и точнее (меньше сдвиг).
    // 2) Сепарация между ДВУМЯ пинами не требуется: двигать нечего, а уравнение только
    //    травит выполнимость всей системы.
    const solveAt = (sepGap: number): number[] | null => {
      const isPin = ordered.map((g) => g.corridor.lo === g.corridor.hi);
      // пин-кластеры: соседние пины ближе 2·sepGap сливаются — между ними не встать
      const pinAxes = ordered.filter((_, j) => isPin[j]).map((g) => g.desired).sort((a, b) => a - b);
      const clusters: Array<{ lo: number; hi: number }> = [];
      for (const ax of pinAxes) {
        const lastC = clusters[clusters.length - 1];
        if (lastC && ax - lastC.hi < 2 * sepGap) lastC.hi = ax;
        else clusters.push({ lo: ax, hi: ax });
      }
      // скорректированные оси подвижных групп: выпрыгивание из пролёта мульти-пиновых
      // кластеров. Прыжок теоретически может привести ось в другой кластер — тогда
      // система честно не решится и канал останется нетронутым (хуже не делаем).
      const adj = ordered.map((g, j) => {
        if (isPin[j]) return g.desired;
        let d = g.desired;
        for (const c of clusters) {
          if (c.hi <= c.lo) continue;                      // одиночный пин — цепочке
          if (d <= c.lo - EPS || d >= c.hi + EPS) continue; // не в пролёте кластера
          const down = c.lo - sepGap;
          const up = c.hi + sepGap;
          const cand = [down, up]
            .filter((v) => v >= g.corridor.lo && v <= g.corridor.hi)
            .filter((v) => Math.abs(v - g.desired) <= MAX_EVICT * sepGap)
            .sort((x, y) => Math.abs(x - d) - Math.abs(y - d) || y - x)[0];
          if (cand !== undefined) d = cand;
        }
        return d;
      });
      // порядок решения — по скорректированным осям (тай-брейки прежние: подходы, ключ)
      const order = ordered.map((_, j) => j).sort((x, y) =>
        (Math.abs(adj[x] - adj[y]) > EPS ? adj[x] - adj[y] : 0) ||
        ordered[x].ref - ordered[y].ref || ordered[x].key.localeCompare(ordered[y].key));
      const desired: number[] = order.map((j) => adj[j]);
      const weights: number[] = order.map((j) => (isPin[j] ? Infinity : 1));
      const cons: SepConstraint[] = [];
      for (let j = 1; j < n; j++) {
        if (weights[j - 1] === Infinity && weights[j] === Infinity) continue; // пин-пара
        cons.push({ left: j - 1, right: j, gap: sepGap });
      }
      order.forEach((gj, j) => {
        const g = ordered[gj];
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
      // назад в индексацию ordered (применение идёт по ней)
      const out = new Array<number>(n);
      order.forEach((gj, j) => { out[gj] = targets[j]; });
      return out;
    };

    // Деградация зазора в тесном коридоре: gap → 12 → 10 → 8 (ниже нельзя — дуги
    // мостиков JUMP_RADIUS=6 соседних плеч сольются совсем). Ни одна ступень не
    // влезла → канал не трогаем: лучше остаточное наложение, чем плечо на грани
    // или в теле узла.
    let targets: number[] | null = null;
    for (const sepGap of [...new Set([gap, ...NUDGE_GAP_LADDER])].filter((v) => v <= gap)) {
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
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- edgeId из сегментов, построенных по work
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
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- work построена из routes, id заведомо есть
  for (const [id, pts] of work) out.set(id, nudged.has(id) ? cleanup(pts) : routes.get(id)!);
  return { routes: out, nudged };
}
