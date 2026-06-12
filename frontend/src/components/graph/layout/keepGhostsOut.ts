// Строгий запрет проникновения гостей (и гостевых рамок) в «родные» рамки уровня.
//
// Инвариант: ни один гость не должен пересекать нативную (breadcrumb) рамку, в которую
// он не входит по членству. «Держать внутри своей рамки» обеспечивается автоматически
// (рамка = bbox её членов), поэтому здесь обеспечиваем только keep-out. Нативные рамки
// концентрически вложены, поэтому связывающая запретная рамка для гостя с членством до
// глубины L — ровно F_{L+1} (самая мелкая запретная = крупнейший прямоугольник): очистив
// её, очищаем все глубже.
//
// Два потребителя:
//  - enforceFramesKeepOut — финальный проход раскладки (после placeOutsideGhosts):
//    выталкивает гостей/гостевые рамки минимальным сдвигом к ближайшему краю. Раскрытую
//    гостевую рамку двигает жёсткой группой. Итерирует до сходимости (родная рамка растёт
//    за своим членом-гостем → может задеть другого).
//  - clampOutOfNativeFrames — clamp одиночного гостя при отпускании ручного драга.
import { NODE_W, NODE_H, KEEPOUT_GAP } from "../constants";
import { computeFrames, type FrameRect } from "./frames";
import { assignEdgeHandles } from "./level";
import type { DisplayExternal } from "../types";
import type { Edge as AppEdge, AncestorRef } from "../../../types";

interface Rect { minX: number; minY: number; maxX: number; maxY: number }

const rectOf = (f: FrameRect): Rect => ({
  minX: f.rect.x, minY: f.rect.y, maxX: f.rect.x + f.rect.w, maxY: f.rect.y + f.rect.h,
});
const overlaps = (a: Rect, b: Rect): boolean =>
  a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;

/**
 * Минимальный сдвиг (MTV к ближайшему краю), чтобы `r` оказался ЗА пределами `f` + gap.
 * Возвращает {dx, dy} (одна из осей ненулевая) либо null, если не пересекаются.
 */
function pushOut(r: Rect, f: Rect, gap: number): { dx: number; dy: number } | null {
  if (!overlaps(r, f)) return null;
  const left = f.minX - gap - r.maxX;   // < 0 — увести влево
  const right = f.maxX + gap - r.minX;  // > 0 — увести вправо
  const up = f.minY - gap - r.maxY;     // < 0 — увести вверх
  const down = f.maxY + gap - r.minY;   // > 0 — увести вниз
  // выбираем ось/направление наименьшего по модулю смещения
  let best = left, bestAxis: "x" | "y" = "x";
  if (Math.abs(right) < Math.abs(best)) best = right;
  if (Math.abs(up) < Math.abs(best)) { best = up; bestAxis = "y"; }
  if (Math.abs(down) < Math.abs(best)) { best = down; bestAxis = "y"; }
  return bestAxis === "x" ? { dx: best, dy: 0 } : { dx: 0, dy: best };
}

// нативные рамки, индексированные по depth (0..k); depth непрерывен по breadcrumb
function nativeByDepth(frames: FrameRect[]): FrameRect[] {
  const out: FrameRect[] = [];
  for (const f of frames) if (f.native) out[f.depth] = f;
  return out;
}

// глубина самой глубокой нативной рамки, членом которой является id (или -1)
function memberDepth(native: FrameRect[], id: string): number {
  let d = -1;
  for (const f of native) if (f && f.memberIds.has(id)) d = Math.max(d, f.depth);
  return d;
}

export interface KeepOutResult {
  /** id сущностей, которые проход сдвинул */
  moved: Set<string>;
  /** хэндлы рёбер, пересчитанные по финальным позициям */
  edgeHandles: Map<string, { sourceHandle: string; targetHandle: string }>;
}

const MAX_ITER = 8;

/**
 * Финальный проход: выталкивает гостей/гостевые рамки за пределы чужих родных рамок.
 * `positions` МУТИРУЕТСЯ. Возвращает null, если выталкивать нечего (никто не сдвинут).
 */
