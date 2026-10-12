// ПЕРВЫЙ ПОКАЗ детей раскрытого ЛОКАЛА (C9 v2, эпик «структура и воздух»,
// docs/archive/plan-spawn-spacing.md): мини-ELK раскладка подграфа детей вместо слепой
// квадратной сетки.
//
// Сетка игнорировала связи между детьми (соседство в решётке случайно — рёбра
// бежали лабиринтом через зазоры 40px) и подписи (плашки 150–250px не влезали
// в такие зазоры физически — треть уходила в выноски). Теперь дети + рёбра
// МЕЖДУ ними раскладываются локальным `elk.layered` (направление — как у уровня,
// LEVEL_DIRECTION): связанные встают в поток, изолированные — упаковкой компонент ELK.
// Bbox результата сдвигается левым-верхним углом к закреплённой позиции
// контейнера (own-on-expand, C6) — якорь раскрытия не меняется; единственный
// ребёнок садится ровно на место контейнера (bbox из одного узла).
//
// УСТОЙЧИВОСТЬ К КАСКАДУ ДОГРУЗКИ (фикс дёрганья анимации): подграф группы —
// ВСЕ ПРЯМЫЕ дети контейнера (по localChildren), раскрытый ребёнок участвует
// УЗЛОМ, его позиция — якорь группы ЕГО детей (обработка сверху вниз в одном
// прогоне). Раньше подграф собирался из ЛИСТЬЕВ (localFrames): волна догрузки
// внуков меняла состав (раскрытый ребёнок заменялся внуками) → мини-ELK решал
// другую задачу → уже видимые дети прыгали на сотни px (репро: spawn-probe
// --expand-child + --trace). Состав из прямых детей от волн не зависит.
//
// Спейсинги label-aware (Ф2 плана): базы компактны, добавку диктуют wrapped-
// габариты фактических плашек внутренних рёбер (см. константы ниже). Позиции
// засеваются вызывающим (own-on-first-render), сюда попадают только СВЕЖИЕ
// дети (без владеемой позиции).
//
// Ф4б (шаг 3): сама мини-раскладка подграфа детей вынесена в layoutChildrenBlock —
// её же использует блок раскрытого локала на СВЕЖЕЙ сцене (localBlocks.ts): там
// контейнер идёт в раскладку уровня одним узлом размера своей рамки. Одна функция —
// одинаковые рамки на свежих и владеемых сценах.
import { NODE_W, NODE_H } from "../constants";
import { edgeText, wrapLabel } from "../text";
import { getElk, LEVEL_DIRECTION, NODE_PLACEMENT } from "./engine";
import { flowSpacing } from "./flowGaps";
import { wrappedLabelBoxSize } from "./labelBox";
import type { AncestorRef, LayoutEdge, LevelPos, Node as AppNode } from "../../../types";

// Зазоры мини-раскладки подграфа детей (C9 v2) — Label-aware (Ф2 плана): базовые
// значения компактны, добавку диктуют ФАКТИЧЕСКИЕ плашки внутренних рёбер этого
// подграфа (перцентиль p75 wrapped-ширин — одна гигантская подпись не раздувает
// рамку, ей лучше остаться выноской; клампы сверху — жёсткий анти-ватман).
const SPAWN_LAYER_GAP_MIN = 100; // между слоями без подписей (чуть плотнее уровня)
const SPAWN_LAYER_GAP_MAX = 220; // кламп: шире не раздвигаем даже ради плашек
const SPAWN_LABEL_CLEAR = 8;     // клиренс плашки вдоль плеча с каждой стороны (как A10)
const SPAWN_COMPONENT_GAP = 60;  // между компонентами связности (изоляты)

type XY = { x: number; y: number };

/** Карта «узел → его прямой родитель» по кэшу детей раскрытых локалов. */
export function childParentMap(localChildren: Record<string, AppNode[]>): Map<string, string> {
  const parentOf = new Map<string, string>();
  for (const [cid, kids] of Object.entries(localChildren)) {
    for (const k of kids) parentOf.set(k.id, cid);
  }
  return parentOf;
}

/**
 * Подъём конца ребра к члену множества по цепочке родителей (рёбра приходят поднятыми
 * к ЛИСТЬЯМ — глубоким видимым узлам; подграфу нужны прямые дети контейнера).
 */
