// Шаг «Проведите связь»: какую пару хэндлов подсветить. Ту же, что выберет сам
// рендерер для связи «второй объект → система», — пара считается заранее ТЕМ ЖЕ
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

// Пересчёт роутера — только когда сцена сдвинулась (кадровый цикл зовёт часто).
let memo: { key: string; pair: { sourceHandle: string; targetHandle: string } } | null = null;

/** Цель шага «Проведите связь»: по точке на каждом из двух объектов. */
export function resolveHandlePair(peerId: string, systemId: string): Resolved | null {
  const peerEl = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${peerId}"]`);
  const sysEl = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${systemId}"]`);
  const flow = peerEl?.closest(".react-flow");
  if (!peerEl || !sysEl || !flow || !flow.contains(sysEl)) return null;
  const boxes = new Map<string, Box>();
  for (const el of Array.from(flow.querySelectorAll<HTMLElement>(ROUTED_NODES))) {
    const id = el.getAttribute("data-id");
    const box = flowBox(el);
    if (id && box && box.w > 0) boxes.set(id, box);
  }
  if (!boxes.has(peerId) || !boxes.has(systemId)) return null;
  const key = [...boxes].map(([id, b]) => `${id}:${b.x},${b.y},${b.w},${b.h}`).join("|") + `>${peerId}>${systemId}`;
  if (memo?.key !== key) memo = { key, pair: pickHandlePair(peerId, systemId, boxes) };
  const { sourceHandle, targetHandle } = memo.pair;
  const handleEl = (h: string) => flow.querySelector(`.react-flow__handle[data-handleid="${h}"]`);
  const src = handleEl(sourceHandle), tgt = handleEl(targetHandle);
  if (!src || !tgt) return null;
  const rect = (el: Element): Rect => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  const holes = [padHole(rect(src), "dot"), padHole(rect(tgt), "dot")];
  const nodes = [rect(peerEl), rect(sysEl)];
  const around = union([...nodes, ...holes]) ?? holes[0];
  return { elements: [src, tgt], holes, anchor: around, avoid: [around] };
}

