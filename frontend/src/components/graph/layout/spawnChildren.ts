// ПЕРВЫЙ ПОКАЗ детей раскрытого ЛОКАЛА (C9 v2, эпик «структура и воздух»,
// docs/plan-spawn-spacing.md): мини-ELK раскладка подграфа детей вместо слепой
// квадратной сетки.
//
// Сетка игнорировала связи между детьми (соседство в решётке случайно — рёбра
// бежали лабиринтом через зазоры 40px) и подписи (плашки 150–250px не влезали
// в такие зазоры физически — треть уходила в выноски). Теперь дети + рёбра
// МЕЖДУ ними раскладываются локальным `elk.layered` (direction RIGHT, как
// уровень): связанные встают в поток, изолированные — упаковкой компонент ELK.
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
import { NODE_W, NODE_H } from "../constants";
import { edgeText, wrapLabel } from "../text";
import { getElk } from "./engine";
import { wrappedLabelBoxSize } from "./labelBox";
import type { AncestorRef, LayoutEdge, LevelPos, Node as AppNode } from "../../../types";

// Зазоры мини-раскладки подграфа детей (C9 v2) — Label-aware (Ф2 плана): базовые
// значения компактны, добавку диктуют ФАКТИЧЕСКИЕ плашки внутренних рёбер этого
// подграфа (перцентиль p75 wrapped-ширин — одна гигантская подпись не раздувает
// рамку, ей лучше остаться выноской; клампы сверху — жёсткий анти-ватман).
const SPAWN_LAYER_GAP_MIN = 100; // между слоями без подписей (чуть плотнее уровня)
const SPAWN_LAYER_GAP_MAX = 220; // кламп: шире не раздвигаем даже ради плашек
const SPAWN_NODE_GAP_MIN = 60;   // внутри слоя (≈ nodesep уровня)
const SPAWN_NODE_GAP_MAX = 120;
const SPAWN_LABEL_CLEAR = 8;     // клиренс плашки вдоль плеча с каждой стороны (как A10)
const SPAWN_COMPONENT_GAP = 60;  // между компонентами связности (изоляты)

/**
 * Раскладывает СВЕЖИХ детей раскрытых локалов (нет владеемой позиции) мини-ELK
 * прогоном от закреплённой позиции контейнера. `positions` МУТИРУЕТСЯ.
 * Контейнер без владеемой позиции пропускается (наблюдатель на никем не
 * раскрывавшемся контейнере — его own-on-expand гейтится): дети остаются как
 * легли в общий поток уровня. Вложенные раскрытия обрабатываются сверху вниз:
 * якорь группы внуков — позиция их контейнера из группы его родителя.
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

  // подъём конца ребра к прямому ребёнку контейнера (рёбра приходят поднятыми
  // к ЛИСТЬЯМ — глубоким видимым узлам)
  const parentOf = new Map<string, string>();
  for (const [cid, kids] of Object.entries(localChildren)) {
    for (const k of kids) parentOf.set(k.id, cid);
  }
  const liftTo = (id: string, members: ReadonlySet<string>): string | null => {
    let cur: string | undefined = id;
    while (cur !== undefined && !members.has(cur)) cur = parentOf.get(cur);
    return cur ?? null;
  };

  // сверху вниз (родительский контейнер раньше вложенного): позиция раскрытого
  // ребёнка из группы родителя становится якорем группы его собственных детей
  const baseOf = new Map<string, { x: number; y: number }>();
  const order = [...freshDepth.entries()].sort((a, b) => a[1] - b[1]).map(([cid]) => cid);
  const elk = await getElk();
  for (const cid of order) {
    const own = ownedPositions[cid];
    const base = own ? { x: own.pos_x, y: own.pos_y } : baseOf.get(cid);
    if (!base) continue;
    // ПОЛНЫЙ состав прямых детей (листья и раскрытые контейнеры — узлами):
    // состав не зависит от того, догрузились ли внуки — волны каскада дают
    // одинаковую раскладку группы (стабильность анимации)
    const direct = (localChildren[cid] ?? []).map((n) => n.id);
    if (direct.length === 0) continue;
    const ids = [...direct].sort(); // детерминизм независимо от порядка догрузки
    const idSet = new Set(ids);
    const innerEdges: LayoutEdge[] = [];
    const inner: Array<{ id: string; sources: [string]; targets: [string] }> = [];
    for (const e of layoutEdges) {
      const s = liftTo(e.source_id, idSet);
      const t = liftTo(e.target_id, idSet);
      if (!s || !t || s === t) continue;
      inner.push({ id: e.id, sources: [s], targets: [t] });
      innerEdges.push(e);
    }
    // Спейсинги от фактических wrapped-габаритов плашек внутренних рёбер:
    // межслойный зазор вмещает p75 ширин (горизонтальные плечи потока несут
    // текст), зазор в слое — максимум высот (плашка сбоку вертикального плеча).
    const boxes = innerEdges.map((e) => wrappedLabelBoxSize(wrapLabel(edgeText(e))));
    const widths = boxes.map((b) => b.w).sort((a, b) => a - b);
    const p75w = widths.length ? widths[Math.min(widths.length - 1, Math.floor(widths.length * 0.75))] : 0;
    const maxH = boxes.reduce((m, b) => Math.max(m, b.h), 0);
    const layerGap = Math.min(SPAWN_LAYER_GAP_MAX,
      Math.max(SPAWN_LAYER_GAP_MIN, Math.ceil(p75w) + 2 * SPAWN_LABEL_CLEAR));
    const nodeGap = Math.min(SPAWN_NODE_GAP_MAX,
      Math.max(SPAWN_NODE_GAP_MIN, maxH + 2 * SPAWN_LABEL_CLEAR));
    const res = await elk.layout({
      id: `spawn-${cid}`,
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.layered.spacing.nodeNodeBetweenLayers": String(layerGap),
        "elk.spacing.nodeNode": String(nodeGap),
        "elk.separateConnectedComponents": "true",
        "elk.spacing.componentComponent": String(SPAWN_COMPONENT_GAP),
        // Анти-ватман: длинную архитектурную цепочку (лента 6+ слоёв, полигон Ф1:
        // 2280px шириной) MULTI_EDGE-свёртка ELK сгибает в полосы. Сила сгиба у
        // elkjs непараметризуема (aspectRatio/correctionFactor на разрез не
        // влияют, MANUAL-cuts требует Java-тип) — берём его единственный разрез.
        "elk.layered.wrapping.strategy": "MULTI_EDGE",
      },
      children: ids.map((id) => ({ id, width: NODE_W, height: NODE_H })),
      edges: inner,
    });
    // сдвиг bbox результата к якорю раскрытия (C6): левый-верх → позиция контейнера
    const kids = res.children ?? [];
    let minX = Infinity, minY = Infinity;
    for (const n of kids) {
      minX = Math.min(minX, n.x ?? 0);
      minY = Math.min(minY, n.y ?? 0);
    }
    if (!Number.isFinite(minX)) continue;
    for (const n of kids) {
      const p = { x: base.x + ((n.x ?? 0) - minX), y: base.y + ((n.y ?? 0) - minY) };
      // раскрытый ребёнок узлом не отображается — его позиция лишь якорь группы
      // его детей; в positions пишем только свежие ЛИСТЬЯ (владеемые прибиты)
      if (localChildren[n.id]) baseOf.set(n.id, p);
      if (freshLeaf.has(n.id)) positions.set(n.id, p);
    }
  }
}
