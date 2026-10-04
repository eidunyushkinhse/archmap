// Поиск цели шага в DOM: атрибуты data-tour на элементах продукта и [data-id] узлов
// React Flow. Возвращает вырезы, якорь для карточки и то, что карточка не должна
// закрывать. Прямоугольники — видимые части элементов (с учётом прокрутки и
// обрезки холстом), в координатах окна.
import { padHole, union, type Hole, type Rect } from "./tourGeometry";
import type { TourVars } from "./tourMachine";
import type { Target } from "./tourSteps";

export interface TargetCtx {
  yarProjectId: string | null | undefined;
  yarObjects: ReadonlyMap<string, string> | undefined;
  vars: TourVars;
}

export interface Resolved {
  /** найденные элементы: по ним решается, лежит ли цель внутри открытого окна */
  elements: Element[];
  holes: Hole[];
  /** рядом с чем ставить карточку */
  anchor: Rect;
  /** что карточка не закрывает */
  avoid: Rect[];
}

// Предки, обрезающие содержимое (overflow не visible): у элемента они не меняются,
// поэтому ищутся один раз — кадр за кадром getComputedStyle по всей цепочке не гоняем.
const clipCache = new WeakMap<Element, Element[]>();

function clippers(el: Element): Element[] {
  const cached = clipCache.get(el);
  if (cached) return cached;
  const out: Element[] = [];
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const st = getComputedStyle(p);
    if (st.overflowX !== "visible" || st.overflowY !== "visible") out.push(p);
  }
  clipCache.set(el, out);
  return out;
}

const toRect = (r: DOMRect): Rect => ({ x: r.left, y: r.top, w: r.width, h: r.height });

function clip(a: Rect, b: Rect): Rect | null {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
}

/** Видимая часть элемента: пересечение с окном и с обрезающими предками. */
export function visibleRect(el: Element): Rect | null {
  let r: Rect | null = toRect(el.getBoundingClientRect());
  if (r.w <= 0 && r.h <= 0) return null;
  r = clip(r, { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight });
  for (const c of clippers(el)) {
    if (!r) return null;
    r = clip(r, toRect(c.getBoundingClientRect()));
  }
  return r;
}

/** Первый видимый элемент по селектору (одинаковые бывают и в скрытых местах). */
function firstVisible(selector: string, root: ParentNode = document): { el: Element; rect: Rect } | null {
  for (const el of Array.from(root.querySelectorAll(selector))) {
    const rect = visibleRect(el);
    if (rect) return { el, rect };
  }
  return null;
}

const byTour = (key: string) => `[data-tour="${key}"]`;
const rfNode = (id: string) => `.react-flow__node[data-id="${id}"]`;

function single(el: Element, rect: Rect, avoid: Rect[] = []): Resolved {
  const hole = padHole(rect, "rect");
  return { elements: [el], holes: [hole], anchor: hole, avoid: [hole, ...avoid] };
}

/** Рамка системы и конец стрелки на ней: из ручек перепривязки React Flow берётся
 *  та, что сидит на границе рамки (тянуть можно только конец, упёршийся в рамку). */
function resolveFrameEnd(systemId: string): Resolved | null {
  const frame = firstVisible(rfNode(systemId));
  if (!frame) return null;
  const f = frame.rect;
  const near = (x: number, y: number) => {
    const inside = x >= f.x - 14 && x <= f.x + f.w + 14 && y >= f.y - 14 && y <= f.y + f.h + 14;
    const edge = Math.min(Math.abs(x - f.x), Math.abs(x - f.x - f.w), Math.abs(y - f.y), Math.abs(y - f.y - f.h));
    return inside && edge <= 14;
  };
  for (const anchor of Array.from(document.querySelectorAll(".react-flow__edgeupdater"))) {
    const r = anchor.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (r.width === 0 || !near(cx, cy)) continue;
    const frameHole = padHole(f, "rect");
    const endHole = padHole({ x: cx - 10, y: cy - 10, w: 20, h: 20 }, "rect");
    const u = union([frameHole, endHole]) ?? frameHole;
    return { elements: [frame.el, anchor], holes: [frameHole, endHole], anchor: u, avoid: [u] };
  }
  return null;
}

/** Связь между двумя объектами на холсте: React Flow подписывает ребро концами
 *  («Edge from A to B»), плашка подписи несёт data-lg-edge с id ребра. */
function resolveEdge(a: string, b: string): Resolved | null {
  for (const el of Array.from(document.querySelectorAll(".react-flow__edge"))) {
    const label = el.getAttribute("aria-label") ?? "";
    if (!label.includes(a) || !label.includes(b)) continue;
    const path = visibleRect(el);
    if (!path) continue;
    const id = el.getAttribute("data-id");
    const plaque = id ? firstVisible(`[data-lg-edge="${id}"]`) : null;
    const rect = union([path, ...(plaque ? [plaque.rect] : [])]) ?? path;
    const hole = padHole(rect, "rect");
    const ends = [a, b].map((n) => firstVisible(rfNode(n))?.rect).filter((r): r is Rect => !!r);
    return { elements: [el], holes: [hole], anchor: hole, avoid: [hole, ...ends] };
  }
  return null;
}

/** Окно «Новый проект»: левая колонка и кнопка «Создать проект» — без неё действие
 *  шага не выполнить, поэтому у неё свой вырез. */
function resolveCreateProject(): Resolved | null {
  const col = firstVisible(byTour("create-project"));
  if (!col) return null;
  const submit = firstVisible(byTour("create-project-submit"));
  const colHole = padHole(col.rect, "rect");
  const holes = [colHole, ...(submit ? [padHole(submit.rect, "rect")] : [])];
  return { elements: [col.el, ...(submit ? [submit.el] : [])], holes, anchor: colHole, avoid: holes };
}

export function resolveTarget(target: Target, ctx: TargetCtx): Resolved | null {
  const { vars } = ctx;
  switch (target.kind) {
    case "tour": {
      const hit = firstVisible(byTour(target.key));
      return hit ? single(hit.el, hit.rect) : null;
    }
    case "yar-card": {
      if (!ctx.yarProjectId) return null;
      const hit = firstVisible(byTour(`project:${ctx.yarProjectId}`));
      return hit ? single(hit.el, hit.rect) : null;
    }
    case "yar-node": {
      const id = ctx.yarObjects?.get(target.name);
      const hit = id ? firstVisible(rfNode(id)) : null;
      return hit ? single(hit.el, hit.rect) : null;
    }
    case "system-part": {
      if (!vars.systemId) return null;
      const node = firstVisible(rfNode(vars.systemId));
      const part = node ? firstVisible(byTour(target.part), node.el) : null;
      return node && part ? single(part.el, part.rect, [padHole(node.rect, "rect")]) : null;
    }
    case "handles":
      // Пару хэндлов считает роутер стрелок — подключается вместе с привязкой к холсту.
      return null;
    case "frame-end":
      return vars.systemId ? resolveFrameEnd(vars.systemId) : null;
    case "context-edge":
      return vars.peerId && vars.systemId ? resolveEdge(vars.peerId, vars.systemId) : null;
    case "create-project":
      return resolveCreateProject();
  }
}

/** Самый верхний открытый модальный <dialog>: остальной документ под ним инертен. */
export function topDialog(): HTMLElement | null {
  const open = Array.from(document.getElementsByTagName("dialog")).filter((d) => d.open);
  return open.length > 0 ? open[open.length - 1] : null;
}