export function liftToMember(
  id: string, members: ReadonlySet<string>, parentOf: ReadonlyMap<string, string>,
): string | null {
  let cur: string | undefined = id;
  while (cur !== undefined && !members.has(cur)) cur = parentOf.get(cur);
  return cur ?? null;
}

/** Мини-раскладка подграфа детей: позиции от левого-верхнего угла их bbox и его размер. */
export interface ChildrenBlock {
  rel: Map<string, XY>;
  w: number;
  h: number;
}

/**
 * Мини-ELK раскладка ПРЯМЫХ детей одного контейнера (C9 v2): дети `ids` (детерминизм —
 * сортирует вызывающий) и рёбра МЕЖДУ ними (концы поднимаются к детям по `parentOf`).
 * Габарит ребёнка даёт `sizeOf` (спавн — всегда 190×100; блок свежей сцены — рамку
 * вложенного блока). Возвращает позиции относительно bbox результата (min = 0) и размер
 * bbox; null — детей нет или ELK не дал позиций.
 */
export async function layoutChildrenBlock(params: {
  cid: string;
  ids: readonly string[];
  sizeOf: (id: string) => { w: number; h: number };
  layoutEdges: readonly LayoutEdge[];
  parentOf: ReadonlyMap<string, string>;
}): Promise<ChildrenBlock | null> {
  const { cid, ids, sizeOf, layoutEdges, parentOf } = params;
  if (ids.length === 0) return null;
  const idSet = new Set(ids);
  const innerEdges: LayoutEdge[] = [];
  const inner: Array<{ id: string; sources: [string]; targets: [string] }> = [];
  for (const e of layoutEdges) {
    const s = liftToMember(e.source_id, idSet, parentOf);
    const t = liftToMember(e.target_id, idSet, parentOf);
    if (!s || !t || s === t) continue;
    inner.push({ id: e.id, sources: [s], targets: [t] });
    innerEdges.push(e);
  }
  // Спейсинги от фактических wrapped-габаритов плашек внутренних рёбер:
  // межслойный зазор вмещает p75 размеров плашек ВДОЛЬ потока (ширин при RIGHT,
  // высот при DOWN: плашка лежит на стабе у цели, E96); поперёк — единый расчёт
  // коридоров flowSpacing (клиренсы нуджинга + максимум поперечных размеров плашек
  // + резерв под пачку параллельных плеч; edgeNode/edgeEdge держат коридоры с
  // пробегающими сквозь слой рёбрами, которые ELK иначе смыкает до 32px
  // независимо от nodeNode).
  const alongs = innerEdges
    .map((e) => { const b = wrappedLabelBoxSize(wrapLabel(edgeText(e))); return LEVEL_DIRECTION === "DOWN" ? b.h : b.w; })
    .sort((a, b) => a - b);
  const p75 = alongs.length ? alongs[Math.min(alongs.length - 1, Math.floor(alongs.length * 0.75))] : 0;
  const layerGap = Math.min(SPAWN_LAYER_GAP_MAX,
    Math.max(SPAWN_LAYER_GAP_MIN, Math.ceil(p75) + 2 * SPAWN_LABEL_CLEAR));
  const sp = flowSpacing(innerEdges, LEVEL_DIRECTION);
  const elk = await getElk();
  const res = await elk.layout({
    id: `spawn-${cid}`,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": LEVEL_DIRECTION,
      "elk.layered.nodePlacement.strategy": NODE_PLACEMENT,
      "elk.layered.spacing.nodeNodeBetweenLayers": String(layerGap),
      "elk.spacing.nodeNode": String(sp.nodeGap),
      "elk.spacing.edgeNode": String(sp.edgeNodeGap),
      "elk.spacing.edgeEdge": String(sp.edgeEdgeGap),
      "elk.layered.spacing.edgeNodeBetweenLayers": String(sp.edgeNodeLayerGap),
      "elk.layered.spacing.edgeEdgeBetweenLayers": String(sp.edgeEdgeGap),
      "elk.separateConnectedComponents": "true",
      "elk.spacing.componentComponent": String(SPAWN_COMPONENT_GAP),
      // Анти-ватман: длинную архитектурную цепочку (лента 6+ слоёв, полигон Ф1:
      // 2280px шириной) MULTI_EDGE-свёртка ELK сгибает в полосы. Сила сгиба у
      // elkjs непараметризуема (aspectRatio/correctionFactor на разрез не
      // влияют, MANUAL-cuts требует Java-тип) — берём его единственный разрез.
      "elk.layered.wrapping.strategy": "MULTI_EDGE",
    },
    children: ids.map((id) => { const z = sizeOf(id); return { id, width: z.w, height: z.h }; }),
    edges: inner,
  });
  // нормализация к левому-верху bbox (C6: якорь раскрытия — его левый-верхний угол)
  const kids = res.children ?? [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of kids) {
    const z = sizeOf(n.id);
    minX = Math.min(minX, n.x ?? 0); minY = Math.min(minY, n.y ?? 0);
    maxX = Math.max(maxX, (n.x ?? 0) + z.w); maxY = Math.max(maxY, (n.y ?? 0) + z.h);
  }
  if (!Number.isFinite(minX)) return null;
  const rel = new Map<string, XY>();
  for (const n of kids) rel.set(n.id, { x: (n.x ?? 0) - minX, y: (n.y ?? 0) - minY });
  return { rel, w: maxX - minX, h: maxY - minY };
}

