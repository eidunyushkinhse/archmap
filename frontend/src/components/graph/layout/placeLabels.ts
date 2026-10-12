// Размещение плашек подписей НА ЛИНИИ без взаимных наложений (эпик стрелок, фаза A6 —
// R2-критичное; Ф3 эпика «стрелки без жёстких хэндлов» — выноски сняты). Чистая функция.
//
// Вход: по каждому ребру маршрут, допустимые arc-интервалы из A5 (где плашку ставить
// МОЖНО — без совпавших плеч R4, зон под узлами R2 и мест, где чужая линия пересекает
// путь, Ф3), запасные интервалы loose (то же без вычета крестов) и габариты плашки.
// Выход: центр плашки — ВСЕГДА точка своей линии (как у Mermaid: место под подпись
// резервирует раскладка — ELK с подписями inline, толщина дорожки в канале E91 — а не
// бегство плашки на поводке). Чистого места нет — плашка садится на наименее плохое
// место линии по ключу E52; выноски-leader и поводки (A7.3/A15) удалены в Ф3.
//
// Алгоритм: жадный best-fit. Для каждой плашки генерим кандидатов — выборку точек по
// чистым интервалам, отсортированную к желаемой позиции (центр самого длинного чистого
// интервала; ручной label_t — если задан); при пустоте — по loose, затем по уникальным
// участкам (весь путь минус слитые плечи), затем — середина пути. Рёбра обрабатываем от
// самых стеснённых (меньше чистых кандидатов) к свободным.
import type { EdgePoint } from "../../../types";
import { axisSegHitsRect, pointAtFraction, type NodeRect, type Segment } from "../edgePath";
import { rectFromCenter, rectsOverlap } from "./arrowMetrics";
import { edgeArcLength, subtractIntervals, type Interval } from "./coincidentLegs";
import { LABEL_END, type Size } from "./labelBox";

const EPS = 0.5;
const LEG_T = 4; // полутолщина плеча стрелки как препятствия (px) — плашка должна явно отойти

export interface LabelInput {
  id: string;
  path: EdgePoint[];
  candidates: Interval[]; // ЧИСТЫЕ arc-интервалы для ПЛАШКИ (labelCandidates / A5 минус кресты
                          // чужих линий, Ф3): без слитых плеч (R4), зон под узлами (R2) и мест,
                          // где чужая линия режет путь
  loose?: Interval[];     // те же интервалы БЕЗ вычета крестов — запас на тесноту
  box: Size;
  preferredT?: number;    // желаемая доля arc-length 0..1 (ручной label_t); по умолч. — центр
                          // самого длинного чистого интервала
  shared?: Interval[];    // слитые с другими рёбрами плечи (R4) — последний запас: уникальные участки
  // РЕЖИМ ПОЧИНКИ (Б3б, E40 v2): прямоугольник ПРЕЖНЕГО места плашки. Если чистого
  // места не нашлось, плашка остаётся там, где была, — и её прежний прямоугольник
  // обязан остаться препятствием для следующих (E53), иначе сосед сядет на неё.
  keepRect?: NodeRect;
}

// Самый длинный интервал набора (ничья — первый); null — набор пуст.
function longest(ivs: ReadonlyArray<Interval>): Interval | null {
  let best: Interval | null = null;
  for (const iv of ivs) if (!best || iv.e - iv.s > best.e - best.s) best = iv;
  return best;
}

// Протяжённость плашки вдоль концевого сегмента пути (первого или последнего): на
// горизонтальном — ширина, на вертикальном — высота.
function endExtent(path: EdgePoint[], box: Size, atStart: boolean): number {
  const a = atStart ? path[0] : path[path.length - 1];
  const b = atStart ? path[1] : path[path.length - 2];
  if (!a || !b) return Math.max(box.w, box.h);
  return Math.abs(b.y - a.y) <= Math.abs(b.x - a.x) ? box.w : box.h;
}

