// Шаги «Проведите связь» и «Перевесьте связь»: какие хэндлы подсветить. Те же, что
// выберет сам рендерер для связи «второй объект → система» (или для перевешенной
// связи «второй объект → сервис внутри системы»), — пара считается заранее ТЕМ ЖЕ
// роутером стрелок (buildAutoRoutes: порты всех сторон и слотов, A*, выбор стороны),
// который конвейер раскладки зовёт для настоящих рёбер. Входы роутера — те же, что
// у конвейера: позиции узлов уровня в координатах потока и их замеренные габариты
// (снимаются с DOM React Flow). Роутер не дал пары — запасной вариант: стороны,
// смотрящие друг на друга по геометрии (autoHandles, прежний движок хэндлов).
//
// Ни холст, ни роутер здесь не меняются: только чтение.
import { buildAutoRoutes } from "../graph/layout/autoRoutes";
import { autoHandles } from "../graph/layout/level";
import type { EdgeGroup } from "../graph/types";
import type { Edge } from "../../types";
import type { RehangDemo, Side } from "./tourDemo";
import { padHole, union, type Rect } from "./tourGeometry";
import type { Resolved } from "./tourTargets";

export type Box = { x: number; y: number; w: number; h: number };

const PROBE = "tour-probe";

/**
 * Хэндлы для будущей связи sourceId → targetId на уровне с узлами boxes (координаты
 * потока: левый верхний угол и габариты). Возвращает id хэндлов в формате узлов
 * холста (hid: `<узел>--<сторона>--<слот>`).
 */
export function pickHandlePair(
  sourceId: string,
  targetId: string,
  boxes: ReadonlyMap<string, Box>,
): { sourceHandle: string; targetHandle: string } {
  const positions = new Map<string, { x: number; y: number }>();
  const sizes = new Map<string, { w: number; h: number }>();
  for (const [id, b] of boxes) {
    positions.set(id, { x: b.x, y: b.y });
    sizes.set(id, { w: b.w, h: b.h });
  }
  const probe: Edge = {
    id: PROBE, label: null, technology: null, source_id: sourceId, target_id: targetId,
    version: 0, created_at: "",
  };
  const group: EdgeGroup = { id: PROBE, source: sourceId, target: targetId, members: [probe] };
  try {
    const ar = buildAutoRoutes({
      groups: [group], routableIds: new Set([PROBE]), positions, displayIds: [...boxes.keys()], sizes,
    });
    const picked = ar.handles.get(PROBE);
    if (picked) return picked;
  } catch {
    // роутер не справился — ниже запасной вариант
  }
  return autoHandles(sourceId, targetId, positions, 0, 1);
}

// Позиция узла в координатах потока: React Flow ставит узлу transform
// translate(x, y) — абсолютную позицию; габариты — его замер (offsetWidth/Height).
function flowBox(el: HTMLElement): Box | null {
  const m = el.style.transform.match(/translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]), w: el.offsetWidth, h: el.offsetHeight };
}

// Узлы, которые видит роутер: блоки, гости и свёрнутые контейнеры (не рамки и не
// служебные распорки).
const ROUTED_NODES = ".react-flow__node-block, .react-flow__node-ghost, .react-flow__node-container";

// Узлы уровня, которые видит роутер, с их положением в координатах потока.
function routedBoxes(flow: Element): Map<string, Box> {
  const boxes = new Map<string, Box>();
  for (const el of Array.from(flow.querySelectorAll<HTMLElement>(ROUTED_NODES))) {
    const id = el.getAttribute("data-id");
    const box = flowBox(el);
    if (id && box && box.w > 0) boxes.set(id, box);
  }
  return boxes;
}

// Пересчёт роутера — только когда сцена сдвинулась (кадровый цикл зовёт часто).
const memo = new Map<string, { key: string; pair: { sourceHandle: string; targetHandle: string } }>();