/**
 * Раскладывает СВЕЖИХ детей раскрытых локалов (нет владеемой позиции) мини-ELK
 * прогоном от закреплённой позиции контейнера. `positions` МУТИРУЕТСЯ.
 * Контейнер без владеемой позиции пропускается (наблюдатель на никем не
 * раскрывавшемся контейнере — его own-on-expand гейтится): дети остаются как
 * легли в общий поток уровня (на свежей сцене их ставит блок, localBlocks.ts).
 * Вложенные раскрытия обрабатываются сверху вниз: якорь группы внуков — позиция
 * их контейнера из группы его родителя.
 */
export async function spawnFreshChildren(params: {
  localFrames: { id: string; ancestors: AncestorRef[] }[];
  ownedPositions: Record<string, LevelPos>;
  layoutEdges: LayoutEdge[];
  positions: Map<string, { x: number; y: number }>;
  /** прямые дети раскрытых локалов (вход конвейера): контейнер → его дети */
  localChildren: Record<string, AppNode[]>;
}): Promise<void> {
  const { localFrames, ownedPositions, layoutEdges, positions, localChildren } = params;

  // контейнеры со СВЕЖИМИ детьми-листьями (цели спавна) + глубина вложенности
  const freshDepth = new Map<string, number>();
  for (const lf of localFrames) {
    if (ownedPositions[lf.id]) continue;
    const parent = lf.ancestors[lf.ancestors.length - 1]?.id;
    if (!parent) continue;
    const d = lf.ancestors.length;
    freshDepth.set(parent, Math.min(freshDepth.get(parent) ?? Infinity, d));
  }
  if (freshDepth.size === 0) return;
  const freshLeaf = new Set(
    localFrames.filter((lf) => !ownedPositions[lf.id]).map((lf) => lf.id),
  );
  const parentOf = childParentMap(localChildren);
  const nodeSize = (): { w: number; h: number } => ({ w: NODE_W, h: NODE_H });

  // сверху вниз (родительский контейнер раньше вложенного): позиция раскрытого
  // ребёнка из группы родителя становится якорем группы его собственных детей
  const baseOf = new Map<string, XY>();
  const order = [...freshDepth.entries()].sort((a, b) => a[1] - b[1]).map(([cid]) => cid);
  for (const cid of order) {
    const own = ownedPositions[cid];
    const base = own ? { x: own.pos_x, y: own.pos_y } : baseOf.get(cid);
    if (!base) continue;
    // ПОЛНЫЙ состав прямых детей (листья и раскрытые контейнеры — узлами):
    // состав не зависит от того, догрузились ли внуки — волны каскада дают
    // одинаковую раскладку группы (стабильность анимации)
    const direct = (localChildren[cid] ?? []).map((n) => n.id);
    if (direct.length === 0) continue;
    const block = await layoutChildrenBlock({
      cid, ids: [...direct].sort(), sizeOf: nodeSize, layoutEdges, parentOf, // детерминизм независимо от порядка догрузки
    });
    if (!block) continue;
    // сдвиг bbox результата к якорю раскрытия (C6): левый-верх → позиция контейнера
    for (const [id, r] of block.rel) {
      const p = { x: base.x + r.x, y: base.y + r.y };
      // раскрытый ребёнок узлом не отображается — его позиция лишь якорь группы
      // его детей; в positions пишем только свежие ЛИСТЬЯ (владеемые прибиты)
      if (localChildren[id]) baseOf.set(id, p);
      if (freshLeaf.has(id)) positions.set(id, p);
    }
  }
}