// ОТСТУП ОТ КОНЦОВ СТРЕЛКИ (Ф5, LABEL_END.clear, решение пользователя 2026-10-12): желаемая
// arc-позиция сдвигается от конца пути так, чтобы ближний к узлу край плашки отстоял от
// границы узла на LABEL_END.clear — хвост и наконечник стрелки остаются видны, а не
// прячутся под плашкой. Якорь носителя на стабе (E96) стоит вплотную к узлу — его
// сдвигаем, центр длинного интервала посреди пути — нет. Путь короче двух отступов —
// позиция как есть. Применяется ТОЛЬКО к чистым кандидатам: отступ берётся, когда на
// линии там нет чужих линий; запасные лестницы (loose/unique) идут от исходной позиции.
function endCleared(arc: number, total: number, path: EdgePoint[], box: Size): number {
  const lo = LABEL_END.clear + endExtent(path, box, true) / 2;
  const hi = total - LABEL_END.clear - endExtent(path, box, false) / 2;
  if (lo > hi) return arc;
  return Math.max(lo, Math.min(arc, hi));
}

export interface Placement {
  id: string;
  /** Режим плашки. С Ф3 — всегда "online"; "leader" остался в типе для прежних снимков. */
  mode: "online" | "leader";
  center: EdgePoint; // центр плашки — точка на линии
  anchor: EdgePoint; // точка на линии, к которой плашка относится; с Ф3 совпадает с center
  box: Size;         // габариты плашки
  leaderEnd: EdgePoint; // с Ф3 совпадает с center (поводков нет)
}

interface Cand {
  center: EdgePoint;
}

export interface PlaceOptions {
  // РЕЖИМ ПОЧИНКИ (Б3б эпика «глубокая оптимизация роутера», E40 v2 — «сначала подвинь
  // плашку»): плашка-жертва пробует уступить режущей её стрелке, и ребро перепрокладывают
  // только если уступить не вышло.
  //
  // ПОЧЕМУ НЕ «ЖЁСТКИЙ ЗАПРЕТ ПОЛОСЫ ЧУЖИХ ПЛЕЧ». Компонент ovLegs ключа E52 считает
  // ЧИСЛО чужих плеч в полосе LEG_T вокруг плашки — и проходящих РЯДОМ тоже. Запрет по
  // нему бесполезен по построению: он стоит в лексикографическом ключе вторым, значит
  // гриди прохода 1 УЖЕ выбрал минимум ovLegs; раз плашка всё-таки перерезана, кандидата
  // с ovLegs = 0 в её наборе нет. Полевая проверка (Zabbix-корень, 42 жертвы): 0
  // переездов, T4 не разгрузился ни на ребро. Запас лежит в разнице «рядом» и
  // «насквозь»: кандидат с ДВУМЯ линиями впритык, но ни одной сквозь, ключу прохода 1
  // проигрывает кандидату с ОДНОЙ линией НАСКВОЗЬ, — а T4 нужен ровно второй.
  //
  // ЧТО ДЕЛАЕТ РЕЖИМ: в ключ выбора между жёсткими наложениями и полосой плеч встаёт
  // ЧИСЛО РЕЖУЩИХ СТРЕЛОК (предикат T4 — axisSegHitsRect), а переезд принимается, только
  // если он строго уменьшает это число и не увеличивает жёсткие наложения (E52: залезть
  // под узел ради бегства от линии — хуже, чем остаться). Не принят — плашки нет в
  // результате, прежнее место живо (keepRect) и остаётся препятствием следующим (E53).
  repair?: boolean;
}

// Точки-кандидаты вдоль интервалов: кламп желаемого, середина и концы каждого интервала,
// плюс шаги через step. Дедуп и сортировка по близости к желаемой arc-позиции.
function sampleArcs(intervals: ReadonlyArray<Interval>, preferredArc: number, step: number): number[] {
  const arcs: number[] = [];
  for (const iv of intervals) {
    arcs.push(Math.max(iv.s, Math.min(preferredArc, iv.e)), (iv.s + iv.e) / 2, iv.s, iv.e);
    for (let a = iv.s; a <= iv.e; a += step) arcs.push(a);
  }
  const uniq: number[] = [];
  for (const a of [...arcs].sort((x, y) => x - y)) {
    if (uniq.length === 0 || Math.abs(uniq[uniq.length - 1] - a) > EPS) uniq.push(a);
  }
  return uniq.sort((x, y) => Math.abs(x - preferredArc) - Math.abs(y - preferredArc));
}

