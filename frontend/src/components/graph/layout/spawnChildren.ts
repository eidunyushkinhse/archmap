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
// Спейсинги label-aware (Ф2 плана): базы компактны, добавку диктуют wrapped-
// габариты фактических плашек внутренних рёбер (см. константы ниже). Позиции
// засеваются вызывающим (own-on-first-render), сюда попадают только СВЕЖИЕ
// дети (без владеемой позиции).
import { NODE_W, NODE_H } from "../constants";
import { edgeText, wrapLabel } from "../text";
import { getElk } from "./engine";
import { wrappedLabelBoxSize } from "./labelBox";
import type { AncestorRef, LayoutEdge, LevelPos } from "../../../types";

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
 * легли в общий поток уровня.
 */
export async function spawnFreshChildren(params: {
  localFrames: { id: string; ancestors: AncestorRef[] }[];
  ownedPositions: Record<string, LevelPos>;
  layoutEdges: LayoutEdge[];
  positions: Map<string, { x: number; y: number }>;
}): Promise<void> {
  const { localFrames, ownedPositions, layoutEdges, positions } = params;

  const freshByContainer = new Map<string, string[]>();
  for (const lf of localFrames) {
    if (ownedPositions[lf.id]) continue;
    const parent = lf.ancestors[lf.ancestors.length - 1]?.id;
    if (!parent) continue;
    (freshByContainer.get(parent) ?? freshByContainer.set(parent, []).get(parent)!).push(lf.id);
  }
  if (freshByContainer.size === 0) return;

  const elk = await getElk();
  for (const [cid, idsRaw] of freshByContainer) {
    const base = ownedPositions[cid];
    if (!base) continue;
    // порядок детей фиксируем сортировкой — детерминизм раскладки (E17) не должен
    // зависеть от порядка прихода детей из кэша догрузки
    const ids = [...idsRaw].sort();
    const idSet = new Set(ids);
    const inner = layoutEdges.filter((e) => idSet.has(e.source_id) && idSet.has(e.target_id));
    // Спейсинги от фактических wrapped-габаритов плашек внутренних рёбер:
    // межслойный зазор вмещает p75 ширин (горизонтальные плечи потока несут
    // текст), зазор в слое — максимум высот (плашка сбоку вертикального плеча).
    const boxes = inner.map((e) => wrappedLabelBoxSize(wrapLabel(edgeText(e))));
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
      edges: inner.map((e) => ({ id: e.id, sources: [e.source_id], targets: [e.target_id] })),
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
      positions.set(n.id, {
        x: base.pos_x + ((n.x ?? 0) - minX),
        y: base.pos_y + ((n.y ?? 0) - minY),
      });
    }
  }
}
