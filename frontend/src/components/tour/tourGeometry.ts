// Геометрия слоя тура: вырезы в затемнении и место карточки рядом с целью. Чистые
// функции в координатах окна (clientX/clientY), под тестами.

export interface Rect { x: number; y: number; w: number; h: number }

/** Вырез: прямоугольник со скруглением или круг (точки-хэндлы связи). quiet — без
 *  пульса даже на шаге с действием: зона броска или то, на что смотреть (холст, рамка,
 *  диаграмма процесса), а не то, что нажимать. */
export interface Hole extends Rect { shape: "rect" | "dot"; quiet?: boolean }

export const HOLE_PAD = 6;
export const DOT_PAD = 4;
/** Зазор между целью и карточкой и отступ карточки от краёв окна. */
export const CARD_GAP = 16;
export const CARD_MARGIN = 16;

export function union(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
}

const overlaps = (a: Rect, b: Rect): boolean => intersect(a, b) !== null;

/** Вырез вокруг цели с полями (как в прототипе: 6px у рамок, 4px у точек). */
export function padHole(r: Rect, shape: Hole["shape"]): Hole {
  if (shape === "dot") {
    // Круг вокруг центра точки: прототип рисует точку 14px с полями 4px.
    const d = Math.max(r.w, r.h, 14) + DOT_PAD * 2;
    return { x: r.x + r.w / 2 - d / 2, y: r.y + r.h / 2 - d / 2, w: d, h: d, shape };
  }
  return { x: r.x - HOLE_PAD, y: r.y - HOLE_PAD, w: r.w + HOLE_PAD * 2, h: r.h + HOLE_PAD * 2, shape };
}

/** Точка внутри выреза (круг — по радиусу). */
export function inHole(h: Hole, px: number, py: number): boolean {
  if (h.shape === "dot") {
    const r = h.w / 2;
    const dx = px - (h.x + r), dy = py - (h.y + r);
    return dx * dx + dy * dy <= r * r;
  }
  return px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h;
}

/**
 * Вырезы для слоя, перехватывающего клики: пересекающиеся сливаются в общий
 * прямоугольник. Правило заливки evenodd иначе закрасило бы пересечение заново
 * (конец стрелки сидит на самой рамке), и именно там клик бы не прошёл.
 */
export function mergeHoles(holes: readonly Hole[]): Hole[] {
  const out: Hole[] = holes.map((h) => ({ ...h }));
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (!overlaps(out[i], out[j])) continue;
        const u = union([out[i], out[j]]);
        if (!u) continue;
        out[i] = { ...u, shape: "rect" };
        out.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }
  return out;
}

/** Контур для SVG-пути: прямоугольник со скруглением r или круг. Обход по часовой. */
export function holePath(h: Hole, radius = 10): string {
  const n = (v: number) => Math.round(v * 10) / 10;
  if (h.shape === "dot") {
    const r = h.w / 2, cx = h.x + r, cy = h.y + r;
    return `M${n(cx - r)} ${n(cy)}A${n(r)} ${n(r)} 0 1 1 ${n(cx + r)} ${n(cy)}A${n(r)} ${n(r)} 0 1 1 ${n(cx - r)} ${n(cy)}Z`;
  }
  const r = Math.min(radius, h.w / 2, h.h / 2);
  const { x, y, w, h: hh } = h;
  return `M${n(x + r)} ${n(y)}H${n(x + w - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)}`
    + `V${n(y + hh - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w - r)} ${n(y + hh)}`
    + `H${n(x + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + hh - r)}`
    + `V${n(y + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)}Z`;
}

/** Путь затемнения с дырами (fill-rule evenodd): всё окно минус вырезы. */
export function shadePath(width: number, height: number, holes: readonly Hole[]): string {
  return `M0 0H${width}V${height}H0Z` + holes.map((h) => holePath(h)).join("");
}

type Side = "right" | "left" | "bottom" | "top";

/**
 * Где поставить карточку: рядом с anchor, целиком в окне и не поверх avoid.
 * Мелкие цели (кнопки шапки) — сначала снизу, крупные — сначала справа, как в
 * прототипе. soft — то, что карточке лучше не закрывать (зона второго выреза): сперва
 * ищем место вне avoid и soft, не нашлось — вне avoid. Ни одна сторона не подошла —
 * правый нижний угол окна.
 */
export function placeCard(
  anchor: Rect,
  avoid: readonly Rect[],
  card: { w: number; h: number },
  view: { w: number; h: number },
  soft: readonly Rect[] = [],
): { x: number; y: number } {
  if (soft.length > 0) {
    const strict = placeBeside(anchor, [...avoid, ...soft], card, view);
    if (strict) return strict;
  }
  const m = CARD_MARGIN;
  return placeBeside(anchor, avoid, card, view)
    ?? { x: Math.max(m, view.w - card.w - m), y: Math.max(m, view.h - card.h - m) };
}

/** Сторона рядом с anchor, где карточка целиком в окне и не поверх avoid (null — нет). */
function placeBeside(
  anchor: Rect,
  avoid: readonly Rect[],
  card: { w: number; h: number },
  view: { w: number; h: number },
): { x: number; y: number } | null {
  const m = CARD_MARGIN, g = CARD_GAP;
  const clampX = (x: number) => Math.max(m, Math.min(x, view.w - card.w - m));
  const clampY = (y: number) => Math.max(m, Math.min(y, view.h - card.h - m));
  const cx = anchor.x + anchor.w / 2, cy = anchor.y + anchor.h / 2;
  const order: Side[] = anchor.h < 60 ? ["bottom", "right", "left", "top"] : ["right", "left", "bottom", "top"];
  for (const side of order) {
    let x: number, y: number;
    if (side === "right") { x = anchor.x + anchor.w + g; y = clampY(cy - card.h / 2); }
    else if (side === "left") { x = anchor.x - g - card.w; y = clampY(cy - card.h / 2); }
    else if (side === "bottom") { x = clampX(cx - card.w / 2); y = anchor.y + anchor.h + g; }
    else { x = clampX(cx - card.w / 2); y = anchor.y - g - card.h; }
    const fits = x >= m && y >= m && x + card.w <= view.w - m && y + card.h <= view.h - m;
    const box = { x, y, w: card.w, h: card.h };
    if (fits && !avoid.some((a) => overlaps(box, a))) return { x, y };
  }
  return null;
}
