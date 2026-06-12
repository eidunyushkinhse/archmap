// Геометрия кастомного пути стрелки (ручные «обходы» узлов на основной схеме).
// Чистые функции без React — под юнит-тесты. Путь — ортогональная ломаная
// [S, ...waypoints, T]: концы (S/T) берутся из хэндлов при рендере, waypoints —
// абсолютные точки-сгибы в координатах графа уровня (хранятся в БД).
import type { EdgePoint } from "../../types";
import { EDGE_STUB } from "./constants";

export type SegOrient = "h" | "v";

export interface Segment {
  index: number;          // индекс сегмента = индекс его первой точки в массиве points
  x1: number; y1: number; // начало
  x2: number; y2: number; // конец
  orient: SegOrient;      // ориентация (горизонталь / вертикаль)
}

const eq = (a: number, b: number): boolean => Math.abs(a - b) < 0.001;

// Дубликаты подряд → одна точка; коллинеарные тройки → средняя выбрасывается.
// Возвращает полный список точек [S, ..., T] без вырожденных сегментов.
export function cleanup(pts: EdgePoint[]): EdgePoint[] {
  const dedup: EdgePoint[] = [];
  for (const p of pts) {
    const last = dedup[dedup.length - 1];
    if (!last || !eq(last.x, p.x) || !eq(last.y, p.y)) dedup.push({ x: p.x, y: p.y });
  }
  if (dedup.length <= 2) return dedup;
  const out: EdgePoint[] = [dedup[0]];
  for (let k = 1; k < dedup.length - 1; k++) {
    const a = out[out.length - 1], b = dedup[k], c = dedup[k + 1];
    const colinear = (eq(a.x, b.x) && eq(b.x, c.x)) || (eq(a.y, b.y) && eq(b.y, c.y));
    if (!colinear) out.push(b);
  }
  out.push(dedup[dedup.length - 1]);
  return out;
}

// Канонический ортогональный маршрут [S, A, B, T] (Z-кроссовер) по доминирующей оси —
// та же логика выбора стороны, что у autoHandles. Сидинг при первом перетаскивании
// стрелки без сохранённых waypoints. Для соосных узлов вырождается в прямую (cleanup).
export function orthogonalPoints(sx: number, sy: number, tx: number, ty: number): EdgePoint[] {
  const dx = tx - sx, dy = ty - sy;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const mx = (sx + tx) / 2;
    return [{ x: sx, y: sy }, { x: mx, y: sy }, { x: mx, y: ty }, { x: tx, y: ty }];
  }
  const my = (sy + ty) / 2;
  return [{ x: sx, y: sy }, { x: sx, y: my }, { x: tx, y: my }, { x: tx, y: ty }];
}

export type EdgeSide = "left" | "right" | "top" | "bottom";

// Внешняя нормаль стороны: направление, в котором стрелка ВЫХОДИТ из этого хэндла
// (а в цель — ВХОДИТ против неё). Нужна, чтобы гарантировать стаб наружу.
const OUT: Record<EdgeSide, { ox: number; oy: number }> = {
  left: { ox: -1, oy: 0 }, right: { ox: 1, oy: 0 },
  top: { ox: 0, oy: -1 }, bottom: { ox: 0, oy: 1 },
};
// Знак с допуском: ±1 или 0 (координаты совпали). 0 ≠ ±1 → «не с той стороны».
const sgn = (v: number): number => (v > 1e-9 ? 1 : v < -1e-9 ? -1 : 0);

