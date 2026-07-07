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
import type { LayoutEdge, AncestorRef } from "../../../types";

interface Rect { minX: number; minY: number; maxX: number; maxY: number }

const rectOf = (f: FrameRect): Rect => ({
  minX: f.rect.x, minY: f.rect.y, maxX: f.rect.x + f.rect.w, maxY: f.rect.y + f.rect.h,
});
const overlaps = (a: Rect, b: Rect): boolean =>
  a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;

/**
 * Минимальный сдвиг (MTV к ближайшему краю), чтобы `r` оказался ЗА пределами `f`,
 * выдержав зазор `gap`. Запретной считается рамка, РАЗДУТАЯ на gap: узел выталкивается
 * ровно к её границе (без добавочного зазора). Так буфер — это сама граница: при
 * подносе узел упирается в него плавно, без скачка на gap (старый порог срабатывал
 * лишь при касании реального края → рывок). Возвращает {dx, dy} (одна ось ненулевая)
 * либо null, если `r` вне раздутой рамки. Экспортируется: тот же MTV использует
 * живой кламп от раскрытых compound-рамок (useSnapAlignment).
 */
export function pushOut(r: Rect, f: Rect, gap: number): { dx: number; dy: number } | null {
  const fx: Rect = { minX: f.minX - gap, minY: f.minY - gap, maxX: f.maxX + gap, maxY: f.maxY + gap };
  if (!overlaps(r, fx)) return null;
  const left = fx.minX - r.maxX;   // < 0 — увести влево
  const right = fx.maxX - r.minX;  // > 0 — увести вправо
  const up = fx.minY - r.maxY;     // < 0 — увести вверх
  const down = fx.maxY - r.minY;   // > 0 — увести вниз
  // выбираем ось/направление наименьшего по модулю смещения
  let best = left, bestAxis: "x" | "y" = "x";
  if (Math.abs(right) < Math.abs(best)) best = right;
  if (Math.abs(up) < Math.abs(best)) { best = up; bestAxis = "y"; }
  if (Math.abs(down) < Math.abs(best)) { best = down; bestAxis = "y"; }
  return bestAxis === "x" ? { dx: best, dy: 0 } : { dx: 0, dy: best };
}

// нативные рамки, индексированные по depth (0..k); depth непрерывен по breadcrumb.
// Экспортируется: ту же индексацию использует ringPlacement, чтобы кольцо гостя
// совпадало с запретной рамкой keep-out (→ keep-out выполняется по построению).
export function nativeByDepth(frames: FrameRect[]): FrameRect[] {
  const out: FrameRect[] = [];
  for (const f of frames) if (f.native) out[f.depth] = f;
  return out;
}