/** Пара хэндлов для связи sourceId → targetId по сцене холста flow (null — концов нет). */
function scenePair(
  flow: Element, sourceId: string, targetId: string,
): { sourceHandle: string; targetHandle: string } | null {
  const boxes = routedBoxes(flow);
  if (!boxes.has(sourceId) || !boxes.has(targetId)) return null;
  const key = [...boxes].map(([id, b]) => `${id}:${b.x},${b.y},${b.w},${b.h}`).join("|") + `>${sourceId}>${targetId}`;
  const slot = `${sourceId}>${targetId}`;
  let hit = memo.get(slot);
  if (hit?.key !== key) {
    hit = { key, pair: pickHandlePair(sourceId, targetId, boxes) };
    memo.set(slot, hit);
  }
  return hit.pair;
}

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

/** Цель шага «Проведите связь»: по точке на каждом из двух объектов. */
export function resolveHandlePair(peerId: string, systemId: string): Resolved | null {
  const peerEl = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${peerId}"]`);
  const sysEl = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${systemId}"]`);
  const flow = peerEl?.closest(".react-flow");
  if (!peerEl || !sysEl || !flow || !flow.contains(sysEl)) return null;
  const pair = scenePair(flow, peerId, systemId);
  if (!pair) return null;
  const { sourceHandle, targetHandle } = pair;
  const handleEl = (h: string) => flow.querySelector(`.react-flow__handle[data-handleid="${h}"]`);
  const src = handleEl(sourceHandle), tgt = handleEl(targetHandle);
  if (!src || !tgt) return null;
  const holes = [padHole(rectOf(src), "dot"), padHole(rectOf(tgt), "dot")];
  const nodes = [rectOf(peerEl), rectOf(sysEl)];
  const around = union([...nodes, ...holes]) ?? holes[0];
  return { elements: [src, tgt], holes, anchor: around, avoid: [around] };
}

// Концы ребра холста: React Flow подписывает ребро «Edge from <source> to <target>».
function edgeEnds(edgeEl: Element): { source: string; target: string } | null {
  const m = (edgeEl.getAttribute("aria-label") ?? "").match(/^Edge from (\S+) to (\S+)$/);
  return m ? { source: m[1], target: m[2] } : null;
}

const SIDES: readonly Side[] = ["top", "right", "bottom", "left"];

/** Сторона из id хэндла `<узел>--<сторона>--<слот>` (см. graph/constants hid). */
function handleSide(handleId: string): Side | null {
  const side = handleId.split("--")[1];
  return SIDES.find((s) => s === side) ?? null;
}

/** Начало или конец пути ребра (координаты потока): первая и последняя пара чисел d. */
function pathEnd(d: string, which: "first" | "last"): { x: number; y: number } | null {
  const n = (d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/gi) ?? []).map(Number);
  if (n.length < 2) return null;
  return which === "first" ? { x: n[0], y: n[1] } : { x: n[n.length - 2], y: n[n.length - 1] };
}

/** Сторона прямоугольника, к которой ближе всего точка. */
function nearestSide(p: { x: number; y: number }, r: Rect): Side {
  const d: Record<Side, number> = {
    top: Math.abs(p.y - r.y), bottom: Math.abs(p.y - r.y - r.h), left: Math.abs(p.x - r.x), right: Math.abs(p.x - r.x - r.w),
  };
  return SIDES.reduce((best, s) => (d[s] < d[best] ? s : best), SIDES[0]);
}

/**
 * Геометрия демонстрации перевеса (tourDemo.ts) в координатах окна: где ладонь берёт
 * конец стрелки, куда кладёт и откуда тянется переносимая копия. Неподвижный конец —
 * начало или конец пути ребра (координаты потока); на экран его переводит второй объект:
 * его позиция в потоке (transform) и прямоугольник на экране дают сдвиг и масштаб.
 */