// Канонический ортогональный маршрут [S, ...сгибы, T], УЧИТЫВАЮЩИЙ стороны хэндлов
// (в отличие от orthogonalPoints, что выбирает ось по доминанте dx/dy). Нужен для
// грипов изломов: видимая линия идёт от СТОРОН хэндлов, и грипы должны лежать на ней.
//
// Чистый Z/L строится, когда сгиб-перемычку можно поставить «снаружи» обоих хэндлов
// (стороны смотрят в маршрут) — тогда здоровые стрелки выглядят как серединный
// smoothstep, ничего не меняется. Если же хэндл смотрит ПРОТИВ цели, прямой маршрут
// сразу ломался назад и прятался за телом узла. Поэтому такому концу даём обязательный
// стаб stub: стрелка выходит вдоль нормали стороны на stub, и лишь затем изламывается
// и идёт обратно (поведение совпадает с offset у getSmoothStepPath в превью/viewer).
export function orthogonalPointsForHandles(
  sx: number, sy: number, sSide: EdgeSide,
  tx: number, ty: number, tSide: EdgeSide,
  stub: number = EDGE_STUB,
): EdgePoint[] {
  const s: EdgePoint = { x: sx, y: sy }, t: EdgePoint = { x: tx, y: ty };
  const { ox: sox, oy: soy } = OUT[sSide];
  const { ox: tox, oy: toy } = OUT[tSide];
  const S = stub;
  const sh = soy === 0; // источник выходит горизонтально
  const th = toy === 0; // цель входит горизонтально

  if (sh && th) {
    // Оба конца горизонтальны: вертикальная перемычка на X=cx. Чистый Z возможен,
    // если cx ставится снаружи обоих хэндлов по их сторонам; иначе хэндлы смотрят друг
    // от друга — выводим оба стаба и перемычку на середине Y (стабы защищены изломом).
    let cx: number | null = null;
    if (sox === tox) {
      cx = sox > 0 ? Math.max(sx, tx) + S : Math.min(sx, tx) - S;
    } else {
      const mid = (sx + tx) / 2;
      if (sgn(mid - sx) === sox && sgn(mid - tx) === tox) cx = mid;
    }
    if (cx !== null) return [s, { x: cx, y: sy }, { x: cx, y: ty }, t];
    const my = (sy + ty) / 2;
    return [s,
      { x: sx + sox * S, y: sy }, { x: sx + sox * S, y: my },
      { x: tx + tox * S, y: my }, { x: tx + tox * S, y: ty }, t];
  }

  if (!sh && !th) {
    // Оба вертикальны: горизонтальная перемычка на Y=cy (симметрично HH).
    let cy: number | null = null;
    if (soy === toy) {
      cy = soy > 0 ? Math.max(sy, ty) + S : Math.min(sy, ty) - S;
    } else {
      const mid = (sy + ty) / 2;
      if (sgn(mid - sy) === soy && sgn(mid - ty) === toy) cy = mid;
    }
    if (cy !== null) return [s, { x: sx, y: cy }, { x: tx, y: cy }, t];
    const mx = (sx + tx) / 2;
    return [s,
      { x: sx, y: sy + soy * S }, { x: mx, y: sy + soy * S },
      { x: mx, y: ty + toy * S }, { x: tx, y: ty + toy * S }, t];
  }

  // Смешанный (один горизонтален, другой вертикален) → угол-L, если стороны «смотрят»
  // в угол; иначе протектед-джог со стабами по обеим осям (углы L2 защищают стабы).
  if (sh) {
    // источник горизонтален, цель вертикальна; чистый угол (tx, sy)
    if (sgn(tx - sx) === sox && sgn(ty - sy) === -toy) return [s, { x: tx, y: sy }, t];
    return [s,
      { x: sx + sox * S, y: sy }, { x: sx + sox * S, y: ty + toy * S },
      { x: tx, y: ty + toy * S }, t];
  }
  // источник вертикален, цель горизонтальна; чистый угол (sx, ty)
  if (sgn(ty - sy) === soy && sgn(tx - sx) === -tox) return [s, { x: sx, y: ty }, t];
  return [s,
    { x: sx, y: sy + soy * S }, { x: tx + tox * S, y: sy + soy * S },
    { x: tx + tox * S, y: ty }, t];
}

// Диагональную пару (обе координаты разошлись — обычно концевой сегмент после сдвига
// узла) разбиваем коленом, чтобы путь остался строго ортогональным. Колено
// детерминированное: сперва горизонталь, затем вертикаль (E = (b.x, a.y)).
function normalize(raw: EdgePoint[]): EdgePoint[] {
  const out: EdgePoint[] = [{ x: raw[0].x, y: raw[0].y }];
  for (let k = 1; k < raw.length; k++) {
    const a = out[out.length - 1], b = raw[k];
    if (!eq(a.x, b.x) && !eq(a.y, b.y)) out.push({ x: b.x, y: a.y }); // колено
    out.push({ x: b.x, y: b.y });
  }
  return out;
}

