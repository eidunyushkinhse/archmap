// Поиск цели шага в DOM: атрибуты data-tour на элементах продукта и [data-id] узлов
// React Flow. Возвращает вырезы, якорь для карточки и то, что карточка не должна
// закрывать. Прямоугольники — видимые части элементов (с учётом прокрутки и
// обрезки холстом), в координатах окна.
import { padHole, union, type Hole, type Rect } from "./tourGeometry";
import type { TourVars } from "./tourMachine";
import type { RehangDemo } from "./tourDemo";
import { resolveHandlePair, resolveRehang } from "./tourHandles";
import type { Target, TargetPart } from "./tourSteps";

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
  /** что карточке лучше не закрывать (зона второго выреза) */
  soft?: Rect[];
  /** шаг «Перевесьте связь»: ладонь показывает перевес конца стрелки (tourDemo.ts) */
  demo?: RehangDemo;
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

/** Видимая связь между двумя объектами на холсте: React Flow подписывает ребро
 *  концами («Edge from A to B»), плашка подписи несёт data-lg-edge с id ребра.
 *  Прямоугольник — линия вместе с плашкой. */
function edgeBox(a: string, b: string): { el: Element; rect: Rect } | null {
  for (const el of Array.from(document.querySelectorAll(".react-flow__edge"))) {
    const label = el.getAttribute("aria-label") ?? "";
    if (!label.includes(a) || !label.includes(b)) continue;
    const path = visibleRect(el);
    if (!path) continue;
    const id = el.getAttribute("data-id");
    const plaque = id ? firstVisible(`[data-lg-edge="${id}"]`) : null;
    return { el, rect: union([path, ...(plaque ? [plaque.rect] : [])]) ?? path };
  }
  return null;
}

/** Связь между двумя объектами: вырез по ней, карточка не закрывает и концы. */
function resolveEdge(a: string, b: string): Resolved | null {
  const edge = edgeBox(a, b);
  if (!edge) return null;
  const hole = padHole(edge.rect, "rect");
  const ends = [a, b].map((n) => firstVisible(rfNode(n))?.rect).filter((r): r is Rect => !!r);
  return { elements: [edge.el], holes: [hole], anchor: hole, avoid: [hole, ...ends] };
}

/** Один вырез вокруг связи и объектов на её концах (если они на экране): вся
 *  диаграмма контекста или «связь и сервис внутри раскрытой системы». */
function resolveEdgeWith(a: string, b: string, ids: readonly string[]): Resolved | null {
  const edge = edgeBox(a, b);
  if (!edge) return null;
  const parts = ids.map((id) => firstVisible(rfNode(id))).filter((p): p is { el: Element; rect: Rect } => !!p);
  if (parts.length < ids.length) return null;
  const hole = padHole(union([edge.rect, ...parts.map((p) => p.rect)]) ?? edge.rect, "rect");
  return { elements: [edge.el, ...parts.map((p) => p.el)], holes: [hole], anchor: hole, avoid: [hole] };
}

/** Часть составной цели в DOM: элемент data-tour, холст редактора, узел «система». */
function findPart(part: TargetPart, systemId: string | undefined): { el: Element; rect: Rect } | null {
  switch (part.kind) {
    case "tour":
      return firstVisible(byTour(part.key));
    case "canvas":
      return firstVisible(".react-flow");
    case "system":
      return systemId ? firstVisible(rfNode(systemId)) : null;
  }
}

/** Два выреза: main (с ним работать — к нему карточка, на шаге с действием пульс) и
 *  zone (куда бросать или на что смотреть — без пульса, карточка по возможности не на
 *  ней). Без main цели нет; зону, которой ещё нет (холст грузится), просто не рисуем. */
function resolvePair(main: TargetPart, zone: TargetPart, systemId: string | undefined): Resolved | null {
  const m = findPart(main, systemId);
  if (!m) return null;
  const mainHole = padHole(m.rect, "rect");
  const z = findPart(zone, systemId);
  if (!z) return { elements: [m.el], holes: [mainHole], anchor: mainHole, avoid: [mainHole] };
  const zoneHole: Hole = { ...padHole(z.rect, "rect"), quiet: true };
  return {
    elements: [m.el, z.el], holes: [mainHole, zoneHole], anchor: mainHole, avoid: [mainHole], soft: [zoneHole],
  };
}