function rehangDemo(
  edgeEl: Element, peerEl: HTMLElement | null, frameIsTarget: boolean,
  grab: { x: number; y: number }, dropEl: Element, dropHandle: string,
): RehangDemo | null {
  const dropSide = handleSide(dropHandle);
  const path = edgeEl.querySelector("path.react-flow__edge-path") ?? edgeEl.querySelector("path");
  const end = path ? pathEnd(path.getAttribute("d") ?? "", frameIsTarget ? "first" : "last") : null;
  const peerBox = peerEl ? flowBox(peerEl) : null;
  if (!dropSide || !end || !peerEl || !peerBox) return null;
  const peer = rectOf(peerEl);
  const zoom = peerBox.w > 0 ? peer.w / peerBox.w : 1;
  const fixed = { x: peer.x + (end.x - peerBox.x) * zoom, y: peer.y + (end.y - peerBox.y) * zoom };
  const dot = rectOf(dropEl);
  return {
    grab,
    drop: { x: dot.x + dot.w / 2, y: dot.y + dot.h / 2 },
    dropSide,
    fixed,
    fixedSide: nearestSide(fixed, peer),
    headAtFixed: !frameIsTarget,
    zoom,
  };
}

/**
 * Цель шага «Перевесьте связь»: конец стрелки, упёршийся в рамку системы (ручка
 * перепривязки React Flow на её границе), и ОДНА точка на дочернем объекте — та, куда
 * роутер провёл бы эту связь, будь её конец уже на нём (тот же расчёт, что у пары на
 * шаге «Проведите связь»). Холст перевес и так принимает у точки на краю. Плюс
 * геометрия демонстрации: ладонь переносит конец с рамки на эту точку (tourDemo.ts).
 */
export function resolveRehang(systemId: string, childId: string): Resolved | null {
  const frameEl = document.querySelector(`.react-flow__node[data-id="${systemId}"]`);
  const childEl = document.querySelector(`.react-flow__node[data-id="${childId}"]`);
  const flow = frameEl?.closest(".react-flow");
  if (!frameEl || !childEl || !flow || !flow.contains(childEl)) return null;
  const f = rectOf(frameEl);
  const onBorder = (x: number, y: number) => {
    const inside = x >= f.x - 14 && x <= f.x + f.w + 14 && y >= f.y - 14 && y <= f.y + f.h + 14;
    const edge = Math.min(Math.abs(x - f.x), Math.abs(x - f.x - f.w), Math.abs(y - f.y), Math.abs(y - f.y - f.h));
    return inside && edge <= 14;
  };
  for (const updater of Array.from(flow.querySelectorAll(".react-flow__edgeupdater"))) {
    const r = updater.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (r.width === 0 || !onBorder(cx, cy)) continue;
    const edgeEl = updater.closest(".react-flow__edge");
    const ends = edgeEl ? edgeEnds(edgeEl) : null;
    if (!edgeEl || !ends) continue;
    // Тянут конец на рамке; после перевеса он станет дочерним объектом.
    const frameIsTarget = ends.target === systemId;
    if (!frameIsTarget && ends.source !== systemId) continue;
    const pair = frameIsTarget ? scenePair(flow, ends.source, childId) : scenePair(flow, childId, ends.target);
    if (!pair) return null;
    const dropHandle = frameIsTarget ? pair.targetHandle : pair.sourceHandle;
    const handle = flow.querySelector(`.react-flow__handle[data-handleid="${dropHandle}"]`);
    if (!handle) return null;
    const endHole = padHole({ x: cx - 10, y: cy - 10, w: 20, h: 20 }, "rect");
    const dot = padHole(rectOf(handle), "dot");
    const around = union([endHole, dot, rectOf(childEl)]) ?? endHole;
    // Карточке лучше не закрывать и саму связь со вторым объектом: её тянут.
    const peerId = frameIsTarget ? ends.source : ends.target;
    const peerEl = flow.querySelector<HTMLElement>(`.react-flow__node[data-id="${peerId}"]`);
    const soft = [rectOf(edgeEl), ...(peerEl ? [rectOf(peerEl)] : [])];
    const demo = rehangDemo(edgeEl, peerEl, frameIsTarget, { x: cx, y: cy }, handle, dropHandle);
    return {
      elements: [updater, handle], holes: [endHole, dot], anchor: around, avoid: [around], soft,
      ...(demo ? { demo } : {}),
    };
  }
  return null;
}