// Ключ выбора места (E52) + компонент починки: [жёсткие наложения, РЕЗ НАСКВОЗЬ,
// чужие плечи в полосе, индекс].
type Key = [number, number, number, number];
const KEY_LEN = 4;

// Сколько ЧУЖИХ СТРЕЛОК режет прямоугольник r насквозь — предикатом T4 (axisSegHitsRect,
// edgePath) и с той же гранулярностью, что метрика «сквозь чужие плашки»: пара
// (стрелка, плашка) считается один раз, сколько бы её плеч ни прошло.
function cutCount(r: NodeRect, segsById: ReadonlyMap<string, Segment[]>): number {
  let n = 0;
  for (const [, segs] of segsById) {
    for (const s of segs) {
      if (axisSegHitsRect(s.x1, s.y1, s.x2, s.y2, r)) { n++; break; }
    }
  }
  return n;
}

// Строго ли лучше найденное место прежнего (режим починки): режущих стрелок меньше,
// жёстких наложений не больше.
function improves(
  key: Key, keepRect: NodeRect, placed: NodeRect[], segsById: ReadonlyMap<string, Segment[]>,
): boolean {
  let ovHard = 0;
  for (const o of placed) if (rectsOverlap(keepRect, o)) ovHard++;
  return key[1] < cutCount(keepRect, segsById) && key[0] <= ovHard;
}

// Сколько прямоугольников из others задевает плашка box с центром center.
function overlapCount(center: EdgePoint, box: Size, others: NodeRect[]): number {
  const r = rectFromCenter(center.x, center.y, box.w, box.h);
  let n = 0;
  for (const o of others) if (rectsOverlap(r, o)) n++;
  return n;
}

// Тонкие прямоугольники-препятствия из сегментов ломаной (плечи стрелки). Толщина 2·LEG_T.
function legRects(segs: Segment[]): NodeRect[] {
  return segs.map((s) => {
    const xlo = Math.min(s.x1, s.x2), xhi = Math.max(s.x1, s.x2);
    const ylo = Math.min(s.y1, s.y2), yhi = Math.max(s.y1, s.y2);
    return { x: xlo - LEG_T, y: ylo - LEG_T, w: xhi - xlo + 2 * LEG_T, h: yhi - ylo + 2 * LEG_T };
  });
}