const treeKey = (part: "chevron" | "row", id: string) => `${part === "chevron" ? "tree-chev" : "tree-row"}:${id}`;

/** Строка дерева: вырез по шеврону или строке, карточка — к строке целиком и по
 *  возможности мимо дерева (оно на шаге и есть то, на что смотрят: раскрытая ветка
 *  показывает детей прямо под строкой). */
function resolveTreeRow(hit: { el: Element; rect: Rect }, id: string): Resolved {
  const hole = padHole(hit.rect, "rect");
  const row = firstVisible(byTour(treeKey("row", id)));
  const tree = firstVisible(byTour("tree"));
  return {
    elements: [hit.el], holes: [hole], anchor: row ? padHole(row.rect, "rect") : hole, avoid: [hole],
    soft: tree ? [tree.rect] : [],
  };
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
    case "yar-tree": {
      const id = ctx.yarObjects?.get(target.name);
      const hit = id ? firstVisible(byTour(treeKey(target.part, id))) : null;
      return hit && id ? resolveTreeRow(hit, id) : null;
    }
    case "pair":
      return resolvePair(target.main, target.zone, vars.systemId);
    case "system-part": {
      if (!vars.systemId) return null;
      const node = firstVisible(rfNode(vars.systemId));
      const part = node ? firstVisible(byTour(target.part), node.el) : null;
      return node && part ? single(part.el, part.rect, [padHole(node.rect, "rect")]) : null;
    }
    case "handles":
      return vars.peerId && vars.systemId ? resolveHandlePair(vars.peerId, vars.systemId) : null;
    case "frame-end":
      return vars.systemId && vars.childId ? resolveRehang(vars.systemId, vars.childId) : null;
    case "context-edge":
      return vars.peerId && vars.systemId ? resolveEdge(vars.peerId, vars.systemId) : null;
    case "context-diagram":
      return vars.peerId && vars.systemId
        ? resolveEdgeWith(vars.peerId, vars.systemId, [vars.peerId, vars.systemId])
        : null;
    case "inside":
      return vars.peerId && vars.childId ? resolveEdgeWith(vars.peerId, vars.childId, [vars.childId]) : null;
    case "create-project":
      return resolveCreateProject();
  }
}

/**
 * Цель есть в DOM, но не видна: секция страницы ниже сгиба, узел холста за краем
 * пана (раскрытая рамка выросла за экран). Возвращает элемент, к которому надо
 * подвести взгляд, или null (цели нет вовсе или она уже видна).
 */
export function hiddenTarget(target: Target, ctx: TargetCtx): Element | null {
  let selector: string | null = null;
  switch (target.kind) {
    case "tour":
      selector = byTour(target.key);
      break;
    case "yar-card":
      selector = ctx.yarProjectId ? byTour(`project:${ctx.yarProjectId}`) : null;
      break;
    case "yar-node": {
      const id = ctx.yarObjects?.get(target.name);
      selector = id ? rfNode(id) : null;
      break;
    }
    case "yar-tree": {
      // строка дерева ниже края его прокрутки
      const id = ctx.yarObjects?.get(target.name);
      selector = id ? byTour(treeKey(target.part, id)) : null;
      break;
    }
    case "pair":
      selector = target.main.kind === "tour" ? byTour(target.main.key) : null;
      break;
    case "system-part":
    case "handles":
    case "frame-end":
    case "context-edge":
    case "context-diagram":
    case "inside":
      selector = ctx.vars.systemId ? rfNode(ctx.vars.systemId) : null;
      break;
    case "create-project":
      selector = null;
      break;
  }
  if (!selector) return null;
  const els = Array.from(document.querySelectorAll(selector));
  if (els.length === 0 || els.some((el) => visibleRect(el))) return null;
  return els[0];
}

/** Подвести взгляд к скрытой цели: холст — «вписать схему» (кнопка React Flow),
 *  страница — прокрутка к элементу. */
export function revealTarget(el: Element): void {
  const flow = el.closest(".react-flow");
  if (flow) {
    flow.querySelector<HTMLElement>(".react-flow__controls-fitview")?.click();
    return;
  }
  el.scrollIntoView({ block: "center", behavior: "smooth" });
}

/** Самый верхний открытый модальный <dialog>: остальной документ под ним инертен. */
export function topDialog(): HTMLElement | null {
  const open = Array.from(document.getElementsByTagName("dialog")).filter((d) => d.open);
  return open.length > 0 ? open[open.length - 1] : null;
}

