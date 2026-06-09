// Геометрия кастомного пути стрелки (ручные «обходы» узлов на основной схеме).
// Чистые функции без React — под юнит-тесты. Путь — ортогональная ломаная
// [S, ...waypoints, T]: концы (S/T) берутся из хэндлов при рендере, waypoints —
// абсолютные точки-сгибы в координатах графа уровня (хранятся в БД).
import type { EdgePoint } from "../../types";

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
const isHoriz = (s: EdgeSide): boolean => s === "left" || s === "right";

// Канонический ортогональный маршрут [S, ...сгибы, T], УЧИТЫВАЮЩИЙ стороны хэндлов
// (в отличие от orthogonalPoints, что выбирает ось по доминанте dx/dy). Нужен для
// грипов изломов: видимая линия рисуется getSmoothStepPath, который идёт от СТОРОН
// хэндлов. У стрелки с сохранённым хэндлом (его не пересчитывает autoHandles) после
// сдвига узла dx/dy-маршрут расходился с линией → грипы «слетали». Для выровненных
// (противоположных по оси) сторон даёт тот же серединный Z, что и smoothstep, поэтому
// у здоровых стрелок ничего не меняется; чинятся лишь смешанные/развёрнутые случаи.
export function orthogonalPointsForHandles(
  sx: number, sy: number, sSide: EdgeSide,
  tx: number, ty: number, tSide: EdgeSide,
): EdgePoint[] {
  const s: EdgePoint = { x: sx, y: sy }, t: EdgePoint = { x: tx, y: ty };
  const sh = isHoriz(sSide), th = isHoriz(tSide);
  if (sh && th) {
    // оба конца горизонтальны → Z через вертикальный сгиб на середине X
    const mx = (sx + tx) / 2;
    return [s, { x: mx, y: sy }, { x: mx, y: ty }, t];
  }
  if (!sh && !th) {
    // оба вертикальны → Z через горизонтальный сгиб на середине Y
    const my = (sy + ty) / 2;
    return [s, { x: sx, y: my }, { x: tx, y: my }, t];
  }
  // смешанный (один горизонтален, другой вертикален) → один сгиб (L): источник
  // выходит вдоль своей оси, цель входит вдоль своей.
  return sh
    ? [s, { x: tx, y: sy }, t]  // S выходит горизонтально, T входит вертикально
    : [s, { x: sx, y: ty }, t]; // S выходит вертикально, T входит горизонтально
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