export function placeLabels(
  labels: LabelInput[],
  nodes: NodeRect[] = [],
  edgeSegs: ReadonlyMap<string, Segment[]> = new Map(),
  // Добавочные жёсткие препятствия ТОЛЬКО для наложений плашки (ovHard) — живой драг
  // подкладывает сюда плашки незатронутых рёбер (эмуляция placedRects финального гриди).
  obstacles: NodeRect[] = [],
  opts?: PlaceOptions,
): Placement[] {
  // плечи каждого ребра как препятствия
  const legRectsById = new Map<string, NodeRect[]>();
  for (const [id, segs] of edgeSegs) legRectsById.set(id, legRects(segs));

  // подготовка кандидатов по каждому ребру
  const prepared = labels.map((l) => {
    const total = edgeArcLength(l.path);
    const toPt = (a: number): EdgePoint => pointAtFraction(l.path, total > 0 ? a / total : 0);
    const unique = subtractIntervals({ s: 0, e: total }, l.shared ?? []);
    // ЖЕЛАЕМАЯ ПОЗИЦИЯ: ручной label_t, иначе центр самого длинного чистого интервала —
    // самый заметный личный отрезок без чужих линий; дальше по лестнице запасов
    const clean = l.candidates;
    const loose = l.loose ?? clean;
    const pick = longest(clean) ?? longest(loose) ?? longest(unique);
    const preferredArc = l.preferredT !== undefined
      ? Math.max(0, Math.min(1, l.preferredT)) * total
      : pick ? (pick.s + pick.e) / 2 : total / 2;
    // ЛЕСТНИЦА ЗАПАСОВ: чистые интервалы (желаемое место — с отступом от концов, Ф5) →
    // без вычета крестов → уникальные участки → середина пути. Плашка всегда на линии
    // (Ф3), выноски нет.
    const step = Math.max(l.box.w, 24);
    const clearedArc = endCleared(preferredArc, total, l.path, l.box);
    let arcs = sampleArcs(clean, clearedArc, step);
    if (arcs.length === 0) arcs = sampleArcs(loose, preferredArc, step);
    if (arcs.length === 0) arcs = sampleArcs(unique, preferredArc, step);
    if (arcs.length === 0) arcs = [preferredArc];
    const cands: Cand[] = arcs.map((a) => ({ center: toPt(a) }));
    return { id: l.id, box: l.box, cands, cleanCount: sampleArcs(clean, clearedArc, step).length, keepRect: l.keepRect };
  });

  // самые стеснённые (мало чистых кандидатов) — первыми; тай-брейк по id для детерминизма
  const order = [...prepared].sort(
    (a, b) => a.cleanCount - b.cleanCount || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const placedRects: NodeRect[] = [...nodes, ...obstacles]; // узлы + внешние препятствия + уже размещённые плашки
  const chosen = new Map<string, Placement>();
  for (const L of order) {
    // чужие плечи (все рёбра, кроме своего) — препятствия для ПЛАШКИ; те же плечи ПО
    // ВЛАДЕЛЬЦАМ — режим починки считает режущие СТРЕЛКИ, а не сегменты (пара «стрелка ×
    // плашка» = единица метрики «сквозь чужие плашки»)
    const otherLegRects: NodeRect[] = [];
    const otherSegsById = new Map<string, Segment[]>();
    for (const [id, segs] of edgeSegs) {
      if (id === L.id) continue;
      otherSegsById.set(id, segs);
      const rs = legRectsById.get(id);
      if (rs) otherLegRects.push(...rs);
    }
    // ключ выбора: [жёсткие наложения (узлы+плашки), рез насквозь (только починка), мягкие
    // (чужие плечи в полосе), индекс-предпочтение]. Чужие плечи — МЯГКИЙ конфликт: плашка
    // сначала ищет чистое место вдоль СВОЕЙ линии и лишь при полном отсутствии мест
    // мирится с чужим плечом.
    let best = -1;
    let bestKey: Key = [Infinity, Infinity, Infinity, Infinity];
    for (let k = 0; k < L.cands.length; k++) {
      const c = L.cands[k];
      const ovHard = overlapCount(c.center, L.box, placedRects);
      const ovLegs = overlapCount(c.center, L.box, otherLegRects);
      // ПОЧИНКА (Б3б): число ЧУЖИХ СТРЕЛОК, режущих плашку насквозь — то самое, что
      // считает T4 (и метрика «сквозь чужие плашки»). В обычном режиме не считается.
      const cutN = opts?.repair ? cutCount(rectFromCenter(c.center.x, c.center.y, L.box.w, L.box.h), otherSegsById) : 0;
      const key: Key = [ovHard, cutN, ovLegs, k];
      for (let d = 0; d < KEY_LEN; d++) {
        if (key[d] < bestKey[d]) { bestKey = key; best = k; break; }
        if (key[d] > bestKey[d]) break;
      }
    }
    // ПОЧИНКА (Б3б): переезд принимается, только если он ДЕЙСТВИТЕЛЬНО УСТУПАЕТ линии —
    // режущих стрелок стало строго меньше, а жёстких наложений не прибавилось (иначе
    // плашка сбегала бы из-под стрелки под узел, а это по E52 хуже). Не принят — плашка
    // остаётся на прежнем месте, и её прямоугольник обязан отталкивать следующих (E53).
    if (best < 0 || (L.keepRect && !improves(bestKey, L.keepRect, placedRects, otherSegsById))) {
      if (L.keepRect) placedRects.push(L.keepRect);
      continue;
    }
    const c = L.cands[best];
    placedRects.push(rectFromCenter(c.center.x, c.center.y, L.box.w, L.box.h));
    chosen.set(L.id, { id: L.id, mode: "online", center: c.center, anchor: c.center, box: L.box, leaderEnd: c.center });
  }

  // chosen заполнен для каждой плашки в цикле выше (в режиме починки — только для тех,
  // кому нашлось безупречное место); flatMap отсеивает отказы и гарантирует тип
  return labels.flatMap((l) => {
    const c = chosen.get(l.id);
    return c ? [c] : [];
  });
}