// Полный список точек для рендера: [S, ...waypoints, T] с нормализацией
// ортогональности (сдвиг узла-конца не ломает путь — концевой сегмент дотягивается
// коленом). cleanup убирает вырожденные/коллинеарные звенья.
export function buildRenderPoints(
  s: EdgePoint, t: EdgePoint, waypoints?: EdgePoint[] | null,
): EdgePoint[] {
  const raw = [s, ...(waypoints ?? []), t];
  return cleanup(normalize(raw));
}

// Сегменты ломаной с ориентацией (для размещения грипов перетаскивания).
export function segments(pts: EdgePoint[]): Segment[] {
  const segs: Segment[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (eq(a.x, b.x) && eq(a.y, b.y)) continue; // вырожденный — пропускаем
    const orient: SegOrient = Math.abs(a.y - b.y) <= Math.abs(a.x - b.x) ? "h" : "v";
    segs.push({ index: i, x1: a.x, y1: a.y, x2: b.x, y2: b.y, orient });
  }
  return segs;
}

// Сдвиг сегмента index перпендикулярно к курсору. Горизонтальный сегмент тянется по Y,
// вертикальный — по X. Внутренний конец сегмента двигаем напрямую; пиннутый конец (S/T,
// привязан к хэндлу) не двигаем, а вставляем у него ортогональный «стаб»-колено, сохраняя
// стык с узлом прямым. Возвращает полный очищенный путь [S, ..., T]. Каждый кадр драга
// зовётся от ИСХОДНОГО pts (не накапливая) — иначе индексы/стабы дрейфуют.
export function dragSegment(pts: EdgePoint[], index: number, cursor: EdgePoint): EdgePoint[] {
  const last = pts.length - 1;
  if (index < 0 || index >= last) return pts;
  const a = pts[index], b = pts[index + 1];
  const isH = Math.abs(a.y - b.y) <= Math.abs(a.x - b.x);

  const out: EdgePoint[] = [];
  for (let k = 0; k < index; k++) out.push({ x: pts[k].x, y: pts[k].y });

  // конец A (index)
  if (index === 0) {
    out.push({ x: pts[0].x, y: pts[0].y }); // пиннутый S остаётся
    out.push(isH ? { x: pts[0].x, y: cursor.y } : { x: cursor.x, y: pts[0].y }); // стаб
  } else {
    out.push(isH ? { x: a.x, y: cursor.y } : { x: cursor.x, y: a.y });
  }

  // конец B (index+1)
  if (index + 1 === last) {
    out.push(isH ? { x: pts[last].x, y: cursor.y } : { x: cursor.x, y: pts[last].y }); // стаб
    out.push({ x: pts[last].x, y: pts[last].y }); // пиннутый T остаётся
  } else {
    out.push(isH ? { x: b.x, y: cursor.y } : { x: cursor.x, y: b.y });
  }

  for (let k = index + 2; k <= last; k++) out.push({ x: pts[k].x, y: pts[k].y });
  return cleanup(out);
}

// Примагничивание тянущегося сегмента к «ровному» положению относительно хэндлов:
// перпендикулярную координату курсора притягиваем к одноимённой координате конца S или T,
// если она ближе threshold. Тогда у соответствующего плеча концевой стаб схлопывается
// (cleanup убирает коллинеарное звено) и сегмент становится прямым продолжением хэндла —
// стрелку легко выровнять. Снапятся независимые оси по ориентации сегмента: горизонтальный
// (тянем по Y) → к y хэндлов; вертикальный (по X) → к x хэндлов. threshold — в координатах
// графа (вызывающий делит экранный порог на зум, чтобы липкость не зависела от масштаба).
export function snapDragCursor(
  pts: EdgePoint[], index: number, cursor: EdgePoint, threshold: number,
): EdgePoint {
  const last = pts.length - 1;
  if (index < 0 || index >= last) return cursor;
  const a = pts[index], b = pts[index + 1];
  const isH = Math.abs(a.y - b.y) <= Math.abs(a.x - b.x);
  const s = pts[0], t = pts[last];
  const snap = (v: number, cands: number[]): number => {
    let best = v, bestD = threshold;
    for (const c of cands) {
      const d = Math.abs(c - v);
      if (d <= bestD) { bestD = d; best = c; }
    }
    return best;
  };
  return isH
    ? { x: cursor.x, y: snap(cursor.y, [s.y, t.y]) }
    : { x: snap(cursor.x, [s.x, t.x]), y: cursor.y };
}

