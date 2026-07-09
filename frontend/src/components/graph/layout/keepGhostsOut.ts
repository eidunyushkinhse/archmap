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
import { separateRects } from "./separateRects";
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

/**
 * Суммарный сдвиг вдоль направления `dir`, выводящий `r` за пределы ВСЕХ
 * прямоугольников `fx` (уже раздутых на зазор). Движение монотонно: очищенная
 * рамка при дальнейшем движении в ту же сторону не задевается снова, поэтому
 * хватает ≤ fx.length шагов. Возвращает знаковый сдвиг по оси направления.
 */
function slideOutAll(r: Rect, fx: Rect[], dir: "left" | "right" | "up" | "down"): number {
  const cur = { ...r };
  let total = 0;
  for (let guard = 0; guard <= fx.length; guard++) {
    const hit = fx.find((f) => overlaps(cur, f));
    if (!hit) break;
    let d: number;
    if (dir === "left") d = hit.minX - cur.maxX;
    else if (dir === "right") d = hit.maxX - cur.minX;
    else if (dir === "up") d = hit.minY - cur.maxY;
    else d = hit.maxY - cur.minY;
    total += d;
    if (dir === "left" || dir === "right") { cur.minX += d; cur.maxX += d; }
    else { cur.minY += d; cur.maxY += d; }
  }
  return total;
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
 * Родные рамки концентрически вложены (запретка одна — F_{L+1}), поэтому здесь
 * попарного MTV достаточно; «сэндвич» между НЕвложенными рамками бывает только у
 * раскрытых compound-рамок — см. slideOutAll в keepOutOfExpandedFrames.
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
 * внутри собственной рамки двигаются с ней жёсткой группой (по top-рамке).
 * Конфликт узел↔рамка: уступает узел (рамка для него запретка). Конфликт
 * рамка↔рамка: VPSC-развод с весом-площадью — в основном уступает меньшая,
 * но при зажатии раздвигаются обе. `positions` МУТИРУЕТСЯ; rect'ы рамок
 * едут вместе со своими группами (shiftFrameGroup) и остаются источником
 * правды внутри стадии. Возвращает id сдвинутых узлов.
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

  // ДЕРЕВО РАМОК по членству: родитель рамки — минимальная объемлющая (самая
  // глубокая рамка-надмножество её членов). Инвариант проверяется РЕКУРСИВНО,
  // в каждом контексте вложенности (жалоба пользователя: раскрытие внутри
  // раскрытого — сиблинги внутри рамки HelixMon лежали в рамке ObsCore, потому
  // что прежняя top-only логика их не видела).
  const isSubset = (a: FrameRect, b: FrameRect): boolean =>
    [...a.memberIds].every((id) => b.memberIds.has(id));
  const parentOf = new Map<string, FrameRect | null>();
  for (const f of frames) {
    let best: FrameRect | null = null;
    for (const g of frames) {
      if (g === f || g.depth >= f.depth || !isSubset(f, g)) continue;
      if (!best || g.depth > best.depth) best = g;
    }
    parentOf.set(f.id, best);
  }
  // «домашняя» рамка узла — самая глубокая содержащая; null — вне рамок
  const homeOf = (id: string): FrameRect | null => {
    let best: FrameRect | null = null;
    for (const f of frames) {
      if (f.memberIds.has(id) && (!best || f.depth > best.depth)) best = f;
    }
    return best;
  };

  const shiftFrameGroup = (g: FrameRect, dx: number, dy: number) => {
    for (const mid of g.memberIds) {
      const p = positions.get(mid);
      if (!p) continue;
      positions.set(mid, { x: p.x + dx, y: p.y + dy });
      moved.add(mid);
    }
    // rect самой рамки и всех вложенных едут с членами — остаются источником
    // правды для последующих проверок этой же стадии
    for (const f of frames) {
      if (f !== g && !isSubset(f, g)) continue;
      f.rect.x += dx; f.rect.y += dy;
      f.content.minX += dx; f.content.maxX += dx;
      f.content.minY += dy; f.content.maxY += dy;
    }
  };

  // Контексты: null (верхний уровень холста) и каждая рамка. Субъекты контекста —
  // его ПРЯМЫЕ узлы (homeOf === ctx) и ПРЯМЫЕ под-рамки (parentOf === ctx, жёсткие
  // группы); запретки — те же под-рамки. Изменение bbox контекста от выталкиваний
  // внутри него добирает внешний цикл в pipeline (computeFrames пересчитывается).
  const contexts: (FrameRect | null)[] = [null, ...frames];
  for (const ctx of contexts) {
    const forbidden = frames.filter((f) => (parentOf.get(f.id) ?? null) === ctx);
    if (forbidden.length === 0) continue;
    const subjectNodes = displayedIds.filter((id) => homeOf(id) === ctx && positions.has(id));

    // Под-рамки контекста между собой — взвешенное VPSC-разведение (separateRects)
    // жёсткими группами, вес = площадь: меньшая уступает больше, но при зажатии
    // раздвигаются и соседи. Прежний попарный MTV «уступает меньшая» зацикливался,
    // когда рамка зажата между двумя крупными («сэндвич»: щель уже субъекта) —
    // её гоняло вверх-вниз с нулевой суммой, и наложение рамок переживало все
    // итерации (Configuration Management лежал в ObsCore при полном раскрытии).
    if (forbidden.length > 1) {
      // Рамки раздуваются на полузазора: конфликтом считается и недобор KEEPOUT_GAP
      // между телами (как у прежнего MTV с pushOut по раздутой рамке), а не только
      // пересечение; после развода раздутые касаются → тела держат ровно зазор.
      const HALF = KEEPOUT_GAP / 2;
      const rects0 = forbidden.map((f) => ({
        minX: f.rect.x - HALF, minY: f.rect.y - HALF,
        maxX: f.rect.x + f.rect.w + HALF, maxY: f.rect.y + f.rect.h + HALF,
      }));
      const solved = separateRects(rects0, forbidden.map((f) => f.rect.w * f.rect.h), 0);
      forbidden.forEach((f, i) => {
        const dx = solved[i].minX - rects0[i].minX;
        const dy = solved[i].minY - rects0[i].minY;
        if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) shiftFrameGroup(f, dx, dy);
      });
    }
    // Одиночные узлы контекста — направленное СКОЛЬЖЕНИЕ из ОБЪЕДИНЕНИЯ уже
    // разведённых под-рамок (slideOutAll). Прежний попарный MTV «к ближайшему
    // краю» пинг-понгал в сэндвиче двух рамок (щель KEEPOUT_GAP уже субъекта):
    // выталкивание из одной заводило в другую, итерации выдыхались, и узел
    // ОСТАВАЛСЯ внутри (Nucleus/IdHub/Cirrus в нижней полосе рамки HelixMon).
    // Скольжение сразу считает суммарный выход за все рамки по каждой из четырёх
    // сторон и применяет минимальный — узел чист за один ход, каскад не нужен.
    const inflated = forbidden.map((f) => {
      const r = rectOf(f);
      return { minX: r.minX - KEEPOUT_GAP, minY: r.minY - KEEPOUT_GAP, maxX: r.maxX + KEEPOUT_GAP, maxY: r.maxY + KEEPOUT_GAP };
    });
    for (const id of subjectNodes) {
      const p0 = positions.get(id)!;
      const subject: Rect = { minX: p0.x, minY: p0.y, maxX: p0.x + NODE_W, maxY: p0.y + NODE_H };
      if (!inflated.some((f) => overlaps(subject, f))) continue;
      let best: { dx: number; dy: number } | null = null;
      for (const dir of ["left", "right", "up", "down"] as const) {
        const d = slideOutAll(subject, inflated, dir);
        const cand = dir === "left" || dir === "right" ? { dx: d, dy: 0 } : { dx: 0, dy: d };
        if (!best || Math.abs(d) < Math.abs(best.dx + best.dy)) best = cand;
      }
      if (!best) continue;
      positions.set(id, { x: p0.x + best.dx, y: p0.y + best.dy });
      moved.add(id);
    }
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