export function enforceFramesKeepOut(params: {
  nodes: { id: string }[];
  entities: DisplayExternal[];
  ancestorIds: string[];
  layoutEdges: AppEdge[];
  positions: Map<string, { x: number; y: number }>;
}): KeepOutResult | null {
  const { nodes, entities, ancestorIds, layoutEdges, positions } = params;
  if (ancestorIds.length === 0 || nodes.length === 0 || entities.length === 0) return null;

  const localIds = nodes.map((n) => n.id);
  const entAncestors = (e: DisplayExternal): AncestorRef[] =>
    e.kind === "leaf" ? (e.ghost.ancestors ?? []) : e.ancestors;
  const externals = entities.map((e) => ({ id: e.id, ancestors: entAncestors(e) }));
  const pos = (id: string) => positions.get(id);
  const moved = new Set<string>();

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const frames = computeFrames({ localIds, externals, pos, ancestorIds, ancestorNames: ancestorIds });
    const native = nativeByDepth(frames);
    const guestFrames = frames.filter((f) => !f.native);

    // группировка: каждая внешняя сущность → самая ВНЕШНЯЯ (min depth) гостевая рамка,
    // которая её содержит (жёсткая группа), либо одиночка (ключ = собственный id).
    const groupKey = new Map<string, string>();
    for (const ext of externals) {
      let bestId: string | null = null, bestDepth = Infinity;
      for (const gf of guestFrames) {
        if (gf.memberIds.has(ext.id) && gf.depth < bestDepth) { bestDepth = gf.depth; bestId = gf.id; }
      }
      groupKey.set(ext.id, bestId ?? ext.id);
    }
    const groups = new Map<string, string[]>();
    for (const ext of externals) {
      const k = groupKey.get(ext.id)!;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(ext.id);
    }

    let changed = false;
    for (const [key, ids] of groups) {
      const repId = ids[0];
      // прямоугольник группы: нарисованная гостевая рамка (если группа — рамка) либо
      // bbox одиночного узла
      const gf = guestFrames.find((f) => f.id === key);
      let groupRect: Rect;
      if (gf) {
        groupRect = rectOf(gf);
      } else {
        const p = pos(repId);
        if (!p) continue;
        groupRect = { minX: p.x, minY: p.y, maxX: p.x + NODE_W, maxY: p.y + NODE_H };
      }
      // связывающая запретная родная рамка = F_{memberDepth+1}
      const fd = memberDepth(native, repId) + 1;
      const forbidden = native[fd];
      if (!forbidden) continue; // глубже текущего контейнера запретных нет

      const push = pushOut(groupRect, rectOf(forbidden), KEEPOUT_GAP);
      if (!push) continue;
      for (const id of ids) {
        const p = pos(id);
        if (!p) continue;
        positions.set(id, { x: p.x + push.dx, y: p.y + push.dy });
        moved.add(id);
      }
      changed = true;
    }
    if (!changed) break;
  }

  if (moved.size === 0) return null;
  const displayed = [...localIds.map((id) => ({ id })), ...externals.map((e) => ({ id: e.id }))];
  return { moved, edgeHandles: assignEdgeHandles(displayed, layoutEdges, positions) };
}

/**
 * Clamp позиции ОДИНОЧНОГО гостя при ручном драге: если предложенная позиция вводит узел
 * в чужую родную рамку — сдвигает его минимально наружу. `nativeFrames` — нативные рамки
 * уровня (computeFrames по текущим узлам); запретная рамка гостя не включает его членом,
 * поэтому от его собственной позиции не зависит. Возвращает скорректированную позицию.
 */
export function clampOutOfNativeFrames(
  entityId: string,
  proposed: { x: number; y: number },
  frames: FrameRect[],
): { x: number; y: number } {
  const native = nativeByDepth(frames);
  const fd = memberDepth(native, entityId) + 1;
  const forbidden = native[fd];
  if (!forbidden) return proposed;
  const r: Rect = { minX: proposed.x, minY: proposed.y, maxX: proposed.x + NODE_W, maxY: proposed.y + NODE_H };
  const push = pushOut(r, rectOf(forbidden), KEEPOUT_GAP);
  return push ? { x: proposed.x + push.dx, y: proposed.y + push.dy } : proposed;
}