// Внутренние точки (waypoints) из полного пути [S, ..., T].
export function interior(pts: EdgePoint[]): EdgePoint[] {
  return pts.length <= 2 ? [] : pts.slice(1, -1);
}

// Длины звеньев ломаной и их сумма (общая arc-length). Пустой путь → нули.
function arcLengths(pts: EdgePoint[]): { seg: number[]; total: number } {
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    seg.push(l);
    total += l;
  }
  return { seg, total };
}

// Точка на ломаной по доле arc-length t∈[0,1] (0 — у первой точки, 1 — у последней).
// Для плашки подписи: t — её позиция вдоль стрелки. Вырожденный путь → первая точка.
export function pointAtFraction(pts: EdgePoint[], t: number): EdgePoint {
  if (pts.length === 0) return { x: 0, y: 0 };
  if (pts.length === 1) return { x: pts[0].x, y: pts[0].y };
  const { seg, total } = arcLengths(pts);
  if (total === 0) return { x: pts[0].x, y: pts[0].y };
  let remain = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i < seg.length; i++) {
    if (remain <= seg[i] || i === seg.length - 1) {
      const r = seg[i] === 0 ? 0 : remain / seg[i];
      return {
        x: pts[i].x + (pts[i + 1].x - pts[i].x) * r,
        y: pts[i].y + (pts[i + 1].y - pts[i].y) * r,
      };
    }
    remain -= seg[i];
  }
  return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
}

// Доля arc-length t∈[0,1] ближайшей к cursor точки ломаной (проекция курсора на путь).
// Для драга плашки: курсор → позиция вдоль стрелки. Вырожденный путь → 0.
export function nearestFraction(pts: EdgePoint[], cursor: EdgePoint): number {
  if (pts.length < 2) return 0;
  const { seg, total } = arcLengths(pts);
  if (total === 0) return 0;
  let bestDist = Infinity;
  let bestLen = 0;
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].x, ay = pts[i].y;
    const dx = pts[i + 1].x - ax, dy = pts[i + 1].y - ay;
    const len2 = dx * dx + dy * dy;
    const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((cursor.x - ax) * dx + (cursor.y - ay) * dy) / len2));
    const px = ax + dx * u, py = ay + dy * u;
    const dist = Math.hypot(cursor.x - px, cursor.y - py);
    if (dist < bestDist) {
      bestDist = dist;
      bestLen = acc + seg[i] * u;
    }
    acc += seg[i];
  }
  return bestLen / total;
}

// Прямоугольник узла (для проверки, пересекает ли маршрут стрелки чужие узлы).
export interface NodeRect { x: number; y: number; w: number; h: number; }

// Пересекает ли ОСЕВОЙ (гориз/верт) сегмент внутренность прямоугольника. eps сжимает
// прямоугольник, чтобы касание ровно по границе (напр. линия идёт вдоль края соседа или
// конец у его хэндла) не считалось пересечением — ловим только реальный проход насквозь.
function axisSegmentHitsRect(
  x1: number, y1: number, x2: number, y2: number, r: NodeRect, eps: number,
): boolean {
  const left = r.x + eps, right = r.x + r.w - eps;
  const top = r.y + eps, bottom = r.y + r.h - eps;
  if (left >= right || top >= bottom) return false; // прямоугольник схлопнулся под eps
  if (eq(y1, y2)) {
    // горизонтальный сегмент на высоте y1
    if (y1 <= top || y1 >= bottom) return false;
    return Math.min(x1, x2) < right && Math.max(x1, x2) > left;
  }
  if (eq(x1, x2)) {
    // вертикальный сегмент на абсциссе x1
    if (x1 <= left || x1 >= right) return false;
    return Math.min(y1, y2) < bottom && Math.max(y1, y2) > top;
  }
  return false; // диагональ — в наших ортогональных маршрутах не встречается
}

// Проходит ли ортогональная ломаная сквозь хотя бы один из прямоугольников (узлов).
// Используется для дефолтного «обвода»: если прямой маршрут гостевой стрелки пересекает
// чужие узлы, ей строится путь в обход рамки.
export function pathCrossesRects(pts: EdgePoint[], rects: NodeRect[]): boolean {
  for (const s of segments(pts)) {
    for (const r of rects) {
      if (axisSegmentHitsRect(s.x1, s.y1, s.x2, s.y2, r, 1)) return true;
    }
  }
  return false;
}