// глубина самой глубокой нативной рамки, членом которой является id (или -1).
// Связывающая запретная рамка гостя = F_{memberDepth+1} (см. инвариант в шапке).
export function memberDepth(native: FrameRect[], id: string): number {
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
  layoutEdges: LayoutEdge[];
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
 * Выталкивание НЕ-ЧЛЕНОВ из РАСКРЫТЫХ compound-рамок (инвариант R5: узел, не
 * относящийся к рамке, не лежит внутри неё — симметрия старого запрета для
 * родных рамок). Субъекты — ВСЕ отображаемые узлы (локалы и сущности); узлы
 * внутри собственной рамки двигаются с ней жёсткой группой (по top-рамке),
 * члены запретной рамки и её вложенные рамки не трогаются. Рамка при
 * раскрытии пиннится на месте — уступают чужие. `positions` МУТИРУЕТСЯ;
 * рамки пересчитывать между итерациями не нужно (rect рамки зависит только
 * от её членов, а члены не двигаются). Возвращает id сдвинутых узлов.
 */
export function keepOutOfExpandedFrames(params: {
  displayedIds: string[];
  /** раскрытые (не-native) рамки на текущих позициях; rect'ы МУТИРУЮТСЯ
      (едут вместе со своей группой при выталкивании рамки из рамки) */
  frames: FrameRect[];
  positions: Map<string, { x: number; y: number }>;
}): Set<string> {
  const { displayedIds, frames, positions } = params;
  const moved = new Set<string>();
  if (frames.length === 0) return moved;

  // top-рамки: без объемлющей (все члены вложенной входят в объемлющую) —
  // достаточно их как запреток и субъектов (rect вложенной внутри rect top)
  const isTop = (f: FrameRect): boolean =>
    !frames.some((g) => g !== f && g.depth < f.depth && [...f.memberIds].every((id) => g.memberIds.has(id)));
  const topFrames = frames.filter(isTop);

  // группа узла — его top-рамка (двигается рамкой целиком) либо он сам
  const frameOf = (id: string) => topFrames.find((f) => f.memberIds.has(id)) ?? null;

  const shiftGroup = (g: FrameRect | null, memberIds: string[], dx: number, dy: number) => {
    for (const mid of memberIds) {
      const p = positions.get(mid);
      if (!p) continue;
      positions.set(mid, { x: p.x + dx, y: p.y + dy });
      moved.add(mid);
    }
    if (g) {
      // rect и вложенных рамок группы едут с членами — они остаются источником
      // правды для последующих проверок этой же стадии
      for (const f of frames) {
        if (![...f.memberIds].every((mid) => g.memberIds.has(mid))) continue;
        f.rect.x += dx; f.rect.y += dy;
        f.content.minX += dx; f.content.maxX += dx;
        f.content.minY += dy; f.content.maxY += dy;
      }
    }
  };

  for (let iter = 0; iter < MAX_ITER; iter++) {
    let changed = false;
    const seen = new Set<string>();
    for (const id of displayedIds) {
      const g = frameOf(id);
      const key = g ? `f:${g.id}` : id;
      if (seen.has(key)) continue;
      seen.add(key);
      const memberIds = g ? [...g.memberIds] : [id];
      const p0 = positions.get(id);
      if (!g && !p0) continue;
      const subject: Rect = g
        ? rectOf(g)
        : { minX: p0!.x, minY: p0!.y, maxX: p0!.x + NODE_W, maxY: p0!.y + NODE_H };
      const subjectArea = (subject.maxX - subject.minX) * (subject.maxY - subject.minY);

      for (const f of topFrames) {
        if (g === f) continue;
        // субъект-член запретной рамки не выталкивается (узел/вложенная в своей)
        if (memberIds.every((mid) => f.memberIds.has(mid))) continue;
        // при конфликте двух рамок уступает МЕНЬШАЯ (меньше визуального разрушения;
        // без этого выталкивалась бы первая по порядку обхода — хоть и большая)
        if (g && subjectArea > f.rect.w * f.rect.h) continue;
        const push = pushOut(subject, rectOf(f), KEEPOUT_GAP);
        if (!push) continue;
        shiftGroup(g, memberIds, push.dx, push.dy);
        subject.minX += push.dx; subject.maxX += push.dx;
        subject.minY += push.dy; subject.maxY += push.dy;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return moved;
}

/**
 * Clamp позиции ОДИНОЧНОЙ сущности при ручном драге: если предложенная позиция вводит
 * её в чужую родную рамку — сдвигает минимально наружу. `nativeFrames` — нативные рамки
 * уровня (computeFrames по текущим узлам); запретная рамка гостя не включает его членом,
 * поэтому от его собственной позиции не зависит. `w`/`h` — размер сущности: узлы —
 * дефолт NODE_W×NODE_H, раскрытая рамка-узел (R4.2) — её реальный rect; у не-члена
 * нативных рамок (гостевая рамка) запретной становится самая внешняя родная.
 * Возвращает скорректированную позицию.
 */
export function clampOutOfNativeFrames(
  entityId: string,
  proposed: { x: number; y: number },
  frames: FrameRect[],
  w: number = NODE_W,
  h: number = NODE_H,
): { x: number; y: number } {
  const native = nativeByDepth(frames);
  const fd = memberDepth(native, entityId) + 1;
  const forbidden = native[fd];
  if (!forbidden) return proposed;
  const r: Rect = { minX: proposed.x, minY: proposed.y, maxX: proposed.x + w, maxY: proposed.y + h };
  const push = pushOut(r, rectOf(forbidden), KEEPOUT_GAP);
  return push ? { x: proposed.x + push.dx, y: proposed.y + push.dy } : proposed;
}
